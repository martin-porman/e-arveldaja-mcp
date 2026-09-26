// F9: the guided bank facade must not reach Wise under the crm target.
//
// `createAccountingWorkflowWorkspace` (src/__fixtures__/accounting-workflow.ts)
// returns the workspace root as a plain string, not an object — it has dozens
// of existing callers elsewhere (src/tools/accounting-inbox.test.ts) that rely
// on that exact shape, so this test does not widen that fixture. It reuses the
// workspace's `<root>/wise/transaction-history.csv` path, but overwrites the
// content: the shared fixture's `fixtureWiseCsv()` is intentionally a minimal
// 3-column stub for folder-presence tests, not a preflight-valid statement, so
// `detectBankInputFormat` would report it "unsupported" rather than "wise"
// (see the full header in src/banking/input-format.test.ts's local
// `validWiseCsv()`, mirrored here).
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAccountingWorkflowApi, createAccountingWorkflowWorkspace } from "../__fixtures__/accounting-workflow.js";
import { createTestRuntimeSafetyContext } from "../__fixtures__/runtime-safety.js";
import { registerProcessBankInputTool } from "./process-bank-input.js";

function validWiseCsv(): string {
  const header = [
    "ID", "Status", "Direction", "Created on", "Finished on",
    "Source fee amount", "Source fee currency", "Target fee amount", "Target fee currency",
    "Source name", "Source amount (after fees)", "Source currency",
    "Target name", "Target amount (after fees)", "Target currency",
    "Exchange rate", "Reference", "Category", "Note",
  ].join(",");
  const row = [
    "WISE-1", "COMPLETED", "OUT", "2026-01-10 10:00:00", "2026-01-10 10:00:00",
    "0", "EUR", "0", "EUR",
    "MyCo", "100", "EUR",
    "Acme", "100", "EUR",
    "1", "inv-1", "General", "note",
  ].join(",");
  return `${header}\n${row}\n`;
}

describe("process_bank_input under the crm target", () => {
  afterEach(() => { delete process.env.CRM_API_URL; delete process.env.CRM_MCP_ATTACHMENTS; });
  it("refuses a Wise CSV as switched off, before any import", async () => {
    process.env.CRM_API_URL = "http://crm/api/crm-mcp";
    const workspace = await createAccountingWorkflowWorkspace({ includeCamt: false, includeWise: true, includeReceipts: false });
    const wiseCsvPath = join(workspace, "wise", "transaction-history.csv");
    await writeFile(wiseCsvPath, validWiseCsv());
    // (I4) Under the crm target the only allowed file root is the attachment
    // store (CRM_MCP_ATTACHMENTS) — see src/file-validation.crm.test.ts.
    process.env.CRM_MCP_ATTACHMENTS = workspace;
    const server = { registerTool: vi.fn() } as any;
    const api = createAccountingWorkflowApi({ transactionRows: [] });
    registerProcessBankInputTool(server, api, createTestRuntimeSafetyContext(), {});
    const handler = server.registerTool.mock.calls.find(([n]: [string]) => n === "process_bank_input")[2];
    const r = await handler({ file_path: wiseCsvPath, mode: "prepare" }, {});
    expect(JSON.stringify(r)).toMatch(/Wise import is switched off in the CRM-MCP/);
    expect(api.transactions.create).not.toHaveBeenCalled();
  });
});
