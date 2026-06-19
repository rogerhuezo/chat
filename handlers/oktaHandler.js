// handlers/oktaHandler.js
'use strict';

/**
 * oktaHandler.js
 * Conversational state machine for Okta Account Management
 * Retail Store Managers only — stores identified by store####@skechers.com
 *
 * Flow:
 *   1. Detect Okta intent from message
 *   2. Guard: retail store only
 *      → Corporate users: KB lookup + transfer offer instead
 *   3. Collect employee ID(s) conversationally
 *   4. Look up each ID in Okta (by employeeNumber)
 *   5. Confirm with manager before acting
 *   6. Execute Okta action per employee
 *   7. Create ServiceNow incident with full payload
 *      - caller_id  = store email (unchanged)
 *      - work_notes = full employee processing log
 *      - assignment_group = regional (same logic as normal incidents)
 *
 * If employee ID not found:
 *   - Option 1: Retry with correct ID(s)
 *   - Option 2: Create incident for IT to investigate
 *
 * Version: 1.2.0
 */

const {
  getUserByEmployeeId,
  executeOktaAction
} = require('../utils/oktaApiHandler');

const {
   createIncident,
   updateIncident,
   snowFetch
} = require('../utils/servicenow');

// ============================================================
// CONSTANTS
// ============================================================

const OKTA_TRIGGER_KEYWORDS = [
  // English
  'okta', 'password reset', 'reset password', 'unlock account',
  'account locked', 'account unlock', 'reset account', 'account reset',
  'reset factors', 'mfa reset', 'locked out',
  // Spanish
  'resetear contraseña', 'restablecer contraseña', 'cambiar contraseña',
  'desbloquear cuenta', 'cuenta bloqueada', 'resetear cuenta',
  'restablecer cuenta', 'contraseña bloqueada', 'acceso bloqueado'
];

const OKTA_ACTION_TRIGGERS = {
  account_unlock: [
    'unlock', 'locked', 'locked out', 'desbloquear',
    'bloqueada', 'bloqueado'
  ],
  account_reset: [
    'reset account', 'account reset', 'reset factors', 'mfa',
    'resetear cuenta', 'restablecer cuenta'
  ],
  password_reset: [
    'password', 'contraseña', 'reset password', 'resetear contraseña',
    'restablecer contraseña', 'cambiar contraseña', 'password reset'
  ]
};

const REGIONAL_GROUPS = {
  'Latin America': 'LATAM SN SDESK',
  'North America': 'NA SN SDESK',
  'EMEA'         : 'EMEA SN SDESK',
  'Asia Pacific' : 'APAC SN SDESK'
};

const OKTA_STATUS_LABELS = {
  ACTIVE          : { en: 'Active',            es: 'Activo'             },
  LOCKED_OUT      : { en: 'Locked Out',         es: 'Bloqueado'          },
  PASSWORD_EXPIRED: { en: 'Password Expired',   es: 'Contraseña vencida' },
  SUSPENDED       : { en: 'Suspended',          es: 'Suspendido'         },
  DEPROVISIONED   : { en: 'Deprovisioned',      es: 'Desaprovisionado'   },
  PROVISIONED     : { en: 'Provisioned',        es: 'Aprovisionado'      },
  RECOVERY        : { en: 'In Recovery',        es: 'En recuperación'    },
  STAGED          : { en: 'Staged',             es: 'En etapa inicial'   }
};

// ============================================================
// MESSAGES
// ============================================================
const MSG = {
  // ── ✅ NEW v1.2.0: Corporate user messages ──────────────────────────────────
  corporateKbIntro: {
    en: (answer) =>
      `Here's what I found that may help:\n\n${answer}\n\n` +
      `Would you like me to connect you with an IT support agent for further assistance? ` +
      `Reply **yes** to transfer or **no** if this resolved your question.`,
    es: (answer) =>
      `Esto es lo que encontré que puede ayudarte:\n\n${answer}\n\n` +
      `¿Te gustaría que te conectara con un agente de soporte de TI para más ayuda? ` +
      `Responde **sí** para transferir o **no** si esto resolvió tu pregunta.`
  },
  corporateTransferDirect: {
    en: 'Okta account management for corporate users is handled directly by the IT support team. Let me connect you with an agent right away. Please hold.',
    es: 'La gestión de cuentas Okta para usuarios corporativos es manejada directamente por el equipo de soporte de TI. Permíteme conectarte con un agente ahora. Por favor espera.'
  },
  corporateTransferAfterKb: {
    en: 'Let me connect you with an IT support agent who can assist you further. Please hold.',
    es: 'Permíteme conectarte con un agente de soporte de TI que pueda ayudarte más. Por favor espera.'
  },
  corporateConfirmTransfer: {
    en: 'Would you like me to connect you with an IT support agent? Reply **yes** to transfer or **no** to continue.',
    es: '¿Te gustaría que te conectara con un agente de soporte de TI? Responde **sí** para transferir o **no** para continuar.'
  },
  // ── End v1.2.0 additions ────────────────────────────────────────────────────
  notRetail: {
    en: '⚠️ Okta account management is only available for Retail Store accounts.',
    es: '⚠️ La gestión de cuentas Okta solo está disponible para cuentas de tiendas minoristas.'
  },
  intro: {
    en: (action) =>
      `Got it — **${action}**.\n\nPlease provide the Employee ID(s) to process. ` +
      `You can enter multiple IDs separated by commas.\n\n_Example: 12345, 67890_`,
    es: (action) =>
      `Entendido — **${action}**.\n\nPor favor proporciona el o los ID(s) de empleado a procesar. ` +
      `Puedes ingresar múltiples IDs separados por comas.\n\n_Ejemplo: 12345, 67890_`
  },
  askIds: {
    en: 'Please provide the Employee ID(s) — numeric IDs separated by commas.',
    es: 'Por favor proporciona los ID(s) de empleado — IDs numéricos separados por comas.'
  },
  foundEmployees: {
    en: (action) => `Found the following employees for **${action}**:`,
    es: (action) => `Encontré los siguientes empleados para **${action}**:`
  },
  confirmPrompt: {
    en: '\nShould I proceed with this action for all listed employees? Reply **yes** to confirm or **no** to cancel.',
    es: '\n¿Procedo con esta acción para todos los empleados listados? Responde **sí** para confirmar o **no** para cancelar.'
  },
  notFound: {
    en: (id) => `⚠️ Employee ID **${id}** was not found in Okta. Please verify the ID.`,
    es: (id) => `⚠️ El ID de empleado **${id}** no fue encontrado en Okta. Por favor verifica el ID.`
  },
  notFoundChoice: {
    en: 'What would you like to do?\n\n1️⃣ **Try again** — type the correct ID(s)\n2️⃣ **Create incident** — log it for IT to investigate',
    es: '¿Qué deseas hacer?\n\n1️⃣ **Reintentar** — escribe los IDs correctos\n2️⃣ **Crear incidente** — registrar para que TI lo investigue'
  },
  notFoundChoiceReprompt: {
    en: 'Please reply **1** to try again with correct IDs, or **2** to create an incident for IT to investigate.',
    es: 'Por favor responde **1** para reintentar con los IDs correctos, o **2** para crear un incidente para que TI investigue.'
  },
  partialMissingWarning: {
    en: (missing) =>
      `\n⚠️ The following ID(s) were not found and will be logged in the incident for IT to review:\n` +
      missing.map(id => `• ID: **${id}**`).join('\n'),
    es: (missing) =>
      `\n⚠️ Los siguientes ID(s) no fueron encontrados y serán registrados en el incidente para revisión de TI:\n` +
      missing.map(id => `• ID: **${id}**`).join('\n')
  },
  cancelled: {
    en: '❌ Action cancelled. Is there anything else I can help you with?',
    es: '❌ Acción cancelada. ¿Puedo ayudarte con algo más?'
  },
  confirmOnly: {
    en: 'Please reply **yes** to proceed or **no** to cancel.',
    es: 'Por favor responde **sí** para continuar o **no** para cancelar.'
  },
  resultSuccess: {
    en: (name, empId, action) => `✅ **${name}** (ID: ${empId}) — ${action} completed`,
    es: (name, empId, action) => `✅ **${name}** (ID: ${empId}) — ${action} completado`
  },
  resultFailed: {
    en: (name, empId, error) => `❌ **${name}** (ID: ${empId}) — Failed: ${error}`,
    es: (name, empId, error) => `❌ **${name}** (ID: ${empId}) — Error: ${error}`
  },
  summary: {
    en: (ok, fail, ticket) =>
      `\n**Summary:** ${ok} processed ✅${fail > 0 ? `, ${fail} failed ❌` : ''}\n` +
      `📋 Incident logged: **${ticket}**\n\nIs there anything else I can help you with?`,
    es: (ok, fail, ticket) =>
      `\n**Resumen:** ${ok} procesados ✅${fail > 0 ? `, ${fail} fallidos ❌` : ''}\n` +
      `📋 Incidente registrado: **${ticket}**\n\n¿Puedo ayudarte con algo más?`
  },
  notFoundIncidentCreated: {
    en: (missing, ticket) =>
      `📋 Incident created for IT to investigate the following IDs:\n` +
      missing.map(id => `• ID: **${id}**`).join('\n') +
      `\n\n📋 Incident logged: **${ticket}**\n\nIs there anything else I can help you with?`,
    es: (missing, ticket) =>
      `📋 Incidente creado para que TI investigue los siguientes IDs:\n` +
      missing.map(id => `• ID: **${id}**`).join('\n') +
      `\n\n📋 Incidente registrado: **${ticket}**\n\n¿Puedo ayudarte con algo más?`
  },
  noEmployeesStored: {
    en: 'Something went wrong — no employees found to process. Please start again.',
    es: 'Algo salió mal — no se encontraron empleados para procesar. Por favor inicia de nuevo.'
  }
};

// ============================================================
// HELPERS
// ============================================================

function isRetailStore(email) {
  return /^store\d+@skechers\.com$/i.test(email || '');
}

function detectOktaAction(msgLower) {
  for (const [action, triggers] of Object.entries(OKTA_ACTION_TRIGGERS)) {
    if (triggers.some(t => msgLower.includes(t))) return action;
  }
  return 'password_reset';
}

function parseEmployeeIds(text) {
  const matches = text.match(/\b\d{4,8}\b/g);
  return matches ? [...new Set(matches)] : [];
}

function actionLabel(action, lang) {
  const labels = {
    password_reset: { en: 'Password Reset',  es: 'Restablecimiento de Contraseña' },
    account_unlock: { en: 'Account Unlock',  es: 'Desbloqueo de Cuenta'           },
    account_reset : { en: 'Account Reset',   es: 'Reseteo de Cuenta'              }
  };
  return (labels[action] || labels.password_reset)[lang]
      || (labels[action] || labels.password_reset).en;
}

function resolveAssignmentGroup(region) {
  return REGIONAL_GROUPS[region] || REGIONAL_GROUPS['North America'];
}

function formatStatus(status, lang) {
  return OKTA_STATUS_LABELS[status]?.[lang]
      || OKTA_STATUS_LABELS[status]?.en
      || status
      || 'Unknown';
}

function isYes(msgLower) {
  return /\b(yes|si|sí|yep|ok|okay|sure|proceed|confirm|go ahead|adelante|confirmo|claro)\b/i.test(msgLower);
}

function isNo(msgLower) {
  return /\b(no|cancel|cancelar|stop|nope|nah|never|abort)\b/i.test(msgLower);
}

function wantsIncident(msgLower) {
  return /\b(2|incident|incidente|create|crear|log|registrar|investigate|investigar)\b/i.test(msgLower);
}

function wantsRetry(msgLower) {
  return /\b(1|retry|reintentar|try again|intentar|intentar de nuevo|retype|volver)\b/i.test(msgLower);
}

function shouldHandleOkta(msgLower, attrs) {
  if (attrs.oktaState) return true;
  return OKTA_TRIGGER_KEYWORDS.some(kw => msgLower.includes(kw));
}

function clearOktaState() {
  return {
    oktaState    : '',
    oktaAction   : '',
    oktaEmployees: '',
    oktaMissing  : ''
  };
}

// ============================================================
// SERVICENOW INCIDENT BUILDERS
// ============================================================

function buildWorkNotes({ label, employees, failed, missing, callerEmail, storeName, region }) {
  const lines = [
    '=== Okta Account Management — Bot Processed ===',
    `Action         : ${label}`,
    `Store Email    : ${callerEmail}`,
    `Store Name     : ${storeName  || 'N/A'}`,
    `Region         : ${region     || 'N/A'}`,
    `Timestamp      : ${new Date().toISOString()}`,
    `Total Processed: ${employees.length}`,
    `Total Failed   : ${failed.length}`,
    `IDs Not Found  : ${(missing || []).length}`,
    ''
  ];

  if (employees.length) {
    lines.push(`=== Successfully Processed (${employees.length}) ===`);
    employees.forEach((e, i) => {
      lines.push(`[${i + 1}]`);
      lines.push(`  Name           : ${e.displayName    || 'N/A'}`);
      lines.push(`  Employee ID    : ${e.employeeNumber || 'N/A'}`);
      lines.push(`  Okta Login     : ${e.login          || 'N/A'}`);
      lines.push(`  Okta User ID   : ${e.oktaId         || 'N/A'}`);
      lines.push(`  Personal Email : ${e.personalEmail  || 'N/A'}`);
      lines.push(`  Department     : ${e.department     || 'N/A'}`);
      lines.push(`  Title          : ${e.title          || 'N/A'}`);
      lines.push(`  Status Before  : ${e.statusBefore   || 'N/A'}`);
      lines.push(`  Action Result  : SUCCESS`);
      lines.push('');
    });
  }

  if (failed.length) {
    lines.push(`=== Failed (${failed.length}) ===`);
    failed.forEach((e, i) => {
      lines.push(`[${i + 1}]`);
      lines.push(`  Name        : ${e.displayName    || 'N/A'}`);
      lines.push(`  Employee ID : ${e.employeeNumber || e.inputId || 'N/A'}`);
      lines.push(`  Okta Login  : ${e.login          || 'N/A'}`);
      lines.push(`  Error       : ${e.error          || 'Unknown error'}`);
      lines.push('');
    });
  }

  if (missing?.length) {
    lines.push(`=== IDs Not Found in Okta — Requires IT Investigation (${missing.length}) ===`);
    missing.forEach((id, i) => {
      lines.push(`[${i + 1}] Employee ID: ${id}`);
      lines.push(`    Note: Not found in Okta. Verify Workday provisioning and Okta sync.`);
      lines.push('');
    });
  }

  return lines.join('\n');
}

function buildNotFoundWorkNotes({ label, missing, callerEmail, storeName, region }) {
  return [
    '=== Okta Account Management — Employee ID(s) Not Found ===',
    `Action Requested : ${label}`,
    `Store Email      : ${callerEmail}`,
    `Store Name       : ${storeName || 'N/A'}`,
    `Region           : ${region    || 'N/A'}`,
    `Timestamp        : ${new Date().toISOString()}`,
    '',
    `=== IDs Not Found in Okta (${missing.length}) ===`,
    ...missing.map((id, i) =>
      `[${i + 1}] Employee ID: ${id}\n    Note: Not found in Okta. Verify Workday provisioning and Okta sync.`
    ),
    '',
    'IT Action Required: Verify that the listed employee IDs exist in Workday and have been',
    'synced to Okta. If the employee is new, provisioning may still be in progress.'
  ].join('\n');
}

async function createOktaIncident({
    shortDescription,
    workNotes,
    callerEmail,
    assignmentGroup,
    region,
    interactionNumber,
    resolved = false
  }) {
    let incidentNumber = interactionNumber || 'N/A';
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
      console.log(`[oktaHandler] incident created: ${incidentNumber} sysId: ${incidentSysId}`);
    } catch (e) {
      console.error(`[oktaHandler] createIncident failed: ${e.message}`);
      return incidentNumber;
    }
  
    if (resolved && incidentSysId) {
      try {
        await updateIncident(incidentSysId, {
          state              : '6',
          close_code         : 'Solved (Permanently)',
          close_notes        : workNotes,
          resolved_by        : callerEmail,
          resolution_code    : 'Solved (Permanently)',
          resolution_notes   : 'Resolved automatically by SkechAI — Okta action completed successfully.'
        });
        console.log(`[oktaHandler] incident resolved: ${incidentNumber}`);
      } catch (e) {
        console.error(`[oktaHandler] resolveIncident failed (non-fatal): ${e.message}`);
      }
    }
  
    return incidentNumber;
  }

// ============================================================
// LOOKUP + CONFIRM  (shared by STATE 0 and STATE 1)
// ============================================================
async function lookupAndConfirm({ ids, action, label, l, callerEmail, attrs }) {
  console.log(`[oktaHandler] lookupAndConfirm: ids=[${ids.join(',')}] action=${action}`);

  const found   = [];
  const missing = [];

  for (const id of ids) {
    try {
      const user = await getUserByEmployeeId(id);
      if (user) {
        found.push({ ...user, inputId: id, statusBefore: user.status });
        console.log(`[oktaHandler] ✅ found: ${user.displayName} (${user.oktaId}) status=${user.status}`);
      } else {
        missing.push(id);
        console.warn(`[oktaHandler] ⚠️ not found: ${id}`);
      }
    } catch (e) {
      console.error(`[oktaHandler] lookup error for ${id}: ${e.message}`);
      missing.push(id);
    }
  }

  if (!found.length) {
    const lines = missing.map(id => MSG.notFound[l](id));
    lines.push('');
    lines.push(MSG.notFoundChoice[l]);

    return {
      handled     : true,
      message     : lines.join('\n'),
      sessionAttrs: {
        oktaState  : 'AWAITING_NOT_FOUND_CHOICE',
        oktaAction : action,
        oktaMissing: JSON.stringify(missing)
      }
    };
  }

  const lines = [];
  lines.push(MSG.foundEmployees[l](label));
  lines.push('');

  found.forEach((e, i) => {
    const status = formatStatus(e.statusBefore, l);
    lines.push(
      `${i + 1}. **${e.displayName}**\n` +
      `   • ${l === 'es' ? 'ID Empleado'   : 'Employee ID'   }: ${e.employeeNumber || e.inputId}\n` +
      `   • ${l === 'es' ? 'Correo Okta'   : 'Okta Login'    }: ${e.login          || 'N/A'}\n` +
      `   • ${l === 'es' ? 'Estado actual' : 'Current Status'}: ${status}`
    );
  });

  if (missing.length) {
    lines.push(MSG.partialMissingWarning[l](missing));
  }

  lines.push(MSG.confirmPrompt[l]);

  return {
    handled     : true,
    message     : lines.join('\n'),
    sessionAttrs: {
      oktaState    : 'AWAITING_CONFIRM',
      oktaAction   : action,
      oktaEmployees: JSON.stringify(found),
      oktaMissing  : JSON.stringify(missing)
    }
  };
}

// ============================================================
// MAIN HANDLER
// ============================================================
async function handleOktaAccountManagement({
  attrs,
  msgLower,
  originalMsg,
  lang,
  callerEmail,
  storeName,
  region,
  interactionNumber
}) {
  const l = (lang === 'es') ? 'es' : 'en';

  // ── Guard: Retail stores only ──────────────────────────────────────────────
  // ✅ CHANGED v1.2.0: Corporate users no longer get a dead-end message.
  // Instead we signal corporateFallback=true so chatHandler can run a KB
  // query and then offer / execute a live-agent transfer.
  if (!isRetailStore(callerEmail)) {
    console.log(`[oktaHandler] corporate user detected (${callerEmail}) — signalling corporateFallback`);
    return {
      handled          : true,
      corporateFallback: true,   // ← chatHandler checks this flag
      message          : null,   // ← chatHandler builds the message
      lang             : l,
      sessionAttrs     : {}
    };
  }
  // ── End v1.2.0 guard change ────────────────────────────────────────────────

  const prevState = attrs.oktaState || '';

  // ══════════════════════════════════════════════════════════
  // STATE 0: New request — detect action, prompt for IDs
  // ══════════════════════════════════════════════════════════
  if (!prevState) {
    const action = detectOktaAction(msgLower);
    const label  = actionLabel(action, l);
    const ids    = parseEmployeeIds(originalMsg);

    if (ids.length) {
      return await lookupAndConfirm({ ids, action, label, l, callerEmail, attrs });
    }

    return {
      handled     : true,
      message     : MSG.intro[l](label),
      sessionAttrs: {
        oktaState : 'AWAITING_IDS',
        oktaAction: action
      }
    };
  }

  // ══════════════════════════════════════════════════════════
  // STATE 1: Waiting for employee IDs
  // ══════════════════════════════════════════════════════════
  if (prevState === 'AWAITING_IDS') {
    const action = attrs.oktaAction || 'password_reset';
    const label  = actionLabel(action, l);
    const ids    = parseEmployeeIds(originalMsg);

    if (!ids.length) {
      return {
        handled     : true,
        message     : MSG.askIds[l],
        sessionAttrs: { oktaState: 'AWAITING_IDS', oktaAction: action }
      };
    }

    return await lookupAndConfirm({ ids, action, label, l, callerEmail, attrs });
  }

  // ══════════════════════════════════════════════════════════
  // STATE 2: Waiting for yes/no confirmation
  // ══════════════════════════════════════════════════════════
  if (prevState === 'AWAITING_CONFIRM') {

    if (isNo(msgLower)) {
      return {
        handled     : true,
        message     : MSG.cancelled[l],
        sessionAttrs: clearOktaState()
      };
    }

    if (!isYes(msgLower)) {
      return {
        handled     : true,
        message     : MSG.confirmOnly[l],
        sessionAttrs: {
          oktaState    : 'AWAITING_CONFIRM',
          oktaAction   : attrs.oktaAction,
          oktaEmployees: attrs.oktaEmployees,
          oktaMissing  : attrs.oktaMissing
        }
      };
    }

    const action = attrs.oktaAction || 'password_reset';
    const label  = actionLabel(action, l);

    let employees = [];
    let missing   = [];
    try { employees = JSON.parse(attrs.oktaEmployees || '[]'); } catch (_) {}
    try { missing   = JSON.parse(attrs.oktaMissing   || '[]'); } catch (_) {}

    if (!employees.length) {
      return {
        handled     : true,
        message     : MSG.noEmployeesStored[l],
        sessionAttrs: clearOktaState()
      };
    }

    const processed = [];
    const failed    = [];

    for (const emp of employees) {
      try {
        const result = await executeOktaAction(action, emp.oktaId);
        processed.push({ ...emp, actionResult: result });
        console.log(`[oktaHandler] ✅ ${action} success: ${emp.displayName} (${emp.oktaId})`);
      } catch (e) {
        console.error(`[oktaHandler] ❌ ${action} failed: ${emp.displayName}: ${e.message}`);
        failed.push({ ...emp, error: e.message });
      }
    }

    const assignmentGroup = resolveAssignmentGroup(region);
    const workNotes       = buildWorkNotes({
      label,
      employees : processed,
      failed,
      missing,
      callerEmail,
      storeName,
      region
    });

    const incidentNumber = await createOktaIncident({
      shortDescription: `Okta ${label} — ${processed.length + failed.length} employee(s) — ${storeName || callerEmail}`,
      workNotes,
      callerEmail,
      assignmentGroup,
      region,
      interactionNumber,
      resolved: failed.length === 0
    });

    const lines = [];
    processed.forEach(e =>
      lines.push(MSG.resultSuccess[l](e.displayName, e.employeeNumber || e.inputId, label))
    );
    failed.forEach(e =>
      lines.push(MSG.resultFailed[l](e.displayName || e.inputId, e.employeeNumber || e.inputId, e.error))
    );
    lines.push(MSG.summary[l](processed.length, failed.length, incidentNumber));

    return {
      handled     : true,
      message     : lines.join('\n'),
      sessionAttrs: clearOktaState()
    };
  }

  // ══════════════════════════════════════════════════════════
  // STATE 3: All IDs not found — retry or create incident
  // ══════════════════════════════════════════════════════════
  if (prevState === 'AWAITING_NOT_FOUND_CHOICE') {
    const action = attrs.oktaAction || 'password_reset';
    const label  = actionLabel(action, l);

    let missing = [];
    try { missing = JSON.parse(attrs.oktaMissing || '[]'); } catch (_) {}

    const newIds         = parseEmployeeIds(originalMsg);
    const wantsIncident_ = wantsIncident(msgLower) && !newIds.length;
    const wantsRetry_    = wantsRetry(msgLower) || newIds.length > 0;

    if (wantsIncident_) {
      const assignmentGroup = resolveAssignmentGroup(region);
      const workNotes       = buildNotFoundWorkNotes({
        label,
        missing,
        callerEmail,
        storeName,
        region
      });

      const incidentNumber = await createOktaIncident({
        shortDescription: `Okta ${label} — Employee ID(s) not found — ${storeName || callerEmail}`,
        workNotes,
        callerEmail,
        assignmentGroup,
        region,
        interactionNumber,
        resolved: false
      });

      return {
        handled     : true,
        message     : MSG.notFoundIncidentCreated[l](missing, incidentNumber),
        sessionAttrs: clearOktaState()
      };
    }

    if (wantsRetry_) {
      const idsToUse = newIds.length ? newIds : missing;
      return await lookupAndConfirm({
        ids   : idsToUse,
        action,
        label,
        l,
        callerEmail,
        attrs
      });
    }

    return {
      handled     : true,
      message     : MSG.notFoundChoiceReprompt[l],
      sessionAttrs: {
        oktaState  : 'AWAITING_NOT_FOUND_CHOICE',
        oktaAction : action,
        oktaMissing: JSON.stringify(missing)
      }
    };
  }

  // ── Unknown state — reset gracefully ──────────────────────
  console.warn(`[oktaHandler] unknown state: "${prevState}" — resetting`);
  return {
    handled     : true,
    message     : MSG.askIds[l],
    sessionAttrs: {
      oktaState : 'AWAITING_IDS',
      oktaAction: detectOktaAction(msgLower)
    }
  };
}

// ============================================================
// EXPORTS
// ============================================================
module.exports = {
  handleOktaAccountManagement,
  shouldHandleOkta,
  isRetailStore,
  detectOktaAction,
  parseEmployeeIds,
  actionLabel,
  resolveAssignmentGroup,
  OKTA_TRIGGER_KEYWORDS,
  // ✅ NEW v1.2.0: exported so chatHandler can reuse without duplication
  isYes,
  isNo,
  OKTA_MSG: MSG
};

console.log('✅ oktaHandler.js v1.2.0 loaded');
console.log('   🏪 Guard       : Retail stores only (store####@skechers.com)');
console.log('   🏢 Corporate   : KB lookup + transfer offer (v1.2.0)');
console.log('   🔄 States      : AWAITING_IDS → AWAITING_CONFIRM → DONE');
console.log('                    AWAITING_NOT_FOUND_CHOICE → retry | incident');
console.log('                    AWAITING_OKTA_TRANSFER_CONFIRM → transfer | continue');
console.log('   👤 Lookup      : Okta by employeeNumber (Workday-provisioned)');
console.log('   🎫 Incident    : caller_id=store, regional assignment group');
console.log('   📋 Work Notes  : full employee payload captured for audit');
console.log('   🌎 Languages   : en / es');
