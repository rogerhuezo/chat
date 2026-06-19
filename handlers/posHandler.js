// handlers/posHandler.js
'use strict';

/**
 * posHandler.js
 * Conversational state machine for POS Staff Code Management
 * Retail Store employees — Aptos One POS (NA, EU, Japan, Philippines)
 * LATAM stores use Xstore (redirected to manual process)
 *
 * Flow:
 *   1. Detect POS intent from message keywords
 *   2. Guard: Aptos region only (redirect LATAM/Xstore)
 *   3. Collect employee POS username/staff code
 *   4. Look up in Aptos One API
 *   5. Confirm with user before acting
 *   6. Execute: reset password or unlock account
 *   7. Create ServiceNow incident with full payload
 *
 * Version: 1.0.0
 */

const {
  getUserByPosUsername,
  executePosAction,
  normalizePosUsername,
  getAlternateUsername,
  getPosSystem,
  getSecurityLevelLabel,
  buildDefaultPassword,
  DEFAULT_POS_PASSWORD
} = require('../utils/aptosApiHandler');

const {
  createIncident,
  updateIncident
} = require('../utils/servicenow');


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
  // New employee POS access
  'new joiner pos', 'new employee pos', 'new hire pos',
  'new joiner till', 'new employee till', 'new hire till',
  'new joiner register', 'new employee register',
  'can\'t log into register', 'cannot log into register',
  'can\'t log into pos', 'cannot log into pos',
  'can\'t log into till', 'cannot log into till',
  // Spanish
  'contraseña pos', 'restablecer pos', 'desbloquear pos',
  'codigo de empleado', 'código de empleado',
  'acceso pos', 'acceso al pos', 'clave pos',
  'nuevo empleado pos', 'nuevo ingreso pos'
];

const POS_ACTION_TRIGGERS = {
  password_reset: [
    'reset', 'password', 'new staff code', 'staff codes',
    'update tills', 'new joiner', 'new employee', 'new hire',
    'can\'t log', 'cannot log', 'contraseña', 'restablecer',
    'codigo', 'código', 'clave', 'nuevo'
  ],
  account_unlock: [
    'unlock', 'locked', 'locked out', 'desbloquear', 'bloqueado', 'bloqueada'
  ]
};


const REGIONAL_GROUPS = {
  'Latin America': 'LATAM SN SDESK',
  'North America': 'NA SN SDESK',
  'EMEA'         : 'EMEA SN SDESK',
  'Europe'       : 'EU SN SDESK',
  'Asia Pacific' : 'APAC SN SDESK'
};

// ============================================================
// MESSAGES
// ============================================================
const MSG = {
  xstoreRedirect: {
    en: '⚠️ Your region uses **Xstore POS**. Automated POS resets are only available for Aptos One regions (NA, EU, Japan, Philippines).\n\nFor Xstore password reset or unlock, please submit a ticket to your Regional IT team.',
    es: '⚠️ Tu región usa **Xstore POS**. Los restablecimientos automáticos de POS solo están disponibles para regiones Aptos One (NA, EU, Japón, Filipinas).\n\nPara restablecer o desbloquear Xstore, por favor crea un ticket con tu equipo regional de TI.'
  },
  intro: {
    en: (action) =>
      `Got it — **POS ${action}**.\n\nPlease provide the employee number (numeric ID from Workday/HR).\n\n💡 **Tip:** This is the same employee number used in HR systems. For 5+ digit IDs, the POS login has an "SKE" prefix (e.g., employee 51494 → SKE51494). You can provide either format.`,
    es: (action) =>
      `Entendido — **POS ${action}**.\n\nPor favor proporciona el número de empleado (ID numérico de Workday/RH).\n\n💡 **Tip:** Es el mismo número de empleado del sistema de RH. Para IDs de 5+ dígitos, el login POS tiene prefijo "SKE" (ej: empleado 51494 → SKE51494). Puedes proporcionar cualquier formato.`
  },
  askId: {
    en: 'Please provide the employee number (the same numeric ID used in Workday/HR, e.g., 51494 or 123456).\n\n💡 **Tip:** The POS login is the employee number. For IDs with 5+ digits, the system adds an "SKE" prefix automatically (e.g., employee 51494 → POS login SKE51494).',
    es: 'Por favor proporciona el número de empleado (el mismo ID numérico usado en Workday/RH, ej: 51494 o 123456).\n\n💡 **Tip:** El login POS es el número de empleado. Para IDs de 5+ dígitos, el sistema agrega el prefijo "SKE" automáticamente (ej: empleado 51494 → login POS SKE51494).'
  },
  foundEmployee: {
    en: (action) => `Found the following employee for **POS ${action}**:`,
    es: (action) => `Encontré al siguiente empleado para **POS ${action}**:`
  },
  confirmPrompt: {
    en: '\nShould I proceed? Reply **yes** to confirm or **no** to cancel.',
    es: '\n¿Procedo con esta acción? Responde **sí** para confirmar o **no** para cancelar.'
  },
  notFound: {
    en: (id) => `⚠️ POS user **${id}** was not found in Aptos One.\n\nPlease verify the employee number. The POS login is typically:\n• Employee number as-is (e.g., 1234)\n• With "SKE" prefix for 5+ digits (e.g., SKE51494)\n\nMake sure the employee has been onboarded in the HR system and that their data has synced to the POS.`,
    es: (id) => `⚠️ El usuario POS **${id}** no fue encontrado en Aptos One.\n\nPor favor verifica el número de empleado. El login POS típicamente es:\n• El número de empleado tal cual (ej: 1234)\n• Con prefijo "SKE" para 5+ dígitos (ej: SKE51494)\n\nAsegúrate que el empleado esté registrado en el sistema de RH y que sus datos se hayan sincronizado con el POS.`
  },

  notFoundChoice: {
    en: 'What would you like to do?\n\n1️⃣ **Try again** — type the correct staff code\n2️⃣ **Create incident & transfer** — log it and connect you with an analyst',
    es: '¿Qué deseas hacer?\n\n1️⃣ **Reintentar** — escribe el código correcto\n2️⃣ **Crear incidente y transferir** — registrar y conectarte con un analista'
  },
  cancelled: {
    en: '❌ POS action cancelled. Is there anything else I can help you with?',
    es: '❌ Acción POS cancelada. ¿Puedo ayudarte con algo más?'
  },
  confirmOnly: {
    en: 'Please reply **yes** to proceed or **no** to cancel.',
    es: 'Por favor responde **sí** para continuar o **no** para cancelar.'
  },
  resultSuccess: {
    en: (name, username, action) => {
      const defaultPwd = buildDefaultPassword(username);
      if (action === 'Password Reset') {
        return `✅ **${name}** (POS: ${username}) — POS ${action} completed successfully.\n\n**Default password:** \`${defaultPwd}\`\nThe employee will need to enter this at the register to log in.\n\nThe DCN file will sync to the store server shortly. The employee should be able to log in at the till within a few minutes.`;
      }
      return `✅ **${name}** (POS: ${username}) — POS ${action} completed successfully.\n\nThe account has been unlocked. The employee can now log in at the register with their existing password.\n\nThe DCN file will sync to the store server shortly.`;
    },
    es: (name, username, action) => {
      const defaultPwd = buildDefaultPassword(username);
      if (action === 'Restablecimiento de Contraseña') {
        return `✅ **${name}** (POS: ${username}) — POS ${action} completado exitosamente.\n\n**Contraseña predeterminada:** \`${defaultPwd}\`\nEl empleado necesitará ingresarla en el registro para iniciar sesión.\n\nEl archivo DCN se sincronizará con el servidor de la tienda en breve.`;
      }
      return `✅ **${name}** (POS: ${username}) — POS ${action} completado exitosamente.\n\nLa cuenta ha sido desbloqueada. El empleado puede iniciar sesión en el registro con su contraseña existente.\n\nEl archivo DCN se sincronizará con el servidor de la tienda en breve.`;
    }
  },
  resultFailed: {
    en: (name, username, error) => `❌ **${name}** (POS: ${username}) — Failed: ${error}`,
    es: (name, username, error) => `❌ **${name}** (POS: ${username}) — Error: ${error}`
  },
  summary: {
    en: (ticket) => `\n📋 Incident logged: **${ticket}**\n\nIs there anything else I can help you with?`,
    es: (ticket) => `\n📋 Incidente registrado: **${ticket}**\n\n¿Puedo ayudarte con algo más?`
  }
};


// ============================================================
// HELPERS
// ============================================================

function detectPosAction(msgLower) {
  for (const [action, triggers] of Object.entries(POS_ACTION_TRIGGERS)) {
    if (triggers.some(t => msgLower.includes(t))) return action;
  }
  return 'password_reset'; // default action
}

function actionLabel(action, lang) {
  const labels = {
    password_reset: { en: 'Password Reset',  es: 'Restablecimiento de Contraseña' },
    account_unlock: { en: 'Account Unlock',  es: 'Desbloqueo de Cuenta'           }
  };
  return (labels[action] || labels.password_reset)[lang]
      || (labels[action] || labels.password_reset).en;
}

function parsePosId(text) {
  // Match SKE##### or plain numbers (4-8 digits)
  const skeMatch = text.match(/\bSKE\d{3,8}\b/i);
  if (skeMatch) return skeMatch[0].toUpperCase();
  const numMatch = text.match(/\b\d{4,8}\b/);
  if (numMatch) return numMatch[0];
  // Also accept alphanumeric staff codes
  const alphaMatch = text.match(/\b[A-Z]{2,4}\d{3,8}\b/i);
  if (alphaMatch) return alphaMatch[0].toUpperCase();
  return null;
}

function resolveAssignmentGroup(region) {
  return REGIONAL_GROUPS[region] || REGIONAL_GROUPS['North America'];
}

function isYes(msgLower) {
  return /\b(yes|si|sí|yep|ok|okay|sure|proceed|confirm|go ahead|adelante|confirmo|claro)\b/i.test(msgLower);
}

function isNo(msgLower) {
  return /\b(no|cancel|cancelar|stop|nope|nah|never|abort)\b/i.test(msgLower);
}

function wantsIncident(msgLower) {
  return /\b(2|incident|incidente|create|crear|log|registrar)\b/i.test(msgLower);
}

function wantsRetry(msgLower) {
  return /\b(1|retry|reintentar|try again|intentar)\b/i.test(msgLower);
}

function shouldHandlePos(msgLower, attrs) {
  if (attrs.posState) return true;
  return POS_TRIGGER_KEYWORDS.some(kw => msgLower.includes(kw));
}

function clearPosState() {
  return { posState: '', posAction: '', posEmployee: '', posUsername: '' };
}


// ============================================================
// SERVICENOW INCIDENT
// ============================================================

function buildPosWorkNotes({ label, employee, success, error, callerEmail, storeName, region }) {
  const lines = [
    '=== POS Staff Code Management — Bot Processed ===',
    `Action         : POS ${label}`,
    `Store Email    : ${callerEmail}`,
    `Store Name     : ${storeName || 'N/A'}`,
    `Region         : ${region || 'N/A'}`,
    `POS System     : Aptos One`,
    `Timestamp      : ${new Date().toISOString()}`,
    '',
    '=== Employee Details ===',
    `  Name           : ${employee.displayName || 'N/A'}`,
    `  POS Username   : ${employee.username || 'N/A'}`,
    `  Aptos User ID  : ${employee.aptosId || 'N/A'}`,
    `  Account Status : ${employee.accountStatus || 'N/A'}`,
    `  Security Level : ${employee.securityRoleId} - ${employee.securityLevel || 'N/A'}`,
    '',
    `  Action Result  : ${success ? 'SUCCESS' : 'FAILED'}`,
  ];
  if (error) lines.push(`  Error          : ${error}`);
  lines.push('');
  lines.push('Note: DCN file sync will propagate changes to the store POS server.');
  return lines.join('\n');
}

async function createPosIncident({ shortDescription, workNotes, callerEmail, assignmentGroup, region, resolved = false }) {
  let incidentNumber = 'N/A';
  let incidentSysId  = null;

  try {
    const inc = await createIncident({
      title          : shortDescription,
      description    : workNotes,
      callerId       : callerEmail,
      urgency        : '3',
      impact         : '3',
      assignmentGroup: assignmentGroup,
      uRegion        : region || 'North America'
    });
    incidentNumber = inc?.number || incidentNumber;
    incidentSysId  = inc?.sysId  || null;
    console.log(`[posHandler] incident created: ${incidentNumber}`);
  } catch (e) {
    console.error(`[posHandler] createIncident failed: ${e.message}`);
    return incidentNumber;
  }

  if (resolved && incidentSysId) {
    try {
      await updateIncident(incidentSysId, {
        state           : '6',
        close_code      : 'Solved (Permanently)',
        close_notes     : workNotes,
        resolution_notes: 'Resolved automatically by SkechAI — POS action completed successfully.'
      });
      console.log(`[posHandler] incident resolved: ${incidentNumber}`);
    } catch (e) {
      console.error(`[posHandler] resolveIncident failed (non-fatal): ${e.message}`);
    }
  }

  return incidentNumber;
}


// ============================================================
// LOOKUP HELPER
// ============================================================

async function lookupUser(posId) {
  const username = normalizePosUsername(posId);
  console.log(`[posHandler] looking up POS user: ${username}`);

  let user = await getUserByPosUsername(username);
  if (!user) {
    const alt = getAlternateUsername(username);
    if (alt) {
      console.log(`[posHandler] trying alternate: ${alt}`);
      user = await getUserByPosUsername(alt);
    }
  }
  return user;
}

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
  countryCode
}) {
  const l = (lang === 'es') ? 'es' : 'en';

  // ── Guard: Check POS system by region ────────────────────
  const posSystem = getPosSystem(countryCode || 'US');
  if (posSystem === 'xstore') {
    console.log(`[posHandler] Xstore region detected (${countryCode}) — redirecting`);
    return {
      handled     : true,
      message     : MSG.xstoreRedirect[l],
      sessionAttrs: clearPosState()
    };
  }

  const prevState = attrs.posState || '';

  // ══════════════════════════════════════════════════════════
  // STATE 0: New request — detect action, prompt for ID
  // ══════════════════════════════════════════════════════════
  if (!prevState) {
    const action = detectPosAction(msgLower);
    const label  = actionLabel(action, l);
    const posId  = parsePosId(originalMsg);

    if (posId) {
      // User provided ID in the initial message
      return await lookupAndConfirm({ posId, action, label, l, callerEmail, attrs });
    }

    return {
      handled     : true,
      message     : MSG.intro[l](label),
      sessionAttrs: { posState: 'AWAITING_ID', posAction: action }
    };
  }


  // ══════════════════════════════════════════════════════════
  // STATE 1: Waiting for POS username / staff code
  // ══════════════════════════════════════════════════════════
  if (prevState === 'AWAITING_ID') {
    const action = attrs.posAction || 'password_reset';
    const label  = actionLabel(action, l);
    const posId  = parsePosId(originalMsg);

    if (!posId) {
      return {
        handled     : true,
        message     : MSG.askId[l],
        sessionAttrs: { posState: 'AWAITING_ID', posAction: action }
      };
    }

    return await lookupAndConfirm({ posId, action, label, l, callerEmail, attrs });
  }

  // ══════════════════════════════════════════════════════════
  // STATE 2: Waiting for yes/no confirmation
  // ══════════════════════════════════════════════════════════
  if (prevState === 'AWAITING_CONFIRM') {
    if (isNo(msgLower)) {
      return {
        handled     : true,
        message     : MSG.cancelled[l],
        sessionAttrs: clearPosState()
      };
    }

    if (!isYes(msgLower)) {
      return {
        handled     : true,
        message     : MSG.confirmOnly[l],
        sessionAttrs: {
          posState   : 'AWAITING_CONFIRM',
          posAction  : attrs.posAction,
          posEmployee: attrs.posEmployee,
          posUsername : attrs.posUsername
        }
      };
    }

    // Execute the action
    const action   = attrs.posAction || 'password_reset';
    const label    = actionLabel(action, l);
    let employee;
    try { employee = JSON.parse(attrs.posEmployee || '{}'); } catch (_) { employee = {}; }

    if (!employee.aptosId) {
      return {
        handled     : true,
        message     : 'Something went wrong — employee data not found. Please start again.',
        sessionAttrs: clearPosState()
      };
    }

    let success = false;
    let error   = null;
    try {
      const result = await executePosAction(action, employee.aptosId, employee.username);
      success = result.success;
      console.log(`[posHandler] ✅ ${action} success: ${employee.displayName}`);
    } catch (e) {
      error = e.message;
      console.error(`[posHandler] ❌ ${action} failed: ${e.message}`);
    }


    // Create ServiceNow incident
    const assignmentGroup = resolveAssignmentGroup(region);
    const workNotes = buildPosWorkNotes({
      label, employee, success, error, callerEmail, storeName, region
    });

    const incidentNumber = await createPosIncident({
      shortDescription: `POS ${label} — ${employee.displayName || employee.username} — ${storeName || callerEmail}`,
      workNotes,
      callerEmail,
      assignmentGroup,
      region,
      resolved: success
    });

    const message = success
      ? MSG.resultSuccess[l](employee.displayName, employee.username, label) + MSG.summary[l](incidentNumber)
      : MSG.resultFailed[l](employee.displayName, employee.username, error) + MSG.summary[l](incidentNumber);

    return {
      handled     : true,
      message,
      sessionAttrs: clearPosState()
    };
  }

  // ══════════════════════════════════════════════════════════
  // STATE 3: User not found — retry or create incident
  // ══════════════════════════════════════════════════════════
  if (prevState === 'AWAITING_NOT_FOUND_CHOICE') {
    const action = attrs.posAction || 'password_reset';
    const label  = actionLabel(action, l);
    const posId  = parsePosId(originalMsg);

    if (wantsIncident(msgLower) && !posId) {
      const assignmentGroup = resolveAssignmentGroup(region);
      const workNotes = [
        '=== POS Staff Code — Employee Not Found ===',
        `Action Requested : POS ${label}`,
        `POS Username     : ${attrs.posUsername || 'N/A'}`,
        `Store Email      : ${callerEmail}`,
        `Store Name       : ${storeName || 'N/A'}`,
        `Region           : ${region || 'N/A'}`,
        `Timestamp        : ${new Date().toISOString()}`,
        '',
        'IT Action Required: Verify that the POS username exists in Aptos One.',
        'If the employee is new, the DCN file may not have synced yet.'
      ].join('\n');

      const incidentNumber = await createPosIncident({
        shortDescription: `POS ${label} — User not found — ${storeName || callerEmail}`,
        workNotes,
        callerEmail,
        assignmentGroup,
        region,
        resolved: false
      });

      return {
        handled     : true,
        message     : `📋 Incident created: **${incidentNumber}**\n\nLet me connect you with an analyst who can help further. Please hold.`,
        sessionAttrs: clearPosState(),
        transfer    : true
      };
    }

    if (wantsRetry(msgLower) || posId) {
      const idToUse = posId || attrs.posUsername;
      if (idToUse) {
        return await lookupAndConfirm({ posId: idToUse, action, label, l, callerEmail, attrs });
      }
      return {
        handled     : true,
        message     : MSG.askId[l],
        sessionAttrs: { posState: 'AWAITING_ID', posAction: action }
      };
    }

    return {
      handled     : true,
      message     : MSG.notFoundChoice[l],
      sessionAttrs: { posState: 'AWAITING_NOT_FOUND_CHOICE', posAction: action, posUsername: attrs.posUsername }
    };
  }

  // ── Unknown state — reset ─────────────────────────────────
  console.warn(`[posHandler] unknown state: "${prevState}" — resetting`);
  return {
    handled     : true,
    message     : MSG.askId[l],
    sessionAttrs: { posState: 'AWAITING_ID', posAction: detectPosAction(msgLower) }
  };
}


// ============================================================
// LOOKUP + CONFIRM
// ============================================================

async function lookupAndConfirm({ posId, action, label, l, callerEmail, attrs }) {
  const user = await lookupUser(posId);

  if (!user) {
    const normalizedId = normalizePosUsername(posId);
    return {
      handled     : true,
      message     : MSG.notFound[l](normalizedId) + '\n\n' + MSG.notFoundChoice[l],
      sessionAttrs: {
        posState   : 'AWAITING_NOT_FOUND_CHOICE',
        posAction  : action,
        posUsername : normalizedId
      }
    };
  }

  const statusLabel = user.accountStatus || 'Unknown';
  const lines = [
    MSG.foundEmployee[l](label),
    '',
    `**${user.displayName}**`,
    `  • POS Username   : ${user.username}`,
    `  • Account Status : ${statusLabel}`,
    `  • Security Level : ${user.securityRoleId} - ${user.securityLevel}`,
    MSG.confirmPrompt[l]
  ];

  return {
    handled     : true,
    message     : lines.join('\n'),
    sessionAttrs: {
      posState   : 'AWAITING_CONFIRM',
      posAction  : action,
      posEmployee: JSON.stringify(user),
      posUsername : user.username
    }
  };
}

// ============================================================
// EXPORTS
// ============================================================
module.exports = {
  handlePosStaffReset,
  shouldHandlePos,
  detectPosAction,
  parsePosId,
  POS_TRIGGER_KEYWORDS,
  POS_MSG: MSG
};

console.log('✅ posHandler.js v1.0.0 loaded');
console.log('   🏪 POS System  : Aptos One (NA, EU, JP, PH)');
console.log('   🚫 LATAM       : Xstore — redirected to manual process');
console.log('   🔄 States      : AWAITING_ID → AWAITING_CONFIRM → DONE');
console.log('                    AWAITING_NOT_FOUND_CHOICE → retry | incident');
console.log('   👤 Lookup      : Aptos One by POS username');
console.log('   🎫 Incident    : caller_id=store, regional assignment group');
console.log('   🌎 Languages   : en / es');
