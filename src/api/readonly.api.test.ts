import { describe, expect, it, vi } from "vitest";
import { HttpClient } from "../http-client.js";
import { ReferenceDataApi } from "./readonly.api.js";

// Deviation from the brief's literal `new Response(JSON.stringify(...))`:
// that constructor leaves content-type as "text/plain;charset=UTF-8" (verified
// against Node's built-in fetch), so http-client.ts's JSON-vs-binary branch
// takes the binary path and getAccounts() never sees an array. `Response.json`
// sets "application/json" and exercises the real branch — the deviation is
// purely to make the mocked transport look like the CRM's real one.
describe("ReferenceDataApi over the CRM", () => {
  it("reads the chart through /accounts and maps non-numeric codes through the id map", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      if (url.endsWith("/accounts")) return Response.json([{ code: "22", nameEt: "Võlad", nameEn: null, parentCode: null, type: "LIABILITY", normalSide: "C", category: null, isHeading: false, requiresCounterparty: true, isVatAccount: false, allowsDimension: false, isActive: true, roles: [], createdBy: "seed" }, { code: "101T", nameEt: "Kassa T", nameEn: null, parentCode: null, type: "ASSET", normalSide: "D", category: null, isHeading: false, requiresCounterparty: false, isVatAccount: false, allowsDimension: false, isActive: true, roles: [], createdBy: "seed" }]);
      if (url.endsWith("/id-map")) return Response.json({ numericIds: [900000001] });
      throw new Error(`unexpected ${url} ${init.method}`);
    }));
    const api = new ReferenceDataApi(new HttpClient({ baseUrl: "http://crm/api/crm-mcp", apiKeyId: "crm-mcp", apiPublicValue: "x", apiPassword: "t".repeat(43) }));
    expect((await api.getAccounts()).map((a) => a.id)).toEqual([22, 900000001]);
    await expect(api.createBankAccount({})).rejects.toThrow(/switched off/);
    vi.unstubAllGlobals();
  });
});

function makeMockClient(namespace: string) {
  return {
    cacheNamespace: namespace,
    connectionFingerprint: `fp:${namespace}`,
    get: vi.fn(),
    post: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  } as unknown as HttpClient;
}

const accountRows = [
  { code: "5000", nameEt: "Kaubad, materjal, teenused", nameEn: null, parentCode: null, type: "EXPENSE", normalSide: "D", category: null, isHeading: false, requiresCounterparty: false, isVatAccount: false, allowsDimension: false, isActive: true, roles: [], createdBy: "seed" },
  { code: "5", nameEt: "Kulude peakonto", nameEn: null, parentCode: null, type: "EXPENSE", normalSide: "D", category: null, isHeading: true, requiresCounterparty: false, isVatAccount: false, allowsDimension: false, isActive: true, roles: [], createdBy: "seed" },
  { code: "3000", nameEt: "Müügitulu", nameEn: null, parentCode: null, type: "REVENUE", normalSide: "C", category: null, isHeading: false, requiresCounterparty: false, isVatAccount: false, allowsDimension: false, isActive: true, roles: [], createdBy: "seed" },
  { code: "2200", nameEt: "Võlad tarnijatele", nameEn: null, parentCode: null, type: "LIABILITY", normalSide: "C", category: null, isHeading: false, requiresCounterparty: true, isVatAccount: false, allowsDimension: false, isActive: true, roles: [], createdBy: "seed" },
];

describe("getPurchaseArticles / getSaleArticles derive from the chart (no VAT-article catalogue exists in the CRM)", () => {
  it("getPurchaseArticles returns only active, non-heading EXPENSE accounts, each as its own article", async () => {
    const client = makeMockClient("connection:purchase-articles");
    (client.get as ReturnType<typeof vi.fn>).mockImplementation(async (path: string) => {
      if (path === "/accounts") return accountRows;
      throw new Error(`unexpected GET ${path}`);
    });
    (client.post as ReturnType<typeof vi.fn>).mockImplementation(async (path: string, body: { crmIds: string[] }) => {
      if (path === "/id-map") return { numericIds: body.crmIds.map(Number) };
      throw new Error(`unexpected POST ${path}`);
    });
    const api = new ReferenceDataApi(client);
    const articles = await api.getPurchaseArticles();
    expect(articles).toHaveLength(1);
    expect(articles[0]).toMatchObject({ id: 5000, name_est: "Kaubad, materjal, teenused", accounts_id: 5000 });
  });

  it("getSaleArticles returns only active, non-heading REVENUE accounts, each as its own article", async () => {
    const client = makeMockClient("connection:sale-articles");
    (client.get as ReturnType<typeof vi.fn>).mockImplementation(async (path: string) => {
      if (path === "/accounts") return accountRows;
      throw new Error(`unexpected GET ${path}`);
    });
    (client.post as ReturnType<typeof vi.fn>).mockImplementation(async (path: string, body: { crmIds: string[] }) => {
      if (path === "/id-map") return { numericIds: body.crmIds.map(Number) };
      throw new Error(`unexpected POST ${path}`);
    });
    const api = new ReferenceDataApi(client);
    const articles = await api.getSaleArticles();
    expect(articles).toHaveLength(1);
    expect(articles[0]).toMatchObject({ id: 3000, name_est: "Müügitulu", accounts_id: 3000, is_valid: true });
  });
});
