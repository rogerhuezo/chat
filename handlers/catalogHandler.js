// handlers/catalogHandler.js
'use strict';

const { searchCatalog, extractSearchTerm } = require('../utils/catalogSearch');

// ── Break/fix indicators — troubleshooting should never route to catalog ──────
const BREAKFIX_PATTERNS = [
  /\b(getting|got|having|seeing)\s+(an?\s+)?error/i,
  /\bbut\s+(i\s+am|i'm|im)\s+getting\b/i,
  /\bnot\s+working\b/i,
  /\bwon'?t\s+work\b/i,
  /\bdoesn'?t\s+work\b/i,
  /\bstopped?\s+working\b/i,
  /\bhaving\s+(an?\s+)?(issue|problem|trouble|error)\b/i,
  /\b(broken|failing|failed|crashed|freezing|frozen)\b/i,
  /\bcan'?t\s+(connect|print|login|log\s+in|access|open|load)\b/i,
  /\bunable\s+to\b/i,
  /\btrouble\s+(with|connecting|printing|installing|accessing)\b/i,
  /\bnot\s+(able|connecting|printing|loading|opening)\b/i,
  /\b(error|errors)\b/i,
  /\bissue(s)?\s+with\b/i,
  /\bproblem(s)?\s+with\b/i,
  /\bi\s+am\s+trying\s+to\b/i,
  /\bi'?m\s+trying\s+to\b/i,
  // ES
  /\b(tengo|tiene)\s+(un\s+)?error\b/i,
  /\bno\s+funciona\b/i,
  /\bproblema\s+con\b/i,
  /\bestoy\s+teniendo\s+problemas\b/i,
  // PT
  /\bestou\s+(tendo|com)\s+(um\s+)?erro\b/i,
  /\bnão\s+funciona\b/i,
  // General "need/want help/assistance with/for" — break/fix territory
  /\b(need|want)\s+(assistance|help)\s+(with|for)\b/i
];

// ── How-to patterns always route to KB (Bedrock), never to catalog ────────────
const HOW_TO_PATTERNS = [
  'how do i install',     'how would i install',    'how can i install',
  'how to install',       'steps to install',        'where do i install',
  'how do i set up',      'how would i set up',      'how can i set up',
  'how to set up',        'how do i configure',      'how to configure',
  'how do i access',      'how to access',           'how do i use',
  'how to use',           'how do i open',           'how to open',
  'how do i find',        'how to find',             'instructions for',
  'guide for',            'steps for',               'tutorial for',
  'how do i get started', 'how to get started',      'how do i launch',
  'how to launch',        'how do i run',            'how to run',
  'how do i enable',      'how to enable',           'how do i download',
  'how to download',      'how do i connect',        'how to connect',
  'how do i log in',      'how to log in',           'how do i sign in',
  'how to sign in',       'how do i login',          'how to login',
];

// ── Known catalog item keywords — software, hardware, apps ───────────────────
const CATALOG_ITEM_KEYWORDS = [
  'adobe', 'microsoft', 'office', 'teams', 'outlook', 'excel', 'word',
  'powerpoint', 'sharepoint', 'visio', 'onenote', 'salesforce', 'oracle',
  'jira', 'confluence', 'photoshop', 'illustrator', 'acrobat', 'zoom',
  'slack', 'garpac', 'sap', 'workday', 'okta', 'lastpass', 'netskope',
  'vpn', 'npa', 'citrix', 'laptop', 'computer', 'monitor', 'keyboard',
  'mouse', 'headset', 'webcam', 'printer', 'docking station', 'tablet',
  'ipad', 'iphone', 'macbook', 'imac', 'scanner', 'speaker', 'creative cloud',
  'dreamweaver', 'indesign', 'lightroom', 'premiere', 'after effects',
  'servicenow', 'snow', 'tableau', 'power bi', 'github', 'gitlab',
  'docker', 'postman', 'figma', 'sketch', 'invision', 'miro',
  'dropbox', 'box', 'onedrive', 'google drive', 'g suite',
  'remote access', 'virtual desktop', 'vdi', 'password reset', 'lastpass',
  'teamviewer', 'team viewer',
];

// ── Catalog trigger verbs/phrases — signals intent to acquire something ───────
// REMOVED: 'install', 'setup', 'set up' — these are how-to signals, not request signals
const CATALOG_TRIGGER_WORDS = [
  'need', 'want', 'request', 'order', 'get',
  'provision', 'require', 'purchase',
];

// ── Explicit catalog request patterns ────────────────────────────────────────
// REMOVED: install/how-to patterns that belong in KB
const CATALOG_REQUEST_PATTERNS = [
  'i need access to',       'need access to',         'request access to',
  'i need to order',        'can i order',             'order a',
  'i need a new',           'can i get a',             'can i get',
  'request software',       'request hardware',        'request a',
  'i need software',        'i need hardware',
  'can you get me',         'get me a',                'get me access',
  'i would like to get',    'i would like access',
  'i want to order',
  'can i have',             'can i have access',
];

// ---------------------------------------------------------------------------
// isCatalogRequest
// Determines whether the incoming message is a catalog/request question
// or a how-to/knowledge question that should be handled by Bedrock KB.
// ---------------------------------------------------------------------------
const isCatalogRequest = (msgLower, slots = {}) => {

  // ✅ GUARD #0 — Break/fix exclusion — ALWAYS checked first
  // If the message contains troubleshooting signals, never treat as catalog
  if (BREAKFIX_PATTERNS.some(p => p.test(msgLower))) {
    console.log(`[catalogHandler] break/fix detected — not a catalog request: "${msgLower}"`);
    return false;
  }

  // ✅ GUARD #1 — How-to questions always go to KB, never catalog
  if (HOW_TO_PATTERNS.some(p => msgLower.includes(p))) {
    console.log(`[catalogHandler] how-to pattern detected — deferring to KB: "${msgLower}"`);
    return false;
  }

  // GUARD #2 — Lex filled CatalogItemName slot explicitly
  if (slots.CatalogItemName?.value?.interpretedValue) {
    console.log('[catalogHandler] catalog detected via CatalogItemName slot');
    return true;
  }

  // GUARD #3 — Explicit request pattern match
  if (CATALOG_REQUEST_PATTERNS.some(p => msgLower.includes(p))) {
    console.log(`[catalogHandler] catalog detected via pattern match: "${msgLower}"`);
    return true;
  }

  // GUARD #4 — Known catalog item keyword + acquisition trigger word combo
  const hasItem    = CATALOG_ITEM_KEYWORDS.some(kw => msgLower.includes(kw));
  const hasTrigger = CATALOG_TRIGGER_WORDS.some(w  => msgLower.includes(w));

  if (hasItem && hasTrigger) {
    console.log(`[catalogHandler] catalog detected via keyword+trigger: "${msgLower}"`);
    return true;
  }

  return false;
};

// ---------------------------------------------------------------------------
// formatCatalogResponse
// Builds the markdown response shown to the user after a catalog search.
// ---------------------------------------------------------------------------
const formatCatalogResponse = (items, keyword, userType, storeNo) => {
  const isRetail = userType === 'retail';

  if (items.length === 0) {
    return isRetail
      ? `❌ I couldn't find **"${keyword}"** in the retail catalog for Store #${storeNo}.\n\nWould you like me to open a support ticket instead?`
      : `❌ I couldn't find **"${keyword}"** in the corporate catalog.\n\nWould you like me to open a support ticket instead?`;
  }

  const header = isRetail
    ? `📂 **Retail Catalog** — Store #${storeNo}\n\n🔍 **Found ${items.length} item${items.length !== 1 ? 's' : ''} matching "${keyword}":**\n\n`
    : `📂 **Corporate Catalog**\n\n🔍 **Found ${items.length} item${items.length !== 1 ? 's' : ''} matching "${keyword}":**\n\n`;

  let message = header;
  items.forEach((item, i) => {
    const desc = item.short_description || `Request for ${item.name}`;
    message += `**${i + 1}. ${item.name}**\n`;
    message += `📋 ${desc}\n`;
    message += `🔗 [Submit Request](${item.url})\n\n`;
  });
  message += `📝 **Ready to proceed?** Click any **Submit Request** link above to access the ServiceNow form.\n`;

  return message;
};

// ---------------------------------------------------------------------------
// handleCatalogRequest
// Main handler — searches the ServiceNow catalog and returns results.
// Only called after isCatalogRequest() returns true.
// ---------------------------------------------------------------------------
const handleCatalogRequest = async (event) => {
  const attrs   = event.contactAttributes || {};
  const message = (event.userMessage || event.inputTranscript || '').trim();
  const slots   = event.sessionState?.intent?.slots || {};
  const email   = attrs.Email || '';

  console.log(`[catalogHandler] message: "${message}" | email: "${email}"`);

  // ✅ Break/fix exclusion — bail out early and return null so chatHandler
  // falls through to KB instead
  const msgLower = message.toLowerCase();
  if (BREAKFIX_PATTERNS.some(p => p.test(msgLower))) {
    console.log(`[catalogHandler] break/fix detected in handler — returning null for KB fallback: "${msgLower}"`);
    return null;
  }

  try {
    // Extract search term from message or slots
    const rawTerm = extractSearchTerm(message, slots);

    // No term found — ask user for clarification
    if (!rawTerm) {
      const isRetail = /^store\d+@skechers\.com$/i.test(email);
      const prompt   = isRetail
        ? `What software, application, or device do you need for your store?\n\n**Examples:**\n• POS software\n• Inventory management\n• Laptop replacement\n• Printer setup`
        : `What software, application, or device do you need?\n\n**Examples:**\n• Adobe Creative Cloud\n• Microsoft Teams\n• Laptop replacement\n• Monitor setup`;

      return {
        sessionState: {
          sessionAttributes: { ...attrs, conversationState: 'AWAITING_CATALOG_TERM' },
          dialogAction: { type: 'ElicitIntent' },
          intent: {
            name             : 'FallbackIntent',
            slots            : {},
            state            : 'InProgress',
            confirmationState: 'None',
          },
        },
        messages: [{ contentType: 'PlainText', content: prompt }],
      };
    }

    // Search ServiceNow catalog
    const { items, keyword, userType, storeNo } = await searchCatalog(rawTerm, email);
    const responseMessage = formatCatalogResponse(items, keyword, userType, storeNo);

    // If no results found, flag state so next turn can offer ticket creation
    const newState = items.length === 0 ? 'AWAITING_CATALOG_FALLBACK' : 'IDLE';

    return {
      sessionState: {
        sessionAttributes: {
          ...attrs,
          conversationState      : newState,
          lastCatalogSearch      : keyword,
          lastCatalogResultsCount: String(items.length),
        },
        dialogAction: { type: 'ElicitIntent' },
        intent: {
          name             : 'FallbackIntent',
          slots            : {},
          state            : 'Fulfilled',
          confirmationState: 'None',
        },
      },
      messages: [{ contentType: 'PlainText', content: responseMessage }],
    };

  } catch (err) {
    console.error('[catalogHandler] error:', err.message);
    return {
      sessionState: {
        sessionAttributes: { ...attrs, conversationState: 'IDLE' },
        dialogAction: { type: 'ElicitIntent' },
        intent: {
          name             : 'FallbackIntent',
          slots            : {},
          state            : 'Fulfilled',
          confirmationState: 'None',
        },
      },
      messages: [{
        contentType: 'PlainText',
        content    : `❌ I encountered an error searching the catalog. Would you like me to open a support ticket instead?`,
      }],
    };
  }
};

module.exports = { handleCatalogRequest, isCatalogRequest };