// utils/servicenow.js
'use strict';

const { SecretsManagerClient, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');

const smClient    = new SecretsManagerClient({ region: process.env.AWS_REGION || 'us-east-1' });
const SECRET_NAME = process.env.SECRET_NAME || 'skx_lex_servicenowkb';
const SNOW_HOST   = process.env.SNOW_HOST   || 'skx.service-now.com';

let cachedCreds = null;

const getCreds = async () => {
  if (cachedCreds) return cachedCreds;
  const res   = await smClient.send(new GetSecretValueCommand({ SecretId: SECRET_NAME }));
  cachedCreds = JSON.parse(res.SecretString);
  return cachedCreds;
};

const snowFetch = async (path, method = 'GET', body = null) => {
  const creds = await getCreds();
  const token = Buffer.from(`${creds.username}:${creds.password}`).toString('base64');
  const url   = `https://${SNOW_HOST}${path}`;

  console.log(`[servicenow] ${method} ${url}`);

  const opts = {
    method,
    headers: {
      'Authorization': `Basic ${token}`,
      'Content-Type':  'application/json',
      'Accept':        'application/json'
    },
    ...(body ? { body: JSON.stringify(body) } : {})
  };

  const res  = await fetch(url, opts);
  const json = await res.json();

  if (!res.ok) {
    console.error('[servicenow] error response:', JSON.stringify(json));
    throw new Error(`ServiceNow error ${res.status}: ${json?.error?.message || res.statusText}`);
  }

  return json;
};

// ── SNOW record prefix → table map (mirrors incidentHandler.js) ───────────────
const SNOW_TABLE_MAP = {
  INC   : 'incident',
  PRB   : 'problem',
  CHG   : 'change_request',
  RITM  : 'sc_req_item',
  REQ   : 'sc_request',
  TASK  : 'task',
  SCTASK: 'sc_task',
  IMS   : 'interaction',
  TKT   : 'incident',
  WO    : 'wm_order',
  WTASK : 'wm_task'
};

// ── Shared fields returned on all lookups ─────────────────────────────────────
const COMMON_FIELDS = 'number,short_description,state,sys_created_on,sys_updated_on,sys_id,assigned_to,assignment_group';

/**
 * Resolve a SNOW record number to its table name.
 * Falls back to 'incident' for unknown prefixes.
 */
const resolveTable = (ticketNumber) => {
  if (!ticketNumber) return 'incident';
  const prefix = ticketNumber.toUpperCase().trim().match(/^([A-Z]+)/)?.[1] || '';
  return SNOW_TABLE_MAP[prefix] || 'incident';
};

// ── Incident ───────────────────────────────────────────────────────────────────
const createIncident = async ({
  title,
  description,
  callerId,
  urgency         = '2',
  impact          = '2',
  assignmentGroup = 'NA SN SDESK',
  uRegion         = 'North America'
}) => {
  const body = {
    short_description: title       || 'IT Support Request',
    description:       description || title || 'IT Support Request',
    caller_id:         callerId    || '',
    urgency,
    impact,
    category:          'software',
    contact_type:      'chat',
    assignment_group:  assignmentGroup,
    u_region:          uRegion
  };

  console.log('[servicenow] createIncident:', JSON.stringify(body));
  const res = await snowFetch('/api/now/table/incident', 'POST', body);
  return {
    number   : res.result?.number,
    sysId    : res.result?.sys_id,
    state    : res.result?.state,
    shortDesc: res.result?.short_description
  };
};

/**
 * getTicket — look up any SNOW record by number or by caller.
 *
 * If `query` matches a SNOW prefix (INC, RITM, REQ, PRB, CHG, etc.)
 * it routes to the correct table automatically.
 *
 * If `query` is an email or username it queries the incident table
 * by caller_id (existing behaviour, incidents only).
 *
 * @param {string} query  - SNOW number (any prefix) OR caller email/username
 * @param {string} [table] - optional override table (skips auto-resolve)
 * @returns {Array} array of result records
 */
const getTicket = async (query, table = null) => {
  const normalized = (query || '').trim();
  const snowNumRx  = /^(INC|RITM|REQ|PRB|CHG|TASK|SCTASK|IMS|TKT|WO|WTASK)\d+$/i;
  const isSnowNum  = snowNumRx.test(normalized);

  const targetTable = table || (isSnowNum ? resolveTable(normalized) : 'incident');
  const encoded     = encodeURIComponent(normalized);

  const sysparmQuery = isSnowNum
    ? `number=${encoded}`
    : `caller_id.user_name=${encoded}^ORcaller_id.email=${encoded}`;

  const path = `/api/now/table/${targetTable}` +
    `?sysparm_query=${sysparmQuery}` +
    `&sysparm_limit=5` +
    `&sysparm_fields=${COMMON_FIELDS}`;

  console.log(`[servicenow] getTicket — table: ${targetTable} isSnowNum: ${isSnowNum} query: "${normalized}"`);
  const res = await snowFetch(path);
  return res.result || [];
};

/**
 * getIncident — legacy alias for getTicket scoped to the incident table.
 * Kept for backwards compatibility with any callers that haven't been updated.
 *
 * @param {string} query - INC number OR caller email/username
 * @returns {Array} array of incident records
 */
const getIncident = async (query) => {
  const normalized = (query || '').trim();
  const isIncNum   = /^INC\d+$/i.test(normalized);

  // If it looks like a non-INC SNOW number route to getTicket instead
  const snowNumRx = /^(RITM|REQ|PRB|CHG|TASK|SCTASK|IMS|TKT|WO|WTASK)\d+$/i;
  if (snowNumRx.test(normalized)) {
    console.log(`[servicenow] getIncident — non-INC number detected, routing to getTicket`);
    return getTicket(normalized);
  }

  const encoded      = encodeURIComponent(normalized);
  const sysparmQuery = isIncNum
    ? `number=${encoded}`
    : `caller_id.user_name=${encoded}^ORcaller_id.email=${encoded}`;

  const fields = COMMON_FIELDS;
  const path   = `/api/now/table/incident?sysparm_query=${sysparmQuery}&sysparm_limit=5&sysparm_fields=${fields}`;

  console.log(`[servicenow] getIncident — isIncNum: ${isIncNum} query: "${normalized}"`);
  const res = await snowFetch(path);
  return res.result || [];
};

/**
 * updateTicket — PATCH any SNOW record by sysId on the correct table.
 *
 * @param {string} sysId        - sys_id of the record
 * @param {object} updates      - fields to update
 * @param {string} [table]      - SNOW table name (default: 'incident')
 * @param {string} [ticketNum]  - optional ticket number used to auto-resolve table
 * @returns {object} updated record result
 */
const updateTicket = async (sysId, updates, table = null, ticketNum = null) => {
  const targetTable = table
    || (ticketNum ? resolveTable(ticketNum) : 'incident');

  console.log(`[servicenow] updateTicket — table: ${targetTable} sysId: ${sysId}`);
  const res = await snowFetch(`/api/now/table/${targetTable}/${sysId}`, 'PATCH', updates);
  return res.result;
};

/**
 * updateIncident — legacy alias for updateTicket scoped to incident table.
 * Kept for backwards compatibility.
 *
 * @param {string} sysId   - sys_id of the incident
 * @param {object} updates - fields to update
 * @returns {object} updated record result
 */
const updateIncident = async (sysId, updates) => {
  console.log(`[servicenow] updateIncident — sysId: ${sysId}`);
  const res = await snowFetch(`/api/now/table/incident/${sysId}`, 'PATCH', updates);
  return res.result;
};

// ── Interaction ────────────────────────────────────────────────────────────────
const createInteraction = async (body) => {
  console.log('[servicenow] createInteraction:', JSON.stringify(body));
  const res = await snowFetch('/api/now/table/interaction', 'POST', body);
  return res.result;
};

const getInteraction = async (sysId, fields = 'work_notes') => {
  const path = `/api/now/table/interaction/${sysId}?sysparm_fields=${fields}`;
  const res  = await snowFetch(path);
  return res.result;
};

const updateInteraction = async (sysId, updates) => {
  const res = await snowFetch(`/api/now/table/interaction/${sysId}`, 'PATCH', updates);
  return res.result;
};

module.exports = {
  // Core fetch
  snowFetch,

  // Incidents (legacy + new)
  createIncident,
  getIncident,      // legacy — incident table only
  getTicket,        // new — any SNOW table, auto-routed by prefix
  updateIncident,   // legacy — incident table only
  updateTicket,     // new — any SNOW table, accepts table param

  // Interactions
  createInteraction,
  getInteraction,
  updateInteraction,

  // Utility
  resolveTable
};