import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpClient } from "../http-client.js";
import { SaleInvoicesApi } from "./sale-invoices.api.js";
import { cache } from "./base-resource.js";

// `Response` defaults to `content-type: text/plain` for a plain string body — http-client.ts
// branches on `content-type: application/json` before parsing the body as JSON — so every
// stub response here sets it explicitly (journals.api.test.ts:10 uses the same fix).
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });

let ns = 0;
const client = () => new HttpClient(
  { baseUrl: "http://crm/api/crm-mcp", apiKeyId: "crm-mcp", apiPublicValue: "x", apiPassword: "t".repeat(43) },
  `sale-invoices-test:${ns++}`,
);
afterEach(() => {
  vi.unstubAllGlobals();
  cache.invalidate();
});

function stubFetch(handlers: Record<string, (init: RequestInit) => Response>) {
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit = {}) => {
    for (const [suffix, handler] of Object.entries(handlers)) {
      if (url.endsWith(suffix)) return handler(init);
    }
    throw new Error(`unexpected ${init.method ?? "GET"} ${url}`);
  }));
}

describe("SaleInvoicesApi over the CRM", () => {
  it("confirm is POST /documents/:id/confirm, mapped back through id-map", async () => {
    stubFetch({
      "/id-map": (init) => {
        const body = JSON.parse(String(init.body));
        return body.numericIds ? json({ crmIds: ["doc-crm-1"] }) : json({ numericIds: [900] });
      },
      "/documents/doc-crm-1/confirm": () => json({ entryId: "entry-crm-1" }),
    });
    const result = await new SaleInvoicesApi(client()).confirm(42);
    expect(result).toEqual({ code: 200, created_object_id: 900, messages: [] });
  });

  it("invalidate DELETEs a DRAFT document instead of reversing it", async () => {
    const calls: string[] = [];
    stubFetch({
      "/id-map": (init) => {
        const body = JSON.parse(String(init.body));
        calls.push(`id-map:${JSON.stringify(body)}`);
        return json({ crmIds: ["doc-crm-2"] });
      },
      "/documents/doc-crm-2": (init) => {
        calls.push(init.method ?? "GET");
        return init.method === "DELETE" ? json({ ok: true }) : json({ status: "DRAFT" });
      },
    });
    const result = await new SaleInvoicesApi(client()).invalidate(7);
    expect(result).toEqual({ code: 200, messages: [] });
    expect(calls).toContain("DELETE");
  });

  it("invalidate reverses a POSTED document instead of deleting it", async () => {
    stubFetch({
      "/id-map": (init) => {
        const body = JSON.parse(String(init.body));
        return body.numericIds ? json({ crmIds: ["doc-crm-3"] }) : json({ numericIds: [901] });
      },
      "/documents/doc-crm-3/invalidate": () => json({ entryId: "entry-crm-3" }),
      "/documents/doc-crm-3": () => json({ status: "POSTED" }),
    });
    const result = await new SaleInvoicesApi(client()).invalidate(8);
    expect(result).toEqual({ code: 200, created_object_id: 901, messages: [] });
  });

  it.each([
    ["getDeliveryOptions", (api: SaleInvoicesApi) => api.getDeliveryOptions(1)],
    ["getSystemPdf", (api: SaleInvoicesApi) => api.getSystemPdf(1)],
    ["getSystemXml", (api: SaleInvoicesApi) => api.getSystemXml(1)],
    ["sendEinvoice", (api: SaleInvoicesApi) => api.sendEinvoice(1, {})],
  ] as const)("%s switches outbound e-invoicing off honestly, with no network call", async (_name, call) => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    await expect(call(new SaleInvoicesApi(client()))).rejects.toThrow(/switched off/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
