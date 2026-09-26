import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFile, readdir, realpath, stat } from "fs/promises";
import { getAllowedRoots, resolveFilePath, validateFilePath } from "../file-validation.js";
import { parseDocument } from "../document-parser.js";
import {
  classifyReceiptDocument,
  extractReceiptFieldsFromText,
  hasAutoBookableReceiptFields,
  suggestBookingInternal,
} from "../tools/receipt-extraction.js";
import { summarizeInvoiceExtraction } from "../invoice-extraction-fallback.js";
import { resolveSupplierInternal } from "../tools/supplier-resolution.js";
import { HttpError } from "../http-client.js";
import { createTestRuntimeSafetyContext } from "../__fixtures__/runtime-safety.js";
import { EXECUTION_PLAN_TTL_MS } from "../plan-store.js";
import { createReceiptBatchOperations } from "./batch-operations.js";
import type { ReceiptApprovedManifestEntry } from "./types.js";

// The typed operation is exercised DIRECTLY (no mock McpServer): narrow api / fs
// / OCR ports only. These pin the staged-approval invariants the refactor must
// preserve: scan is zero-mutation; dry_run issues the SHA-256 manifest without
// mutating; create resends + validates it (manifest_mismatch BEFORE any
// mutation); create (APPROVAL ONE) creates+uploads but never confirms;
// create_and_confirm (APPROVAL TWO) confirms; a post-create failure is
// compensated (rollback) and reported, NEVER auto-retried.

vi.mock("fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs/promises")>();
  const readFileMock = vi.fn();
  return {
    ...actual,
    open: vi.fn().mockImplementation(async (path: unknown) => {
      // A bare receipt-folder path has no extension; any receipt file does
      // (.pdf, .jpg, .png, ...) — generalized from a .pdf-only check so
      // non-PDF (image) receipt fixtures work the same way (E2E-FIX B3).
      const isFile = /\.[a-zA-Z0-9]+$/.test(String(path));
      return {
        fd: 42,
        stat: vi.fn().mockResolvedValue({
          isDirectory: () => !isFile,
          isFile: () => isFile,
          dev: 1,
          ino: isFile ? 3 : 2,
          size: isFile ? 512 : 0,
        }),
        readFile: vi.fn().mockImplementation(() => readFileMock(path)),
        close: vi.fn().mockResolvedValue(undefined),
      };
    }),
    readFile: readFileMock,
    readdir: vi.fn(),
    realpath: vi.fn(),
    stat: vi.fn(),
  };
});

vi.mock("../file-validation.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../file-validation.js")>()),
  getAllowedRoots: vi.fn(),
  resolveFilePath: vi.fn(),
  validateFilePath: vi.fn(),
}));

vi.mock("../document-parser.js", () => ({
  parseDocument: vi.fn(),
}));

vi.mock("../tools/receipt-extraction.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../tools/receipt-extraction.js")>()),
  classifyReceiptDocument: vi.fn(),
  extractReceiptFieldsFromText: vi.fn(),
  hasAutoBookableReceiptFields: vi.fn(),
  suggestBookingInternal: vi.fn(),
}));

vi.mock("../tools/supplier-resolution.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../tools/supplier-resolution.js")>()),
  resolveSupplierInternal: vi.fn(),
}));

vi.mock("../invoice-extraction-fallback.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../invoice-extraction-fallback.js")>()),
  summarizeInvoiceExtraction: vi.fn(),
}));

const FOLDER = "/tmp/receipts";

async function receiptRealpath(path: unknown): Promise<string> {
  const value = String(path);
  if (value === "/proc/self/fd/42" || value === "/dev/fd/42") {
    throw Object.assign(new Error("descriptor namespace unavailable"), { code: "ENOENT" });
  }
  return value;
}

function primeFilesystem(): void {
  vi.mocked(realpath).mockImplementation(receiptRealpath as never);
  vi.mocked(readdir).mockResolvedValue([{ name: "receipt.pdf", isFile: () => true }] as never);
  vi.mocked(stat).mockImplementation(async (path) => {
    if (String(path) === FOLDER) {
      return { isDirectory: () => true, isFile: () => false, dev: 1, ino: 2 } as never;
    }
    return {
      isDirectory: () => false,
      isFile: () => true,
      dev: 1,
      ino: 3,
      size: 512,
      mtime: new Date("2026-03-20T10:00:00.000Z"),
    } as never;
  });
  vi.mocked(readFile).mockResolvedValue(Buffer.from("receipt pdf") as never);
  vi.mocked(resolveFilePath).mockImplementation((path) => path);
  vi.mocked(getAllowedRoots).mockReturnValue(["/tmp"]);
  vi.mocked(validateFilePath).mockImplementation(async (path) => path as string);
}

function primeExtraction(): void {
  vi.mocked(parseDocument).mockResolvedValue({ text: "ignored", pageCount: 1 } as never);
  vi.mocked(classifyReceiptDocument).mockReturnValue("purchase_invoice");
  vi.mocked(extractReceiptFieldsFromText).mockReturnValue({
    supplier_name: "Supplier OÜ",
    invoice_number: "INV-1",
    invoice_date: "2026-03-20",
    due_date: "2026-03-20",
    total_net: 100,
    total_vat: 24,
    total_gross: 124,
    currency: "EUR",
    description: "Service",
    raw_text: "ignored",
  } as never);
  vi.mocked(hasAutoBookableReceiptFields).mockReturnValue(true);
  vi.mocked(suggestBookingInternal).mockResolvedValue({
    item: { custom_title: "Service", amount: 1, total_net_price: 100, cl_purchase_articles_id: 501, purchase_accounts_id: 5230 },
    source: "fallback",
    suggested_purchase_article: { id: 501, name: "Software" },
  } as never);
  vi.mocked(resolveSupplierInternal).mockResolvedValue({
    found: true,
    created: false,
    match_type: "exact_name",
    client: {
      id: 7,
      name: "Supplier OU",
      is_supplier: true,
      is_client: false,
      cl_code_country: "EST",
      is_member: false,
      send_invoice_to_email: false,
      send_invoice_to_accounting_email: false,
      is_deleted: false,
    },
  } as never);
  // High confidence so create_and_confirm is not gated to needs_review by the
  // create_and_confirm-needs-high rule (shouldGateCreation).
  vi.mocked(summarizeInvoiceExtraction).mockReturnValue({
    recommended: false,
    confidence: "high",
    missing_required_fields: [],
    confidence_signals: [],
    reason: "",
  } as never);
}

interface ApiSpies {
  createAndSetTotals: ReturnType<typeof vi.fn>;
  uploadDocument: ReturnType<typeof vi.fn>;
  confirmWithTotals: ReturnType<typeof vi.fn>;
  invalidate: ReturnType<typeof vi.fn>;
}

function makeApi(
  spies: Partial<ApiSpies> = {},
  options: { clients?: unknown[] } = {},
): { api: never; spies: ApiSpies } {
  const createAndSetTotals = spies.createAndSetTotals ?? vi.fn().mockResolvedValue({
    id: 555, number: "INV-1", status: "PROJECT", clients_id: 7,
    client_name: "Supplier OU", cl_currencies_id: "EUR", create_date: "2026-03-20", gross_price: 124,
  });
  const uploadDocument = spies.uploadDocument ?? vi.fn().mockResolvedValue(undefined);
  const confirmWithTotals = spies.confirmWithTotals ?? vi.fn().mockResolvedValue(undefined);
  const invalidate = spies.invalidate ?? vi.fn().mockResolvedValue(undefined);
  const api = {
    clients: { listAll: vi.fn().mockResolvedValue(options.clients ?? []) },
    purchaseInvoices: {
      listAll: vi.fn().mockResolvedValue([]),
      createAndSetTotals,
      uploadDocument,
      confirmWithTotals,
      invalidate,
    },
    readonly: {
      // F7: role-tagged so the PAYABLE role-based fallback (no more
      // hard-coded DEFAULT_LIABILITY_ACCOUNT) resolves a liability account.
      getAccounts: vi.fn().mockResolvedValue([{ id: 2310, cl_account_groups: ["PAYABLE"] }]),
      getPurchaseArticles: vi.fn().mockResolvedValue([]),
      getVatInfo: vi.fn().mockResolvedValue({ vat_number: "EE123456789" }),
      getBankAccounts: vi.fn().mockResolvedValue([]),
    },
    transactions: { listAll: vi.fn().mockResolvedValue([]) },
    journals: { listAll: vi.fn().mockResolvedValue([]) },
  } as never;
  return { api, spies: { createAndSetTotals, uploadDocument, confirmWithTotals, invalidate } };
}

function makeOperations(api: never) {
  return createReceiptBatchOperations(api, createTestRuntimeSafetyContext());
}

// P0-3 drift tests need to reach the SAME runtime safety context the plan handle
// was minted on (to advance the clock / rescope / read the plan store), so mint
// and execute must share one context. makeOperations() hides its context, so this
// variant exposes it.
function makeOperationsWithContext(api: never) {
  const context = createTestRuntimeSafetyContext();
  return { ops: createReceiptBatchOperations(api, context), context };
}

// P0-3: the plan handle is minted by a dry_run and consumed by the matching
// create / create_and_confirm on the SAME operation instance (the plan store
// lives on that instance's runtime safety context). So dry_run and execute must
// share one `ops` — a fresh makeOperations() would have an empty store.
type DryRunPlan = {
  manifest: ReceiptApprovedManifestEntry[];
  planHandles: { create: string; create_and_confirm: string };
};
async function dryRunPlan(ops: ReturnType<typeof makeOperations>, overrides: Partial<typeof baseRun> = {}): Promise<DryRunPlan> {
  const outcome = await ops.runBatch({ ...baseRun, ...overrides, executionMode: "dry_run", dryRun: true });
  if (!outcome.ok) throw new Error("dry run failed");
  if (!outcome.value.planHandles) throw new Error("dry run minted no plan handles");
  return { manifest: outcome.value.manifest, planHandles: outcome.value.planHandles };
}

const baseRun = {
  resolvedFolderPath: FOLDER,
  accountsDimensionsId: 100,
  legacyExecuteCreate: false,
  directoryAccessOptions: {},
} as const;

beforeEach(() => {
  primeFilesystem();
  primeExtraction();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("receipt batch typed operation", () => {
  it("scan performs zero mutation and returns file metadata", async () => {
    const { api, spies } = makeApi();
    const outcome = await makeOperations(api).scan({ resolvedFolderPath: FOLDER, directoryAccessOptions: {} });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("scan failed");
    expect(outcome.value.files.map(f => f.name)).toEqual(["receipt.pdf"]);
    expect(spies.createAndSetTotals).not.toHaveBeenCalled();
    expect(spies.uploadDocument).not.toHaveBeenCalled();
    expect(spies.confirmWithTotals).not.toHaveBeenCalled();
  });

  it("dry_run issues the SHA-256 manifest and mutates nothing", async () => {
    const { api, spies } = makeApi();
    const outcome = await makeOperations(api).runBatch({
      ...baseRun, executionMode: "dry_run", dryRun: true,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("runBatch failed");
    expect(outcome.value.manifest).toHaveLength(1);
    expect(outcome.value.manifest[0]!.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(outcome.value.results[0]!.status).toBe("dry_run_preview");
    expect(spies.createAndSetTotals).not.toHaveBeenCalled();
    expect(spies.confirmWithTotals).not.toHaveBeenCalled();
  });

  it("mintPlanHandles:false previews without consuming plan-store slots", async () => {
    const { api } = makeApi();
    const { ops, context } = makeOperationsWithContext(api as never);
    const before = context.planStore.activeCount;

    const outcome = await ops.runBatch({
      ...baseRun, executionMode: "dry_run", dryRun: true, mintPlanHandles: false,
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("runBatch failed");
    // The preview is unchanged — only the unused approval artifacts are gone.
    expect(outcome.value.results[0]!.status).toBe("dry_run_preview");
    expect(outcome.value.manifest).toHaveLength(1);
    expect(outcome.value.planHandles).toBeUndefined();
    // The store THROWS at capacity rather than evicting, so a summarizing
    // caller that discards handles must not consume slots at all.
    expect(context.planStore.activeCount).toBe(before);
  });

  it("a default dry run still mints one handle per execution effect", async () => {
    const { api } = makeApi();
    const { ops, context } = makeOperationsWithContext(api as never);
    const before = context.planStore.activeCount;

    const outcome = await ops.runBatch({ ...baseRun, executionMode: "dry_run", dryRun: true });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("runBatch failed");
    expect(outcome.value.planHandles?.create).toBeDefined();
    expect(outcome.value.planHandles?.create_and_confirm).toBeDefined();
    expect(context.planStore.activeCount).toBe(before + 2);
  });

  it("create rejects with manifest_mismatch BEFORE any mutation when the folder drifted", async () => {
    const { api, spies } = makeApi();
    const wrongManifest: ReceiptApprovedManifestEntry[] = [{ relative_path: "receipt.pdf", sha256: "0".repeat(64) }];
    await expect(makeOperations(api).runBatch({
      ...baseRun, executionMode: "create", dryRun: false, approvedManifest: wrongManifest,
    })).rejects.toMatchObject({ category: "manifest_mismatch" });
    expect(spies.createAndSetTotals).not.toHaveBeenCalled();
    expect(spies.uploadDocument).not.toHaveBeenCalled();
  });

  it("create (APPROVAL ONE) creates + uploads but never confirms", async () => {
    const { api, spies } = makeApi();
    const ops = makeOperations(api);
    const { manifest, planHandles } = await dryRunPlan(ops);
    const outcome = await ops.runBatch({
      ...baseRun, executionMode: "create", dryRun: false, approvedManifest: manifest, planHandle: planHandles.create,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("runBatch failed");
    expect(spies.createAndSetTotals).toHaveBeenCalledTimes(1);
    expect(spies.uploadDocument).toHaveBeenCalledTimes(1);
    expect(spies.confirmWithTotals).not.toHaveBeenCalled();
    expect(outcome.value.results[0]!.status).toBe("created");
    expect(outcome.value.results[0]!.created_invoice?.confirmed).toBe(false);
  });

  it("create_and_confirm (APPROVAL TWO) also confirms the created invoice", async () => {
    const { api, spies } = makeApi();
    const ops = makeOperations(api);
    const { manifest, planHandles } = await dryRunPlan(ops);
    const outcome = await ops.runBatch({
      ...baseRun, executionMode: "create_and_confirm", dryRun: false, approvedManifest: manifest, planHandle: planHandles.create_and_confirm,
    });
    expect(outcome.ok).toBe(true);
    expect(spies.createAndSetTotals).toHaveBeenCalledTimes(1);
    expect(spies.uploadDocument).toHaveBeenCalledTimes(1);
    expect(spies.confirmWithTotals).toHaveBeenCalledTimes(1);
  });

  it("rolls back (invalidates) the created invoice when the document upload fails", async () => {
    const uploadDocument = vi.fn().mockRejectedValue(new Error("upload boom"));
    const { api, spies } = makeApi({ uploadDocument });
    const ops = makeOperations(api);
    const { manifest, planHandles } = await dryRunPlan(ops);
    const outcome = await ops.runBatch({
      ...baseRun, executionMode: "create", dryRun: false, approvedManifest: manifest, planHandle: planHandles.create,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("runBatch failed");
    expect(spies.createAndSetTotals).toHaveBeenCalledTimes(1);
    expect(spies.invalidate).toHaveBeenCalledTimes(1);
    expect(outcome.value.results[0]!.status).toBe("failed");
  });

  it("never auto-retries an ambiguous (network) post-create confirmation failure", async () => {
    const confirmWithTotals = vi.fn().mockRejectedValue(new HttpError("network failure", "network", "PATCH", "/purchase_invoices/555/register"));
    const { api, spies } = makeApi({ confirmWithTotals });
    const ops = makeOperations(api);
    const { manifest, planHandles } = await dryRunPlan(ops);
    const outcome = await ops.runBatch({
      ...baseRun, executionMode: "create_and_confirm", dryRun: false, approvedManifest: manifest, planHandle: planHandles.create_and_confirm,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("runBatch failed");
    // Created exactly once, confirmation attempted exactly once, then compensated
    // (invalidate) and reported — no second create/confirm.
    expect(spies.createAndSetTotals).toHaveBeenCalledTimes(1);
    expect(spies.confirmWithTotals).toHaveBeenCalledTimes(1);
    expect(spies.invalidate).toHaveBeenCalledTimes(1);
    expect(outcome.value.results[0]!.status).toBe("failed");
  });
});

// E2E-FIX B3: the live E2E rerun's Kesko receipt — an image with no usable
// text, read via the CRM's own structured OCR fields (extractReceiptFieldsFromCrmFields,
// unmocked here). Proves the CRM-fields path plumbs through processSingleReceipt
// to supplier resolution instead of stopping at classification, and that the
// LiteParse note (which never ran under CRM_API_URL) is not attached.
describe("receipt batch typed operation — CRM-fields image receipt (E2E-FIX B3)", () => {
  it("suppresses the LiteParse note and resolves the supplier by registry code, using the REAL classifier / auto-bookable check / matcher (not the module mocks)", async () => {
    // classifyReceiptDocument, hasAutoBookableReceiptFields and
    // resolveSupplierInternal are `vi.fn()` mocks at the module level
    // (primeExtraction sets fixed return values for the .pdf/text-parsed
    // tests above). This test swaps in the real implementations so the
    // structured-fields classification rule, the auto-bookable-fields check,
    // and the registry-code match all actually execute end to end.
    const realExtraction = await vi.importActual<typeof import("../tools/receipt-extraction.js")>(
      "../tools/receipt-extraction.js",
    );
    const realSupplierResolution = await vi.importActual<typeof import("../tools/supplier-resolution.js")>(
      "../tools/supplier-resolution.js",
    );
    vi.mocked(classifyReceiptDocument).mockImplementation(realExtraction.classifyReceiptDocument);
    vi.mocked(hasAutoBookableReceiptFields).mockImplementation(realExtraction.hasAutoBookableReceiptFields);
    vi.mocked(resolveSupplierInternal).mockImplementation(realSupplierResolution.resolveSupplierInternal);

    // Mocked /counterparties response already carrying the Kesko supplier
    // under its registry code — resolveSupplierInternal's registry-code match
    // (supplier-default-resolution.ts) returns straight from this list, no
    // network registry lookup.
    const { api } = makeApi({}, {
      clients: [{
        id: 42,
        code: "10026621",
        name: "AS Kesko Senukai Estonia",
        is_supplier: true,
        is_client: false,
        cl_code_country: "EST",
        is_member: false,
        send_invoice_to_email: false,
        send_invoice_to_accounting_email: false,
        is_deleted: false,
      }],
    });
    // A live WhatsApp-forwarded filename — not "receipt.jpg" — because the
    // real classifier's `hasReceiptKeywords` rule would otherwise match the
    // word "receipt" in the filename itself before the CRM-fields rule is
    // ever reached (there is no raw text to override it with).
    const fileName = "WhatsApp Image 2026-01-03 at 12.34.56.jpg";
    vi.mocked(readdir).mockResolvedValue([{ name: fileName, isFile: () => true }] as never);
    vi.mocked(parseDocument).mockResolvedValue({
      text: "",
      pageCount: 1,
      result: { pages: [] },
      crmFields: {
        fields: {
          supplierName: "AS Kesko Senukai Estonia",
          supplierRegNo: "10026621",
          supplierVatNumber: "EE100269136",
          invoiceNumber: "E309 20260103 04 084460",
          amount: 18.60,
          netAmount: 14.99,
          vatAmount: 3.60,
          currency: "EUR",
          invoiceDate: "2026-01-03",
        },
        tier: "2",
        confidence: "medium",
      },
    } as never);

    const outcome = await makeOperations(api).runBatch({ ...baseRun, executionMode: "dry_run", dryRun: true });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("runBatch failed");
    const row = outcome.value.results[0]!;
    // The real classifier resolved the CRM-fields identity+number+total rule
    // to purchase_invoice (never payment_receipt — CRM fields carry no
    // reference to a SEPARATE invoice), the real hasAutoBookableReceiptFields
    // passed, and the real matcher found the mocked client by registry code —
    // none of that was faked by a mock return value.
    expect(row.classification).toBe("purchase_invoice");
    expect(row.extracted?.supplier_reg_code).toBe("10026621");
    expect(row.extracted?.via_crm_fields).toBe(true);
    expect(row.supplier_resolution?.found).toBe(true);
    expect(row.supplier_resolution?.match_type).toBe("registry_code");
    expect(row.supplier_resolution?.client?.id).toBe(42);
    expect(row.status).toBe("dry_run_preview");
  });

  it("does not attach the LiteParse note for a CRM-fields document, even when it needs review", async () => {
    const { api } = makeApi();
    vi.mocked(readdir).mockResolvedValue([{ name: "receipt.jpg", isFile: () => true }] as never);
    vi.mocked(parseDocument).mockResolvedValue({
      text: "",
      pageCount: 1,
      result: { pages: [] },
      crmFields: {
        fields: { supplierName: "AS Kesko Senukai Estonia" },
        tier: "2",
        confidence: "low",
      },
    } as never);
    // Missing invoice number / date / total: needs_review before booking.
    vi.mocked(hasAutoBookableReceiptFields).mockReturnValue(false);

    const outcome = await makeOperations(api).runBatch({ ...baseRun, executionMode: "dry_run", dryRun: true });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("runBatch failed");
    const row = outcome.value.results[0]!;
    expect(row.status).toBe("needs_review");
    expect(row.extracted?.via_crm_fields).toBe(true);
    expect(row.notes ?? []).not.toEqual(
      expect.arrayContaining([expect.stringContaining("LiteParse")]),
    );
  });
});

// P0-3: the SHA-256 manifest alone only proves the file BYTES are unchanged. It
// says nothing about the accounting effect the operator reviewed — the bank
// dimension, the date filters, the create-vs-create_and_confirm mode, the
// per-file supplier/booking projection, or the live bank transactions the batch
// intends to link. The consume-once plan handle binds ALL of that. Every case
// below proves a mutation is refused BEFORE the first API write when any of those
// drift, plus the replay / scope / expiry lifecycle guards. Each asserts the
// create/upload/confirm/invalidate API mocks were NEVER called.
describe("receipt batch typed operation — P0-3 plan-handle drift gate", () => {
  function expectZeroMutation(spies: ApiSpies): void {
    expect(spies.createAndSetTotals).not.toHaveBeenCalled();
    expect(spies.uploadDocument).not.toHaveBeenCalled();
    expect(spies.confirmWithTotals).not.toHaveBeenCalled();
    expect(spies.invalidate).not.toHaveBeenCalled();
  }

  it("refuses create with NO plan_handle even when the manifest matches", async () => {
    const { api, spies } = makeApi();
    const ops = makeOperations(api);
    const { manifest } = await dryRunPlan(ops);
    const outcome = await ops.runBatch({
      ...baseRun, executionMode: "create", dryRun: false, approvedManifest: manifest,
      // planHandle deliberately omitted — the SHA-256 manifest is NOT approval.
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected plan_handle_required");
    expect(outcome.error.code).toBe("plan_handle_required");
    expectZeroMutation(spies);
  });

  it("blocks the same manifest booked against a DIFFERENT bank dimension", async () => {
    const { api, spies } = makeApi();
    const ops = makeOperations(api);
    const { manifest, planHandles } = await dryRunPlan(ops); // minted at accountsDimensionsId 100
    const outcome = await ops.runBatch({
      ...baseRun, accountsDimensionsId: 200, // operator silently re-pointed the bank leg
      executionMode: "create", dryRun: false, approvedManifest: manifest, planHandle: planHandles.create,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected plan_drift");
    expect(outcome.error.code).toBe("plan_drift");
    expectZeroMutation(spies);
  });

  it("blocks the same manifest with a CHANGED transaction date range", async () => {
    const { api, spies } = makeApi();
    const ops = makeOperations(api);
    const { manifest, planHandles } = await dryRunPlan(ops); // minted with no transaction-date filter
    const outcome = await ops.runBatch({
      ...baseRun, transactionDateFrom: "2026-01-01", transactionDateTo: "2026-01-31",
      executionMode: "create", dryRun: false, approvedManifest: manifest, planHandle: planHandles.create,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected plan_drift");
    expect(outcome.error.code).toBe("plan_drift");
    expectZeroMutation(spies);
  });

  it("blocks a CREATE handle replayed as create_and_confirm (mode escalation)", async () => {
    const { api, spies } = makeApi();
    const ops = makeOperations(api);
    const { manifest, planHandles } = await dryRunPlan(ops);
    const outcome = await ops.runBatch({
      ...baseRun, executionMode: "create_and_confirm", dryRun: false,
      approvedManifest: manifest, planHandle: planHandles.create, // create approval used to auto-confirm
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected plan_drift");
    expect(outcome.error.code).toBe("plan_drift");
    expectZeroMutation(spies);
  });

  it("blocks a CREATE_AND_CONFIRM handle used for a bare create (mode downgrade)", async () => {
    const { api, spies } = makeApi();
    const ops = makeOperations(api);
    const { manifest, planHandles } = await dryRunPlan(ops);
    const outcome = await ops.runBatch({
      ...baseRun, executionMode: "create", dryRun: false,
      approvedManifest: manifest, planHandle: planHandles.create_and_confirm,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected plan_drift");
    expect(outcome.error.code).toBe("plan_drift");
    expectZeroMutation(spies);
  });

  it("blocks a CHANGED supplier resolution between dry_run and create", async () => {
    const { api, spies } = makeApi();
    const ops = makeOperations(api);
    const { manifest, planHandles } = await dryRunPlan(ops); // reviewed with supplier client id 7
    // The supplier-resolution rule changed under the operator's feet.
    vi.mocked(resolveSupplierInternal).mockResolvedValue({
      found: true, created: false, match_type: "exact_name",
      client: {
        id: 9, name: "Different Supplier OU", is_supplier: true, is_client: false,
        cl_code_country: "EST", is_member: false, send_invoice_to_email: false,
        send_invoice_to_accounting_email: false, is_deleted: false,
      },
    } as never);
    const outcome = await ops.runBatch({
      ...baseRun, executionMode: "create", dryRun: false, approvedManifest: manifest, planHandle: planHandles.create,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected plan_drift");
    expect(outcome.error.code).toBe("plan_drift");
    expectZeroMutation(spies);
  });

  it("blocks a CHANGED booking projection (article/account) between dry_run and create", async () => {
    const { api, spies } = makeApi();
    const ops = makeOperations(api);
    const { manifest, planHandles } = await dryRunPlan(ops); // reviewed with article 501 / account 5230
    vi.mocked(suggestBookingInternal).mockResolvedValue({
      item: { custom_title: "Service", amount: 1, total_net_price: 100, cl_purchase_articles_id: 999, purchase_accounts_id: 6000 },
      source: "fallback",
      suggested_purchase_article: { id: 999, name: "Something else" },
    } as never);
    const outcome = await ops.runBatch({
      ...baseRun, executionMode: "create", dryRun: false, approvedManifest: manifest, planHandle: planHandles.create,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected plan_drift");
    expect(outcome.error.code).toBe("plan_drift");
    expectZeroMutation(spies);
  });

  it("blocks when a live bank transaction the plan intended to link has changed", async () => {
    const { api, spies } = makeApi();
    const txListAll = vi.fn();
    (api as { transactions: { listAll: typeof txListAll } }).transactions.listAll = txListAll;
    let liveTransactions: unknown[] = [
      { id: 1, status: "PROJECT", type: "C", amount: 124, base_amount: 124, date: "2026-03-20", accounts_dimensions_id: 100 },
    ];
    txListAll.mockImplementation(async () => liveTransactions.map(tx => ({ ...(tx as object) })));
    const ops = makeOperations(api);
    const { manifest, planHandles } = await dryRunPlan(ops);
    // The live bank row moved (amount corrected upstream) after the operator reviewed.
    liveTransactions = [
      { id: 1, status: "PROJECT", type: "C", amount: 130, base_amount: 130, date: "2026-03-20", accounts_dimensions_id: 100 },
    ];
    const outcome = await ops.runBatch({
      ...baseRun, executionMode: "create", dryRun: false, approvedManifest: manifest, planHandle: planHandles.create,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected plan_drift");
    expect(outcome.error.code).toBe("plan_drift");
    expectZeroMutation(spies);
  });

  it("throws manifest_mismatch (zero mutation) when a receipt file's bytes changed", async () => {
    const { api, spies } = makeApi();
    const ops = makeOperations(api);
    const { manifest, planHandles } = await dryRunPlan(ops);
    // A file in the folder was rewritten after approval; the manifest no longer holds.
    vi.mocked(readFile).mockResolvedValue(Buffer.from("a different receipt pdf") as never);
    await expect(ops.runBatch({
      ...baseRun, executionMode: "create", dryRun: false, approvedManifest: manifest, planHandle: planHandles.create,
    })).rejects.toMatchObject({ category: "manifest_mismatch" });
    expectZeroMutation(spies);
  });

  it("cannot be REPLAYED — a consumed handle is refused with zero further mutation", async () => {
    const { api, spies } = makeApi();
    const ops = makeOperations(api);
    const { manifest, planHandles } = await dryRunPlan(ops);
    const first = await ops.runBatch({
      ...baseRun, executionMode: "create", dryRun: false, approvedManifest: manifest, planHandle: planHandles.create,
    });
    expect(first.ok).toBe(true);
    const createCallsAfterFirst = spies.createAndSetTotals.mock.calls.length;
    expect(createCallsAfterFirst).toBe(1);
    const replay = await ops.runBatch({
      ...baseRun, executionMode: "create", dryRun: false, approvedManifest: manifest, planHandle: planHandles.create,
    });
    expect(replay.ok).toBe(false);
    if (replay.ok) throw new Error("expected plan_handle_consumed");
    expect(replay.error.code).toBe("plan_handle_consumed");
    // No SECOND create/upload from the replay.
    expect(spies.createAndSetTotals.mock.calls.length).toBe(createCallsAfterFirst);
    expect(spies.uploadDocument.mock.calls.length).toBe(1);
  });

  it("rejects a handle used under a DIFFERENT runtime scope (connection switch)", async () => {
    const { api, spies } = makeApi();
    const { ops, context } = makeOperationsWithContext(api);
    const { manifest, planHandles } = await dryRunPlan(ops);
    context.setScope({ verifiedCompanyIdentity: "a-different-company" });
    const outcome = await ops.runBatch({
      ...baseRun, executionMode: "create", dryRun: false, approvedManifest: manifest, planHandle: planHandles.create,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected plan_scope_mismatch");
    expect(outcome.error.code).toBe("plan_scope_mismatch");
    expectZeroMutation(spies);
  });

  it("rejects an EXPIRED handle (past the plan TTL) with zero mutation", async () => {
    const { api, spies } = makeApi();
    const { ops, context } = makeOperationsWithContext(api);
    const { manifest, planHandles } = await dryRunPlan(ops);
    context.advanceTime(EXECUTION_PLAN_TTL_MS + 1); // past the plan TTL
    const outcome = await ops.runBatch({
      ...baseRun, executionMode: "create", dryRun: false, approvedManifest: manifest, planHandle: planHandles.create,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected plan_handle_expired");
    expect(outcome.error.code).toBe("plan_handle_expired");
    expectZeroMutation(spies);
  });
});
