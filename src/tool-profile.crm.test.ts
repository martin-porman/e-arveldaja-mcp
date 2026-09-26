import { afterEach, describe, expect, it } from "vitest";
import { CRM_TOOL_NAMES, GUIDED_TOOL_NAMES, isToolVisibleForProfile, parseToolProfile } from "./tool-profile.js";

describe("the crm profile (F9)", () => {
  afterEach(() => { delete process.env.CRM_API_URL; });
  it("is the default whenever the CRM target is set, and the only one allowed there", () => {
    expect(parseToolProfile({ CRM_API_URL: "http://crm/api/crm-mcp" } as NodeJS.ProcessEnv)).toBe("crm");
    expect(() => parseToolProfile({ CRM_API_URL: "http://crm/api/crm-mcp", EARVELDAJA_PROFILE: "full" } as NodeJS.ProcessEnv)).toThrow(/the CRM-MCP runs the crm profile only/);
    expect(parseToolProfile({} as NodeJS.ProcessEnv)).toBe("standard");
  });
  it("lists 18 tools: the guided 19, plus the two account tools, minus the connection and setup tools", () => {
    expect(CRM_TOOL_NAMES).toHaveLength(18);
    for (const hidden of ["list_connections", "switch_connection", "get_setup_instructions"]) expect(isToolVisibleForProfile(hidden, "crm")).toBe(false);
    for (const shown of ["create_account", "propose_account_deactivate", "accounting_inbox", "continue_accounting_workflow"]) expect(isToolVisibleForProfile(shown, "crm")).toBe(true);
    expect(isToolVisibleForProfile("import_wise_transactions", "crm")).toBe(false);
    expect(GUIDED_TOOL_NAMES).toHaveLength(19);
  });
});
