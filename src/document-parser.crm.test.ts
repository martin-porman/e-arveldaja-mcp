import { mkdtempSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const constructed = vi.fn();
vi.mock("@llamaindex/liteparse", () => ({ LiteParse: vi.fn(() => { constructed(); throw new Error("must not construct a local parser under the crm target"); }) }));
vi.mock("./audit-log.js", () => ({ logAudit: vi.fn() }));

import { parseDocument, setCrmExtractionSource } from "./document-parser.js";
import { extractReceiptFieldsFromCrmFields, shouldUseCrmFields } from "./tools/receipt-extraction.js";

const store = mkdtempSync(join(tmpdir(), "att-"));
const file = join(store, "invoice.pdf");
writeFileSync(file, "%PDF-1.4 fake bytes");
const sha = createHash("sha256").update("%PDF-1.4 fake bytes").digest("hex");

describe("F8: the crm OCR provider", () => {
  afterEach(() => { delete process.env.CRM_API_URL; delete process.env.CRM_MCP_ATTACHMENTS; constructed.mockClear(); });
  it("reads the CRM's 2-tier extraction by the file's sha256 and never runs local OCR", async () => {
    process.env.CRM_API_URL = "http://crm/api/crm-mcp";
    process.env.CRM_MCP_ATTACHMENTS = store;
    const fetchRecord = vi.fn(async (s: string) => ({ sha256: s, textLayer: "Arve A-17\nKokku 124,00 EUR\nSupplier OÜ 12345678", fields: { total: "124.00", date: "2026-02-03", supplierName: "Supplier OÜ" }, tier: "flash", provenance: { model: "gemini", at: "2026-09-26T08:00:00Z", ref: "incoming_invoice:x" } }));
    setCrmExtractionSource(fetchRecord);
    const parsed = await parseDocument(file);
    expect(fetchRecord).toHaveBeenCalledWith(sha);
    expect(parsed.text).toContain("Kokku 124,00 EUR");
    expect(constructed).not.toHaveBeenCalled();
  });
  it("without a CRM record it says the engine's OCR step runs first — no fallback", async () => {
    process.env.CRM_API_URL = "http://crm/api/crm-mcp";
    process.env.CRM_MCP_ATTACHMENTS = store;
    setCrmExtractionSource(async () => null);
    await expect(parseDocument(file)).rejects.toThrow(/no CRM extraction for this document yet — the engine's OCR step runs first/);
    expect(constructed).not.toHaveBeenCalled();
  });

  // E2E-FIX B2: 23 of 41 live extraction records carry `textLayer: null` (an
  // image receipt) but full structured `fields` from the CRM's own OCR — this
  // used to throw "has no text layer yet" (turned into status "failed" by
  // processSingleReceipt). It must now carry those fields through instead.
  it("textLayer: null + structured fields yields a ParsedDocument whose receipt extraction gives the Kesko live-record values", async () => {
    process.env.CRM_API_URL = "http://crm/api/crm-mcp";
    process.env.CRM_MCP_ATTACHMENTS = store;
    setCrmExtractionSource(async (s) => ({
      sha256: s,
      textLayer: null,
      fields: {
        supplierName: "AS Kesko Senukai Estonia",
        supplierRegNo: "10026621",
        supplierVatNumber: "EE100269136",
        invoiceNumber: "E309 20260103 04 084460",
        amount: 18.60,
        netAmount: 14.99,
        vatAmount: 3.60,
        currency: "EUR",
        invoiceDate: "2026-01-03",
        lineItems: [
          { description: "Item one", quantity: 1, unit: null, unitPrice: 5, vatRatePercent: 24, lineTotal: 5 },
          { description: "Item two", quantity: 1, unit: null, unitPrice: 9.99, vatRatePercent: 24, lineTotal: 9.99 },
        ],
      },
      tier: "2",
      provenance: { confidence: "medium", accepted: true, failedChecks: [], unverified: [], costUsd: 0.017, readFor: {}, readAt: "2026-09-26T08:00:00Z" },
    }));
    const parsed = await parseDocument(file);
    expect(parsed.text).toBe("");
    expect(parsed.crmFields?.tier).toBe("2");
    expect(parsed.crmFields?.confidence).toBe("medium");
    expect(shouldUseCrmFields(parsed)).toBe(true);
    const extracted = extractReceiptFieldsFromCrmFields(parsed.crmFields!, "receipt.jpg");
    expect(extracted).toMatchObject({
      supplier_name: "AS Kesko Senukai Estonia",
      supplier_reg_code: "10026621",
      supplier_vat_no: "EE100269136",
      invoice_number: "E309 20260103 04 084460",
      total_net: 14.99,
      total_vat: 3.60,
      total_gross: 18.60,
    });
    expect(constructed).not.toHaveBeenCalled();
  });

  it("textLayer: null + no fields still refuses, unchanged", async () => {
    process.env.CRM_API_URL = "http://crm/api/crm-mcp";
    process.env.CRM_MCP_ATTACHMENTS = store;
    setCrmExtractionSource(async (s) => ({
      sha256: s, textLayer: null, fields: {}, tier: "1", provenance: {},
    }));
    await expect(parseDocument(file)).rejects.toThrow(/has no text layer yet — the engine's OCR step runs first/);
    expect(constructed).not.toHaveBeenCalled();
  });
});
