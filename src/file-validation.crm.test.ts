import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

describe("file roots under the crm target (I4)", () => {
  afterEach(() => { delete process.env.CRM_API_URL; delete process.env.CRM_MCP_ATTACHMENTS; });
  it("reads only from the attachment store, never cwd, tmp or home", async () => {
    const store = mkdtempSync(join(tmpdir(), "att-"));
    process.env.CRM_API_URL = "http://crm/api/crm-mcp";
    process.env.CRM_MCP_ATTACHMENTS = store;
    const { getAllowedRootsForTesting } = await import("./file-validation.js");
    const roots = getAllowedRootsForTesting();
    expect(roots).toHaveLength(1);
    expect(roots[0]).toContain("att-");
    expect(roots).not.toContain(process.cwd());
  });
});
