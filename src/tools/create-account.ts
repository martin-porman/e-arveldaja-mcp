import { randomBytes } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { create, readOnly } from "../annotations.js";
import { sandboxExternalText } from "../external-text-renderer.js";
import { registerTool } from "../mcp-compat.js";
import { toRikAccount } from "../crm/mappers.js";
import type { ApiContext } from "./crud/shared.js";

// F5 (Task 28, spec §5.2/§9): create_account creates a chart account in the
// CRM as PROPOSED — `prepare` scope, no approval. propose_account_deactivate
// is approval-only: it mints an advisory plan handle and returns a card, but
// never calls a deactivate API itself — deactivation is `execute` scope and
// gated by the CRM's own step-token approval manifest, entirely outside this
// fork (spec §9).

const PLAN_HANDLE_BYTES = 32;

// The chart's statement/XBRL categories (crm/prisma-v2/data/chart.json,
// distinct non-null `category` values across the seeded chart, 2026-09-26).
// create_account only ever creates an ACTIVE, non-heading posting account, and
// the CRM's chart validator refuses a null category on one ("a posting
// account needs a statement category") — so category is always required here,
// never optional. A small, closed set, hence an enum rather than a free string.
const ACCOUNT_CATEGORIES = [
  "accrued_expense", "cash", "closing", "current_year_result",
  "deferred_revenue", "depreciation", "financial_expense", "financial_income",
  "fixed_asset", "intangible_asset", "inventory", "long_term_investment",
  "long_term_loan", "materials", "operating_expense", "other_current_liability",
  "other_income", "other_receivable", "payable", "payroll", "prepayment",
  "receivable", "reserve", "retained_earnings", "sales", "share_capital",
  "short_term_investment", "short_term_loan", "tax_payable", "tax_receivable",
] as const;
type AccountCategory = (typeof ACCOUNT_CATEGORIES)[number];

// Plain JSON, not the codebase's usual toMcpJson/TOON encoding: the created
// account is a small, flat, one-shot response, and its RIK-shaped `id` is
// meant to be read directly off the wire (compact `"id":<n>`), not paged or
// token-optimized.
function textResult(payload: Record<string, unknown>, isError = false) {
  return {
    ...(isError ? { isError: true } : {}),
    content: [{ type: "text" as const, text: JSON.stringify(payload) }],
  };
}

interface CreateAccountArgs {
  code: string;
  name_et: string;
  parent_code: string;
  type: "ASSET" | "LIABILITY" | "EQUITY" | "INCOME" | "EXPENSE";
  normal_side: "D" | "C";
  category?: AccountCategory;
  role?: string;
  reason: string;
  evidence: unknown;
}

interface ProposeAccountDeactivateArgs {
  code: string;
  reason: string;
}

function upstreamDetail(error: unknown): string {
  const detail = (error as { upstream_detail?: unknown } | null)?.upstream_detail;
  if (typeof detail === "string") return detail;
  return error instanceof Error ? error.message : String(error);
}

export function registerCreateAccountTools(server: McpServer, api: ApiContext): void {
  registerTool(server,
    "create_account",
    "Create a chart-of-accounts account in the CRM as proposed (prepare scope, no approval). Use when a workflow needs an account the chart does not yet have.",
    {
      code: z.string().min(1).describe("The new account's code."),
      name_et: z.string().min(1).describe("Estonian account name."),
      parent_code: z.string().min(1).describe("Parent account code in the chart."),
      type: z.enum(["ASSET", "LIABILITY", "EQUITY", "INCOME", "EXPENSE"]).describe("Account type."),
      normal_side: z.enum(["D", "C"]).describe("Normal balance side."),
      category: z.enum(ACCOUNT_CATEGORIES).describe(
        "The chart's statement/XBRL category for this account (required: this tool always creates an active posting account, and the CRM refuses a posting account with no category). One of: " +
        ACCOUNT_CATEGORIES.join(", ") + ".",
      ),
      role: z.string().min(1).optional().describe("Optional posting-rule role to attach, e.g. FIN_EXPENSE_OTHER."),
      reason: z.string().min(1).describe("Why this account is being created."),
      evidence: z.record(z.string(), z.unknown()).describe("Supporting evidence recorded with the account's provenance."),
    },
    { ...create, openWorldHint: true, title: "Create Account" },
    async (args: CreateAccountArgs) => {
      // Refused BEFORE any request: this tool only ever creates an active,
      // non-heading posting account, and the CRM's chart validator refuses one
      // with no category. The zod schema above marks it required for a real
      // MCP client; this guard is the same refusal for a direct call that
      // skips schema validation (e.g. a hand-built args object in a test).
      if (!args.category || !ACCOUNT_CATEGORIES.includes(args.category)) {
        return textResult({
          error: "category is required: the chart's statement category for this account. One of: " + ACCOUNT_CATEGORIES.join(", ") + ".",
          category: "category_required",
          retry: "never",
          mutation_occurred: false,
        }, true);
      }
      if (!api.crm) {
        return textResult({
          error: "The CRM connection is not configured on this server.",
          category: "crm_not_configured",
          retry: "never",
          mutation_occurred: false,
        }, true);
      }
      try {
        const created = await api.crm.createAccount({
          code: args.code,
          nameEt: args.name_et,
          parentCode: args.parent_code,
          type: args.type,
          normalSide: args.normal_side,
          category: args.category,
          ...(args.role !== undefined ? { role: args.role } : {}),
          reason: args.reason,
          evidence: args.evidence,
        });
        const payload = {
          account: toRikAccount(created, Number(created.code)),
          created: true,
          mutation_occurred: true,
        };
        return {
          content: [{ type: "text" as const, text: JSON.stringify(payload) }],
          // Carried alongside `content` (MCP's optional structuredContent):
          // the RIK-shaped account as a real object, so a caller reading the
          // numeric `id` off the wire never depends on re-parsing the text.
          structuredContent: payload,
        };
      } catch (error) {
        return textResult({
          error: sandboxExternalText(upstreamDetail(error)),
          category: "crm_account_create_failed",
          retry: "never",
          mutation_occurred: false,
        }, true);
      }
    },
  );

  registerTool(server,
    "propose_account_deactivate",
    "Propose deactivating a chart-of-accounts account. Returns an approval card with a plan handle; it never deactivates the account itself. Deactivation is execute-scope and approval-gated in the CRM.",
    {
      code: z.string().min(1).describe("Account code to deactivate."),
      reason: z.string().min(1).describe("Why this account should be deactivated."),
    },
    { ...readOnly, openWorldHint: true, title: "Propose Account Deactivate" },
    async (args: ProposeAccountDeactivateArgs) => {
      const planHandle = randomBytes(PLAN_HANDLE_BYTES).toString("base64url");
      return textResult({
        status: "needs_approval",
        approval_required: true,
        plan_handle: planHandle,
        operation: "account.deactivate",
        code: args.code,
        reason: args.reason,
        mutation_occurred: false,
      });
    },
  );
}
