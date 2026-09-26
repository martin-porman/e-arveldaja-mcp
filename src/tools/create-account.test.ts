import { describe, expect, it, vi } from "vitest";
import { createMockToolServer, getRegisteredToolHandler } from "../__fixtures__/accounting-workflow.js";
import { registerCreateAccountTools } from "./create-account.js";

const args = { code: "8610", name_et: "Muud finantskulud", parent_code: "60", type: "EXPENSE", normal_side: "D", category: "operating_expense", role: "FIN_EXPENSE_OTHER", reason: "bank fees have no account", evidence: { lines: 3 } };

describe("create_account (F5): created as proposed, no approval", () => {
  it("sends exactly the CRM body and returns the account in RIK shape", async () => {
    const createAccount = vi.fn(async () => ({ code: "8610", nameEt: "Muud finantskulud", nameEn: null, parentCode: "60", type: "EXPENSE", normalSide: "D", category: "operating_expense", isHeading: false, requiresCounterparty: false, isVatAccount: false, allowsDimension: false, isActive: true, roles: ["FIN_EXPENSE_OTHER"], createdBy: "agent" }));
    const server = createMockToolServer();
    registerCreateAccountTools(server, { crm: { createAccount } } as never);
    const r = await getRegisteredToolHandler(server, "create_account")(args as never, {} as never);
    expect(createAccount).toHaveBeenCalledWith({ code: "8610", nameEt: "Muud finantskulud", parentCode: "60", type: "EXPENSE", normalSide: "D", category: "operating_expense", role: "FIN_EXPENSE_OTHER", reason: "bank fees have no account", evidence: { lines: 3 } });
    expect(JSON.stringify(r)).toMatch(/"id":8610/);
    expect(JSON.stringify(r)).toMatch(/FIN_EXPENSE_OTHER/);
  });
  it("surfaces the CRM's refusal as the tool's (fenced) error", async () => {
    const createAccount = vi.fn(async () => { throw Object.assign(new Error("CRM 400"), { status: 400, upstream_detail: "8610 already exists" }); });
    const server = createMockToolServer();
    registerCreateAccountTools(server, { crm: { createAccount } } as never);
    const r = await getRegisteredToolHandler(server, "create_account")(args as never, {} as never);
    expect(r.isError).toBe(true);
    expect(JSON.stringify(r)).toMatch(/8610 already exists/);
  });
  it("refuses a missing category before any request", async () => {
    const createAccount = vi.fn();
    const server = createMockToolServer();
    registerCreateAccountTools(server, { crm: { createAccount } } as never);
    const { category: _category, ...argsWithoutCategory } = args;
    const r = await getRegisteredToolHandler(server, "create_account")(argsWithoutCategory as never, {} as never);
    expect(createAccount).not.toHaveBeenCalled();
    expect(r.isError).toBe(true);
    expect(JSON.stringify(r)).toMatch(/category/);
  });
});

describe("propose_account_deactivate: approval-only", () => {
  it("returns a card with a plan handle and writes nothing", async () => {
    const deactivate = vi.fn();
    const server = createMockToolServer();
    registerCreateAccountTools(server, { crm: { createAccount: vi.fn(), deactivateAccount: deactivate } } as never);
    const r = await getRegisteredToolHandler(server, "propose_account_deactivate")({ code: "8610", reason: "duplicate of 8600" } as never, {} as never);
    expect(deactivate).not.toHaveBeenCalled();
    expect(JSON.stringify(r)).toMatch(/plan_handle/);
    expect(JSON.stringify(r)).toMatch(/approval_required/);
  });
});
