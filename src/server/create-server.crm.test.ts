import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The stdio transport just needs to resolve `start()` without touching the
// real process stdin/stdout in a test process — `McpServer.connect()` only
// calls `await transport.start()` and assigns onmessage/onerror/onclose
// (plain property assignment, safe on any object).
vi.mock("@modelcontextprotocol/sdk/server/stdio.js", () => ({
  StdioServerTransport: class {
    start = vi.fn().mockResolvedValue(undefined);
  },
}));

import { createMcpServer } from "./create-server.js";
import { crmNamedConfig } from "../crm/crm-config.js";
import { findAutoBookingRule, resetAccountingRulesCache } from "../accounting-rules.js";
import { setLogger } from "../logger.js";

const CRM_BASE_URL = "http://crm.test/api/crm-mcp";
const SERVICE_TOKEN = "t".repeat(40);
const SERVER_INSTANCE_ID = "s".repeat(43);

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

describe("F6 (Task 29): crm server start hydrates learned rules from the CRM", () => {
  beforeEach(() => {
    process.env.CRM_API_URL = CRM_BASE_URL;
    process.env.CRM_MCP_SERVICE_TOKEN = SERVICE_TOKEN;
  });

  afterEach(() => {
    delete process.env.CRM_API_URL;
    delete process.env.CRM_MCP_SERVICE_TOKEN;
    delete process.env.CRM_STEP_TOKEN;
    vi.unstubAllGlobals();
    // The server under test replaces the process logger with one bound to its
    // own (now-discarded) McpServer instance — restore the default so a later
    // `log(...)` in another test never calls a dead server's sendLoggingMessage.
    setLogger((_level, message) => { process.stderr.write(`${message}\n`); });
    resetAccountingRulesCache();
  });

  it("fetches GET /rules at startup (mocked client) and only the approved rule is live for booking", async () => {
    const putCalls: Array<{ key: string; body: unknown }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const method = (init?.method ?? "GET").toUpperCase();
      const path = url.pathname;

      if (path.includes("/fork/state/")) {
        return jsonResponse({ records: [] });
      }
      if (path.endsWith("/fork/identity")) {
        return jsonResponse({
          serverInstanceId: SERVER_INSTANCE_ID,
          cursorSecret: Buffer.from("x".repeat(32)).toString("base64"),
        });
      }
      if (method === "GET" && path.endsWith("/rules")) {
        return jsonResponse({
          rules: [
            { key: "auto:zone media", status: "approved", rule: { match: "zone media", purchase_account_id: 4000, reason: "test" } },
            { key: "auto:hetzner", status: "pending", rule: { match: "hetzner", purchase_account_id: 4100, reason: "test" } },
          ],
        });
      }
      if (method === "PUT" && /\/rules\/[^/]+$/.test(path)) {
        putCalls.push({ key: decodeURIComponent(path.split("/").pop()!), body: init?.body ? JSON.parse(String(init.body)) : undefined });
        return jsonResponse({ id: "row-1", key: path.split("/").pop(), status: "pending" });
      }
      throw new Error(`Unexpected fetch in crm-hydration test: ${method} ${path}`);
    }));

    const config = crmNamedConfig(process.env as NodeJS.ProcessEnv);
    expect(config).not.toBeNull();

    await createMcpServer({ configs: [config!], connect: true });

    // Hydrated from GET /rules: the approved rule is live for booking, the
    // pending one is retained (spec §4.4 L2 "listed but unused") but never
    // matched by findAutoBookingRule.
    expect(findAutoBookingRule("zone media ou")?.match).toBe("zone media");
    expect(findAutoBookingRule("hetzner online gmbh")).toBeUndefined();
    // No save happened in this test — the sink was bound but never called.
    expect(putCalls).toEqual([]);
  });
});
