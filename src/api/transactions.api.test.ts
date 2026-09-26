import { describe, expect, it, vi, beforeEach } from "vitest";
import { HttpError, type HttpClient } from "../http-client.js";
import { TransactionsApi, LinkedInvoiceClientMismatchError, getNormalizedNetworkCause } from "./transactions.api.js";
import { cache } from "./base-resource.js";

function mockClient(): HttpClient {
  return {
    cacheNamespace: "connection:0",
    connectionFingerprint: "fp:0",
    get: vi.fn(),
    post: vi.fn(),
    patch: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
  } as unknown as HttpClient;
}

describe("TransactionsApi over the CRM", () => {
  beforeEach(() => cache.invalidate());

  it("create resolves the bank-account iban and POSTs /bank-transactions", async () => {
    const client = mockClient();
    (client.post as ReturnType<typeof vi.fn>).mockImplementation(async (path: string, body: { kind?: string; numericIds?: number[]; crmIds?: string[] }) => {
      if (path === "/id-map" && body.kind === "bank_account") return { crmIds: ["EE001"] };
      if (path === "/bank-transactions") return { id: "bt1", created: true };
      if (path === "/id-map" && body.kind === "bank_transaction") return { numericIds: [500] };
      throw new Error(`unexpected POST ${path}`);
    });
    const api = new TransactionsApi(client);
    const r = await api.create({
      accounts_dimensions_id: 900000001, amount: 10, cl_currencies_id: "EUR", date: "2026-02-03",
      description: "invoice payment", type: "D",
    } as never);
    expect(r.created_object_id).toBe(500);
    expect(client.post).toHaveBeenCalledWith("/bank-transactions", expect.objectContaining({
      accountIban: "EE001", direction: "CRDT", amount: "10.00", remittance: "invoice payment",
    }));
  });

  it("confirm(id, items) PUTs distributions, then POSTs confirm, in that order", async () => {
    const client = mockClient();
    const calls: string[] = [];
    (client.post as ReturnType<typeof vi.fn>).mockImplementation(async (path: string, body: { kind?: string; numericIds?: number[] }) => {
      calls.push(`POST ${path}`);
      if (path === "/id-map" && body.kind === "bank_transaction") return { crmIds: ["bt7"] };
      if (path === "/id-map" && body.kind === "account") return { crmIds: ["6000"] };
      if (path === "/id-map" && body.kind === "entry") return { numericIds: [900] };
      if (path === "/bank-transactions/bt7/confirm") return { entryId: "entry7" };
      throw new Error(`unexpected POST ${path}`);
    });
    (client.put as ReturnType<typeof vi.fn>).mockImplementation(async (path: string) => {
      calls.push(`PUT ${path}`);
      return { replaced: 1 };
    });
    const api = new TransactionsApi(client);
    const r = await api.confirm(7, [{ related_table: "accounts", related_id: 6000, amount: 10 }]);
    expect(r.created_object_id).toBe(900);
    const distributionsIdx = calls.indexOf("PUT /bank-transactions/bt7/distributions");
    const confirmIdx = calls.indexOf("POST /bank-transactions/bt7/confirm");
    expect(distributionsIdx).toBeGreaterThanOrEqual(0);
    expect(confirmIdx).toBeGreaterThan(distributionsIdx);
  });

  it("confirm with no distributions skips the PUT and just confirms", async () => {
    const client = mockClient();
    (client.post as ReturnType<typeof vi.fn>).mockImplementation(async (path: string, body: { kind?: string }) => {
      if (path === "/id-map" && body.kind === "bank_transaction") return { crmIds: ["bt8"] };
      if (path === "/id-map" && body.kind === "entry") return { numericIds: [901] };
      if (path === "/bank-transactions/bt8/confirm") return { entryId: "entry8" };
      throw new Error(`unexpected POST ${path}`);
    });
    const api = new TransactionsApi(client);
    await api.confirm(8);
    expect(client.put).not.toHaveBeenCalled();
    expect(client.post).toHaveBeenCalledWith("/bank-transactions/bt8/confirm", {});
  });

  it("invalidate reads the bank transaction's document and invalidates it", async () => {
    const client = mockClient();
    (client.post as ReturnType<typeof vi.fn>).mockImplementation(async (path: string, body?: { kind?: string }) => {
      if (path === "/id-map" && body?.kind === "bank_transaction") return { crmIds: ["bt9"] };
      if (path === "/id-map" && body?.kind === "entry") return { numericIds: [902] };
      if (path === "/documents/doc9/invalidate") return { entryId: "entry9" };
      throw new Error(`unexpected POST ${path}`);
    });
    (client.get as ReturnType<typeof vi.fn>).mockImplementation(async (path: string) => {
      if (path === "/bank-transactions/bt9") return { id: "bt9", acctSvcrRef: "ref9", accountIban: "EE001", bookingDate: "2026-02-01", amount: "10.00", direction: "CRDT", currency: "EUR", counterpartyName: null, counterpartyIban: null, remittance: null, documentId: "doc9" };
      throw new Error(`unexpected GET ${path}`);
    });
    const api = new TransactionsApi(client);
    const r = await api.invalidate(9);
    expect(r.created_object_id).toBe(902);
    expect(client.post).toHaveBeenCalledWith("/documents/doc9/invalidate", expect.objectContaining({ reason: "invalidated by the approved plan" }));
  });

  it("update WITHOUT items still throws — the CRM has no route to change metadata", async () => {
    const api = new TransactionsApi(mockClient());
    await expect(api.update(10, { description: "x" } as never)).rejects.toMatchObject({ name: "HttpError", status: 501 });
    await expect(api.update(10, { clients_id: 5 } as never)).rejects.toMatchObject({ name: "HttpError", status: 501 });
  });

  it("update WITH items maps them like confirm's first step and PUTs distributions", async () => {
    const client = mockClient();
    (client.post as ReturnType<typeof vi.fn>).mockImplementation(async (path: string, body: { kind?: string }) => {
      if (path === "/id-map" && body.kind === "bank_transaction") return { crmIds: ["bt13"] };
      if (path === "/id-map" && body.kind === "account") return { crmIds: ["6000"] };
      throw new Error(`unexpected POST ${path}`);
    });
    (client.put as ReturnType<typeof vi.fn>).mockResolvedValue({ replaced: 1 });
    const api = new TransactionsApi(client);
    const r = await api.update(13, { items: [{ related_table: "accounts", related_id: 6000, amount: 15 }] } as never);
    expect(r).toMatchObject({ code: 200 });
    expect(client.put).toHaveBeenCalledWith("/bank-transactions/bt13/distributions", {
      lines: [{ lineNo: 1, targetKind: "account", settlesPostingId: null, accountCode: "6000", amount: "15.00" }],
    });
  });

  it("delete throws — the CRM has no route to delete a bank transaction", async () => {
    const api = new TransactionsApi(mockClient());
    await expect(api.delete(11)).rejects.toMatchObject({ name: "HttpError", status: 501 });
  });

  it("list/get maps CRM direction and confirmation status onto the RIK shape", async () => {
    const client = mockClient();
    (client.get as ReturnType<typeof vi.fn>).mockImplementation(async (path: string) => {
      if (path === "/bank-transactions") {
        return [{ id: "bt12", acctSvcrRef: "ref12", accountIban: "EE002", bookingDate: "2026-02-05", amount: "20.00", direction: "DBIT", currency: "EUR", counterpartyName: "Supplier", counterpartyIban: "EE003", remittance: "rent", documentId: null }];
      }
      throw new Error(`unexpected GET ${path}`);
    });
    (client.post as ReturnType<typeof vi.fn>).mockImplementation(async (path: string, body: { kind: string; crmIds: string[] }) => {
      if (path === "/id-map" && body.kind === "bank_transaction") return { numericIds: [12] };
      if (path === "/id-map" && body.kind === "bank_account") return { numericIds: [900000002] };
      throw new Error(`unexpected POST ${path}`);
    });
    const api = new TransactionsApi(client);
    const tx = await api.get(12);
    expect(tx).toMatchObject({ id: 12, type: "C", status: "PROJECT", description: "rent", accounts_dimensions_id: 900000002 });
  });
});

describe("TransactionsApi external compile contract (crud/transactions.ts, accounting-inbox.ts)", () => {
  it("still exports LinkedInvoiceClientMismatchError and getNormalizedNetworkCause", () => {
    expect(typeof LinkedInvoiceClientMismatchError).toBe("function");
    expect(typeof getNormalizedNetworkCause).toBe("function");
    const err = new LinkedInvoiceClientMismatchError({
      transactionId: 1, transactionClientsId: 2, invoiceTable: "sale_invoices", invoiceId: 3, invoiceClientsId: 4,
    });
    expect(err).toBeInstanceOf(Error);
    expect(err.category).toBe("linked_invoice_client_mismatch");
  });

  it("getNormalizedNetworkCause returns undefined for a plain error", () => {
    expect(getNormalizedNetworkCause(new Error("boom"))).toBeUndefined();
    expect(getNormalizedNetworkCause(new HttpError("bad", 400, "GET", "/x"))).toBeUndefined();
  });
});
