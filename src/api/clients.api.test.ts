import { describe, expect, it, vi, beforeEach } from "vitest";
import { ClientsApi } from "./clients.api.js";
import { cache } from "./base-resource.js";
import type { HttpClient } from "../http-client.js";

function makeClient(namespace: string): HttpClient {
  return {
    cacheNamespace: namespace,
    connectionFingerprint: `fp:${namespace}`,
    get: vi.fn(),
    post: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  } as unknown as HttpClient;
}

describe("ClientsApi over the CRM", () => {
  beforeEach(() => cache.invalidate());

  it("findByCode queries GET /counterparties?regCode= and maps the row through the id map", async () => {
    const client = makeClient("connection:findByCode");
    (client.get as ReturnType<typeof vi.fn>).mockImplementation(async (path: string, params?: Record<string, unknown>) => {
      if (path === "/counterparties" && params?.regCode === "12345678") {
        return [{ id: "cp1", name: "Supplier OÜ", regCode: "12345678", vatNo: null, country: "EE", isJuridical: true, isCustomer: false, isSupplier: true, isActive: true, iban: null }];
      }
      throw new Error(`unexpected GET ${path}`);
    });
    (client.post as ReturnType<typeof vi.fn>).mockImplementation(async (path: string, body: { kind: string }) => {
      if (path === "/id-map" && body.kind === "counterparty") return { numericIds: [900000005] };
      throw new Error(`unexpected POST ${path}`);
    });
    const api = new ClientsApi(client);
    const found = await api.findByCode("12345678");
    expect(client.get).toHaveBeenCalledWith("/counterparties", { regCode: "12345678" });
    expect(found).toMatchObject({ id: 900000005, name: "Supplier OÜ", is_supplier: true, code: "12345678" });
  });

  it("findByName queries GET /counterparties?q= and drops inactive rows", async () => {
    const client = makeClient("connection:findByName");
    (client.get as ReturnType<typeof vi.fn>).mockImplementation(async (path: string, params?: Record<string, unknown>) => {
      if (path === "/counterparties" && params?.q === "Supplier") {
        return [
          { id: "cp2", name: "Supplier OÜ", regCode: null, vatNo: null, country: "EE", isJuridical: true, isCustomer: false, isSupplier: true, isActive: true, iban: null },
          { id: "cp3", name: "Old Supplier OÜ", regCode: null, vatNo: null, country: "EE", isJuridical: true, isCustomer: false, isSupplier: true, isActive: false, iban: null },
        ];
      }
      throw new Error(`unexpected GET ${path}`);
    });
    (client.post as ReturnType<typeof vi.fn>).mockImplementation(async (path: string, body: { kind: string; crmIds: string[] }) => {
      if (path === "/id-map" && body.kind === "counterparty") return { numericIds: body.crmIds.map((_, i) => 900000010 + i) };
      throw new Error(`unexpected POST ${path}`);
    });
    const api = new ClientsApi(client);
    const found = await api.findByName("Supplier");
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ name: "Supplier OÜ", is_deleted: false });
  });

  it("create POSTs /counterparties and returns an ApiResponse carrying the mapped numeric id", async () => {
    const client = makeClient("connection:create");
    (client.post as ReturnType<typeof vi.fn>).mockImplementation(async (path: string, body: { kind?: string }) => {
      if (path === "/counterparties") return { id: "cp4", created: true };
      if (path === "/id-map" && body.kind === "counterparty") return { numericIds: [900000006] };
      throw new Error(`unexpected POST ${path}`);
    });
    const api = new ClientsApi(client);
    const result = await api.create({ name: "New Client OÜ", cl_code_country: "EST", is_supplier: true });
    expect(client.post).toHaveBeenCalledWith("/counterparties", {
      name: "New Client OÜ", regCode: null, vatNo: null, country: "EE", isJuridical: false, isCustomer: false, isSupplier: true, iban: null,
    });
    expect(result).toEqual({ code: 200, created_object_id: 900000006, messages: [] });
  });

  it("update PATCHes /counterparties/:id with only the RIK-to-CRM patch fields", async () => {
    const client = makeClient("connection:update");
    (client.post as ReturnType<typeof vi.fn>).mockImplementation(async (path: string, body: { numericIds?: number[] }) => {
      if (path === "/id-map" && body.numericIds) return { crmIds: ["cp5"] };
      throw new Error(`unexpected POST ${path}`);
    });
    (client.patch as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "cp5", created: false });
    const api = new ClientsApi(client);
    const result = await api.update(900000007, { name: "Renamed OÜ", is_deleted: true });
    expect(client.patch).toHaveBeenCalledWith("/counterparties/cp5", { name: "Renamed OÜ", isActive: false });
    expect(result).toEqual({ code: 200, messages: [] });
  });

  it("delete refuses with an approval-only 501 — deletion goes through an approval card, not an API call", async () => {
    const api = new ClientsApi(makeClient("connection:delete"));
    await expect(api.delete(1)).rejects.toThrow(/approval-only: deleting a counterparty goes through an approval card/);
  });

  it("deactivate PATCHes /counterparties/:id with isActive:false", async () => {
    const client = makeClient("connection:deactivate");
    (client.post as ReturnType<typeof vi.fn>).mockImplementation(async (path: string, body: { numericIds?: number[] }) => {
      if (path === "/id-map" && body.numericIds) return { crmIds: ["cp6"] };
      throw new Error(`unexpected POST ${path}`);
    });
    (client.patch as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "cp6", created: false });
    const api = new ClientsApi(client);
    const result = await api.deactivate(900000008);
    expect(client.patch).toHaveBeenCalledWith("/counterparties/cp6", { isActive: false });
    expect(result).toEqual({ code: 200, messages: [] });
  });

  it("restore PATCHes /counterparties/:id with isActive:true", async () => {
    const client = makeClient("connection:restore");
    (client.post as ReturnType<typeof vi.fn>).mockImplementation(async (path: string, body: { numericIds?: number[] }) => {
      if (path === "/id-map" && body.numericIds) return { crmIds: ["cp7"] };
      throw new Error(`unexpected POST ${path}`);
    });
    (client.patch as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "cp7", created: false });
    const api = new ClientsApi(client);
    const result = await api.restore(900000009);
    expect(client.patch).toHaveBeenCalledWith("/counterparties/cp7", { isActive: true });
    expect(result).toEqual({ code: 200, messages: [] });
  });
});
