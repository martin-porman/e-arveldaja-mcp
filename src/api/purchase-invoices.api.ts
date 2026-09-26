import { createHash } from "node:crypto";
import { HttpError, type HttpClient } from "../http-client.js";
import type { PurchaseInvoice, CreatePurchaseInvoiceData, ApiResponse } from "../types/api.js";
import type { CreatePurchaseInvoiceRequest, UpdatePurchaseInvoiceRequest } from "../types/mutations.js";
import { BaseResource } from "./base-resource.js";
import { roundMoney, parseVatRateDropdown } from "../money.js";
import { IdMap } from "../crm/id-map.js";
import { vatCodeFor } from "../crm/vat-map.js";
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
    super(client, "/purchase_invoices");
    this.crmIdMap = new IdMap(client);
  }

  // Narrow the create/update boundary from `Partial<PurchaseInvoice>` to request
  // types that omit server-managed fields (id, status, payment_status,
  // journals/settlements/transactions back-refs, …). Delegates to the base
  // mutate/cache logic; the internal createAndSetTotals / confirmWithTotals paths
  // call through these overrides unchanged.
  override async create(data: CreatePurchaseInvoiceRequest): Promise<ApiResponse> {
    return super.create(data);
  }

  override async update(id: number, data: UpdatePurchaseInvoiceRequest): Promise<ApiResponse> {
    return super.update(id, data);
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

    type CrmLine = {
      description: string; quantity: string | null; unitPrice: string | null; net: string;
      side: null; vatCode: string; vatAmount: string; accountCode: string; dimensionId: string | null;
    };
    const lines: CrmLine[] = [];
    let netTotal = 0;
    let vatTotal = 0;
    for (let i = 0; i < data.items.length; i++) {
      const item = data.items[i]!;
      const rate = item.vat_rate_dropdown ?? (item.vat_rate != null ? String(item.vat_rate) : null);
      const reversed = item.reversed_vat_id != null;
      const mapped = vatCodeFor({
        direction: "IN", rate, reversed, partyCountry: counterparty.country, turnoverDate,
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

  // getDocument / deleteDocument stay inherited from BaseResource, unchanged
  // (/purchase_invoices/:id/document_user) — document-methods.test.ts pins them.

  /**
   * `POST /documents/:id/file` needs a `{ path, sha256 }` of a file the CRM already
   * has on disk under CRM_MCP_ATTACHMENTS (crm/src/lib/crm-mcp/writes-documents.ts:255-283).
   * Finding: this fork has no route to learn that `path` — it comes from the CRM's
   * extraction record, which Task 30 wires up. Hashing the caller's base64 `contents`
   * now (so Task 30 only has to plug in the path) and refusing honestly rather than
   * inventing a path. Consequence: every booking flow that uploads right after create
   * (pdf-workflow.ts:1031, receipt-inbox-booking.ts:293, documents/operations.ts:575)
   * will hit this 501 and roll back (invalidate) the invoice it just created, until
   * Task 30 lands.
   */
  override async uploadDocument(id: number, _name: string, contents: string): Promise<ApiResponse> {
    const sha256 = createHash("sha256").update(Buffer.from(contents, "base64")).digest("hex");
    throw new HttpError(
      `purchase_invoices/${id}: POST /documents/:id/file needs a { path, sha256 } inside CRM_MCP_ATTACHMENTS — ` +
      `the fork has no source for that on-disk path until Task 30 wires the CRM extraction record ` +
      `(sha256 of the given contents: ${sha256})`,
      501, "PUT", `/purchase_invoices/${id}/document_user`,
    );
  }
}
