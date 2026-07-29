/**
 * ISO 3166-1 alpha-2 country reference list.
 *
 * CBPR+ debtor/creditor country fields require an exact 2-letter ISO code
 * (see the `country` iso_format_id and `max_length: 2` rule in
 * cbprRules.json), so free-text entry of a country name is always rejected
 * as too long. This list backs a country picker so the captured value is
 * always a valid 2-letter code rather than a free-typed name.
 *
 * This is a curated common-country subset for the demo, not the full
 * ISO 3166-1 list — sorted by display label.
 */

/**
 * @type {ReadonlyArray<{ code: string, label: string }>}
 */
export const ISO_COUNTRIES = Object.freeze(
  [
    { code: 'AE', label: 'United Arab Emirates' },
    { code: 'AT', label: 'Austria' },
    { code: 'AU', label: 'Australia' },
    { code: 'BE', label: 'Belgium' },
    { code: 'BR', label: 'Brazil' },
    { code: 'CA', label: 'Canada' },
    { code: 'CH', label: 'Switzerland' },
    { code: 'CN', label: 'China' },
    { code: 'CZ', label: 'Czechia' },
    { code: 'DE', label: 'Germany' },
    { code: 'DK', label: 'Denmark' },
    { code: 'ES', label: 'Spain' },
    { code: 'FI', label: 'Finland' },
    { code: 'FR', label: 'France' },
    { code: 'GB', label: 'United Kingdom' },
    { code: 'GR', label: 'Greece' },
    { code: 'HK', label: 'Hong Kong' },
    { code: 'HU', label: 'Hungary' },
    { code: 'IE', label: 'Ireland' },
    { code: 'IN', label: 'India' },
    { code: 'IT', label: 'Italy' },
    { code: 'JP', label: 'Japan' },
    { code: 'KR', label: 'South Korea' },
    { code: 'LU', label: 'Luxembourg' },
    { code: 'MX', label: 'Mexico' },
    { code: 'NL', label: 'Netherlands' },
    { code: 'NO', label: 'Norway' },
    { code: 'NZ', label: 'New Zealand' },
    { code: 'PL', label: 'Poland' },
    { code: 'PT', label: 'Portugal' },
    { code: 'SE', label: 'Sweden' },
    { code: 'SG', label: 'Singapore' },
    { code: 'TH', label: 'Thailand' },
    { code: 'TR', label: 'Turkey' },
    { code: 'US', label: 'United States' },
    { code: 'ZA', label: 'South Africa' },
  ].sort((a, b) => a.label.localeCompare(b.label)),
);

export default ISO_COUNTRIES;
