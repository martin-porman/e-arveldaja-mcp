import { beforeEach, describe, expect, it, vi } from "vitest";
import { PurchaseInvoicesApi } from "./purchase-invoices.api.js";
import { SaleInvoicesApi } from "./sale-invoices.api.js";
import { JournalsApi } from "./journals.api.js";
import { TransactionsApi } from "./transactions.api.js";
import { cache } from "./base-resource.js";
import type { HttpClient } from "../http-client.js";

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
// needing a `path` this fork has no source for until Task 30 (purchase-invoices.api.ts,
// base-resource.ts). PurchaseInvoicesApi overrides only `uploadDocument` to refuse
// honestly — `getDocument`/`deleteDocument` are untouched (it does not opt into
// BaseResource's document-backed mode; `previewTotalsCorrection` needs `get`/`update` to
// stay on `/purchase_invoices`, so document_user stays there too). SaleInvoicesApi *does*
// opt in (all its CRUD is CRM-native), so all three of its document_user methods refuse.
// JournalsApi and TransactionsApi are untouched and keep the full old-route row.
const OLD_ROUTE = "old" as const;
const REFUSES = "refuses" as const;
const CLASSES = [
  ["PurchaseInvoicesApi", (c: HttpClient) => new PurchaseInvoicesApi(c), "/purchase_invoices", { get: OLD_ROUTE, upload: REFUSES, del: OLD_ROUTE }],
  ["SaleInvoicesApi", (c: HttpClient) => new SaleInvoicesApi(c), "/sale_invoices", { get: REFUSES, upload: REFUSES, del: REFUSES }],
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
        await expect(api.uploadDocument(7, "scan.pdf", "Zm9v")).rejects.toThrow(/Task 30/);
        expect(client.request).not.toHaveBeenCalled();
      }
    });
  }
});
