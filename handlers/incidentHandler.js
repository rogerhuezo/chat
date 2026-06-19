// handlers/incidentHandler.js
'use strict';

const { createIncident, getIncident,
        updateIncident, snowFetch }       = require('../utils/servicenow');
const { ok, error }                       = require('../utils/response');
const { getRegionFromCountryCode,
        getAssignmentGroupAndRegion,
        normalizeCountryCode }            = require('../utils/regionUtils');
const { MESSAGES, getMsg }               = require('../utils/languageUtils');

// ── ServiceNow table router ────────────────────────────────────────────────────
const SNOW_TABLE_MAP = {
  INC   : { table: 'incident',          label: 'Incident',              supportsState: true  },
  PRB   : { table: 'problem',           label: 'Problem',               supportsState: true  },
  CHG   : { table: 'change_request',    label: 'Change Request',        supportsState: true  },
  RITM  : { table: 'sc_req_item',       label: 'Request Item',          supportsState: true  },
  REQ   : { table: 'sc_request',        label: 'Request',               supportsState: true  },
  TASK  : { table: 'task',              label: 'Task',                  supportsState: true  },
  SCTASK: { table: 'sc_task',           label: 'Service Catalog Task',  supportsState: true  },
  IMS   : { table: 'interaction',       label: 'Interaction',           supportsState: false },
  TKT   : { table: 'incident',          label: 'Ticket',                supportsState: true  },
  WO    : { table: 'wm_order',          label: 'Work Order',            supportsState: true  },
  WTASK : { table: 'wm_task',           label: 'Work Order Task',       supportsState: true  }
};

// ── State maps per table type ──────────────────────────────────────────────────
const STATE_MAPS = {
  incident: {
    '1': 'New', '2': 'In Progress', '3': 'On Hold',
    '4': 'In Progress', '5': 'In Progress', '6': 'Resolved', '7': 'Closed'
  },
  problem: {
    '1': 'Open', '2': 'Known Error', '3': 'Pending Change',
    '4': 'Closed/Resolved', '107': 'Root Cause Analysis'
  },
  change_request: {
    '-5': 'New', '-4': 'Assess', '-3': 'Authorize', '-2': 'Scheduled',
    '-1': 'Implement', '0': 'Review', '3': 'Closed', '4': 'Canceled'
  },
  sc_req_item: {
    '1': 'Open', '2': 'Work in Progress', '3': 'Closed Complete',
    '4': 'Closed Incomplete', '7': 'Pending', '8': 'Canceled'
  },
  sc_request: {
    '1': 'Open', '3': 'Closed Complete',
    '4': 'Closed Incomplete', '7': 'Pending'
  },
  task: {
    '-5': 'Pending', '1': 'Open', '2': 'Work in Progress',
    '3': 'Closed Complete', '4': 'Closed Incomplete', '7': 'Canceled'
  },
  sc_task: {
    '1': 'Open', '2': 'Work in Progress', '3': 'Closed Complete',
    '4': 'Closed Incomplete', '7': 'Canceled'
  },
  wm_order: {
    '0': 'Open', '1': 'Work in Progress', '2': 'Closed Complete',
    '3': 'Closed Incomplete', '4': 'Pending Dispatch'
  },
  wm_task: {
    '0': 'Open', '1': 'Accepted', '2': 'Work in Progress',
    '3': 'Closed Complete', '4': 'Closed Incomplete'
  },
  interaction: {
    '1': 'Open', '2': 'Work in Progress', '3': 'Closed Complete'
  }
};

const DEFAULT_STATE_MAP = {
  '1': 'Open', '2': 'In Progress', '3': 'On Hold',
  '4': 'In Progress', '5': 'In Progress', '6': 'Resolved',
  '7': 'Closed', '8': 'Canceled'
};

// ── Unified display value helper ───────────────────────────────────────────────
// Handles all SNOW field shapes:
//   - Plain string  (sysparm_display_value=true on primitive fields)
//   - { display_value: "Name", link: "..." }  (reference fields, any mode)
//   - { display_value: "Name", value: "sys_id" }  (reference fields)
// Empty strings are treated as null so conditional rendering works correctly.
const getDisplayValue = (field) => {
  if (!field) return null;
  if (typeof field === 'string') return field.trim() || null;
  if (typeof field === 'object') return (field.display_value || field.value || '').trim() || null;
  return null;
};

// ── Helper: format a SNOW datetime string ─────────────────────────────────────
const fmtDate = (dateStr) => {
  if (!dateStr || dateStr === 'N/A') return 'N/A';
  try {
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return dateStr;
    return d.toLocaleDateString('en-US', {
      month: 'short', day: 'numeric', year: 'numeric'
    });
  } catch (e) { return dateStr; }
};

/**
 * Resolve a SNOW number to its prefix, table config, and state map.
 */
const resolveTicketType = (ticketNumber) => {
  if (!ticketNumber) return null;
  const upper    = ticketNumber.toUpperCase().trim();
  const prefix   = upper.match(/^([A-Z]+)/)?.[1] || '';
  const config   = SNOW_TABLE_MAP[prefix] || null;
  const stateMap = config
    ? (STATE_MAPS[config.table] || DEFAULT_STATE_MAP)
    : DEFAULT_STATE_MAP;
  return config
    ? { prefix, number: upper, ...config, stateMap }
    : { prefix, number: upper, table: 'incident', label: 'Ticket',
        supportsState: true, stateMap: DEFAULT_STATE_MAP };
};

/**
 * Fetch a single SNOW record by ticket number.
 * NO sysparm_display_value on parent record — keeps response
 * structure identical to the working baseline.
 */
const fetchSnowRecord = async (ticketNumber) => {
  const resolved = resolveTicketType(ticketNumber);
  if (!resolved) return null;

  const fields = 'number,short_description,state,sys_created_on,' +
                 'sys_updated_on,sys_id,assigned_to,assignment_group';
  const query  = encodeURIComponent(`number=${resolved.number}`);
  const path   = `/api/now/table/${resolved.table}` +
                 `?sysparm_query=${query}` +
                 `&sysparm_limit=1` +
                 `&sysparm_fields=${fields}`;

  console.log(`[incidentHandler] fetchSnowRecord: ${resolved.number} → table: ${resolved.table}`);
  const res    = await snowFetch(path);
  const record = res?.result?.[0] || null;
  return record ? { ...record, _resolved: resolved } : null;
};

// ── Fetch child RITMs for a REQ ────────────────────────────────────────────────
const fetchRitmsForReq = async (reqSysId) => {
  if (!reqSysId) return [];
  try {
    const fields = 'number,short_description,state,assigned_to,assignment_group,sys_id';
    const query  = encodeURIComponent(`request=${reqSysId}^ORDERBYnumber`);
    const path   = `/api/now/table/sc_req_item` +
                   `?sysparm_query=${query}` +
                   `&sysparm_fields=${fields}` +
                   `&sysparm_limit=5` +
                   `&sysparm_display_value=true`;
    const res    = await snowFetch(path);
    return res?.result || [];
  } catch (e) {
    console.warn('[incidentHandler] fetchRitmsForReq failed:', e.message);
    return [];
  }
};

// ── Fetch child SCTASKs for a RITM ────────────────────────────────────────────
const fetchTasksForRitm = async (ritmSysId) => {
  if (!ritmSysId) return [];
  try {
    const fields = 'number,short_description,state,assigned_to,assignment_group';
    const query  = encodeURIComponent(`request_item=${ritmSysId}^ORDERBYnumber`);
    const path   = `/api/now/table/sc_task` +
                   `?sysparm_query=${query}` +
                   `&sysparm_fields=${fields}` +
                   `&sysparm_limit=5` +
                   `&sysparm_display_value=true`;
    const res    = await snowFetch(path);
    return res?.result || [];
  } catch (e) {
    console.warn('[incidentHandler] fetchTasksForRitm failed:', e.message);
    return [];
  }
};

/**
 * Build the enriched ticket message shown to the user.
 *
 * Layout by ticket type:
 *  REQ    → header + RITMs, each RITM lists its SCTASKs with assignment
 *  RITM   → header + SCTASKs with full assignment detail
 *  Others → header + assigned_to + assignment_group (when present)
 */
const buildTicketMessage = async (record, lang) => {
  const { _resolved } = record;
  const table         = _resolved.table;

  const number      = record.number                               || 'N/A';
  const description = record.short_description                    || 'No description';
  const state       = _resolved.stateMap[String(record.state)]    || record.state || 'Unknown';
  const created     = fmtDate(record.sys_created_on);
  const updated     = fmtDate(record.sys_updated_on);

  const lines = [];

  // ── Header ────────────────────────────────────────────────────────────────
  lines.push(`Ticket: ${number} (${_resolved.label})`);
  lines.push(`Description: ${description}`);
  lines.push(`Status: ${state}`);
  lines.push(`Updated: ${updated}`);

  // ── REQ: list RITMs → each RITM lists its SCTASKs with full assignment ───
  if (table === 'sc_request' && record.sys_id) {
    const ritms = await fetchRitmsForReq(record.sys_id);
    if (ritms.length > 0) {
      lines.push('');
      lines.push(`--- Items (${ritms.length}) ---`);
      for (const ritm of ritms) {
        const rs    = (STATE_MAPS.sc_req_item)[String(ritm.state)] || ritm.state || 'Unknown';
        const rNum  = getDisplayValue(ritm.number)            || 'N/A';
        const rDesc = getDisplayValue(ritm.short_description) || 'N/A';
        lines.push('');
        lines.push(`${rNum}: ${rDesc}`);
        lines.push(`Status: ${rs}`);

        if (ritm.sys_id) {
          const tasks = await fetchTasksForRitm(ritm.sys_id);
          if (tasks.length > 0) {
            lines.push(`Tasks (${tasks.length}):`);
            for (const task of tasks) {
              const ts = (STATE_MAPS.sc_task)[String(task.state)] || task.state || 'Unknown';
              const tn = getDisplayValue(task.number)            || 'N/A';
              const td = getDisplayValue(task.short_description) || 'N/A';
              const ta = getDisplayValue(task.assigned_to);
              const tg = getDisplayValue(task.assignment_group);
              lines.push(`  ${tn}: ${td}`);
              lines.push(`  Status: ${ts}`);
              if (ta) lines.push(`  Assigned To: ${ta}`);
              else    lines.push(`  Assigned To: Pending assignment`);
              if (tg) lines.push(`  Group: ${tg}`);
            }
          }
        }
      }
    }
  }

  // ── RITM: list SCTASKs with full assignment detail ────────────────────────
  else if (table === 'sc_req_item' && record.sys_id) {
    const tasks = await fetchTasksForRitm(record.sys_id);
    if (tasks.length > 0) {
      lines.push('');
      lines.push(`--- Tasks (${tasks.length}) ---`);
      for (const task of tasks) {
        const ts = (STATE_MAPS.sc_task)[String(task.state)] || task.state || 'Unknown';
        const tn = getDisplayValue(task.number)            || 'N/A';
        const td = getDisplayValue(task.short_description) || 'N/A';
        const ta = getDisplayValue(task.assigned_to);
        const tg = getDisplayValue(task.assignment_group);
        lines.push('');
        lines.push(`${tn}: ${td}`);
        lines.push(`Status: ${ts}`);
        if (ta) lines.push(`Assigned To: ${ta}`);
        else    lines.push(`Assigned To: Pending assignment`);
        if (tg) lines.push(`Group: ${tg}`);
      }
    } else {
      lines.push('');
      lines.push('No tasks created yet.');
    }
  }

  // ── All other types: INC, CHG, PRB, SCTASK, TASK, WO, WTASK ─────────────
  // getDisplayValue() handles both plain strings and reference objects,
  // so this works regardless of how SNOW returns the field.
  else {
    const assignedTo  = getDisplayValue(record.assigned_to);
    const assignGroup = getDisplayValue(record.assignment_group);
    if (assignedTo)  lines.push(`Assigned To: ${assignedTo}`);
    if (assignGroup) lines.push(`Group: ${assignGroup}`);
  }

  // ── Footer ─────────────────────────────────────────────────────────────────
  lines.push('');
  lines.push(`Created: ${created}`);
  lines.push('');
  lines.push(getMsg(lang, {
    en: 'Is there anything else I can help you with?',
    es: 'Hay algo mas en lo que pueda ayudarte?',
    pt: 'Ha mais alguma coisa em que posso ajuda-lo?',
    fr: 'Y a-t-il autre chose que je puisse faire pour vous?',
    de: 'Gibt es noch etwas womit ich Ihnen helfen kann?'
  }));

  const msg = lines.join('\n');
  if (msg.length > 900) {
    const cut = msg.lastIndexOf('\n', 900);
    return msg.substring(0, cut > 0 ? cut : 900) +
           '\n\nIs there anything else I can help you with?';
  }
  return msg;
};

// ── Create incident ────────────────────────────────────────────────────────────
const handleCreateIncident = async (event) => {
  const attrs  = event.contactAttributes || {};
  const lang   = attrs.Language || 'en';
  const title  = event.ticketTitle
    || attrs.incidentTitle
    || attrs.lastKbQuestion
    || 'IT Support Request';

  const caller = attrs.wdUsername
    || attrs.userId
    || attrs['HostedWidget-userID']
    || attrs.Email
    || attrs['HostedWidget-customerEmail']
    || '';

  const name = (attrs.Name || attrs['HostedWidget-customerName'] || '').split(' ')[0] || '';

  const countryCode                    = normalizeCountryCode(attrs.CountryCode || 'US');
  const region                         = getRegionFromCountryCode(countryCode);
  const { assignment_group, u_region } = getAssignmentGroupAndRegion(region);

  console.log(`[incidentHandler] createIncident — title: "${title}" caller: "${caller}" region: "${region}" group: "${assignment_group}"`);

  try {
    const incident = await createIncident({
      title,
      description    : title,
      callerId       : caller,
      urgency        : attrs.urgency || '2',
      impact         : attrs.impact  || '2',
      assignmentGroup: assignment_group,
      uRegion        : u_region
    });

    const msgFn = MESSAGES.ticketCreated[lang] || MESSAGES.ticketCreated['en'];
    const msg   = incident.number
      ? msgFn(name, incident.number)
      : getMsg(lang, {
          en: 'Your support ticket has been created. An IT analyst will follow up shortly.',
          es: 'Tu ticket de soporte ha sido creado. Un analista de TI te dara seguimiento en breve.',
          pt: 'Seu ticket de suporte foi criado. Um analista de TI fara o acompanhamento em breve.',
          fr: 'Votre ticket de support a ete cree. Un analyste IT vous contactera bientot.',
          de: 'Ihr Support-Ticket wurde erstellt. Ein IT-Analyst wird sich bald bei Ihnen melden.'
        });

    return {
      ...ok(msg),
      ticketNumber   : incident.number,
      attributesToSet: {
        lastTicketNumber : incident.number || '',
        lastTicketSysId  : incident.sysId  || '',
        conversationState: 'IDLE'
      }
    };
  } catch (err) {
    console.error('[incidentHandler] createIncident error:', err.message);
    return error(getMsg(lang, {
      en: 'I wasn\'t able to create your ticket right now. Please try again or contact IT support directly.',
      es: 'No pude crear tu ticket en este momento. Intenta de nuevo o contacta al soporte de TI.',
      pt: 'Nao consegui criar seu ticket agora. Tente novamente ou entre em contato com o suporte de TI.',
      fr: 'Je n\'ai pas pu creer votre ticket. Veuillez reessayer ou contacter le support IT.',
      de: 'Ich konnte Ihr Ticket nicht erstellen. Bitte versuchen Sie es erneut oder kontaktieren Sie den IT-Support.'
    }));
  }
};

// ── Get incident / ticket status ───────────────────────────────────────────────
const handleGetIncidentStatus = async (event) => {
  const attrs  = event.contactAttributes || {};
  const lang   = attrs.Language || 'en';

  const explicitNumber = event.incidentNumber || null;
  const message        = (event.userMessage || event.inputTranscript || '').trim();

  const snowRegex = /\b(INC|RITM|REQ|PRB|CHG|TASK|SCTASK|IMS|TKT|WO|WTASK)\d+\b/i;
  const msgMatch  = message.match(snowRegex);
  const msgNumber = msgMatch ? msgMatch[0].toUpperCase() : null;

  const lastTicket = (attrs.lastTicketNumber && attrs.lastTicketNumber !== 'null')
    ? attrs.lastTicketNumber : null;

  const caller = attrs.wdUsername || attrs.userId
    || attrs['HostedWidget-userID'] || attrs.Email
    || attrs['HostedWidget-customerEmail'] || '';

  const specificNumber = explicitNumber || msgNumber || null;
  const lookupQuery    = specificNumber || lastTicket || caller;

  console.log(
    `[incidentHandler] getIncidentStatus — query: "${lookupQuery}"` +
    ` (explicit: "${explicitNumber}" msgNum: "${msgNumber}"` +
    ` last: "${lastTicket}" caller: "${caller}")`
  );

  if (!lookupQuery) {
    return error(getMsg(lang, {
      en: 'I wasn\'t able to identify your account or ticket number. Please provide a ticket number (e.g. INC0123456, RITM0123456).',
      es: 'No pude identificar tu cuenta o numero de ticket. Por favor proporciona un numero (ej. INC0123456, RITM0123456).',
      pt: 'Nao consegui identificar sua conta ou numero de ticket. Por favor forneca um numero (ex. INC0123456, RITM0123456).',
      fr: 'Je n\'ai pas pu identifier votre compte ou numero de ticket. Veuillez fournir un numero (ex. INC0123456, RITM0123456).',
      de: 'Ich konnte Ihr Konto oder Ihre Ticketnummer nicht identifizieren. Bitte geben Sie eine Nummer an (z.B. INC0123456, RITM0123456).'
    }));
  }

  try {
    if (specificNumber) {
      const record = await fetchSnowRecord(specificNumber);

      if (!record) {
        const resolved = resolveTicketType(specificNumber);
        return ok(getMsg(lang, {
          en: `I couldn't find ${resolved.label} ${specificNumber}. Please double-check the number and try again.`,
          es: `No pude encontrar ${resolved.label} ${specificNumber}. Por favor verifica el numero e intenta de nuevo.`,
          pt: `Nao encontrei ${resolved.label} ${specificNumber}. Por favor verifique o numero e tente novamente.`,
          fr: `Je n'ai pas trouve ${resolved.label} ${specificNumber}. Veuillez verifier le numero et reessayer.`,
          de: `Ich konnte ${resolved.label} ${specificNumber} nicht finden. Bitte uberprufen Sie die Nummer und versuchen Sie es erneut.`
        }));
      }

      const msg = await buildTicketMessage(record, lang);

      return {
        ...ok(msg),
        attributesToSet: {
          lastTicketNumber : record.number  || '',
          lastTicketSysId  : record.sys_id  || '',
          conversationState: 'IDLE'
        }
      };
    }

    // ── No specific number — look up by caller email ───────────────────────
    const incidents = await getIncident(lookupQuery);

    if (!incidents || incidents.length === 0) {
      return ok(getMsg(lang, {
        en: 'I couldn\'t find any open tickets associated with your account.',
        es: 'No pude encontrar tickets abiertos asociados a tu cuenta.',
        pt: 'Nao encontrei tickets abertos associados a sua conta.',
        fr: 'Je n\'ai pas trouve de tickets ouverts associes a votre compte.',
        de: 'Ich konnte keine offenen Tickets fur Ihr Konto finden.'
      }));
    }

    const incStateMap = STATE_MAPS.incident;
    const list = incidents.slice(0, 3).map(i =>
      `- ${i.number}: ${i.short_description} (${incStateMap[i.state] || 'Unknown'})`
    ).join('\n');

    return {
      ...ok(getMsg(lang, {
        en: `Your recent tickets:\n\n${list}\n\nIs there anything else I can help you with?`,
        es: `Tus tickets recientes:\n\n${list}\n\nHay algo mas en lo que pueda ayudarte?`,
        pt: `Seus tickets recentes:\n\n${list}\n\nHa mais alguma coisa em que posso ajuda-lo?`,
        fr: `Vos tickets recents:\n\n${list}\n\nY a-t-il autre chose que je puisse faire pour vous?`,
        de: `Ihre aktuellen Tickets:\n\n${list}\n\nGibt es noch etwas womit ich Ihnen helfen kann?`
      })),
      attributesToSet: { conversationState: 'IDLE' }
    };

  } catch (err) {
    console.error('[incidentHandler] getIncidentStatus error:', err.message);
    return error(getMsg(lang, {
      en: 'I wasn\'t able to retrieve your tickets right now. Please try again.',
      es: 'No pude recuperar tus tickets en este momento. Intenta de nuevo.',
      pt: 'Nao consegui recuperar seus tickets agora. Tente novamente.',
      fr: 'Je n\'ai pas pu recuperer vos tickets. Veuillez reessayer.',
      de: 'Ich konnte Ihre Tickets gerade nicht abrufen. Bitte versuchen Sie es erneut.'
    }));
  }
};

// ── Update incident ────────────────────────────────────────────────────────────
const handleUpdateIncident = async (event) => {
  const attrs   = event.contactAttributes || {};
  const lang    = attrs.Language || 'en';
  const sysId   = attrs.lastTicketSysId || '';
  const update  = event.ticketTitle || attrs.updateMessage || '';
  const lastNum = attrs.lastTicketNumber || '';

  console.log(`[incidentHandler] updateIncident — sysId: "${sysId}" number: "${lastNum}" update: "${update}"`);

  if (!sysId) {
    return ok(getMsg(lang, {
      en: 'I don\'t have an active ticket to update. Would you like to create a new one?',
      es: 'No tengo un ticket activo para actualizar. Te gustaria crear uno nuevo?',
      pt: 'Nao tenho um ticket ativo para atualizar. Gostaria de criar um novo?',
      fr: 'Je n\'ai pas de ticket actif a mettre a jour. Voulez-vous en creer un nouveau?',
      de: 'Ich habe kein aktives Ticket zum Aktualisieren. Mochten Sie ein neues erstellen?'
    }));
  }

  const resolved = lastNum ? resolveTicketType(lastNum) : null;
  const table    = resolved?.table || 'incident';

  try {
    await snowFetch(
      `/api/now/table/${table}/${sysId}`,
      'PATCH',
      { comments: update, contact_type: 'chat' }
    );

    return ok(getMsg(lang, {
      en: `Your ${resolved?.label || 'ticket'} has been updated successfully. An IT analyst will review your update shortly.`,
      es: `Tu ${resolved?.label || 'ticket'} ha sido actualizado exitosamente. Un analista de TI revisara tu actualizacion en breve.`,
      pt: `Seu ${resolved?.label || 'ticket'} foi atualizado com sucesso. Um analista de TI revisara sua atualizacao em breve.`,
      fr: `Votre ${resolved?.label || 'ticket'} a ete mis a jour avec succes. Un analyste IT examinera votre mise a jour sous peu.`,
      de: `Ihr ${resolved?.label || 'Ticket'} wurde erfolgreich aktualisiert. Ein IT-Analyst wird Ihre Aktualisierung bald prufen.`
    }));
  } catch (err) {
    console.error('[incidentHandler] updateIncident error:', err.message);
    return error(getMsg(lang, {
      en: 'I wasn\'t able to update your ticket right now. Please try again.',
      es: 'No pude actualizar tu ticket en este momento. Intenta de nuevo.',
      pt: 'Nao consegui atualizar seu ticket agora. Tente novamente.',
      fr: 'Je n\'ai pas pu mettre a jour votre ticket. Veuillez reessayer.',
      de: 'Ich konnte Ihr Ticket gerade nicht aktualisieren. Bitte versuchen Sie es erneut.'
    }));
  }
};

module.exports = {
  handleCreateIncident,
  handleGetIncidentStatus,
  handleUpdateIncident,
  resolveTicketType
};