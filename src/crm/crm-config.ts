import { createHash } from "node:crypto";
import type { NamedConfig } from "../config.js";

/** The CRM-MCP's single connection (plan R4a; spec §2.5). The step token is NOT part of it. */
export function crmNamedConfig(env: NodeJS.ProcessEnv): NamedConfig | null {
  const baseUrl = env.CRM_API_URL?.trim();
  if (!baseUrl) return null;
  const token = env.CRM_MCP_SERVICE_TOKEN ?? "";
  if (token.length < 32) throw new Error("CRM_MCP_SERVICE_TOKEN is missing or too short");
  return {
    name: "crm",
    config: {
      baseUrl: baseUrl.replace(/\/+$/, ""),
      apiKeyId: "crm-mcp",
      apiPublicValue: createHash("sha256").update(token).digest("hex").slice(0, 16),
      apiPassword: token,
    },
    verifiedCompanyName: null,
  };
}
