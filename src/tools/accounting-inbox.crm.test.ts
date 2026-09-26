import { describe, expect, it, vi } from "vitest";
import { createTestRuntimeSafetyContext } from "../__fixtures__/runtime-safety.js";
import { createAccountingWorkflowApi, createMockToolServer, getRegisteredToolHandler } from "../__fixtures__/accounting-workflow.js";
import { createPublicWorkflowStateDetail } from "../workflow-state-store.js";
import { extractRuleBookingFields, judgmentForAnswer, ruleMatchLabel, registerAccountingInboxTools } from "./accounting-inbox.js";

vi.mock("../audit-log.js", () => ({ logAudit: vi.fn() }));

// What the receipt batch really emits for a needs_review file (buildNeedsReviewResult + extras).
const batchItem = {
  status: "needs_review",
  booking_suggestion: {
    source: "supplier_history",
    item: { custom_title: "Hosting", cl_purchase_articles_id: 7, purchase_accounts_id: 5230, purchase_accounts_dimensions_id: 3, vat_rate_dropdown: "24", reversed_vat_id: null },
    suggested_liability_account_id: 2310,
  },
  supplier_resolution: { found: true, client: { id: 12, name: "Supplier OÜ" } },
};

describe("F4: the receipt-rule fields read what the batch emits", () => {
  it("extracts the booking from booking_suggestion", () => {
    expect(extractRuleBookingFields({ item: batchItem })).toEqual({
      purchase_article_id: 7, purchase_account_id: 5230, purchase_account_dimensions_id: 3, liability_account_id: 2310, vat_rate_dropdown: "24",
    });
  });
  it("still reads the older suggested_booking shape", () => {
    expect(extractRuleBookingFields({ item: { suggested_booking: { source: "local_rules", purchase_account_id: 4000 } } })).toEqual({ purchase_account_id: 4000 });
  });
  it("ignores keyword and fallback suggestions, as before", () => {
    expect(extractRuleBookingFields({ item: { ...batchItem, booking_suggestion: { ...batchItem.booking_suggestion, source: "keyword_match" } } })).toBeUndefined();
  });
  it("takes the rule's match key from the resolved supplier when display_counterparty is absent", () => {
    expect(ruleMatchLabel({ item: batchItem })).toBe("Supplier OÜ");
    expect(ruleMatchLabel({ item: { ...batchItem, display_counterparty: "Shown Name" } })).toBe("Shown Name");
    expect(ruleMatchLabel({ item: { status: "needs_review" } })).toBeUndefined();
  });
});

describe("F3: continue_accounting_workflow reads the answer", () => {
  it("turns an answer into a judgment scoped to the workflow item", () => {
    expect(judgmentForAnswer({ workflowHandle: "h".repeat(43), itemId: "item-3", questionKey: "vat_deductible", answer: '{"vat_deductible":true}' })).toEqual({
      scope: `workflow:${"h".repeat(43)}:item-3`,
      question: "vat_deductible",
      answer: '{"vat_deductible":true}',
      rationale: "operator answer via continue_accounting_workflow",
      source: "answer",
    });
  });
  it("refuses an answer that names no workflow item, instead of ignoring it", async () => {
    const server = createMockToolServer();
    registerAccountingInboxTools(server, createAccountingWorkflowApi() as never, createTestRuntimeSafetyContext());
    const handler = getRegisteredToolHandler(server, "continue_accounting_workflow");
    const r = await handler({ action: "next", answer: "yes" } as never, {} as never);
    expect(JSON.stringify(r)).toMatch(/answer needs workflow_handle and item_id/);
  });
  it("records the judgment through the CRM and returns the item without the answered question", async () => {
    const recordJudgment = vi.fn(async () => ({ id: "j1" }));
    const api = { ...createAccountingWorkflowApi(), crm: { recordJudgment } };
    const context = createTestRuntimeSafetyContext();
    const handle = context.workflowStateStore.issue({ workflow: "accounting_inbox", status: "needs_input", items: [createPublicWorkflowStateDetail({ item_id: "item-3", code: "vat_deductible" })] });
    const server = createMockToolServer();
    registerAccountingInboxTools(server, api as never, context);
    const handler = getRegisteredToolHandler(server, "continue_accounting_workflow");
    const r = await handler({ action: "next", workflow_handle: handle, item_id: "item-3", answer: '{"vat_deductible":true}', workflow_state_json: JSON.stringify({ workflow: { needs_review: [{ item_id: "item-3", code: "vat_deductible", message: "Is the VAT deductible?" }] } }) } as never, {} as never);
    expect(recordJudgment).toHaveBeenCalledOnce();
    expect(recordJudgment).toHaveBeenCalledWith(expect.objectContaining({ question: "vat_deductible", scope: `workflow:${handle}:item-3` }));
    expect(JSON.stringify(r)).not.toMatch(/"code":"vat_deductible"/);
  });
});
