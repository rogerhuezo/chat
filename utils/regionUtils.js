// utils/regionUtils.js
'use strict';

// ── Connect queue names (must match exactly what's in your Connect flow) ──────
const CONNECT_QUEUES = {
  'North America': 'NA Service Chat',
  'Europe':        'EU Service Chat',
  'Latin America': 'Latam Service Chat',
  'Asia':          'NA Service Chat',   // APAC handled by NA team per Connect flow
  'default':       'NA Service Chat'
};

// ── ServiceNow assignment groups ───────────────────────────────────────────────
const SNOW_ASSIGNMENT_GROUPS = {
  'North America': { u_region: 'North America', assignment_group: 'NA SN SDESK'    },
  'Europe':        { u_region: 'Europe',        assignment_group: 'EU SN SDESK'    },
  'Latin America': { u_region: 'Latin America', assignment_group: 'LATAM SN SDESK' },
  'Asia Pacific':  { u_region: 'Asia Pacific',  assignment_group: 'APAC SN SDESK'  },
  'default':       { u_region: 'Global',        assignment_group: 'NA SN SDESK'    }
};

// ── Country code → region ──────────────────────────────────────────────────────
const COUNTRY_TO_REGION = {
  // North America
  US: 'North America', CA: 'North America', MX: 'North America',
  CR: 'North America', GT: 'North America', SV: 'North America',
  HN: 'North America', PA: 'North America', PR: 'North America',

  // Latin America
  BR: 'Latin America', AR: 'Latin America', CO: 'Latin America',
  PE: 'Latin America', CL: 'Latin America', EC: 'Latin America',
  BO: 'Latin America', PY: 'Latin America', UY: 'Latin America',
  VE: 'Latin America', GY: 'Latin America', SR: 'Latin America',
  BZ: 'Latin America',

  // Europe (incl. Middle East + Africa — routes to EU queue per Connect flow)
  GB: 'Europe', UK: 'Europe', FR: 'Europe', DE: 'Europe', IT: 'Europe',
  ES: 'Europe', PT: 'Europe', NL: 'Europe', BE: 'Europe', CH: 'Europe',
  AT: 'Europe', PL: 'Europe', SE: 'Europe', DK: 'Europe', NO: 'Europe',
  FI: 'Europe', IE: 'Europe', GR: 'Europe', RO: 'Europe', BG: 'Europe',
  CZ: 'Europe', HU: 'Europe', EE: 'Europe', RS: 'Europe', BA: 'Europe',
  GI: 'Europe', TR: 'Europe', IL: 'Europe', ZA: 'Europe', CM: 'Europe',
  MA: 'Europe', OM: 'Europe', SZ: 'Europe', ZW: 'Europe', AE: 'Europe',

  // Asia Pacific — SNOW uses APAC SN SDESK, Connect routes to NA Service Chat
  CN: 'Asia Pacific', JP: 'Asia Pacific', KR: 'Asia Pacific',
  IN: 'Asia Pacific', ID: 'Asia Pacific', PH: 'Asia Pacific',
  VN: 'Asia Pacific', TH: 'Asia Pacific', MY: 'Asia Pacific',
  SG: 'Asia Pacific', AU: 'Asia Pacific', NZ: 'Asia Pacific',
  TW: 'Asia Pacific', HK: 'Asia Pacific', PK: 'Asia Pacific',
  BD: 'Asia Pacific', LK: 'Asia Pacific', NP: 'Asia Pacific',
  KH: 'Asia Pacific', MM: 'Asia Pacific'
};

// ── Full country name map ──────────────────────────────────────────────────────
const COUNTRY_NAMES = {
  US: 'United States',   CA: 'Canada',          MX: 'Mexico',
  CR: 'Costa Rica',      GB: 'United Kingdom',  FR: 'France',
  DE: 'Germany',         IT: 'Italy',           ES: 'Spain',
  PT: 'Portugal',        NL: 'Netherlands',     BE: 'Belgium',
  CH: 'Switzerland',     AT: 'Austria',         SE: 'Sweden',
  DK: 'Denmark',         NO: 'Norway',          FI: 'Finland',
  IE: 'Ireland',         PL: 'Poland',          CZ: 'Czech Republic',
  HU: 'Hungary',         GR: 'Greece',          RO: 'Romania',
  BG: 'Bulgaria',        TR: 'Turkey',          IL: 'Israel',
  AE: 'United Arab Emirates', ZA: 'South Africa',
  CN: 'China',           JP: 'Japan',           KR: 'South Korea',
  IN: 'India',           ID: 'Indonesia',       PH: 'Philippines',
  VN: 'Vietnam',         TH: 'Thailand',        MY: 'Malaysia',
  SG: 'Singapore',       AU: 'Australia',       NZ: 'New Zealand',
  TW: 'Taiwan',          HK: 'Hong Kong',
  BR: 'Brazil',          AR: 'Argentina',       CO: 'Colombia',
  PE: 'Peru',            CL: 'Chile',           EC: 'Ecuador',
  BO: 'Bolivia',         PY: 'Paraguay',        UY: 'Uruguay',
  VE: 'Venezuela'
};

/**
 * Normalize countryCode — handles both ISO ('US') and full name ('United States')
 * Returns ISO code or the original string uppercased
 */
const normalizeCountryCode = (raw) => {
  if (!raw) return 'US';
  const upper = raw.trim().toUpperCase();
  // Already ISO
  if (upper.length <= 3 && COUNTRY_TO_REGION[upper]) return upper;
  // Full name lookup — reverse the COUNTRY_NAMES map
  const entry = Object.entries(COUNTRY_NAMES)
    .find(([, name]) => name.toUpperCase() === upper);
  return entry ? entry[0] : upper;
};

/**
 * Get region string for a country code
 * Used for SNOW ticket assignment (includes Asia Pacific)
 */
const getRegionFromCountryCode = (countryCode) => {
  const iso = normalizeCountryCode(countryCode);
  return COUNTRY_TO_REGION[iso] || 'North America';
};

/**
 * Get Connect transfer region
 * Asia Pacific → 'Asia' so Connect routes to NA Service Chat per the flow
 */
const getTransferRegion = (countryCode) => {
  const region = getRegionFromCountryCode(countryCode);
  // Connect flow has 'Asia' and 'APAC' both → NA Service Chat
  if (region === 'Asia Pacific') return 'Asia';
  return region;
};

/**
 * Get Connect queue name for a transfer region
 */
const getConnectQueue = (transferRegion) => {
  return CONNECT_QUEUES[transferRegion] || CONNECT_QUEUES['default'];
};

/**
 * Get ServiceNow assignment group + u_region for a region string
 */
const getAssignmentGroupAndRegion = (region) => {
  return SNOW_ASSIGNMENT_GROUPS[region] || SNOW_ASSIGNMENT_GROUPS['default'];
};

/**
 * Get full country name from ISO code
 */
const getCountryName = (countryCode) => {
  const iso = normalizeCountryCode(countryCode);
  return COUNTRY_NAMES[iso] || countryCode;
};

module.exports = {
  getRegionFromCountryCode,
  getTransferRegion,
  getConnectQueue,
  getAssignmentGroupAndRegion,
  getCountryName,
  normalizeCountryCode,
  CONNECT_QUEUES,
  SNOW_ASSIGNMENT_GROUPS
};