import { HttpError, type HttpClient } from "../http-client.js";
import type { Client, ApiResponse, PaginatedResponse } from "../types/api.js";
import { BaseResource, cache, type ListParams } from "./base-resource.js";
import { IdMap } from "../crm/id-map.js";
import { fromRikClient, toRikClient, type CrmCounterparty } from "../crm/mappers.js";

const LIST_PAGE_SIZE = 100;

/**
 * RIK's `ClientsApi` over the CRM's counterparties (Tasks 17/18, spec §2.3).
 * `basePath` ("/clients") stays only as the cache-key prefix that
 * `invalidateCache()` / `MUTATION_ENTITY_BY_PATH` in `base-resource.ts` key
 * on; every HTTP call below goes to `/counterparties`.
 */
export class ClientsApi extends BaseResource<Client> {
  private readonly idMap: IdMap;

  constructor(client: HttpClient) {
    super(client, "/clients");
    this.idMap = new IdMap(client);
  }

  private async allClients(): Promise<Client[]> {
    const cacheKey = this.cacheKey(`${this.basePath}:all`);
    const cached = cache.get<Client[]>(cacheKey);
    if (cached !== undefined) return cached;
    const gen = cache.generation;
    const rows = await this.client.get<CrmCounterparty[]>("/counterparties");
    const ids = await this.idMap.toNumeric("counterparty", rows.map(r => r.id));
    const clients = rows.map((r, i) => toRikClient(r, ids[i]!));
    cache.setIfSameGeneration(cacheKey, clients, gen, 60);
    return clients;
  }

  async list(params?: ListParams): Promise<PaginatedResponse<Client>> {
    const requestedPage = params?.page ?? 1;
    const all = await this.allClients();
    const totalPages = Math.max(1, Math.ceil(all.length / LIST_PAGE_SIZE));
    const items = all.slice((requestedPage - 1) * LIST_PAGE_SIZE, requestedPage * LIST_PAGE_SIZE);
    return { current_page: requestedPage, total_pages: totalPages, items };
  }

  async get(id: number): Promise<Client> {
    const crmId = (await this.idMap.toCrm("counterparty", [id]))[0]!;
    const row = await this.client.get<CrmCounterparty>(`/counterparties/${crmId}`);
    return toRikClient(row, id);
  }

  async create(data: Partial<Client>): Promise<ApiResponse> {
    const body = fromRikClient(data);
    const result = await this.mutate<{ id: string; created: boolean }>(
      "create", undefined, `${this.basePath}:create`, [this.basePath],
      () => this.client.post<{ id: string; created: boolean }>("/counterparties", body),
    );
    const createdObjectId = (await this.idMap.toNumeric("counterparty", [result.id]))[0]!;
    return { code: 200, created_object_id: createdObjectId, messages: [] };
  }

  async update(id: number, data: Partial<Client>): Promise<ApiResponse> {
    const crmId = (await this.idMap.toCrm("counterparty", [id]))[0]!;
    const body = counterpartyPatchBody(data);
    await this.mutate<{ id: string; created: boolean }>(
      "update", id, `${this.basePath}:${id}`, [this.basePath],
      () => this.client.patch<{ id: string; created: boolean }>(`/counterparties/${crmId}`, body),
    );
    return { code: 200, messages: [] };
  }

  async delete(id: number): Promise<ApiResponse> {
    throw new HttpError(
      "approval-only: deleting a counterparty goes through an approval card",
      501, "DELETE", `/clients/${id}`,
    );
  }

  async deactivate(id: number): Promise<ApiResponse> {
    const crmId = (await this.idMap.toCrm("counterparty", [id]))[0]!;
    await this.mutate<{ id: string; created: boolean }>(
      "update", id, `${this.basePath}:${id}:deactivate`, [this.basePath],
      () => this.client.patch<{ id: string; created: boolean }>(`/counterparties/${crmId}`, { isActive: false }),
    );
    return { code: 200, messages: [] };
  }

  async restore(id: number): Promise<ApiResponse> {
    const crmId = (await this.idMap.toCrm("counterparty", [id]))[0]!;
    await this.mutate<{ id: string; created: boolean }>(
      "update", id, `${this.basePath}:${id}:restore`, [this.basePath],
      () => this.client.patch<{ id: string; created: boolean }>(`/counterparties/${crmId}`, { isActive: true }),
    );
    return { code: 200, messages: [] };
  }

  // 120s TTL: supplier/customer lookups happen in tight loops during receipt
  // and reconciliation workflows; the default 60s would churn the aggregate
  // too often on a typical batch pass. Queried directly against the CRM
  // rather than filtered client-side out of the full aggregate.
  async findByName(name: string): Promise<Client[]> {
    const cacheKey = this.cacheKey(`${this.basePath}:findByName:${name.toLowerCase()}`);
    const cached = cache.get<Client[]>(cacheKey);
    if (cached !== undefined) return cached;
    const gen = cache.generation;
    const rows = (await this.client.get<CrmCounterparty[]>("/counterparties", { q: name })).filter(r => r.isActive);
    const ids = await this.idMap.toNumeric("counterparty", rows.map(r => r.id));
    const clients = rows.map((r, i) => toRikClient(r, ids[i]!));
    cache.setIfSameGeneration(cacheKey, clients, gen, 120);
    return clients;
  }

  async findByCode(code: string): Promise<Client | undefined> {
    const cacheKey = this.cacheKey(`${this.basePath}:findByCode:${code}`);
    const cached = cache.get<Client | undefined>(cacheKey);
    if (cached !== undefined) return cached;
    const gen = cache.generation;
    const rows = (await this.client.get<CrmCounterparty[]>("/counterparties", { regCode: code })).filter(r => r.isActive);
    let found: Client | undefined;
    if (rows.length > 0) {
      const ids = await this.idMap.toNumeric("counterparty", rows.map(r => r.id));
      found = toRikClient(rows[0]!, ids[0]!);
    }
    cache.setIfSameGeneration(cacheKey, found, gen, 120);
    return found;
  }
}

function counterpartyPatchBody(data: Partial<Client>): { name?: string; vatNo?: string | null; iban?: string | null; isActive?: boolean } {
  const body: { name?: string; vatNo?: string | null; iban?: string | null; isActive?: boolean } = {};
  if (data.name !== undefined) body.name = data.name;
  if (data.invoice_vat_no !== undefined) body.vatNo = data.invoice_vat_no;
  if (data.bank_account_no !== undefined) body.iban = data.bank_account_no;
  if (data.is_deleted !== undefined) body.isActive = !data.is_deleted;
  return body;
}
