import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpClient, HttpError } from "./http-client.js";

const config = { baseUrl: "http://crm/api/crm-mcp", apiKeyId: "crm-mcp", apiPublicValue: "abcd", apiPassword: "t".repeat(43) };
afterEach(() => { vi.unstubAllGlobals(); delete process.env.CRM_STEP_TOKEN; });

describe("the CRM transport", () => {
  it("sends the service token, and the step token only when a phase set one", async () => {
    const seen: Headers[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_u: string, init: RequestInit) => { seen.push(new Headers(init.headers)); return new Response("[]", { status: 200 }); }));
    const c = new HttpClient(config);
    await c.get("/accounts");
    process.env.CRM_STEP_TOKEN = "step";
    await c.post("/documents", { a: 1 });
    expect(seen[0]!.get("authorization")).toBe(`Bearer ${"t".repeat(43)}`);
    expect(seen[0]!.has("x-crm-step-token")).toBe(false);
    expect(seen[1]!.get("x-crm-step-token")).toBe("step");
  });
  it("turns a CRM refusal into an HttpError carrying the CRM's reason as untrusted detail", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "not in the approved manifest" }), { status: 403 })));
    const err = await new HttpClient(config).post("/documents", {}).catch((e) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect(err.status).toBe(403);
    expect(err.upstream_detail).toContain("not in the approved manifest");
  });
});
