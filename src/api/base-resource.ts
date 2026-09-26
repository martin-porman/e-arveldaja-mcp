import { HttpError, type HttpClient } from "../http-client.js";
import type { ApiFile, ApiResponse, PaginatedResponse } from "../types/api.js";
import { Cache } from "../cache.js";
import { log } from "../logger.js";
import { reportProgress } from "../progress.js";
import type { AuditEntityType } from "../audit-log.js";
import { IdMap } from "../crm/id-map.js";
import {
  isMutationIndeterminate,
  MutationIndeterminateError,
  type MutationOperation,
} from "../mutation-outcome.js";

export const cache = new Cache(300);

/** A CRM `Document` row (crm/src/lib/crm-mcp/reads.ts `documentRow`), shared by every
 * document-backed `BaseResource<T>` subclass (spec R4a Task 25). */
export type CrmDocumentLine = {
  description: string;
  quantity: string | null;
  unitPrice: string | null;
  net: string;
  side: "D" | "C" | null;
  vatCode: string | null;
  vatAmount: string;
  accountCode: string;
  dimensionId: string | null;
};

export type CrmDocument = {
  id: string;
  kind: string;
  status: "DRAFT" | "POSTED" | "REVERSED";
  number: string;
  counterpartyId: string | null;
  docDate: string;
  turnoverDate: string;
  dueDate: string | null;
  description: string;
  sourceKey: string | null;
  creditsDocumentId: string | null;
  lines: CrmDocumentLine[];
};

/** Opt-in for a `BaseResource<T>` whose records are CRM `Document` rows of one or more
 * `kind`s (spec R4a Task 25). Unset, every method below is the original RIK-shaped
 * `${basePath}` behaviour — this is a per-resource routing parameter, not a backend
 * toggle: `PurchaseInvoicesApi` deliberately does not opt in (its `get`/`update` stay
 * on `/purchase_invoices` for `previewTotalsCorrection`, which stays adapter-internal). */
export interface DocumentBackedOptions {
  readonly kinds: readonly string[];
}

const MUTATION_ENTITY_BY_PATH = {
  "/clients": "client",
  "/products": "product",
  "/journals": "journal",
  "/transactions": "transaction",
  "/sale_invoices": "sale_invoice",
  "/purchase_invoices": "purchase_invoice",
} as const satisfies Record<string, AuditEntityType>;
const KNOWN_MUTATION_CACHE_PREFIXES = new Set<string>(
  Object.keys(MUTATION_ENTITY_BY_PATH),
);

function safelyIsMutationIndeterminate(error: unknown): boolean {
  try {
    return isMutationIndeterminate(error);
  } catch {
    return false;
  }
}

export interface ListParams {
  page?: number;
  modified_since?: string;
  // Server-side filters supported by some list endpoints (see the OpenAPI spec).
  // Not every endpoint honours every field: e.g. /journals supports only the
  // date range, while /purchase_invoices, /sale_invoices and /transactions also
  // support status / clients_id (and transactions additionally `type`). Unknown
  // query params are ignored by the API, but callers should pass only the fields
  // the target endpoint documents. start_date/end_date are inclusive bounds whose
  // meaning is per-endpoint (invoice/turnover/effective/transaction date).
  start_date?: string;
  end_date?: string;
  status?: string;
  payment_status?: string;
  clients_id?: number;
  type?: string;
}

class PaginationMetadataError extends Error {
  constructor(requestedPage: number, detail: string) {
    super(`Pagination page ${String(requestedPage)}: ${detail}`);
  }
}

function describeMetadataValue(value: unknown): string {
  if (typeof value === "number" || value === undefined) return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function validateRequestedPage(requestedPage: number): void {
  if (!Number.isInteger(requestedPage) || requestedPage < 1) {
    throw new PaginationMetadataError(
      requestedPage,
      `requested page must be a positive integer; received ${describeMetadataValue(requestedPage)}`,
    );
  }
}

function validatePage<T>(response: unknown, requestedPage: number): PaginatedResponse<T> {
  validateRequestedPage(requestedPage);
  if (response === null || typeof response !== "object" || Array.isArray(response)) {
    throw new PaginationMetadataError(
      requestedPage,
      `response must be a non-null object; received ${describeMetadataValue(response)}`,
    );
  }

  const page = response as Partial<PaginatedResponse<T>>;
  if (!Array.isArray(page.items)) {
    throw new PaginationMetadataError(
      requestedPage,
      `items must be an array; received ${describeMetadataValue(page.items)}`,
    );
  }
  if (page.current_page !== requestedPage) {
    throw new PaginationMetadataError(
      requestedPage,
      `current_page must equal requested page ${requestedPage}; received ${describeMetadataValue(page.current_page)}`,
    );
  }
  if (
    !Number.isInteger(page.total_pages) ||
    (page.total_pages as number) < requestedPage
  ) {
    throw new PaginationMetadataError(
      requestedPage,
      `total_pages must be a positive integer at least ${requestedPage}; received ${describeMetadataValue(page.total_pages)}`,
    );
  }
  return page as PaginatedResponse<T>;
}

export class BaseResource<T> {
  protected readonly documentIdMap?: IdMap;

  constructor(
    protected client: HttpClient,
    protected basePath: string,
    protected readonly documents?: DocumentBackedOptions,
  ) {
    if (documents) this.documentIdMap = new IdMap(client);
  }

  /** Maps a CRM document row (plus its id-mapped numeric id and counterparty id) onto
   * `T`. Required when `documents` is set; the base throws so a missing override fails
   * loudly instead of silently returning garbage. */
  protected fromDocument(_doc: CrmDocument, _id: number, _clientsId: number | null): T {
    throw new Error(`${this.basePath}: fromDocument must be overridden by a document-backed resource`);
  }

  get connectionFingerprint(): string {
    return this.client.connectionFingerprint;
  }

  protected cacheKey(key: string): string {
    return `${this.client.cacheNamespace}:${key}`;
  }

  protected invalidateCache(pattern = this.basePath): void {
    cache.invalidate(this.cacheKey(pattern));
  }

  protected async mutate<R>(
    operation: MutationOperation,
    entityId: number | undefined,
    businessKey: string,
    affectedPatterns: readonly string[],
    request: () => Promise<R>,
  ): Promise<R> {
    try {
      const result = await request();
      for (const pattern of new Set(affectedPatterns)) {
        this.invalidateCache(pattern);
      }
      return result;
    } catch (error) {
      if (safelyIsMutationIndeterminate(error)) {
        const invalidatedPatterns = new Set<string>();
        for (const pattern of affectedPatterns) {
          if (invalidatedPatterns.has(pattern)) continue;
          this.invalidateCache(pattern);
          invalidatedPatterns.add(pattern);
        }

        try {
          const declaredPatterns = (error as { affectedCaches?: unknown }).affectedCaches;
          if (Array.isArray(declaredPatterns)) {
            for (const pattern of declaredPatterns) {
              if (
                typeof pattern !== "string" ||
                !KNOWN_MUTATION_CACHE_PREFIXES.has(pattern) ||
                invalidatedPatterns.has(pattern)
              ) {
                continue;
              }
              this.invalidateCache(pattern);
              invalidatedPatterns.add(pattern);
            }
          }
        } catch {
          throw error;
        }
        throw error;
      }

      if (error instanceof HttpError && error.status === "network") {
        for (const pattern of new Set(affectedPatterns)) {
          this.invalidateCache(pattern);
        }
        const entity = MUTATION_ENTITY_BY_PATH[
          this.basePath as keyof typeof MUTATION_ENTITY_BY_PATH
        ];
        if (!entity) throw error;
        throw new MutationIndeterminateError({
          operation,
          entity,
          entityId,
          businessKey,
          affectedCaches: [...affectedPatterns],
          cause: error,
          nextAction: `Re-read ${entity} state for business key "${businessKey}" before deciding whether to retry; do not repeat the mutation blindly.`,
        });
      }

      throw error;
    }
  }

  async list(params?: ListParams): Promise<PaginatedResponse<T>> {
    if (this.documents) return this.listDocumentBacked(params);
    const requestedPage = params?.page ?? 1;
    validateRequestedPage(requestedPage);
    const sortedParams = params ? Object.keys(params).sort().map(k => `${k}=${(params as Record<string, unknown>)[k]}`).join("&") : "";
    const cacheKey = this.cacheKey(`${this.basePath}:list:${sortedParams}`);
    const cached = cache.get<PaginatedResponse<T>>(cacheKey);
    if (cached !== undefined) {
      try {
        return validatePage<T>(cached, requestedPage);
      } catch (error) {
        if (error instanceof PaginationMetadataError) {
          cache.invalidateExact(cacheKey);
        }
        throw error;
      }
    }

    const gen = cache.generation;
    const result = await this.client.get<PaginatedResponse<T>>(this.basePath, params as Record<string, string | number>);
    try {
      const validated = validatePage<T>(result, requestedPage);
      cache.setIfSameGeneration(cacheKey, validated, gen, 120);
      return validated;
    } catch (error) {
      if (error instanceof PaginationMetadataError) {
        cache.invalidateExact(cacheKey);
      }
      throw error;
    }
  }

  private static readonly DOCUMENT_LIST_PAGE_SIZE = 100;

  /**
   * `list()` for a document-backed resource (`documents` set): every `kind` is walked
   * separately — the CRM's `GET /documents` `kind` filter takes one value (spec R4a
   * Task 25) — then paginated client-side with this resource's own page size, the same
   * simplification `TransactionsApi.list` already makes (transactions.api.ts:156-162).
   * Status/date filters are not forwarded; callers filter the returned page themselves.
   */
  private async listDocumentBacked(params?: ListParams): Promise<PaginatedResponse<T>> {
    const requestedPage = params?.page ?? 1;
    validateRequestedPage(requestedPage);
    const all = await this.loadAllDocumentBacked();
    const total_pages = Math.max(1, Math.ceil(all.length / BaseResource.DOCUMENT_LIST_PAGE_SIZE));
    const items = all.slice(
      (requestedPage - 1) * BaseResource.DOCUMENT_LIST_PAGE_SIZE,
      requestedPage * BaseResource.DOCUMENT_LIST_PAGE_SIZE,
    );
    return { current_page: requestedPage, total_pages, items };
  }

  private async loadAllDocumentBacked(): Promise<T[]> {
    const cacheKey = this.cacheKey(`${this.basePath}:documents:all`);
    const cached = cache.get<T[]>(cacheKey);
    if (cached !== undefined) return cached;
    const gen = cache.generation;

    const rows: CrmDocument[] = [];
    for (const kind of this.documents!.kinds) {
      for (let page = 1; ; page++) {
        const resp = await this.client.get<{ items: CrmDocument[]; page: number; pages: number }>(
          "/documents", { kind, page },
        );
        rows.push(...resp.items);
        if (page >= resp.pages) break;
      }
    }

    const counterpartyCrmIds = rows.map(r => r.counterpartyId).filter((x): x is string => !!x);
    const counterpartyNumericIds = await this.documentIdMap!.toNumeric("counterparty", counterpartyCrmIds);
    const clientsIdByCrm = new Map<string, number>();
    counterpartyCrmIds.forEach((cid, i) => clientsIdByCrm.set(cid, counterpartyNumericIds[i]!));

    const docIds = await this.documentIdMap!.toNumeric("document", rows.map(r => r.id));
    const items = rows.map((row, i) =>
      this.fromDocument(row, docIds[i]!, row.counterpartyId ? clientsIdByCrm.get(row.counterpartyId)! : null),
    );

    cache.setIfSameGeneration(cacheKey, items, gen, 60);
    return items;
  }

  private async getDocumentBacked(id: number): Promise<T> {
    const crmId = (await this.documentIdMap!.toCrm("document", [id]))[0]!;
    const doc = await this.client.get<CrmDocument>(`/documents/${crmId}`);
    const clientsId = doc.counterpartyId
      ? (await this.documentIdMap!.toNumeric("counterparty", [doc.counterpartyId]))[0]!
      : null;
    return this.fromDocument(doc, id, clientsId);
  }

  /**
   * Cached aggregate `listAll()` — reads from memory for up to `ttlSeconds`
   * before walking pages again. Use this from tools that do client-side
   * filtering / pagination to avoid re-walking the whole dataset on every
   * filtered call.
   *
   * **Cache key is keyed only on `basePath` — it does NOT vary with filter
   * params.** Do not use this for filtered queries; pass the full list through
   * your own filter layer.
   *
   * **Invalidation**: the key (`${basePath}:listAll`) starts with `basePath`,
   * so `invalidateCache()` (which does a prefix-delete on `basePath`) clears
   * it together with the per-page cache on any mutation, and a connection
   * switch clears everything via `cache.invalidate()` with no pattern. Any
   * cross-namespace mutation (e.g. `TransactionsApi.confirm` creating a
   * journal) must call `this.invalidateCache("/journals")` explicitly.
   */
  async listAllCached(ttlSeconds = 60): Promise<T[]> {
    const cacheKey = this.cacheKey(`${this.basePath}:listAll`);
    const cached = cache.get<T[]>(cacheKey);
    if (cached) return cached;
    const gen = cache.generation;
    const result = await this.listAll();
    cache.setIfSameGeneration(cacheKey, result, gen, ttlSeconds);
    return result;
  }

  async listAll(params?: Omit<ListParams, "page">, maxPages = 200, maxItems = 50_000): Promise<T[]> {
    const allItems: T[] = [];
    let page = 1;
    let totalPages = 1;
    let pinnedTotalPages: number | undefined;
    const deadline = Date.now() + 300_000; // 5 minute overall timeout

    try {
      do {
        if (Date.now() > deadline) {
          throw new Error(
            `${this.basePath}: pagination timed out after 5 minutes (${allItems.length} items loaded from ${page - 1} pages). ` +
            `Use date filters to narrow the query.`
          );
        }
        if (page > maxPages) {
          throw new Error(
            `Data exceeds ${maxPages} pages (${allItems.length} items loaded). ` +
            `Use date filters to narrow the query.`
          );
        }
        const response = await this.list({ ...params, page });
        if (pinnedTotalPages === undefined) {
          pinnedTotalPages = response.total_pages;
        } else if (response.total_pages !== pinnedTotalPages) {
          throw new PaginationMetadataError(
            page,
            `total_pages changed from ${pinnedTotalPages} to ${describeMetadataValue(response.total_pages)}`,
          );
        }
        allItems.push(...response.items);
        if (allItems.length > maxItems) {
          throw new Error(
            `${this.basePath}: item count (${allItems.length}) exceeds limit of ${maxItems}. ` +
            `Use date filters to narrow the query.`
          );
        }
        totalPages = response.total_pages;
        if (totalPages > 1 && page === 1) {
          log("info", `${this.basePath}: fetching ${totalPages} pages...`);
        }
        if (totalPages > 1) {
          await reportProgress(page - 1, totalPages);
        }
        page++;
      } while (page <= totalPages);
    } catch (error) {
      if (error instanceof PaginationMetadataError) {
        this.invalidateCache();
      }
      throw error;
    }

    return allItems;
  }

  async get(id: number): Promise<T> {
    const cacheKey = this.cacheKey(`${this.basePath}:${id}`);
    const cached = cache.get<T>(cacheKey);
    if (cached) return cached;

    const gen = cache.generation;
    const result = this.documents ? await this.getDocumentBacked(id) : await this.client.get<T>(`${this.basePath}/${id}`);
    cache.setIfSameGeneration(cacheKey, result, gen, 120);
    return result;
  }

  async create(data: Partial<T>): Promise<ApiResponse> {
    return this.mutate(
      "create",
      undefined,
      `${this.basePath}:create`,
      [this.basePath],
      () => this.client.post<ApiResponse>(this.basePath, data),
    );
  }

  async update(id: number, data: Partial<T>): Promise<ApiResponse> {
    return this.mutate(
      "update",
      id,
      `${this.basePath}:${id}`,
      [this.basePath],
      () => this.client.patch<ApiResponse>(`${this.basePath}/${id}`, data),
    );
  }

  async delete(id: number): Promise<ApiResponse> {
    if (this.documents) {
      const crmId = (await this.documentIdMap!.toCrm("document", [id]))[0]!;
      await this.mutate(
        "delete", id, `${this.basePath}:${id}`, [this.basePath],
        () => this.client.delete(`/documents/${crmId}`),
      );
      return { code: 200, messages: [] };
    }
    return this.mutate(
      "delete",
      id,
      `${this.basePath}:${id}`,
      [this.basePath],
      () => this.client.delete<ApiResponse>(`${this.basePath}/${id}`),
    );
  }

  // === User-uploaded source document (document_user) ===
  // Supported by purchase_invoices, sale_invoices, journals, and transactions
  // (PUT to upload/replace, GET to read back, DELETE to remove). Calling these
  // on a resource whose API has no /{id}/document_user endpoint returns a 404 —
  // only the document-capable resources are wired to tools.
  //
  // Finding (R4a Task 25): for a document-backed resource, the CRM's only file route
  // is `POST /documents/:id/file` (crm/src/lib/crm-mcp/writes-documents.ts:267-298),
  // which records `{ fileRef, fileSha256 }` on a document that already has the bytes
  // on disk under CRM_MCP_ATTACHMENTS — there is no GET/DELETE for the file content at
  // all, and no route this fork can call to learn the `path` up front (that lookup is
  // Task 30's CRM-extraction-record mapping). All three methods below refuse honestly.

  async getDocument(id: number): Promise<ApiFile> {
    if (this.documents) {
      throw new HttpError(
        `${this.basePath}/${id}: the CRM has no route to read a document's stored file content back (writes-documents.ts:267-298 only records fileRef/fileSha256; there is no matching GET)`,
        501, "GET", `${this.basePath}/${id}/document_user`,
      );
    }
    return this.client.get<ApiFile>(`${this.basePath}/${id}/document_user`);
  }

  async uploadDocument(id: number, name: string, contents: string): Promise<ApiResponse> {
    if (this.documents) {
      throw new HttpError(
        `${this.basePath}/${id}: POST /documents/:id/file needs a { path, sha256 } inside CRM_MCP_ATTACHMENTS (writes-documents.ts:255-283) — the fork has no source for that path until Task 30 wires the CRM extraction record`,
        501, "PUT", `${this.basePath}/${id}/document_user`,
      );
    }
    return this.mutate(
      "upload",
      id,
      `${this.basePath}:${id}:document_user`,
      [this.basePath],
      () => this.client.request<ApiResponse>(`${this.basePath}/${id}/document_user`, {
        method: "PUT",
        body: { name, contents },
      }),
    );
  }

  async deleteDocument(id: number): Promise<ApiResponse> {
    if (this.documents) {
      throw new HttpError(
        `${this.basePath}/${id}: the CRM has no route to delete a document's attached file`,
        501, "DELETE", `${this.basePath}/${id}/document_user`,
      );
    }
    return this.mutate(
      "delete",
      id,
      `${this.basePath}:${id}:document_user`,
      [this.basePath],
      () => this.client.delete<ApiResponse>(`${this.basePath}/${id}/document_user`),
    );
  }

  // restore/reactivate is only supported by clients and products — implemented in those subclasses
}
