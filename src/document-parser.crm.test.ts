import { mkdtempSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const constructed = vi.fn();
vi.mock("@llamaindex/liteparse", () => ({ LiteParse: vi.fn(() => { constructed(); throw new Error("must not construct a local parser under the crm target"); }) }));
vi.mock("./audit-log.js", () => ({ logAudit: vi.fn() }));

import { parseDocument, setCrmExtractionSource } from "./document-parser.js";

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
});
