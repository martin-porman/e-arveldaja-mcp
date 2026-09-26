import { describe, expect, it } from "vitest";
import { VAT_MAP, vatCodeFor } from "./vat-map.js";

const IN = (o: Partial<Parameters<typeof vatCodeFor>[0]>) => vatCodeFor({ direction: "IN", rate: "24", reversed: false, partyCountry: "EE", turnoverDate: "2026-02-03", explicit: null, ...o });

describe("the fork's VAT inputs → core v2 VAT codes", () => {
  it("covers every core code exactly once, each citing its description", () => {
    expect(VAT_MAP).toHaveLength(26);
    expect(new Set(VAT_MAP.map((r) => r.code)).size).toBe(26);
    for (const r of VAT_MAP) expect(r.cites.length).toBeGreaterThan(20);
  });
  it("derives the unambiguous codes", () => {
    expect(IN({})).toEqual({ code: "P24" });
    expect(IN({ rate: "22", turnoverDate: "2025-06-30" })).toEqual({ code: "P22" });
    expect(IN({ rate: "9" })).toEqual({ code: "P9" });
    expect(IN({ rate: "13" })).toEqual({ code: "P13" });
    expect(IN({ rate: "-" })).toEqual({ code: "POUT" });
    expect(IN({ rate: "0", partyCountry: "US" })).toEqual({ code: "POUT" });
    expect(IN({ rate: "24" })).toEqual({ code: "P24" });
    expect(IN({ reversed: true })).toEqual({ code: "PRC24" });
    expect(IN({ reversed: true, rate: "22", turnoverDate: "2025-03-01" })).toEqual({ code: "PRC22" });
    expect(vatCodeFor({ direction: "OUT", rate: "24", reversed: false, partyCountry: "FI", turnoverDate: "2026-02-03", explicit: null })).toEqual({ code: "S24" });
  });
  it("refuses, by name, what the fork's fields cannot decide", () => {
    expect(JSON.stringify(IN({ reversed: true, partyCountry: "DE" }))).toMatch(/goods \(PEUG24\) or services \(PEUS24\).*crm_vat_code/);
    expect(JSON.stringify(IN({ reversed: true, partyCountry: "US" }))).toMatch(/outside the EU.*no core VAT code/);
    expect(JSON.stringify(vatCodeFor({ direction: "OUT", rate: "0", reversed: false, partyCountry: "EE", turnoverDate: "2026-02-03", explicit: null }))).toMatch(/S0EX, S0EU, S0EUS, SEX, SOUT or SRC/);
    expect(JSON.stringify(IN({ rate: "5" }))).toMatch(/no core VAT code at 5 %/);
    expect(JSON.stringify(IN({ rate: null }))).toMatch(/neither vat_rate_dropdown nor vat_rate/);
    expect(JSON.stringify(IN({ partyCountry: "FI" }))).toMatch(/24 % charged by a supplier in FI.*set crm_vat_code/);
    expect(JSON.stringify(IN({ rate: "24", turnoverDate: "2025-06-30" }))).toMatch(/24 % .* 2025-06-30/);
    expect(JSON.stringify(IN({ rate: "22", turnoverDate: "2025-07-01" }))).toMatch(/22 % .* 2025-07-01/);
  });
  it("accepts an explicit code only when it fits the line", () => {
    expect(IN({ reversed: true, partyCountry: "DE", explicit: "PEUS24" })).toEqual({ code: "PEUS24" });
    expect(IN({ reversed: true, partyCountry: "DE", explicit: "PEUG24" })).toEqual({ code: "PEUG24" });
    expect(IN({ rate: "-", explicit: "PEX" })).toEqual({ code: "PEX" });
    expect(IN({ explicit: "PIMP24" })).toEqual({ code: "PIMP24" });
    expect(IN({ partyCountry: "FI", explicit: "P24" })).toEqual({ code: "P24" });
    expect(vatCodeFor({ direction: "OUT", rate: "0", reversed: false, partyCountry: "DE", turnoverDate: "2026-02-03", explicit: "S0EUS" })).toEqual({ code: "S0EUS" });
    expect(JSON.stringify(vatCodeFor({ direction: "OUT", rate: "0", reversed: false, partyCountry: "EE", turnoverDate: "2026-02-03", explicit: "S0EUS" }))).toMatch(/S0EUS needs a party in another EU state/);
    expect(JSON.stringify(IN({ reversed: true, partyCountry: "EE", explicit: "PEUS24" }))).toMatch(/PEUS24 needs a party in another EU state/);
    expect(JSON.stringify(IN({ explicit: "S24" }))).toMatch(/S24 is a sale code/);
    expect(JSON.stringify(IN({ explicit: "PEUS24", reversed: false, partyCountry: "DE" }))).toMatch(/reverse charge/);
    expect(JSON.stringify(IN({ explicit: "NOPE" }))).toMatch(/unknown core VAT code NOPE/);
  });
});
