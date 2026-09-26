import { describe, expect, it } from "vitest";
import { ExecutionPlanStore, type ExecutionPlanInput } from "../plan-store.js";
import type { RuntimeSafetyScope } from "../runtime-safety-context.js";
import type { StorePersistence, StoredRecord } from "./persistence.js";

function memorySink(): StorePersistence & { rows: Map<string, StoredRecord> } {
  const rows = new Map<string, StoredRecord>();
  return {
    rows,
    load: async () => [...rows.values()],
    save: (_store, rec) => void rows.set(rec.handle, rec),
    flush: async () => {},
  };
}

const FEATURES = Object.freeze({
  enableLightyear: true,
  exposeGranularTools: false,
  exposeSetupTools: false,
  enableTaxTools: true,
  enableReferenceAdmin: true,
  enableAnnualReport: true,
  enableSales: true,
  enableProducts: true,
});

function scope(): RuntimeSafetyScope {
  return Object.freeze({
    serverInstanceId: "s".repeat(43),
    connectionIndex: 0,
    connectionGeneration: 0,
    connectionName: "crm",
    connectionFingerprint: "f",
    environmentKind: "crm",
    baseUrl: "https://crm.invalid/api",
    verifiedCompanyIdentity: null,
    profile: "guided",
    catalogFingerprint: "c",
    features: FEATURES,
  });
}

function planInput(): ExecutionPlanInput {
  return {
    normalizedArgs: {},
    sourceIdentities: [],
    liveSnapshot: null,
    commands: [],
    counts: {},
    totals: {},
    exclusions: [],
    reviews: [],
    privatePayload: null,
  };
}

describe("a plan handle survives a new process and is still consumed once", () => {
  it("issue in one store, consume in a store hydrated from the sink, refuse a second consume", async () => {
    const sink = memorySink();
    const first = new ExecutionPlanStore({
      getActiveScope: scope,
      persistence: { store: "plans", sink, initial: [] },
    });
    const handle = first.issue("purchase_invoice.confirm", planInput());

    const second = new ExecutionPlanStore({
      getActiveScope: scope,
      persistence: { store: "plans", sink, initial: await sink.load("plans") },
    });
    expect(second.consume(handle, "purchase_invoice.confirm")).toBeTruthy();

    const third = new ExecutionPlanStore({
      getActiveScope: scope,
      persistence: { store: "plans", sink, initial: await sink.load("plans") },
    });
    expect(() => third.consume(handle, "purchase_invoice.confirm")).toThrow();
  });
});
