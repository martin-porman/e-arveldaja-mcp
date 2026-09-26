import { randomUUID } from "node:crypto";
import { HttpError, type HttpClient } from "../http-client.js";
import type { Journal, Posting, ApiResponse, PaginatedResponse } from "../types/api.js";
import type { CreateJournalRequest, UpdateJournalRequest } from "../types/mutations.js";
import { BaseResource, cache, type ListParams } from "./base-resource.js";
import { IdMap } from "../crm/id-map.js";

const LIST_PAGE_SIZE = 100;
const SOURCE_KEY_RE = /^(mail|file|bankline|manual):.+$/;

type CrmDocumentLine = {
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

type CrmDocument = {
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

type CrmEntry = {
  id: string;
  number: string;
  entryDate: string;
  documentId: string;
  counterpartyId: string | null;
  description: string;
  postings: { accountCode: string; side: "D" | "C"; amount: string }[];
};

type DraftInput = Omit<CrmDocument, "id" | "status">;

/** Refuses an amount the CRM cannot store exactly (money is a two-decimal string). */
function moneyString(amount: number): string {
  if (Math.abs(amount * 100 - Math.round(amount * 100)) > 1e-6) {
    throw new Error(`${amount}: more than two decimals: the CRM does not round money`);
  }
  return (Math.round(amount * 100) / 100).toFixed(2);
}

function todayTallinn(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Europe/Tallinn" });
}

/**
 * RIK's `JournalsApi` over the CRM's documents/entries (Task 24, spec §2.3).
 * `basePath` ("/journals") stays only as the cache-key prefix and the
 * document_user path base (inherited from BaseResource, unchanged); every
 * mutating call below goes to `/documents`. Reads combine `GET /entries`
 * (posted — always fully populated, unlike RIK's list endpoint) with
 * `GET /documents?kind=MEMO&status=DRAFT` (drafts).
 */
export class JournalsApi extends BaseResource<Journal> {
  private readonly idMap: IdMap;

  constructor(client: HttpClient) {
    super(client, "/journals");
    this.idMap = new IdMap(client);
  }

  private async linesFromPostings(postings: Posting[]): Promise<CrmDocumentLine[]> {
    const codes = await this.idMap.toCrm("account", postings.map(p => p.accounts_id));
    return postings.map((p, i) => ({
      description: "",
      quantity: null,
      unitPrice: null,
      net: moneyString(p.amount),
      side: (p.type ?? "D") as "D" | "C",
      vatCode: null,
      vatAmount: "0.00",
      accountCode: codes[i]!,
      // Finding: a RIK posting's `accounts_dimensions_id` is a bank account
      // (kind "bank_account", readonly.api.ts:86) — not the CRM's Dimension
      // model that a document line's `dimensionId` refers to. There is no
      // mapping between them, so a caller-set dimension on a MEMO posting is
      // dropped rather than guessed.
      dimensionId: null,
    }));
  }

  private sourceKeyAndNumber(documentNumber: string | null | undefined): { sourceKey: string; number: string } {
    if (documentNumber && SOURCE_KEY_RE.test(documentNumber)) {
      return { sourceKey: documentNumber, number: documentNumber };
    }
    const sourceKey = `manual:${randomUUID()}`;
    return { sourceKey, number: documentNumber ?? sourceKey };
  }

  // --- reads -----------------------------------------------------------

  private async loadAll(range?: { start_date?: string; end_date?: string }): Promise<Journal[]> {
    const cacheKey = this.cacheKey(`${this.basePath}:all:${range?.start_date ?? ""}:${range?.end_date ?? ""}`);
    const cached = cache.get<Journal[]>(cacheKey);
    if (cached !== undefined) return cached;
    const gen = cache.generation;

    const entries = await this.client.get<CrmEntry[]>("/entries", { from: range?.start_date, to: range?.end_date });

    const drafts: CrmDocument[] = [];
    for (let page = 1; ; page++) {
      const resp = await this.client.get<{ items: CrmDocument[]; page: number; pages: number }>(
        "/documents", { kind: "MEMO", status: "DRAFT", page },
      );
      drafts.push(...resp.items);
      if (page >= resp.pages) break;
    }
    const inRange = (day: string): boolean =>
      (!range?.start_date || day >= range.start_date) && (!range?.end_date || day <= range.end_date);
    const filteredDrafts = drafts.filter(d => inRange(d.turnoverDate));

    const entryDocIds = await this.idMap.toNumeric("document", entries.map(e => e.documentId));
    const draftDocIds = await this.idMap.toNumeric("document", filteredDrafts.map(d => d.id));

    const accountCodes = [
      ...entries.flatMap(e => e.postings.map(p => p.accountCode)),
      ...filteredDrafts.flatMap(d => d.lines.map(l => l.accountCode)),
    ];
    const accountIds = await this.idMap.toNumeric("account", accountCodes);
    const accountIdByCode = new Map<string, number>();
    accountCodes.forEach((code, i) => accountIdByCode.set(code, accountIds[i]!));

    const counterpartyCrmIds = [
      ...entries.map(e => e.counterpartyId), ...filteredDrafts.map(d => d.counterpartyId),
    ].filter((x): x is string => !!x);
    const counterpartyNumericIds = await this.idMap.toNumeric("counterparty", counterpartyCrmIds);
    const clientIdByCrm = new Map<string, number>();
    counterpartyCrmIds.forEach((cid, i) => clientIdByCrm.set(cid, counterpartyNumericIds[i]!));

    const posted: Journal[] = entries.map((e, i) => ({
      id: entryDocIds[i]!,
      clients_id: e.counterpartyId ? clientIdByCrm.get(e.counterpartyId)! : null,
      title: e.description,
      effective_date: e.entryDate,
      // Every `/entries` row is, by definition, posted. A REVERSED document's
      // original and reversing entries both appear here and both net to zero
      // in any postings sum — this mirrors a real double-entry reversal and
      // needs no extra de-duplication.
      registered: true,
      document_number: e.number,
      cl_currencies_id: "EUR",
      postings: e.postings.map(p => ({ accounts_id: accountIdByCode.get(p.accountCode)!, type: p.side, amount: Number(p.amount) })),
    }));

    const draftJournals: Journal[] = filteredDrafts.map((d, i) => ({
      id: draftDocIds[i]!,
      clients_id: d.counterpartyId ? clientIdByCrm.get(d.counterpartyId)! : null,
      title: d.description,
      effective_date: d.turnoverDate,
      registered: d.status === "POSTED",
      document_number: d.sourceKey,
      cl_currencies_id: "EUR",
      postings: d.lines.map(l => ({ accounts_id: accountIdByCode.get(l.accountCode)!, type: l.side ?? "D", amount: Number(l.net) })),
    }));

    const all = [...posted, ...draftJournals];
    cache.setIfSameGeneration(cacheKey, all, gen, 60);
    return all;
  }

  override async list(params?: ListParams): Promise<PaginatedResponse<Journal>> {
    const requestedPage = params?.page ?? 1;
    const all = await this.loadAll({ start_date: params?.start_date, end_date: params?.end_date });
    const total_pages = Math.max(1, Math.ceil(all.length / LIST_PAGE_SIZE));
    const items = all.slice((requestedPage - 1) * LIST_PAGE_SIZE, requestedPage * LIST_PAGE_SIZE);
    return { current_page: requestedPage, total_pages, items };
  }

  override async get(id: number): Promise<Journal> {
    const found = (await this.loadAll()).find(j => j.id === id);
    if (!found) throw new HttpError(`CRM 404 on GET /documents/${id}`, 404, "GET", `/documents/${id}`);
    return found;
  }

  /** Every CRM read already carries full lines/postings — no per-row fetch needed. */
  async listAllWithPostings(): Promise<Journal[]> {
    return this.listAll();
  }

  // --- writes ------------------------------------------------------------

  override async create(data: CreateJournalRequest): Promise<ApiResponse> {
    const { sourceKey, number } = this.sourceKeyAndNumber(data.document_number);
    const counterpartyId = data.clients_id != null
      ? (await this.idMap.toCrm("counterparty", [data.clients_id]))[0]!
      : null;
    const lines = await this.linesFromPostings(data.postings ?? []);
    const effectiveDate = data.effective_date ?? todayTallinn();
    const body: DraftInput = {
      kind: "MEMO", sourceKey, number, counterpartyId,
      docDate: effectiveDate, turnoverDate: effectiveDate, dueDate: null,
      description: data.title ?? "", creditsDocumentId: null, lines,
    };
    const result = await this.mutate<{ id: string; created: boolean }>(
      "create", undefined, `${this.basePath}:create`, [this.basePath],
      () => this.client.post<{ id: string; created: boolean }>("/documents", body),
    );
    const id = (await this.idMap.toNumeric("document", [result.id]))[0]!;
    return { code: 200, created_object_id: id, messages: [] };
  }

  override async update(id: number, data: UpdateJournalRequest): Promise<ApiResponse> {
    const crmId = (await this.idMap.toCrm("document", [id]))[0]!;
    const existing = await this.client.get<CrmDocument>(`/documents/${crmId}`);
    const counterpartyId = data.clients_id !== undefined
      ? (data.clients_id != null ? (await this.idMap.toCrm("counterparty", [data.clients_id]))[0]! : null)
      : existing.counterpartyId;
    const lines = data.postings ? await this.linesFromPostings(data.postings) : existing.lines;
    const body: DraftInput = {
      kind: existing.kind, sourceKey: existing.sourceKey!, number: data.document_number ?? existing.number,
      counterpartyId,
      docDate: data.effective_date ?? existing.docDate,
      turnoverDate: data.effective_date ?? existing.turnoverDate,
      dueDate: existing.dueDate, description: data.title ?? existing.description,
      creditsDocumentId: existing.creditsDocumentId, lines,
    };
    await this.mutate(
      "update", id, `${this.basePath}:${id}`, [this.basePath],
      () => this.client.patch(`/documents/${crmId}`, body),
    );
    return { code: 200, messages: [] };
  }

  async confirm(id: number): Promise<ApiResponse> {
    const crmId = (await this.idMap.toCrm("document", [id]))[0]!;
    const result = await this.mutate<{ entryId: string }>(
      "confirm", id, `${this.basePath}:${id}:confirm`, [this.basePath, "/transactions"],
      () => this.client.post<{ entryId: string }>(`/documents/${crmId}/confirm`, {}),
    );
    const entryId = (await this.idMap.toNumeric("entry", [result.entryId]))[0];
    return { code: 200, created_object_id: entryId, messages: [] };
  }

  async invalidate(id: number): Promise<ApiResponse> {
    const crmId = (await this.idMap.toCrm("document", [id]))[0]!;
    const result = await this.mutate<{ entryId: string }>(
      "invalidate", id, `${this.basePath}:${id}:invalidate`, [this.basePath, "/transactions"],
      () => this.client.post<{ entryId: string }>(`/documents/${crmId}/invalidate`, {
        reason: "invalidated by the approved plan", entryDate: todayTallinn(),
      }),
    );
    const entryId = (await this.idMap.toNumeric("entry", [result.entryId]))[0];
    return { code: 200, created_object_id: entryId, messages: [] };
  }

  override async delete(id: number): Promise<ApiResponse> {
    const crmId = (await this.idMap.toCrm("document", [id]))[0]!;
    await this.mutate(
      "delete", id, `${this.basePath}:${id}`, [this.basePath],
      () => this.client.delete(`/documents/${crmId}`),
    );
    return { code: 200, messages: [] };
  }

  /**
   * Force-drop the journals aggregate cache so the next `listAll()` /
   * `listAllWithPostings()` re-reads from the CRM. `create()` only
   * invalidates the cache *after* a successful POST, so a create that fails
   * with a network error never clears it and the cached snapshot can still
   * predate the ambiguous write. BookingGuard's verify-then-retry calls this
   * before re-scanning to check whether the ambiguous journal actually
   * committed.
   */
  invalidateListCache(): void {
    this.invalidateCache();
  }
}
