/**
 * The CRM stores ISO 3166-1 alpha-2 country codes (`Counterparty.country`,
 * e.g. `"EE"`); the RIK-shaped `Client.cl_code_country` field is ISO 3166-1
 * alpha-3 (e.g. `"EST"` — legal-entity-identity.ts:28, crud/clients.ts:82,
 * receipt-inbox.ts:811,846 all compare against `"EST"`). This is the
 * translation table between the two at that one boundary (mappers.ts).
 *
 * Minimal EU/EEA table — the fork's counterparties are Estonian-VAT-scoped
 * business entities, so this is deliberately not a full ISO-3166 list.
 */
const EU_EEA_COUNTRIES: ReadonlyArray<readonly [iso2: string, iso3: string]> = [
  ["AT", "AUT"], // Austria
  ["BE", "BEL"], // Belgium
  ["BG", "BGR"], // Bulgaria
  ["HR", "HRV"], // Croatia
  ["CY", "CYP"], // Cyprus
  ["CZ", "CZE"], // Czechia
  ["DK", "DNK"], // Denmark
  ["EE", "EST"], // Estonia
  ["FI", "FIN"], // Finland
  ["FR", "FRA"], // France
  ["DE", "DEU"], // Germany
  ["GR", "GRC"], // Greece
  ["HU", "HUN"], // Hungary
  ["IE", "IRL"], // Ireland
  ["IT", "ITA"], // Italy
  ["LV", "LVA"], // Latvia
  ["LT", "LTU"], // Lithuania
  ["LU", "LUX"], // Luxembourg
  ["MT", "MLT"], // Malta
  ["NL", "NLD"], // Netherlands
  ["PL", "POL"], // Poland
  ["PT", "PRT"], // Portugal
  ["RO", "ROU"], // Romania
  ["SK", "SVK"], // Slovakia
  ["SI", "SVN"], // Slovenia
  ["ES", "ESP"], // Spain
  ["SE", "SWE"], // Sweden
  ["IS", "ISL"], // Iceland (EEA)
  ["LI", "LIE"], // Liechtenstein (EEA)
  ["NO", "NOR"], // Norway (EEA)
];

const ISO2_TO_ISO3 = new Map<string, string>(EU_EEA_COUNTRIES.map(([iso2, iso3]) => [iso2, iso3]));
const ISO3_TO_ISO2 = new Map<string, string>(EU_EEA_COUNTRIES.map(([iso2, iso3]) => [iso3, iso2]));

/** CRM ISO-2 (e.g. `"EE"`) → RIK ISO-3 (e.g. `"EST"`). Throws, naming the code, when it isn't in the table. */
export function iso2ToIso3(iso2: string): string {
  const iso3 = ISO2_TO_ISO3.get(iso2);
  if (!iso3) throw new Error(`unknown EU/EEA country code: ${iso2}`);
  return iso3;
}

/** RIK ISO-3 (e.g. `"EST"`) → CRM ISO-2 (e.g. `"EE"`). Throws, naming the code, when it isn't in the table. */
export function iso3ToIso2(iso3: string): string {
  const iso2 = ISO3_TO_ISO2.get(iso3);
  if (!iso2) throw new Error(`unknown EU/EEA country code: ${iso3}`);
  return iso2;
}
