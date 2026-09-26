import type { HttpClient } from "../http-client.js";

/**
 * The fork keeps RIK's numeric ids (spec §2.3): every RIK-shaped record still
 * carries a plain `number` id. The CRM keeps its own ids (a `code` for
 * accounts, a cuid for everything else). This module is the boundary: it
 * mirrors the CRM's `app.mcp_id_map` allocation rule (crm/src/lib/crm-mcp/id-map.ts)
 * client-side so a digit-only account code never needs a network round-trip,
 * and otherwise calls `POST /id-map` (CRM route 13).
 */
export type IdKind =
  | "account"
  | "counterparty"
  | "document"
  | "entry"
  | "bank_transaction"
  | "dimension"
  | "bank_account"
  | "series"
  | "product";

/** Below this, a numeric "account" id IS the chart code (mirrors the CRM's allocation floor). */
export const ACCOUNT_ALLOCATED_FROM = 900_000_000;

function isDigitOnlyAccountCode(crmId: string): boolean {
  return /^\d+$/.test(crmId) && !crmId.startsWith("0");
}

// Memoised for the process lifetime, shared across every IdMap instance so a
// counterparty resolved by one API class is not re-resolved by another.
// Keyed by the owning connection (HttpClient.cacheNamespace) so two
// connections never share an id space.
const toNumericMemo = new Map<string, number>();
const toCrmMemo = new Map<string, string>();

export class IdMap {
  constructor(private readonly client: HttpClient) {}

  private numericKey(kind: IdKind, crmId: string): string {
    return `${this.client.cacheNamespace}:${kind}:${crmId}`;
  }

  private crmKey(kind: IdKind, numericId: number): string {
    return `${this.client.cacheNamespace}:${kind}:${numericId}`;
  }

  private remember(kind: IdKind, crmId: string, numericId: number): void {
    toNumericMemo.set(this.numericKey(kind, crmId), numericId);
    toCrmMemo.set(this.crmKey(kind, numericId), crmId);
  }

  async toNumeric(kind: IdKind, crmIds: string[]): Promise<number[]> {
    const result: number[] = new Array(crmIds.length);
    const pending: { index: number; crmId: string }[] = [];

    for (let i = 0; i < crmIds.length; i++) {
      const crmId = crmIds[i]!;
      if (kind === "account" && isDigitOnlyAccountCode(crmId)) {
        const numericId = Number(crmId);
        result[i] = numericId;
        this.remember(kind, crmId, numericId);
        continue;
      }
      const cached = toNumericMemo.get(this.numericKey(kind, crmId));
      if (cached !== undefined) {
        result[i] = cached;
        continue;
      }
      pending.push({ index: i, crmId });
    }

    if (pending.length > 0) {
      const { numericIds } = await this.client.post<{ numericIds: number[] }>("/id-map", {
        kind,
        crmIds: pending.map(p => p.crmId),
      });
      pending.forEach((p, j) => {
        const numericId = numericIds[j]!;
        result[p.index] = numericId;
        this.remember(kind, p.crmId, numericId);
      });
    }

    return result;
  }

  async toCrm(kind: IdKind, numericIds: number[]): Promise<string[]> {
    const result: string[] = new Array(numericIds.length);
    const pending: { index: number; numericId: number }[] = [];

    for (let i = 0; i < numericIds.length; i++) {
      const numericId = numericIds[i]!;
      if (kind === "account" && numericId < ACCOUNT_ALLOCATED_FROM) {
        const crmId = String(numericId);
        result[i] = crmId;
        this.remember(kind, crmId, numericId);
        continue;
      }
      const cached = toCrmMemo.get(this.crmKey(kind, numericId));
      if (cached !== undefined) {
        result[i] = cached;
        continue;
      }
      pending.push({ index: i, numericId });
    }

    if (pending.length > 0) {
      const { crmIds } = await this.client.post<{ crmIds: string[] }>("/id-map", {
        kind,
        numericIds: pending.map(p => p.numericId),
      });
      pending.forEach((p, j) => {
        const crmId = crmIds[j]!;
        result[p.index] = crmId;
        this.remember(kind, crmId, p.numericId);
      });
    }

    return result;
  }
}
