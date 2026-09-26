import { HttpError, type HttpClient, type HttpMethod } from "../http-client.js";
import type {
  Account, AccountDimension, Currency, SaleArticle, PurchaseArticle,
  Template, CompanyInvoiceInfo, CompanyVatInfo, Project, InvoiceSeries,
  BankAccount, ApiResponse
} from "../types/api.js";
import { Cache } from "../cache.js";
import { IdMap } from "../crm/id-map.js";
import { toRikAccount, type CrmAccount } from "../crm/mappers.js";

const REFERENCE_TTL_SECONDS = 600; // 10 min cache for reference data

export const readonlyCache = new Cache(REFERENCE_TTL_SECONDS);

function readonlyCacheKey(client: HttpClient, key: string): string {
  return `${client.cacheNamespace}:${key}`;
}

/** One GET, cached; `compute` does the CRM fetch + RIK mapping. */
async function cachedCompute<T>(client: HttpClient, key: string, compute: () => Promise<T>): Promise<T> {
  const cacheKey = readonlyCacheKey(client, key);
  const cached = readonlyCache.get<T>(cacheKey);
  if (cached !== undefined) return cached;
  // Capture generation BEFORE the round-trip so a concurrent invalidation
  // can't have a slow in-flight read pollute the cache afterwards.
  const gen = readonlyCache.generation;
  const result = await compute();
  readonlyCache.setIfSameGeneration(cacheKey, result, gen, REFERENCE_TTL_SECONDS);
  return result;
}

function switchedOff(method: HttpMethod, path: string, reason: string): never {
  throw new HttpError(`switched off in the CRM-MCP: ${reason}`, 501, method, path);
}

type CrmCompanyProfile = {
  name: string;
  regCode: string;
  vatNo: string | null;
  vatLiable: boolean | null;
  financialYearPeriod: string | null;
  fiscalYears: { startDate: string; endDate: string }[];
};

type CrmBankAccountRow = { iban: string; accountCode: string; name: string; currency: string; isActive: boolean };
type CrmDimensionRow = { id: string; axis: string; code: string; name: string; isActive: boolean };
type CrmNumberSeriesRow = { id: string; key: string; year: number; prefix: string; width: number; lastNumber: number };

// A CRM bank account IS the sub-ledger dimension it books through: the same
// numeric id serves as both `BankAccount.id`/`accounts_dimensions_id` and
// `AccountDimension.id`, and the dimension's `accounts_id` is the bank
// account's own ledger account. This keeps `resolveBankAccount` (spec
// bank-account-resolution.ts) working over the CRM without a CRM concept of
// "account dimension" that doesn't exist.
type BankAccountJoin = { row: CrmBankAccountRow; id: number; ledgerAccountId: number };

export class ReferenceDataApi {
  private readonly idMap: IdMap;

  constructor(private client: HttpClient) {
    this.idMap = new IdMap(client);
  }

  private async loadAccounts(): Promise<{ row: CrmAccount; id: number }[]> {
    return cachedCompute(this.client, "/accounts:all", async () => {
      const rows = await this.client.get<CrmAccount[]>("/accounts");
      const ids = await this.idMap.toNumeric("account", rows.map(r => r.code));
      return rows.map((row, i) => ({ row, id: ids[i]! }));
    });
  }

  // Chart of accounts
  async getAccounts(): Promise<Account[]> {
    const joined = await this.loadAccounts();
    return joined.map(({ row, id }) => toRikAccount(row, id));
  }

  async getAccount(id: number): Promise<Account | undefined> {
    const accounts = await this.getAccounts();
    return accounts.find(a => a.id === id);
  }

  private async loadBankAccounts(): Promise<BankAccountJoin[]> {
    return cachedCompute(this.client, "/bank-accounts:all", async () => {
      const rows = await this.client.get<CrmBankAccountRow[]>("/bank-accounts");
      const ids = await this.idMap.toNumeric("bank_account", rows.map(r => r.iban));
      const ledgerIds = await this.idMap.toNumeric("account", rows.map(r => r.accountCode));
      return rows.map((row, i) => ({ row, id: ids[i]!, ledgerAccountId: ledgerIds[i]! }));
    });
  }

  // Account dimensions — derived from bank accounts (see BankAccountJoin above).
  async getAccountDimensions(): Promise<AccountDimension[]> {
    const joined = await this.loadBankAccounts();
    return joined.map(({ row, id, ledgerAccountId }) => ({
      id,
      accounts_id: ledgerAccountId,
      title_est: row.name,
      cl_currencies_id: row.currency,
      is_deleted: !row.isActive,
    }));
  }

  // Currencies — the core is euro-cents only (crm/src/lib/accounting/types.ts:15).
  async getCurrencies(): Promise<Currency[]> {
    return [{ id: "EUR", name_est: "Euro", name_eng: "Euro" }];
  }

  // Sale/purchase articles have no dedicated CRM catalogue: receipt-batch
  // (receipts/batch-operations.ts:695-709) and purchase-vat-defaults.ts:140
  // both depend on getPurchaseArticles() succeeding, so it is derived from
  // the chart instead of switched off — every active, non-heading EXPENSE
  // account is a purchase article (mirror for REVENUE / sale articles), the
  // article's own `accounts_id` being that same account.
  async getSaleArticles(): Promise<SaleArticle[]> {
    const joined = await this.loadAccounts();
    return joined
      .filter(({ row }) => row.type === "REVENUE" && row.isActive && !row.isHeading)
      .map(({ row, id }) => ({
        id,
        group_est: row.nameEt,
        group_eng: row.nameEn ?? row.nameEt,
        name_est: row.nameEt,
        name_eng: row.nameEn ?? row.nameEt,
        accounts_id: id,
        vat_type: 0,
        is_valid: true,
        cl_account_groups: row.roles,
      }));
  }

  async getPurchaseArticles(): Promise<PurchaseArticle[]> {
    const joined = await this.loadAccounts();
    return joined
      .filter(({ row }) => row.type === "EXPENSE" && row.isActive && !row.isHeading)
      .map(({ row, id }) => ({
        id,
        level: 1,
        name_est: row.nameEt,
        name_eng: row.nameEn ?? row.nameEt,
        accounts_id: id,
        cl_account_groups: row.roles,
        is_disabled: false,
      }));
  }

  // Templates
  async getTemplates(): Promise<Template[]> {
    return switchedOff("GET", "/templates", "invoice templates are not exposed by the CRM-MCP");
  }

  private async companyProfile(): Promise<CrmCompanyProfile> {
    return cachedCompute(this.client, "/company-profile", () =>
      this.client.get<CrmCompanyProfile>("/company-profile"));
  }

  // Invoice info
  async getInvoiceInfo(): Promise<CompanyInvoiceInfo> {
    const profile = await this.companyProfile();
    return { invoice_company_name: profile.name };
  }

  async updateInvoiceInfo(_data: Partial<CompanyInvoiceInfo>): Promise<ApiResponse> {
    return switchedOff("PATCH", "/invoice_info", "company profile is read-only in the CRM-MCP");
  }

  // VAT info
  async getVatInfo(): Promise<CompanyVatInfo> {
    const profile = await this.companyProfile();
    return { vat_number: profile.vatNo ?? undefined };
  }

  // Projects — the CRM's general-purpose dimensions filtered to the PROJECT axis.
  async getProjects(): Promise<Project[]> {
    return cachedCompute(this.client, "/dimensions:projects", async () => {
      const rows = await this.client.get<CrmDimensionRow[]>("/dimensions");
      const projectRows = rows.filter(r => r.axis === "PROJECT");
      const ids = await this.idMap.toNumeric("dimension", projectRows.map(r => r.id));
      return projectRows.map((r, i) => ({
        id: ids[i]!,
        name: r.name,
        cl_projects_type: r.axis,
        is_disabled: !r.isActive,
      }));
    });
  }

  // Invoice series — the CRM's number series (per-kind/year document numbering).
  async getInvoiceSeries(): Promise<InvoiceSeries[]> {
    return cachedCompute(this.client, "/number-series:all", async () => {
      const rows = await this.client.get<CrmNumberSeriesRow[]>("/number-series");
      const ids = await this.idMap.toNumeric("series", rows.map(r => r.id));
      return rows.map((r, i) => ({
        id: ids[i]!,
        is_active: true,
        is_default: false,
        number_prefix: r.prefix,
        number_start_value: r.lastNumber + 1,
        term_days: 0,
      }));
    });
  }

  async getInvoiceSeriesOne(id: number): Promise<InvoiceSeries> {
    const all = await this.getInvoiceSeries();
    const found = all.find(s => s.id === id);
    if (!found) throw new HttpError(`CRM 404 on GET /number-series/${id}`, 404, "GET", `/number-series/${id}`);
    return found;
  }

  async createInvoiceSeries(_data: Partial<InvoiceSeries>): Promise<ApiResponse> {
    return switchedOff("POST", "/invoice_series", "the series are decided, R2 Task 17");
  }

  async updateInvoiceSeries(_id: number, _data: Partial<InvoiceSeries>): Promise<ApiResponse> {
    return switchedOff("PATCH", "/invoice_series", "the series are decided, R2 Task 17");
  }

  async deleteInvoiceSeries(_id: number): Promise<ApiResponse> {
    return switchedOff("DELETE", "/invoice_series", "the series are decided, R2 Task 17");
  }

  // Bank accounts
  async getBankAccounts(): Promise<BankAccount[]> {
    const joined = await this.loadBankAccounts();
    return joined.map(({ row, id }) => ({
      id,
      account_name_est: row.name,
      account_no: row.iban,
      iban_code: row.iban,
      accounts_dimensions_id: id,
    }));
  }

  async getBankAccount(id: number): Promise<BankAccount> {
    const all = await this.getBankAccounts();
    const found = all.find(b => b.id === id);
    if (!found) throw new HttpError(`CRM 404 on GET /bank-accounts/${id}`, 404, "GET", `/bank-accounts/${id}`);
    return found;
  }

  async createBankAccount(_data: Partial<BankAccount>): Promise<ApiResponse> {
    return switchedOff("POST", "/bank_accounts", "bank accounts are an operator fact, V11");
  }

  async updateBankAccount(_id: number, _data: Partial<BankAccount>): Promise<ApiResponse> {
    return switchedOff("PATCH", "/bank_accounts", "bank accounts are an operator fact, V11");
  }

  async deleteBankAccount(_id: number): Promise<ApiResponse> {
    return switchedOff("DELETE", "/bank_accounts", "bank accounts are an operator fact, V11");
  }
}
