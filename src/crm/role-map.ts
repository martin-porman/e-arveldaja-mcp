import type { Account } from "../types/api.js";

/**
 * F7 (Task 29, spec §6.4): the fork never hard-codes a chart-of-accounts
 * number as a booking default. Every constant in `accounting-defaults.ts`
 * that used to serve as a silent fallback account maps here to a CRM chart
 * ROLE (`cl_account_groups`, mirrored from the CRM's `GET /accounts` `roles`
 * field — see `src/crm/mappers.ts:toRikAccount`). `roleAccount` resolves a
 * role against the live chart; when the CRM's roles.json has not yet defined
 * that role for this company, the correct answer is `{ missing }`, never a
 * guessed number — the caller surfaces this to the inside LLM, which proposes
 * `create_account` or asks, per the operator's no-hard-coded-accounts rule.
 *
 * The two SECURITIES_* constants are intentionally absent: their tools
 * (Lightyear securities income/expense) are switched off in this deployment.
 */
export const ROLE_FOR_CONSTANT: Record<string, string> = {
  DEFAULT_LIABILITY_ACCOUNT: "PAYABLE",
  DEFAULT_VAT_ACCOUNT: "VAT_INPUT",
  DEFAULT_OWNER_PAYABLE_ACCOUNT: "OWNER_PAYABLE",
  DEFAULT_ACCOUNTS_RECEIVABLE: "RECEIVABLE",
  RETAINED_EARNINGS_ACCOUNT: "RETAINED_EARNINGS",
  DIVIDEND_PAYABLE_ACCOUNT: "DIVIDEND_PAYABLE",
  CIT_PAYABLE_ACCOUNT: "DISTRIBUTION_CIT_PAYABLE",
  INCOME_TAX_EXPENSE_ACCOUNT: "CIT_EXPENSE",
  EMTA_PREPAYMENT_ACCOUNT: "TAX_PREPAYMENT",
  SHARE_CAPITAL_ACCOUNT: "SHARE_CAPITAL",
  RESERVE_CAPITAL_ACCOUNT: "RESERVE_CAPITAL",
  CURRENT_YEAR_PROFIT_ACCOUNT: "CURRENT_YEAR_RESULT",
  DEFAULT_OTHER_FINANCIAL_EXPENSE_ACCOUNT: "FIN_EXPENSE_OTHER",
  DEFAULT_OTHER_FINANCIAL_INCOME_ACCOUNT: "FIN_INCOME_OTHER",
  DEFAULT_FX_GAIN_ACCOUNT: "FX_GAIN",
  DEFAULT_FX_LOSS_ACCOUNT: "FX_LOSS",
};

/**
 * The account carrying `role` in this company's chart, or `{ missing }` when
 * roles.json has no account for it yet. Active accounts only (a deactivated
 * account is never silently picked), lowest id wins on a tie — same
 * convention as `findAccountByName` in `account-resolution.ts`.
 */
export function roleAccount(accounts: Account[], role: string): number | { missing: string } {
  const id = accounts
    .filter(a => a.is_valid !== false)
    .filter(a => a.cl_account_groups?.includes(role))
    .map(a => a.id)
    .sort((x, y) => x - y)[0];
  return id !== undefined ? id : { missing: role };
}

const ROLE_FALLBACK_BRAND = Symbol("roleFallback");

/**
 * Sentinel a `fallback` parameter can carry (e.g. `account-resolution.ts`'s
 * `resolveAccountByName`) so the resolver looks up a chart role instead of
 * returning a hard-coded number when no name match is found.
 */
export interface RoleFallback {
  readonly [ROLE_FALLBACK_BRAND]: true;
  readonly constantName: keyof typeof ROLE_FOR_CONSTANT;
  readonly role: string;
}

export function roleFallback(constantName: keyof typeof ROLE_FOR_CONSTANT): RoleFallback {
  const role = ROLE_FOR_CONSTANT[constantName];
  if (!role) {
    throw new Error(`No role mapped for accounting-defaults constant "${constantName}".`);
  }
  return { [ROLE_FALLBACK_BRAND]: true, constantName, role };
}
