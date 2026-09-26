import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PurchaseInvoicesApi } from "./purchase-invoices.api.js";
import { SaleInvoicesApi } from "./sale-invoices.api.js";
import { JournalsApi } from "./journals.api.js";
import { TransactionsApi } from "./transactions.api.js";
import { cache } from "./base-resource.js";
import { HttpError, type HttpClient } from "../http-client.js";

vi.mock("../logger.js", () => ({ log: vi.fn() }));
vi.mock("../progress.js", () => ({ reportProgress: vi.fn().mockResolvedValue(undefined) }));

function makeClient(): HttpClient {
  return {
    cacheNamespace: "connection:0",
    get: vi.fn().mockResolvedValue({ name: "doc.pdf", contents: "YmFzZTY0" }),
    post: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn().mockResolvedValue({ code: 200, messages: [] }),
    request: vi.fn().mockResolvedValue({ code: 200, messages: [] }),
  } as unknown as HttpClient;
}

// Each document-capable resource must reach /{basePath}/{id}/document_user via
// the methods inherited from BaseResource. This pins the path per class and
// specifically guards the removal of the old PurchaseInvoicesApi overrides.
//
// R4a Task 25 narrows this: the CRM's only file route is `POST /documents/:id/file`,
// needing a `path` (purchase-invoices.api.ts, base-resource.ts). E2E-FIX B1 opts
// PurchaseInvoicesApi into BaseResource's document-backed mode too (its `get`/`update`
// now read/write `/documents/:id`, same as SaleInvoicesApi; `previewTotalsCorrection`
// stays adapter-internal, reading through the opted-in `get`), so `getDocument`/
// `deleteDocument` now refuse the same way SaleInvoicesApi's do (there is no CRM route
// for either). JournalsApi and TransactionsApi are untouched and keep the full
// old-route row.
//
// R4a Task 30 closes `uploadDocument` for the two CRM-backed classes: it now
// resolves `path` from the CRM's own extraction record (`GET /extractions/:sha256`,
// keyed by the uploaded bytes' sha256) instead of refusing outright — see the
// dedicated `CRM_EXTRACTION` cases below.
const OLD_ROUTE = "old" as const;
const REFUSES = "refuses" as const;
const CRM_EXTRACTION = "crm-extraction" as const;
const CLASSES = [
  ["PurchaseInvoicesApi", (c: HttpClient) => new PurchaseInvoicesApi(c), "/purchase_invoices", { get: REFUSES, upload: CRM_EXTRACTION, del: REFUSES }],
  ["SaleInvoicesApi", (c: HttpClient) => new SaleInvoicesApi(c), "/sale_invoices", { get: REFUSES, upload: CRM_EXTRACTION, del: REFUSES }],
  ["JournalsApi", (c: HttpClient) => new JournalsApi(c), "/journals", { get: OLD_ROUTE, upload: OLD_ROUTE, del: OLD_ROUTE }],
  ["TransactionsApi", (c: HttpClient) => new TransactionsApi(c), "/transactions", { get: OLD_ROUTE, upload: OLD_ROUTE, del: OLD_ROUTE }],
] as const;

describe("document_user methods inherited on each document-capable API class", () => {
  beforeEach(() => cache.invalidate());

  for (const [name, make, base, expected] of CLASSES) {
    it(`${name}.getDocument`, async () => {
      const client = makeClient();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const api = make(client) as any;
      if (expected.get === OLD_ROUTE) {
        await api.getDocument(7);
        expect(client.get).toHaveBeenCalledWith(`${base}/7/document_user`);
      } else {
        await expect(api.getDocument(7)).rejects.toThrow(/no route to read/);
      }
    });

    it(`${name}.deleteDocument`, async () => {
      const client = makeClient();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const api = make(client) as any;
      if (expected.del === OLD_ROUTE) {
        await api.deleteDocument(7);
        expect(client.delete).toHaveBeenCalledWith(`${base}/7/document_user`);
      } else {
        await expect(api.deleteDocument(7)).rejects.toThrow(/no route to delete/);
      }
    });

    it(`${name}.uploadDocument`, async () => {
      const client = makeClient();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const api = make(client) as any;
      if (expected.upload === OLD_ROUTE) {
        await api.uploadDocument(7, "scan.pdf", "Zm9v");
        expect(client.request).toHaveBeenCalledWith(`${base}/7/document_user`, {
          method: "PUT",
          body: { name: "scan.pdf", contents: "Zm9v" },
        });
      } else {
        // CRM_EXTRACTION: the default client.get mock resolves to a body with no
        // `path` (see makeClient), the same shape a real 200 with a null re-verified
        // path would have — so the no-record and the null-path cases assert alike.
        await expect(api.uploadDocument(7, "scan.pdf", "Zm9v")).rejects.toThrow(/no CRM extraction record/);
        expect(client.request).not.toHaveBeenCalled();
        expect(client.post).not.toHaveBeenCalledWith(expect.stringMatching(/\/file$/), expect.anything());
      }
    });
  }

  // R4a Task 30: PurchaseInvoicesApi and SaleInvoicesApi resolve uploadDocument's
  // `path` from the CRM's extraction record instead of refusing outright.
  const CRM_EXTRACTION_CLASSES = CLASSES.filter(([, , , expected]) => expected.upload === CRM_EXTRACTION);
  for (const [name, make] of CRM_EXTRACTION_CLASSES) {
    it(`${name}.uploadDocument posts { path, sha256 } to /documents/:id/file once the CRM extraction record has a path`, async () => {
      const client = makeClient();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const api = make(client) as any;
      const sha256 = createHash("sha256").update(Buffer.from("Zm9v", "base64")).digest("hex");
      (client.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ path: "/app/uploads/scan.pdf" });
      (client.post as ReturnType<typeof vi.fn>).mockImplementation(async (path: string) => {
        if (path === "/id-map") return { crmIds: ["crm-doc-7"], numericIds: [7] };
        return { code: 200, messages: [] };
      });

      await api.uploadDocument(7, "scan.pdf", "Zm9v");

      expect(client.get).toHaveBeenCalledWith(`/extractions/${sha256}`);
      expect(client.post).toHaveBeenCalledWith(
        expect.stringMatching(/^\/documents\/.+\/file$/),
        { path: "/app/uploads/scan.pdf", sha256 },
      );
      expect(client.request).not.toHaveBeenCalled();
    });

    it(`${name}.uploadDocument refuses (no rollback-inducing 501) when no CRM extraction record exists yet`, async () => {
      const client = makeClient();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const api = make(client) as any;
      (client.get as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new HttpError("CRM 404 on GET /extractions/x", 404, "GET", "/extractions/x"),
      );

      await expect(api.uploadDocument(7, "scan.pdf", "Zm9v")).rejects.toThrow(/no CRM extraction record/);
      expect(client.request).not.toHaveBeenCalled();
      expect(client.post).not.toHaveBeenCalledWith(expect.stringMatching(/\/file$/), expect.anything());
    });
  }
});
