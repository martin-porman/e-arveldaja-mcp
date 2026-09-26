/**
 * The fork's VAT inputs (vat_rate_dropdown / vat_rate, reversed_vat_id, the counterparty's country, the
 * turnover date) → the CRM's core v2 VAT codes. One row per core code. The fork's fields cannot tell goods
 * from services, exempt from outside-scope, or an import from a domestic purchase, so those codes are
 * reachable only through an explicit `crm_vat_code` — never guessed (plan R4a Task 25).
 */
export type VatMapRow = { code: string; direction: "IN" | "OUT"; rate: string; reversed: boolean; party: "EE" | "EU" | "NON_EU" | "ANY"; derived: boolean; validFrom: string; validTo: string | null; cites: string };

export const VAT_MAP: readonly VatMapRow[] = [
  { code: "P24", direction: "IN", rate: "24", reversed: false, party: "ANY", derived: true, validFrom: "2025-07-01", validTo: null, cites: "Domestic purchase at 24 % (24 % from 2025-07-01: ee-vat-standard-rate.md, ee-vat-declaration_vat-rates-ee.md)" },
  { code: "P22", direction: "IN", rate: "22", reversed: false, party: "ANY", derived: true, validFrom: "2024-01-01", validTo: "2025-06-30", cites: "Domestic purchase at 22 %, tax point 2024-01-01…2025-06-30 (ee-vat-declaration_vat-rates-ee.md, rate history)" },
  { code: "P13", direction: "IN", rate: "13", reversed: false, party: "ANY", derived: true, validFrom: "2025-01-01", validTo: null, cites: "Domestic purchase at 13 %: accommodation (KMS § 15 lg 1¹, ee-vat-reduced-rates-and-exempt-supplies.md; from 2025-01-01, ee-vat-declaration_vat-rates-ee.md)" },
  { code: "P9", direction: "IN", rate: "9", reversed: false, party: "ANY", derived: true, validFrom: "2024-01-01", validTo: null, cites: "Domestic purchase at 9 % (KMS § 15 lg 2, ee-vat-reduced-rates-and-exempt-supplies.md; accommodation until 2024-12-31, ee-vat-declaration_vat-rates-ee.md)" },
  { code: "POUT", direction: "IN", rate: "0", reversed: false, party: "ANY", derived: true, validFrom: "2024-01-01", validTo: null, cites: "Purchase with no Estonian VAT and no self-assessment (outside the scope, or a supplier not registered for VAT)" },
  { code: "PRC24", direction: "IN", rate: "24", reversed: true, party: "EE", derived: true, validFrom: "2025-07-01", validTo: null, cites: "Domestic reverse-charge purchase of immovables, scrap metal, precious metal or metal products (KMS § 41¹) at 24 % from 2025-07-01 (ee-vat-standard-rate.md, ee-vat-declaration_vat-rates-ee.md)" },
  { code: "PRC22", direction: "IN", rate: "22", reversed: true, party: "EE", derived: true, validFrom: "2024-01-01", validTo: "2025-06-30", cites: "Domestic reverse-charge purchase of immovables, scrap metal, precious metal or metal products (KMS § 41¹) at 22 %, tax point 2024-01-01…2025-06-30 (ee-vat-declaration_vat-rates-ee.md, rate history)" },
  { code: "PEUG24", direction: "IN", rate: "24", reversed: true, party: "EU", derived: false, validFrom: "2025-07-01", validTo: null, cites: "Intra-Community acquisition of goods at 24 % from 2025-07-01 (ee-vat-standard-rate.md, ee-vat-declaration_vat-rates-ee.md)" },
  { code: "PEUG22", direction: "IN", rate: "22", reversed: true, party: "EU", derived: false, validFrom: "2024-01-01", validTo: "2025-06-30", cites: "Intra-Community acquisition of goods at 22 %, tax point 2024-01-01…2025-06-30 (ee-vat-declaration_vat-rates-ee.md, rate history)" },
  { code: "PEUG9", direction: "IN", rate: "9", reversed: true, party: "EU", derived: false, validFrom: "2024-01-01", validTo: null, cites: "Intra-Community acquisition of goods at 9 % (KMS § 15 lg 2, ee-vat-reduced-rates-and-exempt-supplies.md)" },
  { code: "PEUS24", direction: "IN", rate: "24", reversed: true, party: "EU", derived: false, validFrom: "2025-07-01", validTo: null, cites: "Service received from a taxable person of another Member State (KMS § 10 lg 1-2) at 24 % from 2025-07-01 (ee-vat-standard-rate.md, ee-vat-declaration_vat-rates-ee.md)" },
  { code: "PEUS22", direction: "IN", rate: "22", reversed: true, party: "EU", derived: false, validFrom: "2024-01-01", validTo: "2025-06-30", cites: "Service received from a taxable person of another Member State (KMS § 10 lg 1-2) at 22 %, tax point 2024-01-01…2025-06-30 (ee-vat-declaration_vat-rates-ee.md, rate history)" },
  { code: "PEUS9", direction: "IN", rate: "9", reversed: true, party: "EU", derived: false, validFrom: "2024-01-01", validTo: null, cites: "Service received from a taxable person of another Member State (KMS § 10 lg 1-2) at 9 % (KMS § 15 lg 2, ee-vat-reduced-rates-and-exempt-supplies.md)" },
  { code: "PEX", direction: "IN", rate: "0", reversed: false, party: "ANY", derived: false, validFrom: "2024-01-01", validTo: null, cites: "Exempt purchase (KMS § 16, ee-vat-reduced-rates-and-exempt-supplies.md): no VAT charged, nothing to deduct, not reported on form KMD." },
  { code: "PIMP24", direction: "IN", rate: "24", reversed: false, party: "ANY", derived: false, validFrom: "2025-07-01", validTo: null, cites: "Import VAT at 24 % paid to customs, deducted in the period customs released the goods (KMS § 31 lg 8, ee-vat-input-deduction-on-advance.md)" },
  { code: "PIMP22", direction: "IN", rate: "22", reversed: false, party: "ANY", derived: false, validFrom: "2024-01-01", validTo: "2025-06-30", cites: "Import VAT at 22 %, tax point 2024-01-01…2025-06-30 (ee-vat-declaration_vat-rates-ee.md); kept for corrections" },
  { code: "S24", direction: "OUT", rate: "24", reversed: false, party: "ANY", derived: true, validFrom: "2025-07-01", validTo: null, cites: "Domestic sale at 24 % (KMS § 15 lg 1; 24 % from 2025-07-01: ee-vat-standard-rate.md, ee-vat-declaration_vat-rates-ee.md)" },
  { code: "S22", direction: "OUT", rate: "22", reversed: false, party: "ANY", derived: true, validFrom: "2024-01-01", validTo: "2025-06-30", cites: "Domestic sale at 22 %, tax point 2024-01-01…2025-06-30 (ee-vat-declaration_vat-rates-ee.md, rate history)" },
  { code: "S13", direction: "OUT", rate: "13", reversed: false, party: "ANY", derived: true, validFrom: "2025-01-01", validTo: null, cites: "Domestic sale at 13 %: accommodation, with or without breakfast (KMS § 15 lg 1¹, ee-vat-reduced-rates-and-exempt-supplies.md); 13 % from 2025-01-01, 9 % before (ee-vat-declaration_vat-rates-ee.md)" },
  { code: "S9", direction: "OUT", rate: "9", reversed: false, party: "ANY", derived: true, validFrom: "2024-01-01", validTo: null, cites: "Domestic sale at 9 %: books, listed medicines and aids, press from 2025 (KMS § 15 lg 2, ee-vat-reduced-rates-and-exempt-supplies.md); accommodation until 2024-12-31 (ee-vat-declaration_vat-rates-ee.md)" },
  { code: "S0EX", direction: "OUT", rate: "0", reversed: false, party: "NON_EU", derived: false, validFrom: "2024-01-01", validTo: null, cites: "Export of goods at 0 % (KMS § 15 lg 3 p 1, ee-vat-reduced-rates-and-exempt-supplies.md)" },
  { code: "S0EUS", direction: "OUT", rate: "0", reversed: false, party: "EU", derived: false, validFrom: "2024-01-01", validTo: null, cites: "Intra-Community supply of services to a taxable person of another Member State at 0 % (KMS § 10 lg 4 p 9, § 15 lg 4); KMD lines 3 and 3.1, not 3.1.1 (ee-vat-declaration_form-kmd-2025-07.md:38-41, 148-153)" },
  { code: "S0EU", direction: "OUT", rate: "0", reversed: false, party: "EU", derived: false, validFrom: "2024-01-01", validTo: null, cites: "Intra-Community supply of goods at 0 % (KMS § 15 lg 3 p 2, ee-vat-reduced-rates-and-exempt-supplies.md)" },
  { code: "SEX", direction: "OUT", rate: "0", reversed: false, party: "ANY", derived: false, validFrom: "2024-01-01", validTo: null, cites: "Exempt supply (maksuvaba käive, KMS § 16, ee-vat-reduced-rates-and-exempt-supplies.md); not 0 %" },
  { code: "SOUT", direction: "OUT", rate: "0", reversed: false, party: "ANY", derived: false, validFrom: "2024-01-01", validTo: null, cites: "Sale outside the scope of Estonian VAT (not a supply under KMS)" },
  { code: "SRC", direction: "OUT", rate: "0", reversed: false, party: "EE", derived: false, validFrom: "2024-01-01", validTo: null, cites: "Domestic supply under the KMS § 41¹ reverse charge (immovables, scrap metal, precious metal); the buyer accounts for the VAT" },
];

const EU = new Set(["AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE", "GR", "HU", "IE", "IT", "LV", "LT", "LU", "MT", "NL", "PL", "PT", "RO", "SK", "SI", "ES", "SE"]);
const partyClass = (country: string): "EE" | "EU" | "NON_EU" => (country === "EE" ? "EE" : EU.has(country) ? "EU" : "NON_EU");
const fits = (party: VatMapRow["party"], cls: "EE" | "EU" | "NON_EU") => party === "ANY" || party === cls;
const normalRate = (rate: string | null): string => {
  const s = (rate ?? "").trim().replace(",", ".").replace("%", "");
  return s === "" || s === "-" ? "0" : String(Number(s));
};
const inForce = (r: VatMapRow, day: string) => r.validFrom <= day && (r.validTo === null || day <= r.validTo);

export type VatMapInput = { direction: "IN" | "OUT"; rate: string | null; reversed: boolean; partyCountry: string; turnoverDate: string; explicit: string | null };

export function vatCodeFor(input: VatMapInput): { code: string } | { problem: string } {
  if (input.rate === null || input.rate.trim() === "") return { problem: "the line has neither vat_rate_dropdown nor vat_rate — the VAT is unknown, never assumed" };
  const rate = normalRate(input.rate);
  const cls = partyClass(input.partyCountry.toUpperCase());
  if (input.explicit) {
    const row = VAT_MAP.find((r) => r.code === input.explicit);
    if (!row) return { problem: `unknown core VAT code ${input.explicit}` };
    if (row.direction !== input.direction) return { problem: `${row.code} is a ${row.direction === "OUT" ? "sale" : "purchase"} code; this line is a ${input.direction === "OUT" ? "sale" : "purchase"}` };
    if (row.reversed !== input.reversed) return { problem: `${row.code} ${row.reversed ? "is a reverse charge; set reversed_vat_id" : "is not a reverse charge; clear reversed_vat_id"}` };
    if (row.rate !== rate) return { problem: `${row.code} is ${row.rate} %; the line says ${rate} %` };
    if (!fits(row.party, cls)) return { problem: `${row.code} needs a party ${row.party === "EU" ? "in another EU state" : row.party === "EE" ? "in Estonia" : "outside the EU"}; this party is in ${input.partyCountry}` };
    if (!inForce(row, input.turnoverDate)) return { problem: `${row.code} is not in force on ${input.turnoverDate} (${row.validFrom}…${row.validTo ?? "open"})` };
    return { code: row.code };
  }
  // A domestic purchase rate is derived only from an Estonian supplier: a foreign supplier's own 24 % or 9 % is
  // not Estonian input VAT. An explicit crm_vat_code may still name P24 for a foreign supplier registered in Estonia.
  const deriveFits = (r: VatMapRow) => (r.direction === "IN" && !r.reversed && r.rate !== "0" ? cls === "EE" : fits(r.party, cls));
  const candidates = VAT_MAP.filter((r) => r.derived && r.direction === input.direction && r.rate === rate && r.reversed === input.reversed && deriveFits(r));
  const live = candidates.filter((r) => inForce(r, input.turnoverDate));
  if (live.length === 1) return { code: live[0]!.code };
  if (candidates.length > 0) return { problem: `${rate} % is not in force on ${input.turnoverDate} (${candidates.map((r) => `${r.code} ${r.validFrom}…${r.validTo ?? "open"}`).join(", ")})` };
  if (input.direction === "IN" && input.reversed && cls === "EU") return { problem: `a reverse charge from ${input.partyCountry}: goods (PEUG${rate}) or services (PEUS${rate})? set crm_vat_code and say why` };
  if (input.direction === "IN" && input.reversed && cls === "NON_EU") return { problem: `a reverse charge from outside the EU (${input.partyCountry}): the chart has no core VAT code for it — ask the operator` };
  if (input.direction === "OUT" && rate === "0") return { problem: "a 0 % sale is S0EX, S0EU, S0EUS, SEX, SOUT or SRC — set crm_vat_code and say why" };
  if (input.direction === "IN" && !input.reversed && rate !== "0" && cls !== "EE") return { problem: `${rate} % charged by a supplier in ${input.partyCountry}: Estonian input VAT (KMD line 5) only from a supplier registered for Estonian VAT — set crm_vat_code (P${rate} if it is) or ask` };
  if (!VAT_MAP.some((r) => r.rate === rate)) return { problem: `no core VAT code at ${rate} %` };
  return { problem: `no core VAT code fits ${input.direction} ${rate} %${input.reversed ? " reverse charge" : ""} for a party in ${input.partyCountry}` };
}
