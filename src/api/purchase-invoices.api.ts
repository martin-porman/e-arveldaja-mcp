import { createHash } from "node:crypto";
import { HttpError, type HttpClient } from "../http-client.js";
import type { PurchaseInvoice, PurchaseInvoiceItem, CreatePurchaseInvoiceData, ApiResponse } from "../types/api.js";
import type { CreatePurchaseInvoiceRequest, UpdatePurchaseInvoiceRequest } from "../types/mutations.js";
import { BaseResource, type CrmDocument, type CrmDocumentLine } from "./base-resource.js";
import { roundMoney, parseVatRateDropdown } from "../money.js";
import { IdMap } from "../crm/id-map.js";
import { VAT_MAP, vatCodeFor } from "../crm/vat-map.js";
import { sourceKeyFor } from "../crm/source-key.js";
import type { CrmCounterparty } from "../crm/mappers.js";

/** Refuses an amount the CRM cannot store exactly (money is a two-decimal string). */
function moneyString(amount: number): string {
  if (Math.abs(amount * 100 - Math.round(amount * 100)) > 1e-6) {
    throw new Error(`${amount}: more than two decimals: the CRM does not round money`);
  }
  return (Math.round(amount * 100) / 100).toFixed(2);
}

function addDaysUtc(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split("-").map(Number) as [number, number, number];
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

function todayTallinn(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Europe/Tallinn" });
}

function daysBetweenUtc(fromDate: string, toDate: string): number {
  const [fy, fm, fd] = fromDate.split("-").map(Number) as [number, number, number];
  const [ty, tm, td] = toDate.split("-").map(Number) as [number, number, number];
  const from = Date.UTC(fy, fm - 1, fd);
  const to = Date.UTC(ty, tm - 1, td);
  return Math.round((to - from) / 86_400_000);
}

/** `P24` → `24`, a reverse-charge or unmapped code → `0` — mirrors
 * `SaleInvoicesApi`'s `rateFromVatCode` (sale-invoices.api.ts): only a
 * `vatCodeFor`-produced code is ever stored, so this only sees an unknown
 * code for a document this fork itself never wrote. */
function rateFromVatCode(code: string | null): number {
  if (!code) return 0;
  const row = VAT_MAP.find((r) => r.code === code);
  return row ? Number(row.rate) : 0;
}

type CrmLine = {
  description: string; quantity: string | null; unitPrice: string | null; net: string;
  side: null; vatCode: string; vatAmount: string; accountCode: string; dimensionId: string | null;
};

type CrmDraftDocument = { status: "DRAFT" | "POSTED" | "REVERSED" };

/**
 * Kept only for the external `instanceof` contract at documents/operations.ts:39,554,
 * pdf-workflow.ts:12,1021, and guided/process-accounting-document.test.ts:13,380 (the
 * T24 `LinkedInvoiceClientMismatchError` precedent, transactions.api.ts:43-50).
 * Finding: `createAndSetTotals` below is a single `POST /documents` with no follow-up
 * write to roll back, so this fork no longer throws it itself — the "created but the
 * next step failed" scenario it described (create-then-PATCH) is gone with the quirk.
 */
export class InvoiceCreationError extends Error {
  constructor(message: string, public readonly invoiceId: number, options?: ErrorOptions) {
    super(message, options);
    this.name = "InvoiceCreationError";
  }
}

export interface PurchaseInvoiceTotalsCorrectionPreview {
  invoice_id: number;
  is_vat_registered: boolean;
  current_vat_price: number | null;
  current_gross_price: number | null;
  proposed_vat_price: number;
  proposed_gross_price: number;
  correction_required: boolean;
  approval_digest: string;
}

interface ConfirmPurchaseInvoiceOptions {
  recalculateTotals?: boolean;
  approvedCorrection?: PurchaseInvoiceTotalsCorrectionPreview;
}

export type PurchaseInvoiceTotalsCorrectionCode =
  | "correction_invoice_not_project"
  | "correction_currency_not_supported"
  | "correction_reverse_charge_not_supported"
  | "correction_items_missing"
  | "correction_preview_required"
  | "correction_preview_mismatch";

const TOTALS_CORRECTION_ERRORS: Record<PurchaseInvoiceTotalsCorrectionCode, {
  message: string;
  nextAction: string;
}> = {
  correction_invoice_not_project: {
    message: "Purchase invoice totals correction requires a PROJECT draft.",
    nextAction: "Fetch the invoice; if it is confirmed, invalidate it explicitly, then request and approve a new correction preview.",
  },
  correction_currency_not_supported: {
    message: "Automatic purchase invoice totals correction supports EUR invoices only.",
    nextAction: "Review the currency and base totals manually; do not use automatic totals correction.",
  },
  correction_reverse_charge_not_supported: {
    message: "Automatic totals correction is disabled for reverse-charge purchase invoices.",
    nextAction: "Review and preserve the reverse-charge totals manually, then confirm without recalculation only after approval.",
  },
  correction_items_missing: {
    message: "Purchase invoice totals correction requires at least one item.",
    nextAction: "Add or repair the invoice items, then request and approve a new correction preview.",
  },
  correction_preview_required: {
    message: "An exact approved purchase invoice totals correction preview is required.",
    nextAction: "Call preview_purchase_invoice_totals_correction, obtain approval, and resubmit that preview unchanged.",
  },
  correction_preview_mismatch: {
    message: "The approved purchase invoice totals correction preview no longer matches fresh invoice state.",
    nextAction: "Call preview_purchase_invoice_totals_correction again and obtain approval for the new snapshot.",
  },
};

export class PurchaseInvoiceTotalsCorrectionError extends Error {
  readonly nextAction: string;

  constructor(public readonly code: PurchaseInvoiceTotalsCorrectionCode) {
    const contract = TOTALS_CORRECTION_ERRORS[code];
    super(contract.message);
    this.name = "PurchaseInvoiceTotalsCorrectionError";
    this.nextAction = contract.nextAction;
  }
}

function normalizeCorrectionSnapshot(value: unknown): unknown {
  if (value === undefined) return null;
  if (Array.isArray(value)) return value.map(normalizeCorrectionSnapshot);
  if (value !== null && typeof value === "object") {
    const normalized: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      normalized[key] = normalizeCorrectionSnapshot((value as Record<string, unknown>)[key]);
    }
    return normalized;
  }
  return value;
}

function canonicalCorrectionJson(value: unknown): string {
  return JSON.stringify(normalizeCorrectionSnapshot(value));
}

const CORRECTION_PREVIEW_KEYS = [
  "invoice_id",
  "is_vat_registered",
  "current_vat_price",
  "current_gross_price",
  "proposed_vat_price",
  "proposed_gross_price",
  "correction_required",
  "approval_digest",
] as const;

function isFiniteNullableNumber(value: unknown): boolean {
  return value === null || (typeof value === "number" && Number.isFinite(value));
}

function isCorrectionPreview(value: unknown): value is PurchaseInvoiceTotalsCorrectionPreview {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.length !== CORRECTION_PREVIEW_KEYS.length ||
      keys.some((key, index) => key !== [...CORRECTION_PREVIEW_KEYS].sort()[index])) return false;
  return Number.isInteger(record.invoice_id) && (record.invoice_id as number) > 0 &&
    typeof record.is_vat_registered === "boolean" &&
    isFiniteNullableNumber(record.current_vat_price) &&
    isFiniteNullableNumber(record.current_gross_price) &&
    typeof record.proposed_vat_price === "number" && Number.isFinite(record.proposed_vat_price) &&
    typeof record.proposed_gross_price === "number" && Number.isFinite(record.proposed_gross_price) &&
    typeof record.correction_required === "boolean" &&
    typeof record.approval_digest === "string" && /^[0-9a-f]{64}$/.test(record.approval_digest);
}


export class PurchaseInvoicesApi extends BaseResource<PurchaseInvoice> {
  private readonly crmIdMap: IdMap;

  constructor(client: HttpClient) {
    super(client, "/purchase_invoices", { kinds: ["PURCHASE_INVOICE", "PURCHASE_CREDIT"] });
    this.crmIdMap = new IdMap(client);
  }

  /** `list`/`get`/`delete`/the `document_user` family now come from
   * `BaseResource`'s document-backed opt-in (base-resource.ts), following
   * `SaleInvoicesApi`'s pattern (sale-invoices.api.ts). This class still
   * supplies `fromDocument`, `create` (routed through `createAndSetTotals`,
   * the only write shape the CRM's single `POST /documents` supports) and
   * `update` (the CRM's `PATCH /documents/:id` needs the full draft read
   * back first, so it cannot be the generic `BaseResource.update`). */
  override async create(data: CreatePurchaseInvoiceRequest): Promise<ApiResponse> {
    const result = await this.createAndSetTotals(data);
    return { code: 200, created_object_id: result.created_object_id, messages: [] };
  }

  /** Finding: a `CrmDocument` carries no counterparty name, and `fromDocument`
   * is called synchronously (per row, no extra network round trip) — `client_name`
   * (required on `PurchaseInvoice`) is left `""`. `findDuplicateInvoice`
   * (receipt-inbox-matching.ts:51-95) and `suggestBookingInternal`
   * (receipt-extraction.ts:2696-2787) never read it; display-only consumers
   * that do (receipt-inbox.ts:915, receipt-extraction.ts:2675,
   * wise/projection.ts:711, match-score.ts:126, aging-analysis.ts,
   * financial-statements.ts, document-audit.ts) degrade the same way
   * `SaleInvoicesApi.fromDocument` already leaves `client_name` unset for a
   * sale invoice (sale-invoices.api.ts) — not a new gap, the same one T25
   * already shipped for sales. */
  protected override fromDocument(doc: CrmDocument, id: number, clientsId: number | null): PurchaseInvoice {
    const netTotal = roundMoney(doc.lines.reduce((s, l) => s + Number(l.net), 0));
    const vatTotal = roundMoney(doc.lines.reduce((s, l) => s + Number(l.vatAmount), 0));
    return {
      id,
      clients_id: clientsId ?? 0,
      client_name: "",
      number: doc.number,
      create_date: doc.docDate,
      journal_date: doc.turnoverDate,
      status: doc.status === "DRAFT" ? "PROJECT" : doc.status === "POSTED" ? "CONFIRMED" : "INVALIDATED",
      net_price: netTotal,
      vat_price: vatTotal,
      gross_price: roundMoney(netTotal + vatTotal),
      term_days: doc.dueDate ? daysBetweenUtc(doc.docDate, doc.dueDate) : 0,
      notes: doc.description || null,
      cl_currencies_id: "EUR",
      items: doc.lines.map((l) => this.itemFromLine(l)),
    };
  }

  /** Finding: a CRM document line carries no catalogue ids at all — no
   * `cl_purchase_articles_id` (purchase article), `cl_vat_articles_id` /
   * `vat_accounts_id` (VAT article/account) — this fork's catalogues have no
   * CRM equivalent, so those stay unset rather than guessed.
   * `suggestBookingInternal`'s supplier-history branch requires
   * `matchedItem.cl_purchase_articles_id` (receipt-extraction.ts:2744), so a
   * CRM-sourced history item never matches it and the call falls through to
   * its keyword suggestion instead — a real consequence of the data model
   * change, not a bug introduced here. `purchase_accounts_id` is filled only
   * when the line's `accountCode` is itself a digit-only chart code (the same
   * fast path `IdMap`'s allocation floor documents, id-map.ts): resolving an
   * allocated CRM account id back to a numeric one needs a network round
   * trip `fromDocument` cannot make (it is called synchronously, per row).
   * `reversed_vat_id` is an id-typed field this fork only ever tests for
   * presence (`!= null`, purchase-invoices.api.ts, receipt-extraction.ts); the
   * real signal is `VAT_MAP`'s own `reversed` flag, so a reverse-charge line
   * gets a documented sentinel (`-1`) rather than a fabricated catalogue id. */
  private itemFromLine(l: CrmDocumentLine): PurchaseInvoiceItem {
    const vatRow = l.vatCode ? VAT_MAP.find((r) => r.code === l.vatCode) : undefined;
    const accountId = /^\d+$/.test(l.accountCode) && !l.accountCode.startsWith("0")
      ? Number(l.accountCode)
      : undefined;
    return {
      custom_title: l.description,
      amount: l.quantity != null ? Number(l.quantity) : 1,
      unit_net_price: l.unitPrice != null ? Number(l.unitPrice) : undefined,
      total_net_price: Number(l.net),
      vat_amount: Number(l.vatAmount),
      vat_rate: rateFromVatCode(l.vatCode),
      vat_rate_dropdown: vatRow?.rate,
      purchase_accounts_id: accountId,
      crm_vat_code: l.vatCode,
      reversed_vat_id: vatRow?.reversed ? -1 : null,
    };
  }

  /** Shared by `create`/`update`: every item's VAT mapped to a core v2 code
   * via `vatCodeFor` before any write (spec R4a Task 25) — the first refusal
   * throws before the caller's data reaches the CRM at all. Reads
   * `crm_vat_code` first (set by `itemFromLine` above on every item this
   * class itself returns) so re-sending an unchanged item on `update` round-trips
   * a non-derived code (e.g. `PEUG24`) instead of re-deriving and possibly
   * refusing it. */
  private async buildLines(
    items: PurchaseInvoiceItem[],
    partyCountry: string,
    turnoverDate: string,
  ): Promise<{ lines: CrmLine[]; netTotal: number; vatTotal: number }> {
    const lines: CrmLine[] = [];
    let netTotal = 0;
    let vatTotal = 0;
    for (let i = 0; i < items.length; i++) {
      const item = items[i]!;
      const rate = item.vat_rate_dropdown ?? (item.vat_rate != null ? String(item.vat_rate) : null);
      const reversed = item.reversed_vat_id != null;
      const mapped = vatCodeFor({
        direction: "IN", rate, reversed, partyCountry, turnoverDate,
        explicit: item.crm_vat_code ?? null,
      });
      if ("problem" in mapped) throw new HttpError(`line ${i + 1}: ${mapped.problem}`, 422, "POST", "/documents");

      const net = item.total_net_price ?? roundMoney((item.unit_net_price ?? 0) * (item.amount ?? 1));
      const vatAmount = item.vat_amount !== undefined
        ? item.vat_amount
        : reversed ? 0 : roundMoney(net * (parseVatRateDropdown(rate) / 100));
      const accountCode = item.purchase_accounts_id != null
        ? (await this.crmIdMap.toCrm("account", [item.purchase_accounts_id]))[0]!
        : "";

      netTotal = roundMoney(netTotal + net);
      vatTotal = roundMoney(vatTotal + vatAmount);
      lines.push({
        description: item.custom_title ?? "",
        quantity: item.amount != null ? String(item.amount) : null,
        unitPrice: item.unit_net_price != null ? moneyString(item.unit_net_price) : null,
        net: moneyString(net),
        side: null,
        vatCode: mapped.code,
        vatAmount: moneyString(vatAmount),
        accountCode,
        dimensionId: null,
      });
    }
    return { lines, netTotal, vatTotal };
  }

  /**
   * The CRM's `PATCH /documents/:id` replaces the whole draft (writes-documents.ts:233-253,
   * `sourceKey` immutable) — existing fields are read back first and only the
   * caller's changes are merged in, mirroring `SaleInvoicesApi.update`
   * (sale-invoices.api.ts) and `JournalsApi.update` (journals.api.ts:218-238).
   *
   * Finding: `vat_price`/`gross_price`/`base_net_price`/`base_vat_price`/
   * `base_gross_price`/`currency_rate`/`liability_accounts_id`/`bank_ref_number`/
   * `bank_account_no`/`cl_currencies_id` have no CRM document field — the CRM
   * always computes a line's `vatAmount` from `net`+`vatCode`, and this class
   * derives `vat_price`/`gross_price` from the document's own lines on every
   * read (`fromDocument` above), never from a stored header total. An
   * explicit override in `data` is accepted (the tool layer's
   * `validateUpdateFields` already governs which fields a confirmed invoice
   * may still change) but not forwarded — the same non-guess
   * `createAndSetTotals` already documents for `vatPrice`/`grossPrice`.
   * Finding: because totals are always derived, `previewTotalsCorrection`'s
   * `current_*` and `proposed_*` are now always equal for a CRM-backed
   * invoice, so `confirmWithTotals`'s `this.update(id, { vat_price,
   * gross_price, items })` correction branch is effectively dead — `items`
   * still round-trips through this method, `vat_price`/`gross_price` are
   * silently dropped as above.
   */
  override async update(id: number, data: UpdatePurchaseInvoiceRequest): Promise<ApiResponse> {
    const crmId = (await this.crmIdMap.toCrm("document", [id]))[0]!;
    const existing = await this.client.get<CrmDocument>(`/documents/${crmId}`);
    const counterpartyCrmId = data.clients_id !== undefined
      ? (await this.crmIdMap.toCrm("counterparty", [data.clients_id]))[0]!
      : existing.counterpartyId;
    let lines = existing.lines as CrmLine[];
    if (data.items) {
      const counterparty = counterpartyCrmId
        ? await this.client.get<CrmCounterparty>(`/counterparties/${counterpartyCrmId}`)
        : null;
      const turnoverDate = data.journal_date ?? existing.turnoverDate;
      ({ lines } = await this.buildLines(data.items, counterparty?.country ?? "EE", turnoverDate));
    }
    const body = {
      kind: existing.kind,
      sourceKey: existing.sourceKey!,
      number: data.number ?? existing.number,
      counterpartyId: counterpartyCrmId,
      docDate: data.create_date ?? existing.docDate,
      turnoverDate: data.journal_date ?? existing.turnoverDate,
      dueDate: data.term_days !== undefined
        ? addDaysUtc(data.create_date ?? existing.docDate, data.term_days)
        : existing.dueDate,
      description: data.notes ?? existing.description,
      creditsDocumentId: existing.creditsDocumentId,
      lines,
    };
    await this.mutate(
      "update", id, `${this.basePath}:${id}`, [this.basePath],
      () => this.client.patch(`/documents/${crmId}`, body),
    );
    return { code: 200, messages: [] };
  }

  /**
   * Create a purchase invoice as ONE CRM document (plan R4a Task 25, spec §2.3):
   * every item's VAT is mapped to a core v2 code via `vatCodeFor` before any write,
   * then a single `POST /documents` — the old create-then-PATCH-totals quirk (see
   * git history) is gone because the CRM computes and stores each line's own
   * `vatAmount` server-side from the `vatCode`/`net` we send (contract C5).
   *
   * `vatPrice`/`grossPrice`/`isVatRegistered` are kept for callers that still pass
   * them (pdf-workflow.ts, receipt-inbox-booking.ts, receipts/classification-operations.ts):
   * an explicit `vatPrice`/`grossPrice` overrides the summed line totals in the
   * *returned* invoice only (not sent back to the CRM as a correction — there is no
   * readback after the create); `isVatRegistered=false` still zeroes the returned
   * `vat_price` the same way it did before. There is no per-line rounding-difference
   * push onto the last line any more: each line's `vatAmount` is exactly what the
   * CRM will compute from its own `vatCode`, so drifting it to match an explicit
   * `vatPrice` would desync the request from what the server actually stores.
   *
   * Finding: `CreatePurchaseInvoiceData` (types/api.ts:397-416) carries no credit-note
   * flag, so every call creates `kind: "PURCHASE_INVOICE"` — `PURCHASE_CREDIT` is
   * unreachable from this method (never inferred from a negative amount).
   */
  async createAndSetTotals(
    data: CreatePurchaseInvoiceData,
    vatPrice?: number,
    grossPrice?: number,
    isVatRegistered = true,
  ): Promise<PurchaseInvoice & { created_object_id: number }> {
    const bankTransactionCrmId = data.crm_source?.bank_transaction_id != null
      ? (await this.crmIdMap.toCrm("bank_transaction", [data.crm_source.bank_transaction_id]))[0]
      : undefined;
    const sourceKey = sourceKeyFor({ ...(data.crm_source ?? {}), bank_transaction_id: bankTransactionCrmId });
    const counterpartyCrmId = (await this.crmIdMap.toCrm("counterparty", [data.clients_id]))[0]!;
    const counterparty = await this.client.get<CrmCounterparty>(`/counterparties/${counterpartyCrmId}`);
    const turnoverDate = data.journal_date;

    const { lines, netTotal, vatTotal } = await this.buildLines(data.items, counterparty.country, turnoverDate);

    const body = {
      kind: "PURCHASE_INVOICE" as const,
      sourceKey,
      number: data.number,
      counterpartyId: counterpartyCrmId,
      docDate: data.create_date,
      turnoverDate,
      dueDate: addDaysUtc(data.create_date, data.term_days),
      description: data.notes ?? "",
      creditsDocumentId: null,
      lines,
    };
    const created = await this.mutate<{ id: string; created: boolean }>(
      "create", undefined, `${this.basePath}:create`, [this.basePath],
      () => this.client.post<{ id: string; created: boolean }>("/documents", body),
    );
    const numericId = (await this.crmIdMap.toNumeric("document", [created.id]))[0]!;

    const vat = isVatRegistered ? (vatPrice !== undefined ? vatPrice : vatTotal) : 0;
    const gross = grossPrice !== undefined ? grossPrice : roundMoney(netTotal + vatTotal);
    return {
      ...data,
      id: numericId,
      created_object_id: numericId,
      status: "PROJECT",
      net_price: netTotal,
      vat_price: vat,
      gross_price: gross,
    };
  }

  private async getFreshInvoice(id: number): Promise<PurchaseInvoice> {
    this.invalidateCache();
    return this.get(id);
  }

  private buildTotalsCorrectionPreview(
    id: number,
    invoice: PurchaseInvoice,
    isVatRegistered: boolean,
  ): PurchaseInvoiceTotalsCorrectionPreview {
    if (invoice.status !== "PROJECT") {
      throw new PurchaseInvoiceTotalsCorrectionError("correction_invoice_not_project");
    }
    if (invoice.cl_currencies_id?.toUpperCase() !== "EUR") {
      throw new PurchaseInvoiceTotalsCorrectionError("correction_currency_not_supported");
    }
    if (!invoice.items || invoice.items.length === 0) {
      throw new PurchaseInvoiceTotalsCorrectionError("correction_items_missing");
    }
    if (invoice.items.some(item => item.reversed_vat_id !== undefined && item.reversed_vat_id !== null)) {
      throw new PurchaseInvoiceTotalsCorrectionError("correction_reverse_charge_not_supported");
    }

    const itemVat = roundMoney(invoice.items.reduce((sum, item) => sum + (item.vat_amount ?? 0), 0));
    const itemNet = roundMoney(invoice.items.reduce((sum, item) => sum + (item.total_net_price ?? 0), 0));
    const proposedVat = isVatRegistered ? itemVat : 0;
    const proposedGross = roundMoney(itemNet + itemVat);
    const currentVat = invoice.vat_price ?? null;
    const currentGross = invoice.gross_price ?? null;
    const correctionRequired =
      currentVat === null || roundMoney(currentVat) !== proposedVat ||
      currentGross === null || roundMoney(currentGross) !== proposedGross;

    const digestSnapshot = {
      invoice_id: id,
      is_vat_registered: isVatRegistered,
      status: invoice.status,
      net_price: invoice.net_price,
      vat_price: invoice.vat_price,
      gross_price: invoice.gross_price,
      cl_currencies_id: invoice.cl_currencies_id,
      currency_rate: invoice.currency_rate,
      base_net_price: invoice.base_net_price,
      base_vat_price: invoice.base_vat_price,
      base_gross_price: invoice.base_gross_price,
      proposed_vat_price: proposedVat,
      proposed_gross_price: proposedGross,
      correction_required: correctionRequired,
      items: invoice.items,
    };
    const approvalDigest = createHash("sha256")
      .update(canonicalCorrectionJson(digestSnapshot))
      .digest("hex");

    return {
      invoice_id: id,
      is_vat_registered: isVatRegistered,
      current_vat_price: currentVat,
      current_gross_price: currentGross,
      proposed_vat_price: proposedVat,
      proposed_gross_price: proposedGross,
      correction_required: correctionRequired,
      approval_digest: approvalDigest,
    };
  }

  async previewTotalsCorrection(
    id: number,
    isVatRegistered = true,
  ): Promise<PurchaseInvoiceTotalsCorrectionPreview> {
    const invoice = await this.getFreshInvoice(id);
    return this.buildTotalsCorrectionPreview(id, invoice, isVatRegistered);
  }

  /** Confirm without changing totals unless an exact fresh correction preview was approved. */
  async confirmWithTotals(
    id: number,
    isVatRegistered = true,
    options: ConfirmPurchaseInvoiceOptions = {},
  ): Promise<ApiResponse> {
    if (!options.recalculateTotals) {
      if (options.approvedCorrection !== undefined) {
        throw new PurchaseInvoiceTotalsCorrectionError("correction_preview_mismatch");
      }
      return this.confirm(id);
    }
    if (options.approvedCorrection === undefined) {
      throw new PurchaseInvoiceTotalsCorrectionError("correction_preview_required");
    }
    if (!isCorrectionPreview(options.approvedCorrection)) {
      throw new PurchaseInvoiceTotalsCorrectionError("correction_preview_mismatch");
    }

    const invoice = await this.getFreshInvoice(id);
    const freshPreview = this.buildTotalsCorrectionPreview(id, invoice, isVatRegistered);
    if (canonicalCorrectionJson(options.approvedCorrection) !== canonicalCorrectionJson(freshPreview)) {
      throw new PurchaseInvoiceTotalsCorrectionError("correction_preview_mismatch");
    }

    if (freshPreview.correction_required) {
      await this.update(id, {
        vat_price: freshPreview.proposed_vat_price,
        gross_price: freshPreview.proposed_gross_price,
        items: invoice.items,
      });
    }
    return this.confirm(id);
  }

  /** `POST /documents/:id/confirm` (plan R4a Task 25, spec §2.3) — registering a
   * purchase invoice creates a journal entry server-side and can flip payment_status
   * on a linked transaction, so both caches are busted alongside this resource's own. */
  async confirm(id: number): Promise<ApiResponse> {
    const crmId = (await this.crmIdMap.toCrm("document", [id]))[0]!;
    const result = await this.mutate<{ entryId: string }>(
      "confirm", id, `${this.basePath}:${id}:confirm`, [this.basePath, "/journals", "/transactions"],
      () => this.client.post<{ entryId: string }>(`/documents/${crmId}/confirm`, {}),
    );
    const entryId = (await this.crmIdMap.toNumeric("entry", [result.entryId]))[0];
    return { code: 200, created_object_id: entryId, messages: [] };
  }

  /**
   * RIK's one `/invalidate` route covered both a draft and a registered invoice; the
   * CRM splits the two (spec R4a Task 25): a DRAFT document has no journal entry yet,
   * so the only way to discard it is `DELETE /documents/:id` (the same route
   * `TransactionsApi.invalidate` needs a confirmed document for, transactions.api.ts:274-289,
   * has no equivalent for — a draft here is simply removed); a POSTED document is
   * reversed via `POST /documents/:id/invalidate`, mirroring journals.api.ts:250-260.
   */
  async invalidate(id: number): Promise<ApiResponse> {
    const crmId = (await this.crmIdMap.toCrm("document", [id]))[0]!;
    const doc = await this.client.get<CrmDraftDocument>(`/documents/${crmId}`);
    if (doc.status === "DRAFT") {
      await this.mutate(
        "delete", id, `${this.basePath}:${id}:invalidate`, [this.basePath, "/journals", "/transactions"],
        () => this.client.delete(`/documents/${crmId}`),
      );
      return { code: 200, messages: [] };
    }
    const result = await this.mutate<{ entryId: string }>(
      "invalidate", id, `${this.basePath}:${id}:invalidate`, [this.basePath, "/journals", "/transactions"],
      () => this.client.post<{ entryId: string }>(`/documents/${crmId}/invalidate`, {
        reason: "invalidated by the approved plan", entryDate: todayTallinn(),
      }),
    );
    const entryId = (await this.crmIdMap.toNumeric("entry", [result.entryId]))[0];
    return { code: 200, created_object_id: entryId, messages: [] };
  }

  // getDocument / deleteDocument / uploadDocument now all come from
  // `BaseResource`'s document-backed branch (`this.documents` set in the
  // constructor above), the same as `SaleInvoicesApi`: getDocument/deleteDocument
  // refuse honestly (the CRM's only file route, `POST /documents/:id/file`,
  // has no matching GET/DELETE — base-resource.ts), and uploadDocument resolves
  // the `path` it needs from the CRM's own extraction record (`GET
  // /extractions/:sha256`, spec R4a Task 30) before `POST /documents/:id/file`.
  // document-methods.test.ts pins all three.
}
