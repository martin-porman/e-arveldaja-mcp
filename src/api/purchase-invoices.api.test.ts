import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpClient } from "../http-client.js";
import { sourceKeyFor } from "../crm/source-key.js";
import { PurchaseInvoicesApi } from "./purchase-invoices.api.js";
import { SaleInvoicesApi } from "./sale-invoices.api.js";

// IdMap's memo (src/crm/id-map.ts:33-34) is keyed by `client.cacheNamespace` but shared
// at module scope across every HttpClient instance in the process — a fresh
// `cacheNamespace` per `client()` call keeps one test's counterparty resolution
// (clients_id 12 → "ck-supplier") from leaking into another test's stub.
let clientNamespace = 0;
const client = () => new HttpClient(
  { baseUrl: "http://crm/api/crm-mcp", apiKeyId: "crm-mcp", apiPublicValue: "x", apiPassword: "t".repeat(43) },
  `test:${clientNamespace++}`,
);
afterEach(() => vi.unstubAllGlobals());

// `Response` defaults to `content-type: text/plain` for a plain string body — http-client.ts
// branches on `content-type: application/json` before parsing the body as JSON (http-client.ts:242-255),
// so every stub response here sets it explicitly (same fix as the shared helper in journals.api.test.ts:10).
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });

function stubCrm(calls: { method: string; url: string; body?: any }[]) {
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method: String(init.method ?? "GET"), url, body });
    if (url.endsWith("/id-map") && body?.numericIds) return json({ crmIds: body.numericIds.map((n: number) => (n === 12 ? "ck-supplier" : String(n))) });
    if (url.endsWith("/id-map")) return json({ numericIds: [501] });
    if (url.endsWith("/counterparties/ck-supplier")) return json({ id: "ck-supplier", name: "Supplier OÜ", regCode: "12345678", vatNo: "EE100000000", country: "EE", isJuridical: true, isCustomer: false, isSupplier: true, isActive: true, iban: null });
    if (url.endsWith("/documents") && init.method === "POST") return json({ id: "doc-1", created: true });
    throw new Error(`unexpected ${init.method} ${url}`);
  }));
}

const data = {
  clients_id: 12, client_name: "Supplier OÜ", number: "A-17", create_date: "2026-02-03", journal_date: "2026-02-03", term_days: 14, cl_currencies_id: "EUR", liability_accounts_id: 22,
  items: [{ custom_title: "Hosting", purchase_accounts_id: 4000, total_net_price: 100, vat_rate_dropdown: "24", amount: 1 }],
  crm_source: { sha256: "a".repeat(64) },
};

describe("PurchaseInvoicesApi over the CRM", () => {
  it("createAndSetTotals is ONE document create with core VAT codes — no create-then-PATCH", async () => {
    const calls: { method: string; url: string; body?: any }[] = [];
    stubCrm(calls);
    const r = await new PurchaseInvoicesApi(client()).createAndSetTotals(data as never, 24, 124);
    expect(r.created_object_id).toBe(501);
    const writes = calls.filter((c) => c.method !== "GET" && !c.url.endsWith("/id-map"));
    expect(writes).toHaveLength(1);
    expect(writes[0]!.body).toMatchObject({
      kind: "PURCHASE_INVOICE", sourceKey: `file:${"a".repeat(64)}`, number: "A-17", counterpartyId: "ck-supplier",
      docDate: "2026-02-03", turnoverDate: "2026-02-03", dueDate: "2026-02-17",
      lines: [{ accountCode: "4000", net: "100.00", vatCode: "P24", vatAmount: "24.00", side: null }],
    });
  });
  it("refuses a line the VAT map cannot decide, naming the line, before any write", async () => {
    const calls: { method: string; url: string; body?: any }[] = [];
    stubCrm(calls);
    const reverse = { ...data, items: [{ ...data.items[0], reversed_vat_id: 1 }] };
    vi.mocked(fetch).mockImplementation(async (url: any, init: any) => {
      calls.push({ method: String(init?.method ?? "GET"), url });
      if (String(url).endsWith("/id-map")) return json({ crmIds: ["ck-de"] });
      if (String(url).endsWith("/counterparties/ck-de")) return json({ id: "ck-de", name: "GmbH", regCode: null, vatNo: "DE1", country: "DE", isJuridical: true, isCustomer: false, isSupplier: true, isActive: true, iban: null });
      throw new Error(`unexpected ${url}`);
    });
    await expect(new PurchaseInvoicesApi(client()).createAndSetTotals(reverse as never)).rejects.toThrow(/line 1: .*goods \(PEUG24\) or services \(PEUS24\)/);
    expect(calls.some((c) => c.url.endsWith("/documents"))).toBe(false);
  });
});

describe("SaleInvoicesApi over the CRM", () => {
  it("switches outbound e-invoicing off honestly", async () => {
    await expect(new SaleInvoicesApi(client()).sendEinvoice(1, {} as never)).rejects.toThrow(/switched off/);
  });
});

describe("sourceKeyFor", () => {
  it("binds an invoice to its source, or refuses", () => {
    expect(sourceKeyFor({ sha256: "ab".repeat(32) })).toBe(`file:${"ab".repeat(32)}`);
    expect(sourceKeyFor({ message_id: "<x@y>", index: 2 })).toBe("mail:<x@y>#2");
    expect(sourceKeyFor({ bank_transaction_id: "ck-bank-txn-1" })).toBe("bankline:ck-bank-txn-1");
    expect(() => sourceKeyFor({})).toThrow(/without a source cannot be booked idempotently/);
  });
});

describe("createAndSetTotals with a bank-transaction source", () => {
  it("resolves the RIK bank transaction id through the id map and sends a bankline: sourceKey", async () => {
    const calls: { method: string; url: string; body?: any }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      const body = init.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ method: String(init.method ?? "GET"), url, body });
      if (url.endsWith("/id-map") && body?.numericIds) return json({ crmIds: body.numericIds.map((n: number) => (n === 12 ? "ck-supplier" : n === 55 ? "ck-bank-txn-55" : String(n))) });
      if (url.endsWith("/id-map")) return json({ numericIds: [501] });
      if (url.endsWith("/counterparties/ck-supplier")) return json({ id: "ck-supplier", name: "Supplier OÜ", regCode: "12345678", vatNo: "EE100000000", country: "EE", isJuridical: true, isCustomer: false, isSupplier: true, isActive: true, iban: null });
      if (url.endsWith("/documents") && init.method === "POST") return json({ id: "doc-1", created: true });
      throw new Error(`unexpected ${init.method} ${url}`);
    }));
    const bankSourced = { ...data, crm_source: { bank_transaction_id: 55 } };

    const r = await new PurchaseInvoicesApi(client()).createAndSetTotals(bankSourced as never);
    expect(r.created_object_id).toBe(501);
    const write = calls.find((c) => c.url.endsWith("/documents") && c.method === "POST");
    expect(write?.body).toMatchObject({ sourceKey: "bankline:ck-bank-txn-55" });
  });
});
