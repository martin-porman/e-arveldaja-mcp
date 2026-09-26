import { describe, expect, it, vi, beforeEach } from "vitest";
import { HttpError, HttpClient } from "../http-client.js";
import { JournalsApi } from "./journals.api.js";
import { cache } from "./base-resource.js";

vi.mock("../logger.js", () => ({ log: vi.fn() }));
vi.mock("../progress.js", () => ({ reportProgress: vi.fn().mockResolvedValue(undefined) }));

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function realClient(): HttpClient {
  return new HttpClient({ baseUrl: "http://crm/api/crm-mcp", apiKeyId: "crm-mcp", apiPublicValue: "x", apiPassword: "t".repeat(43) } as never);
}

describe("JournalsApi over the CRM", () => {
  beforeEach(() => cache.invalidate());

  it("creates a MEMO draft with sides and two-decimal amounts", async () => {
    const bodies: unknown[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      if (url.endsWith("/documents")) { bodies.push(JSON.parse(String(init.body))); return jsonResponse({ id: "doc1", created: true }); }
      if (url.endsWith("/id-map")) return jsonResponse({ numericIds: [101] });
      throw new Error(url);
    }));
    const api = new JournalsApi(realClient());
    const r = await api.create({ effective_date: "2026-02-03", title: "Correction", postings: [{ accounts_id: 6000, type: "D", amount: 10 }, { accounts_id: 22, type: "C", amount: 10 }] } as never);
    expect(r.created_object_id).toBe(101);
    expect(bodies[0]).toMatchObject({ kind: "MEMO", description: "Correction", lines: [{ accountCode: "6000", side: "D", net: "10.00" }, { accountCode: "22", side: "C", net: "10.00" }] });
    vi.unstubAllGlobals();
  });

  it("confirm resolves the numeric id through /id-map and POSTs /documents/{crmId}/confirm", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      if (url.endsWith("/id-map")) {
        const body = JSON.parse(String(init.body)) as { kind: string; numericIds?: number[] };
        if (body.kind === "document" && body.numericIds?.[0] === 42) return jsonResponse({ crmIds: ["doc42"] });
        if (body.kind === "entry") return jsonResponse({ numericIds: [900] });
      }
      if (url.endsWith("/documents/doc42/confirm")) return jsonResponse({ entryId: "entry42" });
      throw new Error(url);
    }));
    const api = new JournalsApi(realClient());
    const r = await api.confirm(42);
    expect(r.created_object_id).toBe(900);
    vi.unstubAllGlobals();
  });

  it("a CRM 422 refusal surfaces as HttpError with the reason in upstream_detail", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      if (url.endsWith("/id-map")) {
        const body = JSON.parse(String(init.body)) as { kind: string };
        if (body.kind === "document") return jsonResponse({ crmIds: ["doc43"] });
      }
      if (url.endsWith("/documents/doc43/confirm")) return jsonResponse({ refused: ["period closed"] }, 422);
      throw new Error(url);
    }));
    const api = new JournalsApi(realClient());
    await expect(api.confirm(43)).rejects.toMatchObject({ name: "HttpError", status: 422 });
    try {
      await api.confirm(43);
      throw new Error("expected rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(HttpError);
      expect((error as HttpError).upstream_detail).toContain("period closed");
    }
    vi.unstubAllGlobals();
  });
});

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

describe("JournalsApi.update / delete / invalidate over the CRM (direct client mocks)", () => {
  beforeEach(() => cache.invalidate());

  it("update reads the existing document and PATCHes the full merged draft", async () => {
    const client = mockClient();
    (client.post as ReturnType<typeof vi.fn>).mockImplementation(async (path: string, body: { kind: string }) => {
      if (path === "/id-map" && body.kind === "document") return { crmIds: ["doc55"] };
      throw new Error(`unexpected POST ${path}`);
    });
    (client.get as ReturnType<typeof vi.fn>).mockImplementation(async (path: string) => {
      if (path === "/documents/doc55") {
        return {
          id: "doc55", kind: "MEMO", counterpartyId: null, docDate: "2026-01-01", turnoverDate: "2026-01-01",
          dueDate: null, description: "old title", sourceKey: "manual:abc", creditsDocumentId: null,
          lines: [{ description: "", quantity: null, unitPrice: null, net: "5.00", side: "D", vatCode: null, vatAmount: "0.00", accountCode: "6000", dimensionId: null }],
        };
      }
      throw new Error(`unexpected GET ${path}`);
    });
    const api = new JournalsApi(client);
    await api.update(55, { title: "renamed" } as never);
    expect(client.patch).toHaveBeenCalledWith("/documents/doc55", expect.objectContaining({
      sourceKey: "manual:abc", description: "renamed", kind: "MEMO",
    }));
  });

  it("delete resolves the crm id and DELETEs /documents/{crmId}", async () => {
    const client = mockClient();
    (client.post as ReturnType<typeof vi.fn>).mockImplementation(async (path: string) => {
      if (path === "/id-map") return { crmIds: ["doc66"] };
      throw new Error(`unexpected POST ${path}`);
    });
    (client.delete as ReturnType<typeof vi.fn>).mockResolvedValue({ code: 200, messages: [] });
    const api = new JournalsApi(client);
    await api.delete(66);
    expect(client.delete).toHaveBeenCalledWith("/documents/doc66");
  });

  it("invalidate POSTs a reason and today's Tallinn date", async () => {
    const client = mockClient();
    (client.post as ReturnType<typeof vi.fn>).mockImplementation(async (path: string, body?: { kind?: string }) => {
      if (path === "/id-map" && body?.kind === "document") return { crmIds: ["doc77"] };
      if (path === "/id-map" && body?.kind === "entry") return { numericIds: [777] };
      if (path === "/documents/doc77/invalidate") {
        expect(body).toMatchObject({ reason: "invalidated by the approved plan" });
        expect((body as { entryDate: string }).entryDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        return { entryId: "entry77" };
      }
      throw new Error(`unexpected POST ${path}`);
    });
    const api = new JournalsApi(client);
    await api.invalidate(77);
    expect(client.post).toHaveBeenCalledWith("/documents/doc77/invalidate", expect.any(Object));
  });
});

describe("JournalsApi reads merge posted entries with DRAFT documents", () => {
  beforeEach(() => cache.invalidate());

  it("get() finds a posted journal (from /entries) and a draft (from /documents)", async () => {
    const client = mockClient();
    (client.get as ReturnType<typeof vi.fn>).mockImplementation(async (path: string) => {
      if (path === "/entries") {
        return [{ id: "e1", number: "1", entryDate: "2026-01-05", documentId: "doc200", counterpartyId: null, description: "Posted", postings: [{ accountCode: "6000", side: "D", amount: "10.00" }] }];
      }
      if (path === "/documents") {
        return { items: [{ id: "doc300", kind: "MEMO", status: "DRAFT", number: "n1", counterpartyId: null, docDate: "2026-01-06", turnoverDate: "2026-01-06", dueDate: null, description: "Draft", sourceKey: "manual:d1", creditsDocumentId: null, lines: [{ description: "", quantity: null, unitPrice: null, net: "5.00", side: "C", vatCode: null, vatAmount: "0.00", accountCode: "22", dimensionId: null }] }], page: 1, pages: 1 };
      }
      throw new Error(`unexpected GET ${path}`);
    });
    (client.post as ReturnType<typeof vi.fn>).mockImplementation(async (path: string, body: { kind: string; crmIds?: string[] }) => {
      if (path === "/id-map" && body.kind === "document") return { numericIds: body.crmIds!.map(id => (id === "doc200" ? 200 : 300)) };
      if (path === "/id-map" && body.kind === "account") return { numericIds: [6000, 22] };
      throw new Error(`unexpected POST ${path}`);
    });
    const api = new JournalsApi(client);
    const posted = await api.get(200);
    expect(posted).toMatchObject({ registered: true, title: "Posted" });
    const draft = await api.get(300);
    expect(draft).toMatchObject({ registered: false, title: "Draft" });
  });
});
