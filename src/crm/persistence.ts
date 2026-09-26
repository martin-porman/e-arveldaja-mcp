import type { HttpClient } from "../http-client.js";

/**
 * The fork's four persistent stores over the CRM (Task 26, spec §2.2/§2.5).
 * Mirrors the CRM route contract exactly (`crm/src/lib/crm-mcp/fork-stores.ts`,
 * Task 21): `GET/PUT fork/state/:store(/:handle)` with scope prepare-or-execute.
 * A plan/workflow-state handle carries `state` and is consumed once (the CRM's
 * 409 "plan already consumed" surfaces here as the store's own consume error).
 * `file_refs` and `operation_results` carry no `state` column server-side —
 * verified against Task 21's actual route implementation (only `plans` and
 * `workflow_states` read/write `state`; only `plans` carries `domain`).
 */
export type ForkStore = "plans" | "workflow_states" | "file_refs" | "operation_results";
export type StoredState = "active" | "consumed" | "tombstone";
export interface StoredRecord {
  readonly handle: string;
  readonly domain?: string;
  readonly record: unknown;
  readonly state?: StoredState;
  readonly expiresAt: string;
}

/**
 * The seam the four in-process stores persist mutations through. `save` is
 * fire-and-forget from the caller's perspective (queued, not awaited); every
 * queued write is chained onto one promise so `flush()` can await the lot and
 * reject if any of them failed — a handle the CRM does not hold must never be
 * treated as durably stored.
 */
export interface StorePersistence {
  load(store: ForkStore): Promise<StoredRecord[]>;
  save(store: ForkStore, rec: StoredRecord): void;
  flush(): Promise<void>;
}

interface ForkStateListResponse {
  readonly records: StoredRecord[];
}

interface ForkIdentityResponse {
  readonly serverInstanceId: string;
  readonly cursorSecret: string;
}

/** Backs `StorePersistence` with the CRM's `fork/state/:store(/:handle)` routes. */
export function crmPersistence(client: HttpClient): StorePersistence {
  // Every save is appended to this chain so PUTs for the same store land at
  // the CRM in mutation order, and flush() can await exactly the writes
  // queued so far. Reassigned synchronously (no `await` in between), so a
  // save queued after a flush() call always joins the NEXT chain, never the
  // one flush() is already awaiting.
  let pending: Promise<void> = Promise.resolve();

  return {
    async load(store: ForkStore): Promise<StoredRecord[]> {
      const response = await client.get<ForkStateListResponse>(`/fork/state/${store}`);
      return response.records;
    },

    save(store: ForkStore, rec: StoredRecord): void {
      pending = pending
        .then(() => client.put(`/fork/state/${store}/${rec.handle}`, rec))
        .then(() => undefined);
    },

    async flush(): Promise<void> {
      const outstanding = pending;
      pending = Promise.resolve();
      await outstanding;
    },
  };
}

/** The CRM's stable, signed server identity (Task 21's `GET fork/identity`, scope none). */
export async function fetchIdentity(
  client: HttpClient,
): Promise<{ serverInstanceId: string; cursorSecret: Buffer }> {
  const response = await client.get<ForkIdentityResponse>("/fork/identity");
  return {
    serverInstanceId: response.serverInstanceId,
    cursorSecret: Buffer.from(response.cursorSecret, "base64"),
  };
}
