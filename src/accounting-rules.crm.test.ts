import { afterEach, describe, expect, it } from "vitest";
import { findAutoBookingRule, initCrmRules, loadAccountingRules, saveAutoBookingRule } from "./accounting-rules.js";

function sink() {
  const puts: { key: string; rule: unknown }[] = [];
  return { puts, save: (key: string, rule: unknown) => void puts.push({ key, rule }), flush: async () => {} };
}
const rule = (match: string, status: "approved" | "pending") => ({ key: `auto:${match}`, status, rule: { match, purchase_account_id: 4000, reason: "test" } });

describe("F6: learned rules live in the CRM; only approved ones are used", () => {
  afterEach(() => { delete process.env.CRM_API_URL; });
  it("uses approved rules and ignores pending ones", () => {
    process.env.CRM_API_URL = "http://crm/api/crm-mcp";
    initCrmRules([rule("zone media", "approved"), rule("hetzner", "pending")], sink());
    expect(findAutoBookingRule("zone media ou")?.match).toBe("zone media");
    expect(findAutoBookingRule("hetzner online gmbh")).toBeUndefined();
    expect(loadAccountingRules().auto_booking?.counterparties?.map((r) => r.match)).toEqual(["zone media"]);
  });
  it("a saved rule goes to the CRM as pending and is not used until approved", () => {
    process.env.CRM_API_URL = "http://crm/api/crm-mcp";
    const s = sink();
    initCrmRules([], s);
    const r = saveAutoBookingRule({ match: "Telia Eesti", purchase_account_id: 5230, reason: "telecom" });
    expect(r.path).toBe("crm:rules/auto:telia eesti");
    expect(s.puts).toEqual([{ key: "auto:telia eesti", rule: expect.objectContaining({ match: "Telia Eesti", purchase_account_id: 5230 }) }]);
    expect(findAutoBookingRule("telia eesti as")).toBeUndefined();
  });
});
