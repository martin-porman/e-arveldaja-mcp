import { describe, expect, it } from "vitest";
import { fromRikClient, toRikAccount, toRikClient } from "./mappers.js";
import { iso2ToIso3, iso3ToIso2 } from "./country-codes.js";

const acc = { code: "22", nameEt: "Võlad tarnijatele", nameEn: null, parentCode: "2", type: "LIABILITY" as const, normalSide: "C" as const, category: null, isHeading: false, requiresCounterparty: true, isVatAccount: false, allowsDimension: false, isActive: true, roles: ["PAYABLE"], createdBy: "seed" as const };

describe("RIK shapes at the boundary", () => {
  it("an account keeps its code as id and its roles as groups", () => {
    const a = toRikAccount(acc, 22);
    expect([a.id, a.name_est, a.balance_type, a.is_valid, a.requires_client, a.cl_account_groups, a.allows_deactivation]).toEqual([22, "Võlad tarnijatele", "C", true, true, ["PAYABLE"], false]);
  });
  it("a heading is never postable", () => {
    expect(toRikAccount({ ...acc, isHeading: true }, 2).is_valid).toBe(false);
  });
  it("a client round-trips without inventing a code", () => {
    const c = toRikClient({ id: "ck1", name: "Supplier OÜ", regCode: null, vatNo: null, country: "EE", isJuridical: true, isCustomer: false, isSupplier: true, isActive: true, iban: null }, 7);
    expect(c.code ?? null).toBeNull();
    expect(fromRikClient(c)).toMatchObject({ name: "Supplier OÜ", regCode: null, country: "EE", isSupplier: true });
  });
});

describe("country code translation at the boundary (CRM ISO-2 <-> RIK ISO-3)", () => {
  it("EE <-> EST", () => {
    expect(iso2ToIso3("EE")).toBe("EST");
    expect(iso3ToIso2("EST")).toBe("EE");
  });
  it("DE <-> DEU", () => {
    expect(iso2ToIso3("DE")).toBe("DEU");
    expect(iso3ToIso2("DEU")).toBe("DE");
  });
  it("an unknown code is refused by name, not silently defaulted", () => {
    expect(() => iso2ToIso3("XX")).toThrow(/XX/);
    expect(() => iso3ToIso2("ZZZ")).toThrow(/ZZZ/);
  });
  it("toRikClient/fromRikClient carry a German counterparty through DEU, not DE", () => {
    const c = toRikClient({ id: "ck2", name: "Berlin GmbH", regCode: null, vatNo: null, country: "DE", isJuridical: true, isCustomer: false, isSupplier: true, isActive: true, iban: null }, 8);
    expect(c.cl_code_country).toBe("DEU");
    expect(fromRikClient(c)).toMatchObject({ country: "DE" });
  });
});
