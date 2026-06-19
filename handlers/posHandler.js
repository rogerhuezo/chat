// handlers/posHandler.js
'use strict';

/**
 * posHandler.js
 * POS Staff Code / Till Login Issue Handler
 *
 * When a store user reports a POS/till/register login issue, this handler:
 *   1. Detects the POS intent (distinct from Okta)
 *   2. Acknowledges the issue
 *   3. Creates a ServiceNow incident
 *   4. Transfers to a live analyst
 *
 * This prevents POS issues from being mistakenly processed as Okta resets.
 * POS login resets require manual intervention (Aptos One is on private network).
 *
 * Trigger keywords: pos, till, register, aptos, staff code, new employee pos, etc.
 * NOT Okta: okta, mfa, sso, email login, computer login
 *
 * Version: 2.0.0 — incident + transfer (no API calls)
 */

const {
  createIncident,
  updateIncident
} = require('../utils/servicenow');

const { getTransferRegion } = require('../utils/regionUtils');

// ============================================================
// CONSTANTS
// ============================================================

const POS_TRIGGER_KEYWORDS = [
  // English — POS/till/register specific
  'pos login', 'pos password', 'pos reset', 'pos unlock',
  'till login', 'till password', 'till reset', 'till unlock',
  'register login', 'register password', 'register reset',
  'staff code', 'staff codes', 'new staff code',
  'update tills', 'update the tills',
  'pos access', 'pos account',
  'aptos login', 'aptos password', 'aptos reset', 'aptos unlock',
  'aptos', 'aptos one',
  // New employee POS access
  'new joiner pos', 'new employee pos', 'new hire pos',
  'new joiner till', 'new employee till', 'new hire till',
  'new joiner register', 'new employee register',
  "can't log into register", 'cannot log into register',
  "can't log into pos", 'cannot log into pos',
  "can't log into till", 'cannot log into till',
  "can't login to the register", 'cannot login to the register',
  'login to the register', 'log into the register',
  'log into pos', 'login to pos', 'login pos',
  // Tills + new employee combinations
  'new staff codes working', 'tills to have the new',
  'codes working', 'till codes',
  // Spanish
  'contraseña pos', 'restablecer pos', 'desbloquear pos',
  'codigo de empleado', 'código de empleado',
  'acceso pos', 'acceso al pos', 'clave pos',
  'nuevo empleado pos', 'nuevo ingreso pos',
  'caja registradora', 'iniciar sesion en caja',
  'codigo de caja', 'código de caja'
];

const REGIONAL_GROUPS = {
  'Latin America': 'LATAM SN SDESK',
  'North America': 'NA SN SDESK',
  'Europe':        'EU SN SDESK',
  'Asia Pacific':  'APAC SN SDESK'
};

// ============================================================
// MESSAGES
// ============================================================

const MSG = {
  acknowledge: {
    en: "I can see this is a **POS / register login issue**. This requires an IT analyst to process. Let me create a ticket and connect you with the right team.",
    es: "Puedo ver que este es un **problema de inicio de sesión POS / caja registradora**. Esto requiere que un analista de TI lo procese. Voy a crear un ticket y conectarte con el equipo adecuado."
  },
  ticketCreated: {
    en: (incidentNumber) =>
      `📋 Ticket created: **${incidentNumber}**\n\n` +
      `I'm transferring you to an IT analyst who can assist with the POS login reset. Please hold.`,
    es: (incidentNumber) =>
      `📋 Ticket creado: **${incidentNumber}**\n\n` +
      `Te estoy transfiriendo a un analista de TI que puede ayudarte con el restablecimiento de login POS. Por favor espera.`
  },
  ticketFailed: {
    en: "I wasn't able to create a ticket automatically, but let me transfer you to an analyst who can help with the POS login issue. Please hold.",
    es: "No pude crear un ticket automáticamente, pero te transferiré a un analista que puede ayudarte con el problema de login POS. Por favor espera."
  }
};

// ============================================================
// MAIN HANDLER
// ============================================================

async function handlePosStaffReset({
  attrs,
  msgLower,
  originalMsg,
  lang,
  callerEmail,
  storeName,
  region,
  countryCode,
  interactionNumber
}) {
  const l = (lang === 'es') ? 'es' : 'en';

  console.log(`[posHandler] POS issue detected — creating incident + transfer`);
  console.log(`[posHandler] message: "${originalMsg}" | store: ${callerEmail} | region: ${region}`);

  // Create ServiceNow incident
  const assignmentGroup = resolveAssignmentGroup(region);
  const workNotes = [
    '=== POS / Register Login Issue — Bot Detected ===',
    `User Message   : ${originalMsg}`,
    `Store Email    : ${callerEmail}`,
    `Store Name     : ${storeName || 'N/A'}`,
    `Region         : ${region || 'N/A'}`,
    `Country Code   : ${countryCode || 'N/A'}`,
    `Timestamp      : ${new Date().toISOString()}`,
    '',
    'Issue Type: POS / Till / Register Login',
    'This issue was detected as a POS login problem (not Okta).',
    'The store may need: staff code reset, new employee POS access,',
    'or till/register unlock via Aptos One.',
    '',
    'Action Required: Process POS login reset via Aptos One admin tools.',
    'Default password format: SK + employee number (e.g., SK51494)'
  ].join('\n');

  let incidentNumber = interactionNumber || 'N/A';
  try {
    const inc = await createIncident({
      title          : `POS Login Issue — ${storeName || callerEmail}`,
      description    : workNotes,
      callerId       : callerEmail,
      urgency        : '3',
      impact         : '3',
      assignmentGroup,
      uRegion        : region || 'North America'
    });
    incidentNumber = inc?.number || incidentNumber;
    console.log(`[posHandler] incident created: ${incidentNumber}`);
  } catch (e) {
    console.error(`[posHandler] createIncident failed: ${e.message}`);
  }

  const message = (incidentNumber && incidentNumber !== 'N/A')
    ? MSG.ticketCreated[l](incidentNumber)
    : MSG.ticketFailed[l];

  return {
    handled     : true,
    message,
    sessionAttrs: { posState: '', posAction: '' },
    transfer    : true  // Signal chatHandler to transfer to agent
  };
}

// ============================================================
// HELPERS
// ============================================================

function shouldHandlePos(msgLower, attrs) {
  // If already in POS flow, continue
  if (attrs.posState) return true;
  // Check for POS keywords
  return POS_TRIGGER_KEYWORDS.some(kw => msgLower.includes(kw));
}

function resolveAssignmentGroup(region) {
  return REGIONAL_GROUPS[region] || REGIONAL_GROUPS['North America'];
}

// ============================================================
// EXPORTS
// ============================================================
module.exports = {
  handlePosStaffReset,
  shouldHandlePos,
  POS_TRIGGER_KEYWORDS,
  POS_MSG: MSG
};

console.log('✅ posHandler.js v2.0.0 loaded');
console.log('   🏪 POS Issues  : Detect → Create Ticket → Transfer to Analyst');
console.log('   🚫 NOT Okta    : Prevents POS issues from being processed as Okta resets');
console.log('   🎫 Incident    : Auto-created with POS context');
console.log('   🔀 Transfer    : Routes to live analyst after ticket creation');
console.log('   🌎 Languages   : en / es');
