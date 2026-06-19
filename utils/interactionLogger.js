// utils/interactionLogger.js
'use strict';

const { snowFetch,
        createInteraction  : snowCreateInteraction,
        getInteraction     : snowGetInteraction,
        updateInteraction  : snowUpdateInteraction }  = require('./servicenow');
const { getRegionFromCountryCode,
        getAssignmentGroupAndRegion,
        getCountryName,
        normalizeCountryCode }                        = require('./regionUtils');

// ── Build structured work notes ────────────────────────────────────────────────
const buildWorkNotes = (event, userInfo, data = {}, isUpdate = false) => {
  const ts     = new Date().toISOString();
  const intent = event?.sessionState?.intent?.name || 'Unknown';
  const input  = event?.inputTranscript || '';
  let notes    = '';

  if (!isUpdate) {
    notes += `=== BOT INTERACTION LOG ===\n`;
    notes += `Timestamp  : ${ts}\n`;
    notes += `Intent     : ${intent}\n`;
    notes += `User Input : "${input}"\n\n`;

    if (userInfo) {
      notes += `=== USER INFORMATION ===\n`;
      notes += `Name           : ${userInfo.name           || 'Unknown'}\n`;
      notes += `Email          : ${userInfo.email          || 'Unknown'}\n`;
      notes += `Employee #     : ${userInfo.employeeNumber || 'N/A'}\n`;
      notes += `Department     : ${userInfo.department     || 'N/A'}\n`;
      notes += `Location       : ${userInfo.location       || 'N/A'}\n`;
      notes += `Country        : ${getCountryName(userInfo.countryCode || 'US')}\n`;
      notes += `Country Code   : ${userInfo.countryCode    || 'N/A'}\n`;
      notes += `Region         : ${getRegionFromCountryCode(userInfo.countryCode || 'US')}\n`;
      notes += `Location Type  : ${(userInfo.storeEmail && userInfo.storeEmail !== 'N/A') ? 'Store / Retail' : 'Corporate'}\n\n`;
    }

    if (data.botResponse) {
      notes += `=== BOT RESPONSE ===\n${data.botResponse}\n\n`;
    }
  } else {
    const start    = data.conversationStartTime;
    const duration = start
      ? Math.round((new Date() - new Date(start)) / 1000 / 60)
      : null;

    notes += `\n=== CONVERSATION ENDED ===\n`;
    notes += `End Time   : ${ts}\n`;
    notes += `End Reason : ${data.endReason || 'User requested'}\n`;
    if (duration !== null) notes += `Duration   : ${duration} minute${duration !== 1 ? 's' : ''}\n`;
    notes += `Status     : ${data.resolved ? 'Resolved' : 'May require follow-up'}\n`;

    if (data.summary) {
      notes += `\n=== CONVERSATION SUMMARY ===\n${data.summary}\n`;
    }
  }

  return notes;
};

// ── Extract user info from session attributes ──────────────────────────────────
const extractUserInfo = (attrs) => {
  let parsed = {};
  try {
    if (attrs.userInfo) parsed = JSON.parse(attrs.userInfo);
  } catch (e) { /* ignore */ }

  return {
    name          : attrs.Name            || parsed.name           || 'Unknown User',
    email         : attrs.Email           || parsed.email          || '',
    employeeNumber: parsed.employeeNumber || '',
    department    : parsed.department     || '',
    location      : parsed.location       || '',
    countryCode   : normalizeCountryCode(attrs.CountryCode || parsed.countryCode || 'US'),
    storeEmail    : parsed.storeEmail     || 'N/A',
    jobTitle      : parsed.title          || ''
  };
};

// ── Determine caller ID ────────────────────────────────────────────────────────
const determineCallerId = (userInfo, attrs) => {
  const SKECHERS_DOMAINS = [
    '@skechers.com', '@cn.skechers.com', '@jp.skechers.com',
    '@vn.skechers.com', '@eu.skechers.com'
  ];

  if (userInfo.storeEmail && userInfo.storeEmail !== 'N/A') return userInfo.storeEmail;

  const email = (userInfo.email || attrs.Email || '').toLowerCase();
  if (email && SKECHERS_DOMAINS.some(d => email.endsWith(d))) return email;

  if (userInfo.employeeNumber) return userInfo.employeeNumber;

  return attrs.wdUsername || attrs.userId || 'SKXAmazonLex';
};

// ── Create new interaction record ──────────────────────────────────────────────
const createInteraction = async (event, attrs, initialResponse = '') => {
  const userInfo    = extractUserInfo(attrs);
  const callerId    = determineCallerId(userInfo, attrs);
  const countryCode = userInfo.countryCode;
  const region      = getRegionFromCountryCode(countryCode);
  const { assignment_group, u_region } = getAssignmentGroupAndRegion(region);
  const isRetail    = userInfo.storeEmail && userInfo.storeEmail !== 'N/A';

  // ── Clean input ──────────────────────────────────────────────────────────
  const rawInput  = (event?.inputTranscript || initialResponse || '').replace(/[\n\r\t]/g, ' ').trim();
  const input     = rawInput.replace(/\s+/g, ' ').trim();
  const intent    = event?.sessionState?.intent?.name || 'Chat';
  const shortDesc = input
    ? `${input.substring(0, 80)}${input.length > 80 ? '...' : ''}`
    : `Chat Session — ${intent}`;

  const payload = {
    type             : 'chat',
    state            : 'New',
    short_description: shortDesc,
    work_notes       : buildWorkNotes(event, userInfo, { botResponse: initialResponse }),
    opened_for       : callerId,
    assignment_group : assignment_group,
    assigned_to      : 'SKX Amazon Lex',
    contact_type     : 'chat',
    u_region         : u_region,
    u_country        : getCountryName(countryCode),
    u_location_type  : isRetail ? 'Store / Retail' : 'Corporate',
    channel          : 'Amazon Lex',
    source           : 'Chatbot',
    priority         : '4',
    urgency          : '3',
    impact           : '3',
    comments         : `Session: ${event?.sessionId || 'N/A'} | Intent: ${intent} | Lang: ${attrs.Language || 'en'}`
  };

  console.log(`[interactionLogger] createInteraction — input: "${shortDesc}" caller: "${callerId}"`);

  // ── Use centralised servicenow.js helper ─────────────────────────────────
  const result = await snowCreateInteraction(payload);
  return {
    interactionId    : result?.sys_id  || null,
    interactionNumber: result?.number  || null
  };
};

// ── Append work notes to existing interaction ──────────────────────────────────
const appendNotes = async (interactionId, notes) => {
  if (!interactionId) {
    console.log('[interactionLogger] appendNotes — no interactionId, skipping');
    return false;
  }

  // ── Use centralised get + update helpers ────────────────────────────────
  const current  = await snowGetInteraction(interactionId, 'work_notes');
  const existing = current?.work_notes || '';
  const updated  = existing ? existing + '\n\n' + notes : notes;

  await snowUpdateInteraction(interactionId, { work_notes: updated });

  console.log(`[interactionLogger] appendNotes — appended to ${interactionId}`);
  return true;
};

// ── Close interaction ──────────────────────────────────────────────────────────
const closeInteraction = async (interactionId, event, attrs, data = {}) => {
  if (!interactionId) return false;

  const userInfo = extractUserInfo(attrs);
  const notes    = buildWorkNotes(event, userInfo, {
    ...data,
    conversationStartTime: attrs.conversationStartTime
  }, true);

  // ── Use centralised update helper ────────────────────────────────────────
  await snowUpdateInteraction(interactionId, {
    state      : 'closed_complete',
    closed_at  : new Date().toISOString(),
    close_notes: data.closeNotes || 'Conversation completed',
    work_notes : notes
  });

  console.log(`[interactionLogger] closeInteraction — closed ${interactionId}`);
  return true;
};

// ── Append turn to existing interaction (called each turn) ────────────────────
const appendTurn = async (attrs, event, botResponse = '') => {
  const interactionId = attrs.serviceNowInteractionId;
  if (!interactionId) return;

  const ts     = new Date().toISOString();
  const intent = event?.sessionState?.intent?.name || 'Unknown';
  const input  = event?.inputTranscript || '';

  const notes =
    `=== TURN ===\n` +
    `Time   : ${ts}\n` +
    `Intent : ${intent}\n` +
    `User   : "${input}"\n` +
    `Bot    : "${botResponse.substring(0, 300)}${botResponse.length > 300 ? '...' : ''}"\n`;

  try {
    await appendNotes(interactionId, notes);
  } catch (err) {
    console.warn(`[interactionLogger] appendTurn failed (non-fatal): ${err.message}`);
  }
};

// ── Ensure interaction exists — create if not, reuse if yes ───────────────────
const ensureInteraction = async (event, attrs, initialResponse = '') => {
  const existing = attrs.serviceNowInteractionId;

  if (existing) {
    console.log(`[interactionLogger] ensureInteraction — using existing: ${existing}`);
    return {
      interactionId    : existing,
      interactionNumber: attrs.serviceNowInteractionNumber || '',
      created          : false
    };
  }

  try {
    const result = await createInteraction(event, attrs, initialResponse);
    console.log(`[interactionLogger] ensureInteraction — created: ${result.interactionNumber}`);
    return { ...result, created: true };
  } catch (err) {
    console.error(`[interactionLogger] ensureInteraction failed: ${err.message}`);
    return { interactionId: null, interactionNumber: null, created: false };
  }
};

module.exports = {
  ensureInteraction,
  appendTurn,
  appendNotes,
  closeInteraction,
  extractUserInfo,
  determineCallerId,
  buildWorkNotes
};