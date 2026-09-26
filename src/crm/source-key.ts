/**
 * The CRM's `Document.sourceKey` grammar (mail:|file:|bankline:|manual:<rest>, crm/src/lib/crm-mcp/writes-documents.ts:41,
 * `SOURCE_KEY_RE`). An invoice's source is the workflow's own attachment (a PDF's sha256, or a mail Message-ID and
 * its attachment index) or, for a bank line auto-booked into a purchase invoice, the CRM bank transaction it was
 * classified from. Without one, the CRM cannot make the booking idempotent — refused rather than invented (plan
 * R4a Task 25). `bank_transaction_id` here is already the CRM's own id (a cuid) — the caller resolves the RIK
 * numeric transaction id through the id map first (`PurchaseInvoicesApi.createAndSetTotals`), matching the CRM's
 * own `bankline:` prefix (not `bank:`) so the grammar check in writes-documents.ts:46-49 accepts it.
 */
export function sourceKeyFor(src: { sha256?: string; message_id?: string; index?: number; bank_transaction_id?: string }): string {
  if (src.sha256 && /^[0-9a-f]{64}$/.test(src.sha256)) return `file:${src.sha256}`;
  if (src.message_id) return `mail:${src.message_id}#${src.index ?? 1}`;
  if (src.bank_transaction_id) return `bankline:${src.bank_transaction_id}`;
  throw new Error("an invoice without a source cannot be booked idempotently (no source sha256, Message-ID, or bank transaction)");
}
