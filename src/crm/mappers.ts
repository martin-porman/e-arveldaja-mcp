import type { Account, Client } from "../types/api.js";
import { iso2ToIso3, iso3ToIso2 } from "./country-codes.js";

/**
 * RIK shapes at the boundary (spec §2.3, Task 23). These map a CRM row
 * (crm/src/lib/crm-mcp/reads.ts: `accountRow` / `counterpartyRow`) onto the
 * RIK-shaped record every downstream tool/workflow already expects, and back.
 * The Crm* types below are this fork's own local copies — there is no
 * cross-repo import between crm-mcp and the CRM app.
 */

export type CrmAccountType = "ASSET" | "LIABILITY" | "EQUITY" | "REVENUE" | "EXPENSE";

export type CrmAccount = {
  code: string;
  nameEt: string;
  nameEn: string | null;
  parentCode: string | null;
  type: CrmAccountType;
  normalSide: "D" | "C";
  category: string | null;
  isHeading: boolean;
  requiresCounterparty: boolean;
  isVatAccount: boolean;
  allowsDimension: boolean;
  isActive: boolean;
  roles: string[];
  createdBy: "seed" | "agent" | "user";
};

export type CrmCounterparty = {
  id: string;
  name: string;
  regCode: string | null;
  vatNo: string | null;
  country: string;
  isJuridical: boolean;
  isCustomer: boolean;
  isSupplier: boolean;
  isActive: boolean;
  iban: string | null;
};

const ACCOUNT_TYPE_LABELS: Record<CrmAccountType, { est: string; eng: string }> = {
  ASSET: { est: "Varad", eng: "Assets" },
  LIABILITY: { est: "Kohustused", eng: "Liabilities" },
  EQUITY: { est: "Omakapital", eng: "Equity" },
  REVENUE: { est: "Tulud", eng: "Revenue" },
  EXPENSE: { est: "Kulud", eng: "Expenses" },
};

/** `id` is resolved by the caller through `IdMap.toNumeric("account", [a.code])`. */
export function toRikAccount(a: CrmAccount, id: number): Account {
  const labels = ACCOUNT_TYPE_LABELS[a.type];
  const bindable = !a.isHeading;
  return {
    id,
    balance_type: a.normalSide,
    account_type_est: labels.est,
    account_type_eng: labels.eng,
    name_est: a.nameEt,
    name_eng: a.nameEn ?? a.nameEt,
    is_valid: a.isActive && !a.isHeading,
    allows_dimensions: a.allowsDimension,
    allows_deactivation: a.createdBy !== "seed",
    is_vat_account: a.isVatAccount,
    is_fixed_asset: a.category === "FIXED_ASSET",
    transaction_in_bindable: bindable,
    transaction_out_bindable: bindable,
    transaction_in_user_bindable: bindable,
    transaction_out_user_bindable: bindable,
    is_product_account: false,
    cl_account_groups: a.roles,
    default_disabled: !a.isActive,
    requires_client: a.requiresCounterparty,
  };
}

/** `id` is resolved by the caller through `IdMap.toNumeric("counterparty", [c.id])`. */
export function toRikClient(c: CrmCounterparty, id: number): Client {
  return {
    id,
    name: c.name,
    code: c.regCode,
    invoice_vat_no: c.vatNo,
    cl_code_country: iso2ToIso3(c.country),
    is_juridical_entity: c.isJuridical,
    is_physical_entity: !c.isJuridical,
    is_client: c.isCustomer,
    is_supplier: c.isSupplier,
    is_member: false,
    send_invoice_to_email: false,
    send_invoice_to_accounting_email: false,
    is_deleted: !c.isActive,
    bank_account_no: c.iban,
  };
}

/** The reverse of `toRikClient` — the shape `ClientsApi` sends to `POST/PATCH /counterparties`. */
export function fromRikClient(c: Partial<Client>): {
  name: string;
  regCode: string | null;
  vatNo: string | null;
  country: string;
  isJuridical: boolean;
  isCustomer: boolean;
  isSupplier: boolean;
  iban: string | null;
} {
  return {
    name: c.name ?? "",
    regCode: c.code ?? null,
    vatNo: c.invoice_vat_no ?? null,
    country: iso3ToIso2(c.cl_code_country ?? "EST"),
    isJuridical: c.is_juridical_entity ?? false,
    isCustomer: c.is_client ?? false,
    isSupplier: c.is_supplier ?? false,
    iban: c.bank_account_no ?? null,
  };
}
