import { describe, expect, it } from "vitest";
import { buildConnectionFingerprint } from "../connection-fingerprint.js";
import { crmNamedConfig } from "./crm-config.js";

const env = { CRM_API_URL: "http://app:3005/api/crm-mcp", CRM_MCP_SERVICE_TOKEN: "t".repeat(43) };

describe("the crm connection", () => {
  it("is one named connection whose fingerprint ignores the per-phase step token", () => {
    const a = crmNamedConfig({ ...env, CRM_STEP_TOKEN: "prepare-token" })!;
    const b = crmNamedConfig({ ...env, CRM_STEP_TOKEN: "execute-token" })!;
    expect(a.name).toBe("crm");
    expect(buildConnectionFingerprint(a.config)).toBe(buildConnectionFingerprint(b.config));
    expect(a.config.apiPublicValue).not.toContain("t".repeat(8));
  });
  it("is absent without CRM_API_URL and refuses a short token", () => {
    expect(crmNamedConfig({})).toBeNull();
    expect(() => crmNamedConfig({ ...env, CRM_MCP_SERVICE_TOKEN: "short" })).toThrow(/CRM_MCP_SERVICE_TOKEN/);
  });
});
