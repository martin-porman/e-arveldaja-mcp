import { randomUUID } from "node:crypto";
import { HttpError, type HttpClient, type HttpMethod } from "../http-client.js";
import type { Transaction, TransactionDistribution, ApiResponse, PaginatedResponse } from "../types/api.js";
import type { CreateBankTransactionPayload, UpdateBankTransactionRequest } from "../types/mutations.js";
import { isMutationIndeterminate } from "../mutation-outcome.js";
import { BaseResource, cache, type ListParams } from "./base-resource.js";
import { IdMap } from "../crm/id-map.js";

const LIST_PAGE_SIZE = 100;

function isHttpMethod(value: unknown): value is HttpMethod {
  return value === "GET" || value === "POST" || value === "PUT" ||
    value === "PATCH" || value === "DELETE";
}

export function getNormalizedNetworkCause(error: unknown): HttpError | undefined {
  try {
    if (!isMutationIndeterminate(error)) return undefined;
    if (typeof error.cause !== "object" || error.cause === null) return undefined;
    const cause = error.cause as unknown as Record<string, unknown>;
    if (
      cause.name !== "HttpError" ||
      cause.status !== "network" ||
      typeof cause.message !== "string" ||
      typeof cause.path !== "string" ||
      cause.path.trim() === "" ||
      !isHttpMethod(cause.method)
    ) {
      return undefined;
    }
    return new HttpError(cause.message, "network", cause.method, cause.path);
  } catch {
    return undefined;
  }
}

const LINKED_INVOICE_CLIENT_MISMATCH_NEXT_ACTION =
  "Re-run confirm_transaction with reassign_client_to_invoice: true to book the receipt under the invoice's " +
  "client, or fix the linked invoice; the journal client comes from the transaction's client and would land " +
  "the 1210/2310 entry in the wrong sub-ledger.";

/**
 * Kept only for the external `instanceof` contract at crud/transactions.ts:12,400
 * (`import { ... LinkedInvoiceClientMismatchError } from "../../api/transactions.api.js"`).
 * Finding: the CRM derives a bank transaction's counterparty from its
 * distributions' settled open items server-side (writes-bank-accounts.ts:253),
 * so there is no separate payer/invoice-client comparison left for `confirm`
 * below to make — this is never thrown by this file anymore.
 */
export class LinkedInvoiceClientMismatchError extends Error {
  readonly category = "linked_invoice_client_mismatch";
  readonly transaction_id: number;
  readonly transaction_clients_id: number;
  readonly invoice_table: string;
  readonly invoice_id: number;
  readonly invoice_clients_id: number;
  readonly next_action = LINKED_INVOICE_CLIENT_MISMATCH_NEXT_ACTION;

  constructor(details: {
    transactionId: number;
    transactionClientsId: number;
    invoiceTable: string;
    invoiceId: number;
    invoiceClientsId: number;
  }) {
    super(
      `Transaction ${details.transactionId} is booked to client ${details.transactionClientsId}, but the linked ` +
      `${details.invoiceTable} ${details.invoiceId} belongs to client ${details.invoiceClientsId}. Confirming ` +
      `would post the receipt into the payer's client sub-ledger instead of the invoice client's.`,
    );
    this.name = "LinkedInvoiceClientMismatchError";
    this.transaction_id = details.transactionId;
    this.transaction_clients_id = details.transactionClientsId;
    this.invoice_table = details.invoiceTable;
    this.invoice_id = details.invoiceId;
    this.invoice_clients_id = details.invoiceClientsId;
  }
}

type CrmBankTxnRow = {
  id: string; acctSvcrRef: string; accountIban: string; bookingDate: string;
  amount: string; direction: "CRDT" | "DBIT"; currency: string;
  counterpartyName: string | null; counterpartyIban: string | null;
  remittance: string | null; documentId: string | null;
};

type CrmDistributionLine = {
  lineNo: number; targetKind: "open_item" | "account";
  settlesPostingId: string | null; accountCode: string | null; amount: string;
};

function moneyString(amount: number): string {
  if (Math.abs(amount * 100 - Math.round(amount * 100)) > 1e-6) {
    throw new Error(`${amount}: more than two decimals: the CRM does not round money`);
  }
  return (Math.round(amount * 100) / 100).toFixed(2);
}

function todayTallinn(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Europe/Tallinn" });
}

function toRikTransaction(r: CrmBankTxnRow, id: number, accountsDimensionsId: number): Transaction {
  return {
    id,
    accounts_dimensions_id: accountsDimensionsId,
    status: r.documentId ? "CONFIRMED" : "PROJECT",
    type: r.direction === "CRDT" ? "D" : "C",
    bank_account_name: r.counterpartyName ?? null,
    bank_account_no: r.counterpartyIban ?? null,
    ref_number: r.acctSvcrRef,
    amount: Number(r.amount),
    cl_currencies_id: r.currency,
    // C7: stored/read back verbatim through the CRM's `remittance` field.
    description: r.remittance ?? null,
    date: r.bookingDate,
    // Findings, not invented: no `clients_id` exists on a bank transaction
    // before confirm (readers: crud/transactions.ts:341,346,416), and no
    // `items[]` — GET :id only returns `openItems` (settlement candidates),
    // not what was actually allocated; drafts are deleted on confirm
    // (writes-bank-accounts.ts:273). Readers: receipt-ledger-check.ts:262,
    // currency-rounding.ts:249-250.
  };
}

/**
 * RIK's `TransactionsApi` over the CRM's bank-transactions (Task 24, spec
 * §2.3). `basePath` ("/transactions") stays only as the cache-key prefix and
 * the document_user path base (inherited from BaseResource, unchanged).
 */
export class TransactionsApi extends BaseResource<Transaction> {
  private readonly idMap: IdMap;

  constructor(client: HttpClient) {
    super(client, "/transactions");
    this.idMap = new IdMap(client);
  }

  public invalidateTransactionsAfterAmbiguousCleanup(): void {
    this.invalidateCache();
  }

  private async loadAll(): Promise<Transaction[]> {
    const cacheKey = this.cacheKey(`${this.basePath}:all`);
    const cached = cache.get<Transaction[]>(cacheKey);
    if (cached !== undefined) return cached;
    const gen = cache.generation;
    const rows = await this.client.get<CrmBankTxnRow[]>("/bank-transactions");
    const ids = await this.idMap.toNumeric("bank_transaction", rows.map(r => r.id));
    const dims = await this.idMap.toNumeric("bank_account", rows.map(r => r.accountIban));
    const txs = rows.map((r, i) => toRikTransaction(r, ids[i]!, dims[i]!));
    cache.setIfSameGeneration(cacheKey, txs, gen, 60);
    return txs;
  }

  override async list(params?: ListParams): Promise<PaginatedResponse<Transaction>> {
    const requestedPage = params?.page ?? 1;
    const all = await this.loadAll();
    const total_pages = Math.max(1, Math.ceil(all.length / LIST_PAGE_SIZE));
    const items = all.slice((requestedPage - 1) * LIST_PAGE_SIZE, requestedPage * LIST_PAGE_SIZE);
    return { current_page: requestedPage, total_pages, items };
  }

  override async get(id: number): Promise<Transaction> {
    const found = (await this.loadAll()).find(t => t.id === id);
    if (!found) throw new HttpError(`CRM 404 on GET /bank-transactions/${id}`, 404, "GET", `/bank-transactions/${id}`);
    return found;
  }

  override async create(data: CreateBankTransactionPayload): Promise<ApiResponse> {
    const accountIban = (await this.idMap.toCrm("bank_account", [data.accounts_dimensions_id]))[0]!;
    const body = {
      acctSvcrRef: data.bank_ref_number ?? data.ref_number ?? `manual:${randomUUID()}`,
      accountIban,
      bookingDate: data.date,
      amount: moneyString(Math.abs(data.amount)),
      direction: data.type === "D" ? "CRDT" as const : "DBIT" as const,
      currency: data.cl_currencies_id ?? "EUR",
      counterpartyName: data.bank_account_name ?? null,
      counterpartyIban: data.bank_account_no ?? null,
      // Finding: no separate `clients_id` field exists pre-confirm (see
      // toRikTransaction above); C7 maps `description` onto `remittance`.
      remittance: data.description ?? null,
    };
    const result = await this.mutate<{ id: string; created: boolean }>(
      "create", undefined, `${this.basePath}:create`, [this.basePath],
      () => this.client.post<{ id: string; created: boolean }>("/bank-transactions", body),
    );
    const id = (await this.idMap.toNumeric("bank_transaction", [result.id]))[0]!;
    return { code: 200, created_object_id: id, messages: [] };
  }

  /**
   * `data.items` (plan l.3070) maps through the same distribution lines
   * `confirm` builds and PUTs them to `/bank-transactions/{crmId}/distributions`
   * — the CRM has no separate "update" route, PUT-replace of the drafts is the
   * only pre-confirm write it exposes for a bank line.
   *
   * Finding: without `items`, there is still no route to change a bank
   * transaction's metadata (bank_ref_number, description, clients_id) —
   * writes-bank-accounts.ts exposes only POST create, PUT .../distributions
   * and POST .../confirm — so a metadata-only update keeps refusing with a
   * 501. Callers depending on that: crud/transactions.ts:348,363,499,
   * accounting-inbox.ts:2421.
   */
  override async update(id: number, data: UpdateBankTransactionRequest): Promise<ApiResponse> {
    // `Transaction.items` (TransactionItem[], the GET readback shape) already
    // occupies that field name in the base `Partial<Transaction>` signature,
    // so a distribution-shaped `items?: TransactionDistribution[]` is read via
    // an internal cast rather than widened into the public parameter type —
    // that would collide with the inherited field and break every existing
    // `Partial<Transaction>`-typed caller (crud/transactions.ts, accounting-inbox.ts).
    const items = (data as UpdateBankTransactionRequest & { items?: TransactionDistribution[] }).items;
    if (items && items.length > 0) {
      const crmId = (await this.idMap.toCrm("bank_transaction", [id]))[0]!;
      const lines = await this.distributionLines(items);
      await this.mutate(
        "update", id, `${this.basePath}:${id}:distributions`, [this.basePath],
        () => this.client.put(`/bank-transactions/${crmId}/distributions`, { lines }),
      );
      return { code: 200, messages: [] };
    }
    throw new HttpError(
      "the CRM has no route to update a bank transaction's metadata after creation",
      501, "PATCH", `/transactions/${id}`,
    );
  }

  private async distributionLines(items: TransactionDistribution[]): Promise<CrmDistributionLine[]> {
    const lines: CrmDistributionLine[] = [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i]!;
      if (item.related_table === "accounts") {
        const accountCode = (await this.idMap.toCrm("account", [item.related_id!]))[0]!;
        lines.push({ lineNo: i + 1, targetKind: "account", settlesPostingId: null, accountCode, amount: moneyString(item.amount) });
        continue;
      }
      if (item.related_table === "purchase_invoices" || item.related_table === "sale_invoices") {
        // Finding: settling an invoice's open item needs the invoice's CRM
        // document id and the matching open-item posting id (from GET
        // /bank-transactions/{id} openItems) — but purchase/sale invoices are
        // not yet migrated onto CRM documents (purchase-invoices.api.ts /
        // sale-invoices.api.ts still call the old /purchase_invoices,
        // /sale_invoices routes), so `related_id` has no id-map entry to
        // resolve against. Depends on that migration task, not T24.
        throw new Error(
          `distribution line ${i + 1}: related_table "${item.related_table}" needs the invoice-to-CRM-document ` +
          "migration (not done yet) before it can settle an open item",
        );
      }
      throw new Error(`distribution line ${i + 1}: unknown related_table "${item.related_table}"`);
    }
    return lines;
  }

  async confirm(
    id: number,
    distributions?: TransactionDistribution[],
    _options?: { autoFixClientsId?: boolean; reassignClientToInvoice?: boolean },
  ): Promise<ApiResponse> {
    const crmId = (await this.idMap.toCrm("bank_transaction", [id]))[0]!;
    if (distributions && distributions.length > 0) {
      const lines = await this.distributionLines(distributions);
      await this.client.put(`/bank-transactions/${crmId}/distributions`, { lines });
    }
    const result = await this.mutate<{ entryId: string }>(
      "confirm", id, `${this.basePath}:${id}:confirm`, [this.basePath, "/journals"],
      () => this.client.post<{ entryId: string }>(`/bank-transactions/${crmId}/confirm`, {}),
    );
    const entryId = (await this.idMap.toNumeric("entry", [result.entryId]))[0];
    return { code: 200, created_object_id: entryId, messages: [] };
  }

  async invalidate(id: number): Promise<ApiResponse> {
    const crmId = (await this.idMap.toCrm("bank_transaction", [id]))[0]!;
    const txn = await this.client.get<CrmBankTxnRow>(`/bank-transactions/${crmId}`);
    if (!txn.documentId) {
      throw new HttpError(`transaction ${id} has never been confirmed — nothing to invalidate`, 400, "POST", `/transactions/${id}/invalidate`);
    }
    const documentId = txn.documentId;
    const result = await this.mutate<{ entryId: string }>(
      "invalidate", id, `${this.basePath}:${id}:invalidate`, [this.basePath, "/journals"],
      () => this.client.post<{ entryId: string }>(`/documents/${documentId}/invalidate`, {
        reason: "invalidated by the approved plan", entryDate: todayTallinn(),
      }),
    );
    const entryId = (await this.idMap.toNumeric("entry", [result.entryId]))[0];
    return { code: 200, created_object_id: entryId, messages: [] };
  }

  /**
   * Finding: the only DELETE route in the CRM-MCP is `documents/:id`
   * (writes-posting.ts:190) — bank transactions have no delete route.
   * Callers depending on this: crud/transactions.ts:533,589,
   * accounting-inbox.ts:2435.
   */
  override async delete(id: number): Promise<ApiResponse> {
    throw new HttpError("the CRM has no route to delete a bank transaction", 501, "DELETE", `/transactions/${id}`);
  }
}
