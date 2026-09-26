import { randomUUID } from "node:crypto";
import { HttpError, type HttpClient } from "../http-client.js";
import type {
  SaleInvoice, SaleInvoiceItem, SaleInvoiceDeliveryOptions, SaleInvoiceDeliveryRequest, ApiResponse, ApiFile,
} from "../types/api.js";
import type { CreateSaleInvoiceRequest, UpdateSaleInvoiceRequest } from "../types/mutations.js";
import { BaseResource, type CrmDocument, type CrmDocumentLine } from "./base-resource.js";
import { roundMoney } from "../money.js";
import { IdMap } from "../crm/id-map.js";
import { VAT_MAP, vatCodeFor } from "../crm/vat-map.js";
import type { CrmCounterparty } from "../crm/mappers.js";

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

function daysBetweenUtc(fromDate: string, toDate: string): number {
  const [fy, fm, fd] = fromDate.split("-").map(Number) as [number, number, number];
  const [ty, tm, td] = toDate.split("-").map(Number) as [number, number, number];
  const from = Date.UTC(fy, fm - 1, fd);
  const to = Date.UTC(ty, tm - 1, td);
  return Math.round((to - from) / 86_400_000);
}

function todayTallinn(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Europe/Tallinn" });
}

/** `S24` → `24`, `POUT`/`S0EX` → `0`, an unknown code → `0` (a finding, not a guess: only
 * `vatCodeFor`-produced codes are ever stored, so this only happens for a document this
 * fork itself never wrote — e.g. seeded test/demo data). */
function rateFromVatCode(code: string | null): number {
  if (!code) return 0;
  const row = VAT_MAP.find((r) => r.code === code);
  return row ? Number(row.rate) : 0;
}

type CrmLine = {
  description: string; quantity: string | null; unitPrice: string | null; net: string;
  side: null; vatCode: string; vatAmount: string; accountCode: string; dimensionId: string | null;
};

const SWITCHED_OFF = "switched off: outbound e-invoicing is not part of R4";
function switchedOff(): never {
  throw new HttpError(SWITCHED_OFF, 501, "POST", "/sale_invoices");
}

/**
 * RIK's `SaleInvoicesApi` over the CRM's `/documents` (`kind` SALE_INVOICE/SALE_CREDIT),
 * plan R4a Task 25, spec §2.3 ("SaleInvoicesApi create/update/confirm/invalidate/delete
 * as above with SALE_INVOICE/SALE_CREDIT"). `list`/`get`/`delete`/the document_user
 * family come from `BaseResource`'s document-backed opt-in (base-resource.ts); this
 * class supplies `fromDocument` and the writes, following `JournalsApi`'s pattern
 * (journals.api.ts:198-238) rather than the RIK-shaped generic CRUD.
 *
 * Finding: a sale invoice carries no source-document field in this fork (no
 * `crm_source`-shaped input, unlike `CreatePurchaseInvoiceData` — plan R4a Task 25 adds
 * `crm_source` only to purchases), so `sourceKeyFor` would refuse every sale create.
 * Every created document instead gets `sourceKey: manual:<uuid>`, the same fallback
 * `JournalsApi.sourceKeyAndNumber` uses for an untagged journal (journals.api.ts:98-104).
 */
export class SaleInvoicesApi extends BaseResource<SaleInvoice> {
  private readonly crmIdMap: IdMap;

  constructor(client: HttpClient) {
    super(client, "/sale_invoices", { kinds: ["SALE_INVOICE", "SALE_CREDIT"] });
    this.crmIdMap = new IdMap(client);
  }

  protected override fromDocument(doc: CrmDocument, id: number, clientsId: number | null): SaleInvoice {
    const netTotal = roundMoney(doc.lines.reduce((s, l) => s + Number(l.net), 0));
    const vatTotal = roundMoney(doc.lines.reduce((s, l) => s + Number(l.vatAmount), 0));
    return {
      id,
      // Findings: `cl_templates_id`/`cl_countries_id` (RIK's invoice-template selector
      // and its own-company country) have no CRM equivalent — this single-tenant CRM
      // has no invoice templates. Hardcoded placeholders, not invented business data.
      cl_templates_id: 0,
      cl_countries_id: "EST",
      sale_invoice_type: doc.kind === "SALE_CREDIT" ? "CREDIT_INVOICE" : "INVOICE",
      clients_id: clientsId ?? 0,
      number_suffix: doc.number,
      number: doc.number,
      create_date: doc.docDate,
      journal_date: doc.turnoverDate,
      status: doc.status === "DRAFT" ? "PROJECT" : doc.status === "POSTED" ? "CONFIRMED" : "INVALIDATED",
      net_price: netTotal,
      gross_price: roundMoney(netTotal + vatTotal),
      term_days: doc.dueDate ? daysBetweenUtc(doc.docDate, doc.dueDate) : 0,
      notes: doc.description || null,
      cl_currencies_id: "EUR",
      // Finding: `show_client_balance` is a RIK invoice-PDF display toggle with no CRM
      // field; defaulted off rather than guessed.
      show_client_balance: false,
      // Finding: resolving `doc.creditsDocumentId` to a numeric id needs another
      // idMap round trip per row — not wired for R4a Task 25.
      credit_sale_invoices_id: null,
      items: doc.lines.map((l) => this.itemFromLine(l)),
    };
  }

  private itemFromLine(l: CrmDocumentLine): SaleInvoiceItem {
    return {
      // Finding: a CRM document line carries an `accountCode`, not a catalogue
      // `products_id` — there is no reverse mapping from account back to product.
      products_id: 0,
      custom_title: l.description,
      amount: l.quantity != null ? Number(l.quantity) : 1,
      unit_net_price: l.unitPrice != null ? Number(l.unitPrice) : undefined,
      total_net_price: Number(l.net),
      vat_amount: Number(l.vatAmount),
      vat_rate: rateFromVatCode(l.vatCode),
    };
  }

  /** Shared by `create`/`update`: every item's VAT mapped to a core v2 code via
   * `vatCodeFor` before any write (spec R4a Task 25) — the first refusal throws
   * before the caller's data reaches the CRM at all. */
  private async buildLines(items: SaleInvoiceItem[], partyCountry: string, turnoverDate: string): Promise<{ lines: CrmLine[]; netTotal: number; vatTotal: number }> {
    const lines: CrmLine[] = [];
    let netTotal = 0;
    let vatTotal = 0;
    for (let i = 0; i < items.length; i++) {
      const item = items[i]!;
      const rate = item.vat_rate != null ? String(item.vat_rate) : null;
      const mapped = vatCodeFor({ direction: "OUT", rate, reversed: false, partyCountry, turnoverDate, explicit: item.crm_vat_code ?? null });
      if ("problem" in mapped) throw new HttpError(`line ${i + 1}: ${mapped.problem}`, 422, "POST", "/documents");

      const net = item.total_net_price ?? roundMoney((item.unit_net_price ?? 0) * (item.amount ?? 1));
      const vatAmount = item.vat_amount !== undefined ? item.vat_amount : roundMoney(net * ((item.vat_rate ?? 0) / 100));
      const accountCode = item.sale_accounts_id != null
        ? (await this.crmIdMap.toCrm("account", [item.sale_accounts_id]))[0]!
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

  override async create(data: CreateSaleInvoiceRequest): Promise<ApiResponse> {
    const counterpartyId = data.clients_id != null
      ? (await this.crmIdMap.toCrm("counterparty", [data.clients_id]))[0]!
      : null;
    const counterparty = counterpartyId
      ? await this.client.get<CrmCounterparty>(`/counterparties/${counterpartyId}`)
      : null;
    const docDate = data.create_date ?? todayTallinn();
    const turnoverDate = data.journal_date ?? docDate;
    const { lines } = await this.buildLines(data.items ?? [], counterparty?.country ?? "EE", turnoverDate);
    const creditsDocumentId = data.credit_sale_invoices_id != null
      ? (await this.crmIdMap.toCrm("document", [data.credit_sale_invoices_id]))[0]!
      : null;
    const sourceKey = `manual:${randomUUID()}`;

    const body = {
      kind: creditsDocumentId ? ("SALE_CREDIT" as const) : ("SALE_INVOICE" as const),
      sourceKey,
      // Finding: `number` is RIK server-managed (auto-numbered, types/mutations.ts:120)
      // and there is no CRM number-series route to allocate one from — `number_suffix`
      // (a real, caller-settable field) is used when given, else the sourceKey.
      number: data.number_suffix ?? sourceKey,
      counterpartyId,
      docDate,
      turnoverDate,
      dueDate: data.term_days != null ? addDaysUtc(docDate, data.term_days) : null,
      description: data.notes ?? "",
      creditsDocumentId,
      lines,
    };
    const created = await this.mutate<{ id: string; created: boolean }>(
      "create", undefined, `${this.basePath}:create`, [this.basePath],
      () => this.client.post<{ id: string; created: boolean }>("/documents", body),
    );
    const numericId = (await this.crmIdMap.toNumeric("document", [created.id]))[0]!;
    return { code: 200, created_object_id: numericId, messages: [] };
  }

  /** The CRM's `PATCH /documents/:id` replaces the whole draft (writes-documents.ts:233-253,
   * `sourceKey` immutable) — existing fields are read back first and only the caller's
   * changes are merged in, mirroring `JournalsApi.update` (journals.api.ts:218-238). */
  override async update(id: number, data: UpdateSaleInvoiceRequest): Promise<ApiResponse> {
    const crmId = (await this.crmIdMap.toCrm("document", [id]))[0]!;
    const existing = await this.client.get<CrmDocument>(`/documents/${crmId}`);
    const counterpartyId = data.clients_id !== undefined
      ? (data.clients_id != null ? (await this.crmIdMap.toCrm("counterparty", [data.clients_id]))[0]! : null)
      : existing.counterpartyId;
    let lines = existing.lines as CrmLine[];
    if (data.items) {
      const counterparty = counterpartyId ? await this.client.get<CrmCounterparty>(`/counterparties/${counterpartyId}`) : null;
      const turnoverDate = data.journal_date ?? existing.turnoverDate;
      ({ lines } = await this.buildLines(data.items, counterparty?.country ?? "EE", turnoverDate));
    }
    const body = {
      kind: existing.kind, sourceKey: existing.sourceKey!, number: data.number_suffix ?? existing.number,
      counterpartyId,
      docDate: data.create_date ?? existing.docDate,
      turnoverDate: data.journal_date ?? existing.turnoverDate,
      dueDate: existing.dueDate,
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

  /** `POST /documents/:id/confirm` (spec R4a Task 25, §2.3). */
  async confirm(id: number): Promise<ApiResponse> {
    const crmId = (await this.crmIdMap.toCrm("document", [id]))[0]!;
    const result = await this.mutate<{ entryId: string }>(
      "confirm", id, `${this.basePath}:${id}:confirm`, [this.basePath, "/journals"],
      () => this.client.post<{ entryId: string }>(`/documents/${crmId}/confirm`, {}),
    );
    const entryId = (await this.crmIdMap.toNumeric("entry", [result.entryId]))[0];
    return { code: 200, created_object_id: entryId, messages: [] };
  }

  /** Splits on CRM document status like `PurchaseInvoicesApi.invalidate`
   * (purchase-invoices.api.ts): a DRAFT has no journal entry, so it is simply
   * `DELETE`d; a POSTED document is reversed via `POST /documents/:id/invalidate`. */
  async invalidate(id: number): Promise<ApiResponse> {
    const crmId = (await this.crmIdMap.toCrm("document", [id]))[0]!;
    const doc = await this.client.get<{ status: "DRAFT" | "POSTED" | "REVERSED" }>(`/documents/${crmId}`);
    if (doc.status === "DRAFT") {
      await this.mutate(
        "delete", id, `${this.basePath}:${id}:invalidate`, [this.basePath, "/journals"],
        () => this.client.delete(`/documents/${crmId}`),
      );
      return { code: 200, messages: [] };
    }
    const result = await this.mutate<{ entryId: string }>(
      "invalidate", id, `${this.basePath}:${id}:invalidate`, [this.basePath, "/journals"],
      () => this.client.post<{ entryId: string }>(`/documents/${crmId}/invalidate`, {
        reason: "invalidated by the approved plan", entryDate: todayTallinn(),
      }),
    );
    const entryId = (await this.crmIdMap.toNumeric("entry", [result.entryId]))[0];
    return { code: 200, created_object_id: entryId, messages: [] };
  }

  // Outbound e-invoicing is switched off (spec R4a Task 25): the CRM-MCP has no
  // delivery/PDF/XML route at all (crm/src/lib/crm-mcp reads.ts/writes-*.ts have no
  // such pattern) — refused honestly rather than simulated.
  async getDeliveryOptions(_id: number): Promise<SaleInvoiceDeliveryOptions> {
    return switchedOff();
  }

  async getSystemPdf(_id: number): Promise<ApiFile> {
    return switchedOff();
  }

  async getSystemXml(_id: number): Promise<ApiFile> {
    return switchedOff();
  }

  async sendEinvoice(_id: number, _request: SaleInvoiceDeliveryRequest): Promise<ApiResponse> {
    return switchedOff();
  }
}
