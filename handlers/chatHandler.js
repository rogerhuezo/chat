// handlers/chatHandler.js
'use strict';

const { handleKnowledgeQuery }            = require('./knowledgeHandler');
const { handleCreateIncident }            = require('./incidentHandler');
const { handleFallback }                  = require('./fallbackHandler');
const { handleCatalogRequest,
        isCatalogRequest }                = require('./catalogHandler');
const { handleOktaAccountManagement,
        shouldHandleOkta,
        isYes: oktaIsYes,
        isNo:  oktaIsNo,
        OKTA_MSG                        } = require('./oktaHandler');
const { handlePosStaffReset,
        shouldHandlePos,
        POS_TRIGGER_KEYWORDS            } = require('./posHandler');
const { ensureInteraction,
        appendTurn,
        closeInteraction }                = require('../utils/interactionLogger');
const { getTransferRegion,
        getConnectQueue,
        normalizeCountryCode }            = require('../utils/regionUtils');
const { resolveLanguage, getMsg,
        MESSAGES }                        = require('../utils/languageUtils');
const { buildQuickReply }                 = require('../utils/response');

// ── Intent groups ──────────────────────────────────────────────────────────────
const INCIDENT_INTENTS = ['LogIncident', 'CreateIncident'];
const STATUS_INTENTS   = ['GetIncidentStatus'];
const UPDATE_INTENTS   = ['UpdateIncident'];
const TRANSFER_INTENTS = ['TransferToAgent'];
const CATALOG_INTENTS  = ['ServiceCatalogIntent', 'RequestSoftware', 'RequestHardware'];
const OKTA_INTENTS     = ['OktaAccountManagement'];

// ── ServiceNow record number regex ────────────────────────────────────────────
const SNOW_NUMBER_REGEX = /\b(INC|RITM|REQ|PRB|CHG|TASK|SCTASK|IMS|TKT|WO|WTASK)\d+\b/i;

const STATUS_LOOKUP_WORDS = [
  'check', 'status', 'look up', 'lookup', 'find', 'search',
  'what is', 'whats', 'where is', 'update on', 'any update',
  'progress', 'follow up', 'followup', 'open', 'closed', 'resolved'
];

const LOOKUP_OVERRIDE_REGEX = /^(can you )?(check|look up|lookup|find|search|status|ver|revisar|buscar|verificar)[\s\w]*\d+/i;
const NUMERIC_ONLY_REGEX    = /^\d{4,8}$/;

const ACCESS_REQUEST_PATTERNS = [
  // ── English — Access requests (new access to a system/app) ────────────────
  /^i need access to /i,
  /^i want access to /i,
  /^request access to /i,
  /^can i get access to /i,
  /^need access to /i,
  /^get access to /i,
  /^i need .+ access$/i,          // "I need Salesforce access" — anchored to END
  /^i would like access to /i,
  /^i am requesting access to /i,
  /^requesting access to /i,
  /^can you give me access to /i,
  /^can you grant me access to /i,
  /^grant me access to /i,

  // ── English — New software/hardware install requests ──────────────────────
  // MUST be clearly a new request, not a break/fix
  // ✅ "I want to install Zoom" = new request
  // ❌ "I am trying to install a printer but getting errors" = break/fix
  /^i need a new /i,              // "I need a new laptop/monitor/headset"
  /^i want a new /i,
  /^i would like a new /i,
  /^can i get a new /i,
  /^request a new /i,
  /^requesting a new /i,
  /^i need to request /i,
  /^i want to request /i,
  /^i would like to request /i,
  /^can i request /i,

  // ── English — General new item/software requests ──────────────────────────
  /^can i get /i,
  /^how (do|can) i (get|request) /i,   // "how do I get/request X"
  // ❌ REMOVED: /^how (do|can) i (install|access)/i  ← break/fix territory
  // ❌ REMOVED: /^install /i                         ← too broad

  // ── Spanish ───────────────────────────────────────────────────────────────
  /^necesito acceso a /i,
  /^quiero acceso a /i,
  /^solicitar acceso a /i,
  /^me pueden dar acceso a /i,
  /^necesito un nuevo /i,         // "necesito un nuevo laptop"
  /^quiero un nuevo /i,
  
  // ── Portuguese ────────────────────────────────────────────────────────────
  /^preciso de acesso a /i,
  /^quero acesso a /i,
  /^solicitar acesso a /i,
  /^preciso de um novo /i,        // "preciso de um novo laptop"
  /^quero um novo /i
];

const TRANSFER_TRIGGER_WORDS = [
  // EN
  'live agent', 'human', 'real person', 'transfer', 'live support',
  'speak to someone', 'talk to someone', 'talk to a person',
  'talk to an agent', 'speak to an agent', 'need an agent', 
  // ES
  'agente', 'persona real', 'transferir', 'soporte en vivo', 'hablar con alguien',
  'necesito a alguien', 'necesito hablar con alguien', 'necesito un agente',
  'quiero hablar con alguien', 'quiero un agente', 'conectar con agente',
  'hablar con una persona', 'con alguien', 'un humano', 'soporte humano',
  // PT
  'pessoa real', 'suporte ao vivo', 'falar com alguem',
  'preciso de alguem', 'preciso falar com alguem', 'quero um agente',
  'falar com uma pessoa',
  // FR
  'personne réelle', 'transférer', 'support en direct', 'parler à quelqu\'un',
  'besoin de quelqu\'un', 'un agent humain',
  // DE
  'echte person', 'weiterleiten', 'live-support', 'mit jemandem sprechen',
  'ich brauche jemanden', 'einen agenten'
];

const PURE_REQUEST_PATTERNS = [
  'can you create', 'can you open', 'can you log', 'can you submit', 'can you raise',
  'can you help create', 'can you help open', 'can you help me',
  'help create a ticket', 'help me create', 'help opening', 'help open a ticket',
  'i need a ticket', 'i want a ticket', 'i need help creating', 'i need to open',
  'i need to create', 'create a ticket for me', 'open a ticket for me',
  'please create a ticket', 'please open a ticket', 'i need help with a ticket',
  'i would like to open', 'i would like to create', 'i want to open', 'i want to create',
  'submit a request for me', 'can you submit a request', 'submit a ticket for me',
  // ES
  'crear un ticket', 'abrir un ticket', 'necesito un ticket',
  // PT
  'criar um ticket', 'abrir um ticket', 'preciso de um ticket'
];

const SOCIAL_PATTERNS = [
  'ok', 'okay', 'ok thanks', 'okay thanks', 'no thanks', 'no thank you',
  'thanks', 'thank you', 'thank you so much', 'got it', 'sounds good',
  'great', 'perfect', 'awesome', 'cool', 'sure', 'yes', 'no', 'nope', 'yep',
  'bye', 'goodbye', 'see you', 'talk later', 'thats all', 'thats it',
  'that is all', 'that is it', 'nothing else', 'im good', 'i am good',
  'im all set', 'i am all set', 'all good', 'all set', 'done', 'great thanks',
  'great thank you', 'perfect thanks', 'sounds great', 'will do', 'noted',
  'no thank you', 'thanks a lot', 'ty', 'thx', 'thnks', 'thnx',
  'appreciate it', 'i appreciate it', 'appreciate that',
  'that is great', 'thats great', 'that was helpful',
  'i am fine', 'im fine', 'i am ok', 'im ok',
  'have a good day', 'have a great day', 'not right now', 'maybe later',
  'ill figure it out', 'i will figure it out', 'i think i got it',
  // ES
  'gracias', 'de acuerdo', 'entendido', 'perfecto', 'hasta luego', 'adios', 'adiós',
  // PT
  'obrigado', 'obrigada', 'perfeito', 'tchau', 'até logo',
  // FR
  'merci', 'entendu', 'parfait', 'au revoir',
  // DE
  'danke', 'verstanden', 'perfekt', 'auf wiedersehen', 'tschüss'
];

const CLOSING_PATTERNS = [
  'bye', 'goodbye', 'see you', 'talk later', 'thats all', 'thats it',
  'that is all', 'that is it', 'nothing else', 'im all set', 'i am all set',
  'all set', 'done', 'have a good day', 'have a great day',
  'not right now', 'maybe later', 'ill figure it out', 'i will figure it out',
  // ES
  'hasta luego', 'adios', 'adiós', 'eso es todo', 'nada mas', 'nada más',
  // PT
  'tchau', 'até logo', 'é isso', 'nada mais',
  // FR
  'au revoir', 'c\'est tout',
  // DE
  'auf wiedersehen', 'tschüss', 'das ist alles'
];

const RESOLVED_PATTERNS = [
  'that helped', 'that works', 'that worked', 'it worked', 'problem solved',
  'issue resolved', 'all good', 'i got it', 'i understand', 'makes sense',
  'that makes sense', 'i see', 'got it thanks', 'perfect that helped',
  // ES
  'eso ayudó', 'funcionó', 'problema resuelto', 'entendido',
  // PT
  'isso ajudou', 'funcionou', 'problema resolvido', 'entendi'
];

const UNRESOLVED_PATTERNS = [
  'still not working', 'still having issues', 'still having problems', 'doesnt work',
  'did not work', 'not working', 'that didnt help', 'that did not help',
  'no it didnt', 'no it did not', 'i still need help', 'not resolved',
  'still need help', 'it didnt work', 'it did not work',
  // ES
  'sigue sin funcionar', 'todavía no funciona', 'no funcionó', 'no me ayudó',
  // PT
  'ainda não funciona', 'não funcionou', 'não me ajudou'
];

const POSITIVE_RESOLUTION_WORDS = [
  'thanks', 'thank you', 'ty', 'thx', 'thnks', 'thnx',
  'yes', 'yep', 'yeah', 'yup',
  'great', 'perfect', 'awesome', 'got it', 'sounds good', 'cool',
  'great thanks', 'great thank you', 'perfect thanks',
  'ok thanks', 'okay thanks',
  'appreciate it', 'i appreciate it', 'appreciate that',
  'that is great', 'thats great', 'that was helpful',
  'all good', 'done', 'will do', 'noted', 'sounds great',
  'sure', 'ok', 'okay',
  'gracias', 'obrigado', 'obrigada', 'merci', 'danke',
  'perfecto', 'perfeito', 'parfait', 'perfekt',
  'entendido', 'entendu', 'verstanden'
];

const NEGATIVE_RESOLUTION_WORDS = [
  'no', 'nope', 'no thanks', 'no thank you',
  'no gracias', 'não', 'nao', 'nein'
];

// ── Response helpers ───────────────────────────────────────────────────────────
const wrapLexResponse = (result, attrs, intentName) => {
  const msg        = result.response || result.botResponse || 'Your request has been processed.';
  const isTerminal = result.conversationState === 'TRANSFER';
  return {
    sessionState: {
      sessionAttributes: { ...attrs, ...(result.attributesToSet || {}) },
      dialogAction: { type: isTerminal ? 'Close' : 'ElicitIntent' },
      intent: {
        name             : intentName || 'FallbackIntent',
        slots            : {},
        state            : 'Fulfilled',
        confirmationState: 'None'
      }
    },
    messages: [{ contentType: 'PlainText', content: msg }]
  };
};

const lexOpen = (content, attrs) => ({
  sessionState: {
    sessionAttributes: { ...attrs, conversationState: 'IDLE' },
    dialogAction: { type: 'ElicitIntent' },
    intent: {
      name             : 'FallbackIntent',
      slots            : {},
      state            : 'InProgress',
      confirmationState: 'None'
    }
  },
  messages: [{ contentType: 'PlainText', content }]
});

const lexOkta = (content, attrs) => ({
  sessionState: {
    sessionAttributes: {
      ...attrs,
      conversationState: attrs.oktaState ? 'OKTA' : 'IDLE'
    },
    dialogAction: { type: 'ElicitIntent' },
    intent: {
      name             : 'OktaAccountManagement',
      slots            : {},
      state            : 'InProgress',
      confirmationState: 'None'
    }
  },
  messages: [{ contentType: 'PlainText', content }]
});

// ── Apply quick reply to catalog fallback responses ───────────────────────────
const applyCatalogQuickReply = (result, platform) => {
  if (!result) return result;
  const state = result.sessionState?.sessionAttributes?.conversationState;
  if (state === 'AWAITING_CATALOG_FALLBACK') {
    const title = result.messages?.[0]?.content || '';
    result.messages = buildQuickReply(title, [{ title: 'Yes' }, { title: 'No' }], platform);
  }
  return result;
};

// ── Shared Okta dispatcher ────────────────────────────────────────────────────
const dispatchOkta = async ({ event, sessionAttrs, msgLower, message, lang,
                               countryCode, intent, doTicketLookup }) => {
  console.log(`[chatHandler] → oktaHandler: intent="${intent}" state="${sessionAttrs.oktaState || 'new'}"`);
  try {
    const oktaResult = await handleOktaAccountManagement({
      attrs            : sessionAttrs,
      msgLower,
      originalMsg      : message,
      lang,
      callerEmail      : sessionAttrs.Email  || '',
      storeName        : sessionAttrs.Name   || '',
      region           : sessionAttrs.Region || getTransferRegion(countryCode),
      interactionNumber: sessionAttrs.serviceNowInteractionNumber || ''
    });

    // ── ✅ NEW v1.2.0: Corporate user fallback — KB then transfer ─────────────
    if (oktaResult.corporateFallback) {
      console.log(`[chatHandler] oktaHandler corporateFallback — running KB query for corporate user`);
      const l = oktaResult.lang || 'en';

      try {
        const kbResult = await handleKnowledgeQuery(message, sessionAttrs);
        const kbAnswer = kbResult?.response || kbResult?.botResponse || '';

        // KB returned a useful answer — present it and offer transfer
        const kbUseful = kbAnswer &&
          !kbAnswer.includes("wasn't able to find") &&
          !kbAnswer.includes("no pude encontrar");

        if (kbUseful) {
          console.log(`[chatHandler] corporate Okta: KB answered — offering transfer`);
          const replyMsg = OKTA_MSG.corporateKbIntro[l]
            ? OKTA_MSG.corporateKbIntro[l](kbAnswer)
            : `${kbAnswer}\n\nWould you like me to connect you with an IT support agent for further assistance?\n\nReply **yes** or **no**.`;

          try { await appendTurn(sessionAttrs, event, replyMsg); } catch (e) { /* non-fatal */ }

          // Store KB answer in session so we can reference it if needed
          return {
            sessionState: {
              sessionAttributes: {
                ...sessionAttrs,
                ...(kbResult.attributesToSet || {}),
                conversationState   : 'AWAITING_OKTA_TRANSFER_CONFIRM',
                oktaTransferPending : 'true'
              },
              dialogAction: { type: 'ElicitIntent' },
              intent: {
                name             : 'OktaAccountManagement',
                slots            : {},
                state            : 'InProgress',
                confirmationState: 'None'
              }
            },
            messages: [{ contentType: 'PlainText', content: replyMsg }]
          };
        }
      } catch (kbErr) {
        console.warn(`[chatHandler] corporate Okta KB query failed (non-fatal): ${kbErr.message}`);
      }

      // KB had no answer — transfer directly
      console.log(`[chatHandler] corporate Okta: no KB answer — transferring directly`);
      const directMsg = OKTA_MSG.corporateTransferDirect[l] ||
        'Okta account management for corporate users is handled by the IT support team. Let me connect you with an agent right away.';

      try { await appendTurn(sessionAttrs, event, directMsg); } catch (e) { /* non-fatal */ }
      return dispatchTransfer({ event, sessionAttrs, lang, firstName: '', countryCode });
    }
    // ── End v1.2.0 corporateFallback block ────────────────────────────────────

    if (oktaResult.handled) {
      const updatedAttrs = { ...sessionAttrs, ...(oktaResult.sessionAttrs || {}) };
      try { await appendTurn(updatedAttrs, event, oktaResult.message); } catch (e) { /* non-fatal */ }
      return lexOkta(oktaResult.message, updatedAttrs);
    }
  } catch (err) {
    console.error(`[chatHandler] oktaHandler error: ${err.message}`);
  }

  // ── Okta declined — fall back to SNOW ticket lookup if number present ────────
  const snowMatch = SNOW_NUMBER_REGEX.exec(message);
  if (snowMatch) {
    console.log(`[chatHandler] oktaHandler declined → SNOW lookup fallback: ${snowMatch[0]}`);
    return doTicketLookup(snowMatch[0].toUpperCase());
  }

  return null;
};

// ── POS response builder (keeps chat open, tracks POS state) ──────────────────
const lexPos = (content, attrs) => ({
  sessionState: {
    sessionAttributes: {
      ...attrs,
      conversationState: attrs.posState ? 'POS' : 'IDLE'
    },
    dialogAction: { type: 'ElicitIntent' },
    intent: {
      name             : 'FallbackIntent',
      slots            : {},
      state            : 'InProgress',
      confirmationState: 'None'
    }
  },
  messages: [{ contentType: 'PlainText', content }]
});

// ── Shared POS dispatcher ─────────────────────────────────────────────────────
const dispatchPos = async ({ event, sessionAttrs, msgLower, message, lang, countryCode }) => {
  console.log(`[chatHandler] → posHandler: POS issue detected`);
  try {
    const posResult = await handlePosStaffReset({
      attrs       : sessionAttrs,
      msgLower,
      originalMsg : message,
      lang,
      callerEmail : sessionAttrs.Email  || '',
      storeName   : sessionAttrs.Name   || '',
      region      : sessionAttrs.Region || getTransferRegion(countryCode),
      countryCode,
      interactionNumber: sessionAttrs.serviceNowInteractionNumber || ''
    });

    if (posResult.handled) {
      const updatedAttrs = { ...sessionAttrs, ...(posResult.sessionAttrs || {}) };
      try { await appendTurn(updatedAttrs, event, posResult.message); } catch (e) { /* non-fatal */ }

      // POS handler always requests transfer (create incident + transfer)
      if (posResult.transfer) {
        return dispatchTransfer({ event, sessionAttrs: updatedAttrs, lang, firstName: '', countryCode });
      }

      return lexPos(posResult.message, updatedAttrs);
    }
  } catch (err) {
    console.error(`[chatHandler] posHandler error: ${err.message}`);
  }
  return null;
};

// ── Transfer helper ───────────────────────────────────────────────────────────
const dispatchTransfer = async ({ event, sessionAttrs, lang, firstName,
  countryCode }) => {
  const transferRegion = getTransferRegion(countryCode);
  const queue          = getConnectQueue(transferRegion);
  const msgFn          = MESSAGES.transferring[lang] || MESSAGES.transferring['en'];
  const transferMsg    = msgFn(firstName, transferRegion);

  console.log(`[chatHandler] transfer → region: "${transferRegion}" queue: "${queue}"`);

  // Log the transfer turn before closing
  try { await appendTurn(sessionAttrs, event, transferMsg); } catch (e) { /* non-fatal */ }

  // ✅ FIXED v1.2.2: guard closeInteraction — log clearly if not available
  if (typeof closeInteraction === 'function') {
  try {
  await closeInteraction(
  sessionAttrs.serviceNowInteractionId,
  event,
  sessionAttrs,
  {
  endReason : 'Transferred to live agent',
  resolved  : false,
  closeNotes: `Transferred to ${queue}`
  }
  );
  } catch (err) {
  console.warn(`[chatHandler] closeInteraction failed (non-fatal): ${err.message}`);
  }
  } else {
  console.warn(`[chatHandler] closeInteraction not available — skipping (check interactionLogger exports)`);
  }

  return {
  sessionState: {
  sessionAttributes: {
  ...sessionAttrs,
  transferRequested: 'true',
  transferRegion,
  transferQueue    : queue,
  conversationState: 'TRANSFER'
  },
  dialogAction: { type: 'Close' },
  intent: {
  name             : 'TransferToAgent',
  slots            : {},
  state            : 'Fulfilled',
  confirmationState: 'None'
  }
  },
  messages: [{ contentType: 'PlainText', content: transferMsg }]
  };
};

// ── Auto-create incident + offer transfer helper ──────────────────────────────
// Consolidates the incident-creation logic used by both the social/isNegative
// and the direct AWAITING_RESOLUTION (isUnresolved/wantsTicket) paths.
const createIncidentAndOfferTransfer = async ({ event, sessionAttrs, message, lang, firstName, attrs }) => {
  // Build a meaningful incident title:
  // 1. Use lastKbQuestion if available (the original user question to KB)
  // 2. If message is a short negative phrase with no context, use lastKbAnswer summary or generic title
  // 3. Otherwise fall back to the raw message
  const SHORT_NEGATIVE_PHRASES = [
    'no', 'nope', 'no thanks', 'no thank you', 'that didnt help',
    'that did not help', 'still not working', 'not working', 'doesnt work',
    'did not work', 'no it didnt', 'no it did not', 'not resolved',
    'no gracias', 'nao', 'não', 'nein'
  ];
  const msgNorm = message.toLowerCase().replace(/[?!.'",]/g, '').replace(/\s+/g, ' ').trim();
  const isShortNegative = SHORT_NEGATIVE_PHRASES.some(p => msgNorm === p);

  let issueTitle;
  if (sessionAttrs.lastKbQuestion) {
    issueTitle = sessionAttrs.lastKbQuestion;
  } else if (isShortNegative) {
    // Message is just "no" or "still not working" with no useful context
    if (sessionAttrs.lastKbAnswer) {
      // Use a truncated version of the KB answer as context
      const kbContext = sessionAttrs.lastKbAnswer.substring(0, 120).replace(/\n/g, ' ').trim();
      issueTitle = `User reported unresolved issue after KB response: ${kbContext}`;
    } else {
      issueTitle = 'User reported unresolved issue after KB response';
    }
  } else {
    issueTitle = message;
  }

  let ticketResult;
  try {
    ticketResult = await handleCreateIncident({
      ...event,
      ticketTitle      : issueTitle,
      contactAttributes: {
        ...sessionAttrs,
        incidentTitle:       issueTitle,
        incidentDescription: issueTitle,
        Name:       event.customerName || attrs['HostedWidget-customerName'] || attrs.Name  || '',
        wdUsername: event.userID       || attrs['HostedWidget-userID']       || attrs.Email || '',
        userId:     event.userID       || attrs['HostedWidget-userID']       || attrs.Email || ''
      }
    });
  } catch (incErr) {
    console.error(`[chatHandler] auto-create incident failed (unexpected throw): ${incErr.message}`);
    ticketResult = null;
  }

  // handleCreateIncident catches its own errors internally and returns an
  // error-shaped object (never throws in practice). Check ticketNumber explicitly
  // to detect failure -- a missing ticketNumber means the ServiceNow call failed.
  const incNumber = ticketResult && ticketResult.ticketNumber;

  if (incNumber) {
    // Success path: show ticket number and offer transfer
    const msgFn = MESSAGES.incidentCreatedOfferTransfer[lang] || MESSAGES.incidentCreatedOfferTransfer['en'];
    const content = msgFn(firstName, incNumber);
    return {
      success: true,
      content,
      sessionAttributes: {
        ...sessionAttrs,
        ...(ticketResult.attributesToSet || {}),
        conversationState: 'AWAITING_TRANSFER_CONFIRM'
      }
    };
  } else {
    // Failure path: inform user and still offer transfer to a live agent
    console.warn(`[chatHandler] incident creation returned no ticketNumber — showing failure message`);
    const content = getMsg(lang, MESSAGES.incidentCreationFailed);
    return {
      success: false,
      content,
      sessionAttributes: {
        ...sessionAttrs,
        conversationState: 'AWAITING_TRANSFER_CONFIRM'
      }
    };
  }
};

// ── Main handler ───────────────────────────────────────────────────────────────
const handleChat = async (event) => {
  const intent    = event.intent  || '';
  const message   = (event.userMessage || event.inputTranscript || event.ticketTitle || '').trim();
  const attrs     = event.contactAttributes || {};
  const slots     = event.sessionState?.intent?.slots || {};
  const prevState = attrs.conversationState || '';
  const firstName = (attrs.Name || attrs['HostedWidget-customerName'] || '').split(' ')[0] || '';
  const platform  = (event.requestAttributes && event.requestAttributes['x-amz-lex:channels:platform']) || '';

  const lang = resolveLanguage(attrs, message, intent);
  const countryCode = normalizeCountryCode(attrs.CountryCode || 'US');

  const msgLower = message
    .toLowerCase()
    .replace(/[?!.'",]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  const resolvedAttrs = {
    ...attrs,
    Language   : lang,
    CountryCode: countryCode
  };

  console.log(
    `[chatHandler] intent: "${intent}" | message: "${message}" | ` +
    `lang: "${lang}" | country: "${countryCode}" | prevState: "${prevState}"`
  );

  let interactionAttrs = {};
  if (!attrs.serviceNowInteractionId) {
    try {
      const interaction = await ensureInteraction(event, resolvedAttrs, message);
      if (interaction.interactionId) {
        interactionAttrs = {
          serviceNowInteractionId    : interaction.interactionId,
          serviceNowInteractionNumber: interaction.interactionNumber,
          conversationStartTime      : new Date().toISOString()
        };
        console.log(`[chatHandler] interaction created: ${interaction.interactionNumber}`);
      }
    } catch (err) {
      console.warn(`[chatHandler] interaction create failed (non-fatal): ${err.message}`);
    }
  }

  const sessionAttrs = { ...resolvedAttrs, ...interactionAttrs };

  const doTicketLookup = async (ticketNumber) => {
    console.log(`[chatHandler] ticket lookup: "${ticketNumber}"`);
    const { handleGetIncidentStatus } = require('./incidentHandler');
    const statusResult = await handleGetIncidentStatus({
      ...event,
      incidentNumber   : ticketNumber,
      contactAttributes: sessionAttrs
    });
    const content = statusResult.response || statusResult.botResponse
      || getMsg(lang, {
          en: `I couldn't retrieve ${ticketNumber}.`,
          es: `No pude recuperar ${ticketNumber}.`,
          pt: `Não consegui recuperar ${ticketNumber}.`,
          fr: `Je n'ai pas pu récupérer ${ticketNumber}.`,
          de: `Ich konnte ${ticketNumber} nicht abrufen.`
        });
    try { await appendTurn(sessionAttrs, event, content); } catch (e) { /* non-fatal */ }
    return {
      sessionState: {
        sessionAttributes: {
          ...sessionAttrs,
          ...(statusResult.attributesToSet || {}),
          conversationState: 'IDLE'
        },
        dialogAction: { type: 'ElicitIntent' },
        intent: {
          name             : 'FallbackIntent',
          slots            : {},
          state            : 'InProgress',
          confirmationState: 'None'
        }
      },
      messages: [{ contentType: 'PlainText', content }]
    };
  };

  // ══════════════════════════════════════════════════════════════════════════
  // PRIORITY 0 — SNOW TICKET NUMBER LOOKUP
  // ══════════════════════════════════════════════════════════════════════════
  // PRIORITY 0.9 — SYSTEM DISAMBIGUATION (Okta vs POS)
  // When user's message matches both Okta and POS, we asked them to clarify.
  // ══════════════════════════════════════════════════════════════════════════
  if (prevState === 'AWAITING_SYSTEM_CHOICE') {
    const pendingMsg    = sessionAttrs.pendingMessage || '';
    const chose1orPos   = /\b(1|pos|till|register|aptos|caja|registro)\b/i.test(message);
    const chose2orOkta  = /\b(2|okta|computer|apps?|email|teams|computadora|correo)\b/i.test(message);

    if (chose1orPos) {
      console.log(`[chatHandler] disambiguation → POS selected`);
      // Route to POS handler with the original pending message
      const posResponse = await dispatchPos({
        event, sessionAttrs: { ...sessionAttrs, conversationState: 'IDLE', pendingMessage: '' },
        msgLower: pendingMsg.toLowerCase(), message: pendingMsg, lang, countryCode
      });
      if (posResponse) return posResponse;
    }

    if (chose2orOkta) {
      console.log(`[chatHandler] disambiguation → Okta selected`);
      // Route to Okta handler with the original pending message
      const oktaResponse = await dispatchOkta({
        event, sessionAttrs: { ...sessionAttrs, conversationState: 'IDLE', pendingMessage: '' },
        msgLower: pendingMsg.toLowerCase(), message: pendingMsg, lang, countryCode, intent,
        doTicketLookup
      });
      if (oktaResponse) return oktaResponse;
    }

    // Unclear response — re-prompt
    const reprompt = getMsg(lang, {
      en: 'Please reply **1** for POS/register login or **2** for Okta/computer/apps login.',
      es: 'Por favor responde **1** para POS/caja o **2** para Okta/computadora/apps.'
    });
    try { await appendTurn(sessionAttrs, event, reprompt); } catch (e) { /* non-fatal */ }
    return {
      sessionState: {
        sessionAttributes: { ...sessionAttrs, conversationState: 'AWAITING_SYSTEM_CHOICE' },
        dialogAction: { type: 'ElicitIntent' },
        intent: { name: 'FallbackIntent', slots: {}, state: 'InProgress', confirmationState: 'None' }
      },
      messages: buildQuickReply(
        reprompt,
        [{ title: 'POS / Register' }, { title: 'Okta / Computer / Apps' }],
        platform
      )
    };
  }

  // ══════════════════════════════════════════════════════════════════════════
  const snowMatch = SNOW_NUMBER_REGEX.exec(message);
  if (snowMatch) {
    console.log(`[chatHandler] SNOW number detected: "${snowMatch[0]}" → ticket lookup`);
    return doTicketLookup(snowMatch[0].toUpperCase());
  }

  // ══════════════════════════════════════════════════════════════════════════
  // PRIORITY 1 — OKTA ACCOUNT MANAGEMENT
  // ══════════════════════════════════════════════════════════════════════════
  const isOktaIntent  = OKTA_INTENTS.includes(intent);
  const isOktaMidFlow = prevState === 'OKTA' && !!sessionAttrs.oktaState;
  const isOktaKeyword = shouldHandleOkta(msgLower, sessionAttrs);

  const isLogWithNumeric = INCIDENT_INTENTS.includes(intent) &&
    !SNOW_NUMBER_REGEX.test(message) &&
    (NUMERIC_ONLY_REGEX.test(msgLower.trim()) ||
     LOOKUP_OVERRIDE_REGEX.test(msgLower)     ||
     STATUS_LOOKUP_WORDS.some(w => msgLower.includes(w)));

  if (isOktaIntent && !isOktaMidFlow) {
    const isStoreUser    = /^store\d+@skechers\.com$/i.test(sessionAttrs.Email || '');
    const isAccessPhrase = ACCESS_REQUEST_PATTERNS.some(p => p.test(message));
    if (!isStoreUser && isAccessPhrase) {
      console.log(`[chatHandler] OktaIntent intercept → catalog redirect: "${message}"`);
      const catalogResult = await handleCatalogRequest({
        ...event,
        userMessage      : message,
        contactAttributes: sessionAttrs
      });
      const catalogContent = catalogResult?.messages?.[0]?.content || '';
      try { await appendTurn(sessionAttrs, event, catalogContent); } catch (e) { /* non-fatal */ }
      return applyCatalogQuickReply(catalogResult, platform);
    }
  }

  if (isOktaIntent || isOktaMidFlow || isOktaKeyword || isLogWithNumeric) {
    // ── Disambiguation: if POS keywords also match and no clear Okta-only signal ──
    const isPosKeywordToo = shouldHandlePos(msgLower, sessionAttrs);
    const hasOktaOnlySignal = /\b(okta|mfa|factors|sso|single sign|email login|apps? login|computer login)\b/i.test(message);
    const hasPosOnlySignal  = /\b(pos|till|register|aptos|staff code)\b/i.test(message);

    // If message has a clear POS signal, skip Okta entirely → let POS handler (Priority 1.2) handle it
    if (hasPosOnlySignal && !hasOktaOnlySignal) {
      console.log(`[chatHandler] POS-only signal detected in Okta block — skipping Okta, will route to POS`);
    } else if (isPosKeywordToo && !hasOktaOnlySignal && !hasPosOnlySignal && !isOktaMidFlow && !sessionAttrs.posState) {
      // Ambiguous — ask user to clarify
      console.log(`[chatHandler] ambiguous Okta/POS — prompting disambiguation`);
      const disambigMsg = getMsg(lang, {
        en: 'I want to make sure I help you with the right system. Is this for:\n\n' +
            '1️⃣ **POS / Register / Till** — the login at the store register (Aptos One)\n' +
            '2️⃣ **Okta / Computer / Apps** — email, Teams, or other app logins\n\n' +
            'Please reply **1** for POS or **2** for Okta.',
        es: 'Quiero asegurarme de ayudarte con el sistema correcto. ¿Es para:\n\n' +
            '1️⃣ **POS / Registro / Caja** — el inicio de sesión en la caja registradora (Aptos One)\n' +
            '2️⃣ **Okta / Computadora / Apps** — correo, Teams, u otras aplicaciones\n\n' +
            'Por favor responde **1** para POS o **2** para Okta.'
      });

      try { await appendTurn(sessionAttrs, event, disambigMsg); } catch (e) { /* non-fatal */ }

      return {
        sessionState: {
          sessionAttributes: {
            ...sessionAttrs,
            conversationState: 'AWAITING_SYSTEM_CHOICE',
            pendingMessage: message
          },
          dialogAction: { type: 'ElicitIntent' },
          intent: { name: 'FallbackIntent', slots: {}, state: 'InProgress', confirmationState: 'None' }
        },
        messages: buildQuickReply(
          disambigMsg,
          [{ title: 'POS / Register' }, { title: 'Okta / Computer / Apps' }],
          platform
        )
      };
    } else {
      // No POS signal — dispatch to Okta
      const oktaResponse = await dispatchOkta({
        event, sessionAttrs, msgLower, message, lang, countryCode, intent,
        doTicketLookup
      });
      if (oktaResponse) return oktaResponse;
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // PRIORITY 1.2 — POS STAFF CODE MANAGEMENT (Aptos One)
  // Retail stores: reset POS login / unlock POS account
  // Distinct from Okta — this is for the till/register login, not SSO
  // ══════════════════════════════════════════════════════════════════════════
  const isPosMidFlow = prevState === 'POS' && !!sessionAttrs.posState;
  const isPosKeyword = shouldHandlePos(msgLower, sessionAttrs);

  if (isPosMidFlow || isPosKeyword) {
    const posResponse = await dispatchPos({
      event, sessionAttrs, msgLower, message, lang, countryCode
    });
    if (posResponse) return posResponse;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // ✅ NEW v1.2.0 — PRIORITY 1.5: AWAITING_OKTA_TRANSFER_CONFIRM
  // Corporate user received KB answer and we are waiting for yes/no on transfer.
  // Must run BEFORE PRIORITY 2 so yes/no isn't swallowed by status or social.
  // ══════════════════════════════════════════════════════════════════════════
  if (prevState === 'AWAITING_OKTA_TRANSFER_CONFIRM') {
    console.log(`[chatHandler] AWAITING_OKTA_TRANSFER_CONFIRM — response: "${msgLower}"`);
  
    // ✅ FIXED v1.2.2: also treat explicit transfer phrases as "yes"
    const isTransferPhrase = TRANSFER_TRIGGER_WORDS.some(w => msgLower.includes(w))
      || TRANSFER_INTENTS.includes(intent);
  
    if (oktaIsYes(msgLower) || isTransferPhrase) {
      console.log(`[chatHandler] corporate Okta transfer confirmed — transferring`);
      return dispatchTransfer({ event, sessionAttrs, lang, firstName, countryCode });
    }
  
    if (oktaIsNo(msgLower)) {
      console.log(`[chatHandler] corporate Okta transfer declined — returning to IDLE`);
      const declineMsg = getMsg(lang, {
        en: `No problem${firstName ? ', ' + firstName : ''}! Is there anything else I can help you with?`,
        es: `¡Sin problema${firstName ? ', ' + firstName : ''}! ¿Hay algo más en lo que pueda ayudarte?`,
        pt: `Sem problema${firstName ? ', ' + firstName : ''}! Há mais alguma coisa em que posso ajudá-lo?`,
        fr: `Pas de problème${firstName ? ', ' + firstName : ''}! Y a-t-il autre chose que je puisse faire pour vous?`,
        de: `Kein Problem${firstName ? ', ' + firstName : ''}! Gibt es noch etwas, womit ich Ihnen helfen kann?`
      });
      try { await appendTurn(sessionAttrs, event, declineMsg); } catch (e) { /* non-fatal */ }
      return {
        sessionState: {
          sessionAttributes: {
            ...sessionAttrs,
            conversationState  : 'IDLE',
            oktaTransferPending: ''
          },
          dialogAction: { type: 'ElicitIntent' },
          intent: {
            name             : 'FallbackIntent',
            slots            : {},
            state            : 'Fulfilled',
            confirmationState: 'None'
          }
        },
        messages: [{ contentType: 'PlainText', content: declineMsg }]
      };
    }
  
    // Unclear — re-prompt
    console.log(`[chatHandler] AWAITING_OKTA_TRANSFER_CONFIRM — unclear, re-prompting`);
    const repromptMsg = getMsg(lang, {
      en: 'Would you like me to connect you with an IT support agent? Please reply **yes** or **no**.',
      es: '¿Te gustaría que te conectara con un agente de soporte de TI? Por favor responde **sí** o **no**.',
      pt: 'Você gostaria que eu conectasse você com um agente de suporte de TI? Por favor responda **sim** ou **não**.',
      fr: 'Souhaitez-vous que je vous connecte avec un agent de support informatique? Veuillez répondre **oui** ou **non**.',
      de: 'Möchten Sie, dass ich Sie mit einem IT-Support-Mitarbeiter verbinde? Bitte antworten Sie mit **ja** oder **nein**.'
    });
    try { await appendTurn(sessionAttrs, event, repromptMsg); } catch (e) { /* non-fatal */ }
    return {
      sessionState: {
        sessionAttributes: {
          ...sessionAttrs,
          conversationState  : 'AWAITING_OKTA_TRANSFER_CONFIRM',
          oktaTransferPending: 'true'
        },
        dialogAction: { type: 'ElicitIntent' },
        intent: {
          name             : 'OktaAccountManagement',
          slots            : {},
          state            : 'InProgress',
          confirmationState: 'None'
        }
      },
      messages: buildQuickReply(
        repromptMsg,
        [{ title: 'Yes' }, { title: 'No' }],
        platform
      )
    };
  }
  // ── End v1.2.0 AWAITING_OKTA_TRANSFER_CONFIRM ─────────────────────────────

  // ══════════════════════════════════════════════════════════════════════════
  // PRIORITY 1.6: AWAITING_TRANSFER_CONFIRM (post-incident auto-create)
  // User was offered a live agent transfer after auto-incident creation.
  // Must run BEFORE PRIORITY 2 so yes/no isn't swallowed by status or social.
  // ══════════════════════════════════════════════════════════════════════════
  if (prevState === 'AWAITING_TRANSFER_CONFIRM') {
    console.log(`[chatHandler] AWAITING_TRANSFER_CONFIRM — response: "${msgLower}"`);

    const transferYesWords = ['yes', 'yeah', 'sure', 'yep', 'ok', 'okay', 'please',
                              'si', 'sí', 'claro', 'sim', 'oui', 'ja'];
    const transferNoWords  = ['no', 'nope', 'no thanks', 'no gracias', 'nao', 'não'];

    const isTransferYes = transferYesWords.some(w => msgLower === w)
      || TRANSFER_TRIGGER_WORDS.some(w => msgLower.includes(w))
      || TRANSFER_INTENTS.includes(intent);

    const isTransferNo = transferNoWords.some(w => msgLower === w);

    if (isTransferYes) {
      console.log(`[chatHandler] AWAITING_TRANSFER_CONFIRM — yes → transferring`);
      return dispatchTransfer({ event, sessionAttrs, lang, firstName, countryCode });
    }

    if (isTransferNo) {
      console.log(`[chatHandler] AWAITING_TRANSFER_CONFIRM — no → returning to IDLE`);
      const declineMsg = getMsg(lang, {
        en: `No problem${firstName ? ', ' + firstName : ''}! Let me know if you need anything else.`,
        es: `¡Sin problema${firstName ? ', ' + firstName : ''}! Avísame si necesitas algo más.`,
        pt: `Sem problema${firstName ? ', ' + firstName : ''}! Me avise se precisar de mais alguma coisa.`,
        fr: `Pas de problème${firstName ? ', ' + firstName : ''}! N'hésitez pas si vous avez besoin d'autre chose.`,
        de: `Kein Problem${firstName ? ', ' + firstName : ''}! Lassen Sie mich wissen, wenn Sie noch etwas brauchen.`
      });
      try { await appendTurn(sessionAttrs, event, declineMsg); } catch (e) { /* non-fatal */ }
      return {
        sessionState: {
          sessionAttributes: {
            ...sessionAttrs,
            conversationState: 'IDLE'
          },
          dialogAction: { type: 'ElicitIntent' },
          intent: {
            name             : 'FallbackIntent',
            slots            : {},
            state            : 'Fulfilled',
            confirmationState: 'None'
          }
        },
        messages: [{ contentType: 'PlainText', content: declineMsg }]
      };
    }

    // Unclear — re-prompt
    console.log(`[chatHandler] AWAITING_TRANSFER_CONFIRM — unclear, re-prompting`);
    const repromptMsg = getMsg(lang, {
      en: 'Would you like me to connect you with a live agent? Reply **yes** or **no**.',
      es: '¿Te gustaría que te conectara con un agente en vivo? Responde **sí** o **no**.',
      pt: 'Gostaria que eu conectasse você com um agente ao vivo? Responda **sim** ou **não**.',
      fr: 'Souhaitez-vous que je vous connecte avec un agent en direct? Répondez **oui** ou **non**.',
      de: 'Möchten Sie, dass ich Sie mit einem Live-Agenten verbinde? Antworten Sie mit **ja** oder **nein**.'
    });
    try { await appendTurn(sessionAttrs, event, repromptMsg); } catch (e) { /* non-fatal */ }
    return {
      sessionState: {
        sessionAttributes: {
          ...sessionAttrs,
          conversationState: 'AWAITING_TRANSFER_CONFIRM'
        },
        dialogAction: { type: 'ElicitIntent' },
        intent: {
          name             : 'FallbackIntent',
          slots            : {},
          state            : 'InProgress',
          confirmationState: 'None'
        }
      },
      messages: buildQuickReply(
        repromptMsg,
        [{ title: 'Yes' }, { title: 'No' }],
        platform
      )
    };
  }
  // ── End AWAITING_TRANSFER_CONFIRM ─────────────────────────────────────────

  // ══════════════════════════════════════════════════════════════════════════
  // PRIORITY 2 — STATUS LOOKUP
  // ══════════════════════════════════════════════════════════════════════════
  const hasStatusWord = STATUS_LOOKUP_WORDS.some(w => msgLower.includes(w));

  if (STATUS_INTENTS.includes(intent)) {
    const { handleGetIncidentStatus } = require('./incidentHandler');
    const statusResult = await handleGetIncidentStatus({
      ...event,
      contactAttributes: sessionAttrs
    });
    const content = statusResult.response || statusResult.botResponse || getMsg(lang, {
      en: 'I couldn\'t retrieve your tickets.',
      es: 'No pude recuperar tus tickets.',
      pt: 'Não consegui recuperar seus tickets.',
      fr: 'Je n\'ai pas pu récupérer vos tickets.',
      de: 'Ich konnte Ihre Tickets nicht abrufen.'
    });
    try { await appendTurn(sessionAttrs, event, content); } catch (e) { /* non-fatal */ }
    return {
      sessionState: {
        sessionAttributes: {
          ...sessionAttrs,
          ...(statusResult.attributesToSet || {}),
          conversationState: 'IDLE'
        },
        dialogAction: { type: 'ElicitIntent' },
        intent: {
          name             : 'FallbackIntent',
          slots            : {},
          state            : 'InProgress',
          confirmationState: 'None'
        }
      },
      messages: [{ contentType: 'PlainText', content }]
    };
  }

  // ══════════════════════════════════════════════════════════════════════════
  // PRIORITY 3 — ACCESS REQUEST GUARD
  // ══════════════════════════════════════════════════════════════════════════
  const isAccessRequest = ACCESS_REQUEST_PATTERNS.some(p => p.test(message));
  if (isAccessRequest) {
    console.log(`[chatHandler] access request guard → catalog: "${message}"`);
    const catalogResult = await handleCatalogRequest({
      ...event,
      userMessage      : message,
      contactAttributes: sessionAttrs
    });
    const catalogContent = catalogResult?.messages?.[0]?.content || '';
    try { await appendTurn(sessionAttrs, event, catalogContent); } catch (e) { /* non-fatal */ }
    return applyCatalogQuickReply(catalogResult, platform);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // PRIORITY 4 — TRANSFER TO AGENT
  // ══════════════════════════════════════════════════════════════════════════
  const explicitTransfer = TRANSFER_TRIGGER_WORDS.some(w => msgLower.includes(w));
  const wantsTransfer    = TRANSFER_INTENTS.includes(intent) || explicitTransfer;

  if (wantsTransfer) {
    return dispatchTransfer({ event, sessionAttrs, lang, firstName, countryCode });
  }

  // ══════════════════════════════════════════════════════════════════════════
  // PRIORITY 5 — SOCIAL / CONVERSATIONAL
  // ══════════════════════════════════════════════════════════════════════════
  const wordCount = msgLower.split(/\s+/).filter(w => w.length > 0).length;
  const isSocial  = wordCount <= 5 && SOCIAL_PATTERNS.some(p =>
    msgLower === p ||
    msgLower.startsWith(p + ' ') ||
    msgLower.endsWith(' ' + p)
  );

  if (isSocial) {

    if (prevState === 'AWAITING_RESOLUTION') {
      const isPositive = POSITIVE_RESOLUTION_WORDS.some(p =>
        msgLower === p || msgLower.includes(p)
      );
      const isNegative = NEGATIVE_RESOLUTION_WORDS.some(p => msgLower === p);

      if (isPositive) {
        console.log(`[chatHandler] AWAITING_RESOLUTION + positive social → resolved`);
        const positiveContent = getMsg(lang, {
          en: `Glad I could help${firstName ? ', ' + firstName : ''}! Is there anything else I can assist you with?`,
          es: `Me alegra haber podido ayudar${firstName ? ', ' + firstName : ''}! Hay algo mas en lo que pueda ayudarte?`,
          pt: `Fico feliz em ter ajudado${firstName ? ', ' + firstName : ''}! Ha mais alguma coisa em que posso ajuda-lo?`,
          fr: `Ravi d'avoir pu aider${firstName ? ', ' + firstName : ''}! Y a-t-il autre chose que je puisse faire pour vous?`,
          de: `Schoen dass ich helfen konnte${firstName ? ', ' + firstName : ''}! Gibt es noch etwas womit ich Ihnen helfen kann?`
        });
        try { await appendTurn(sessionAttrs, event, positiveContent); } catch (e) { /* non-fatal */ }
        try {
          await closeInteraction(
            sessionAttrs.serviceNowInteractionId,
            event,
            sessionAttrs,
            { endReason: 'Resolved via KB', resolved: true }
          );
        } catch (err) {
          console.warn(`[chatHandler] closeInteraction failed (non-fatal): ${err.message}`);
        }
        return {
          sessionState: {
            sessionAttributes: { ...sessionAttrs, conversationState: 'IDLE' },
            dialogAction: { type: 'ElicitIntent' },
            intent: {
              name             : 'FallbackIntent',
              slots            : {},
              state            : 'Fulfilled',
              confirmationState: 'None'
            }
          },
          messages: [{
            contentType: 'PlainText',
            content    : positiveContent
          }]
        };
      }

      if (isNegative) {
        console.log(`[chatHandler] AWAITING_RESOLUTION + negative social → auto-create incident + offer transfer`);
        const result = await createIncidentAndOfferTransfer({ event, sessionAttrs, message, lang, firstName, attrs });
        try { await appendTurn(sessionAttrs, event, result.content); } catch (e) { /* non-fatal */ }
        return {
          sessionState: {
            sessionAttributes: result.sessionAttributes,
            dialogAction: { type: 'ElicitIntent' },
            intent: {
              name             : 'FallbackIntent',
              slots            : {},
              state            : 'InProgress',
              confirmationState: 'None'
            }
          },
          messages: [{
            contentType: 'PlainText',
            content    : result.content
          }]
        };
      }
    }

    const isNoResponse = ['no', 'nope', 'no thanks', 'no thank you',
                          'no gracias', 'não', 'nao'].some(p => msgLower === p);
    const isClosing    = CLOSING_PATTERNS.some(p =>
      msgLower === p || msgLower.startsWith(p)
    ) || (isNoResponse && (prevState === 'IDLE' || prevState === 'AWAITING_RESOLUTION'));

    if (isClosing) {
      try {
        await closeInteraction(
          sessionAttrs.serviceNowInteractionId,
          event,
          sessionAttrs,
          { endReason: 'User ended conversation', resolved: true }
        );
      } catch (err) {
        console.warn(`[chatHandler] closeInteraction failed (non-fatal): ${err.message}`);
      }
    }

    const content = isClosing
      ? `${getMsg(lang, MESSAGES.youreWelcome)}${firstName ? ' ' + firstName + '!' : '!'} ${getMsg(lang, MESSAGES.goodbye)}`
      : `${getMsg(lang, MESSAGES.youreWelcome)} ${getMsg(lang, MESSAGES.anythingElse)}`;

    try { await appendTurn(sessionAttrs, event, content); } catch (e) { /* non-fatal */ }

    return {
      sessionState: {
        sessionAttributes: {
          ...sessionAttrs,
          conversationState: isClosing ? 'IDLE' : prevState
        },
        dialogAction: { type: isClosing ? 'Close' : 'ElicitIntent' },
        intent: {
          name             : 'FallbackIntent',
          slots            : {},
          state            : 'Fulfilled',
          confirmationState: 'None'
        }
      },
      messages: [{ contentType: 'PlainText', content }]
    };
  }

  // ══════════════════════════════════════════════════════════════════════════
  // CONTEXT STATES
  // ══════════════════════════════════════════════════════════════════════════

  if (prevState === 'AWAITING_CATALOG_TERM' && message) {
    const catalogResult = await handleCatalogRequest({
      ...event,
      userMessage      : message,
      contactAttributes: sessionAttrs
    });
    const catalogContent = catalogResult?.messages?.[0]?.content || '';
    try { await appendTurn(sessionAttrs, event, catalogContent); } catch (e) { /* non-fatal */ }
    return applyCatalogQuickReply(catalogResult, platform);
  }

  if (prevState === 'AWAITING_CATALOG_FALLBACK') {
    const wantsTicket = ['yes', 'yeah', 'sure', 'please', 'ok', 'okay', 'yes please',
                         'sí', 'si', 'claro', 'sim', 'oui', 'ja']
      .some(w => msgLower === w);

    if (wantsTicket) {
      const catalogYesContent = getMsg(lang, MESSAGES.describeIssue);
      try { await appendTurn(sessionAttrs, event, catalogYesContent); } catch (e) { /* non-fatal */ }
      return {
        sessionState: {
          sessionAttributes: { ...sessionAttrs, conversationState: 'AWAITING_DESCRIPTION' },
          dialogAction: { type: 'ElicitIntent' },
          intent: {
            name             : 'FallbackIntent',
            slots            : {},
            state            : 'InProgress',
            confirmationState: 'None'
          }
        },
        messages: [{ contentType: 'PlainText', content: catalogYesContent }]
      };
    }

    const catalogNoContent = getMsg(lang, {
      en: 'No problem! Is there anything else I can help you with?',
      es: '¡Sin problema! ¿Hay algo más en lo que pueda ayudarte?',
      pt: 'Sem problema! Há mais alguma coisa em que posso ajudá-lo?',
      fr: 'Pas de problème! Y a-t-il autre chose que je puisse faire pour vous?',
      de: 'Kein Problem! Gibt es noch etwas, womit ich Ihnen helfen kann?'
    });
    try { await appendTurn(sessionAttrs, event, catalogNoContent); } catch (e) { /* non-fatal */ }
    return {
      sessionState: {
        sessionAttributes: { ...sessionAttrs, conversationState: 'IDLE' },
        dialogAction: { type: 'ElicitIntent' },
        intent: {
          name             : 'FallbackIntent',
          slots            : {},
          state            : 'Fulfilled',
          confirmationState: 'None'
        }
      },
      messages: [{ contentType: 'PlainText', content: catalogNoContent }]
    };
  }

  if (prevState === 'AWAITING_RESOLUTION') {

    if (TRANSFER_TRIGGER_WORDS.some(w => msgLower.includes(w))) {
      return dispatchTransfer({ event, sessionAttrs, lang, firstName, countryCode });
    }

    if (isCatalogRequest(msgLower, slots)) {
      const catalogResult = await handleCatalogRequest({
        ...event,
        userMessage      : message,
        contactAttributes: sessionAttrs
      });
      const catalogContent = catalogResult?.messages?.[0]?.content || '';
      try { await appendTurn(sessionAttrs, event, catalogContent); } catch (e) { /* non-fatal */ }
      return applyCatalogQuickReply(catalogResult, platform);
    }

    const isResolved   = RESOLVED_PATTERNS.some(p => msgLower.includes(p));
    const isUnresolved = UNRESOLVED_PATTERNS.some(p => msgLower.includes(p));
    const wantsTicket  = PURE_REQUEST_PATTERNS.some(p => msgLower.includes(p)) ||
                         msgLower.includes('ticket') || msgLower.includes('incident');

    if (isResolved) {
      const resolvedContent = getMsg(lang, {
        en: `Glad I could help${firstName ? ', ' + firstName : ''}! ${MESSAGES.anythingElse.en}`,
        es: `¡Me alegra haber podido ayudar${firstName ? ', ' + firstName : ''}! ${MESSAGES.anythingElse.es}`,
        pt: `Fico feliz em ter ajudado${firstName ? ', ' + firstName : ''}! ${MESSAGES.anythingElse.pt}`,
        fr: `Ravi d'avoir pu aider${firstName ? ', ' + firstName : ''}! ${MESSAGES.anythingElse.fr}`,
        de: `Schön, dass ich helfen konnte${firstName ? ', ' + firstName : ''}! ${MESSAGES.anythingElse.de}`
      });
      try { await appendTurn(sessionAttrs, event, resolvedContent); } catch (e) { /* non-fatal */ }
      return {
        sessionState: {
          sessionAttributes: { ...sessionAttrs, conversationState: 'IDLE' },
          dialogAction: { type: 'ElicitIntent' },
          intent: {
            name             : 'FallbackIntent',
            slots            : {},
            state            : 'Fulfilled',
            confirmationState: 'None'
          }
        },
        messages: [{ contentType: 'PlainText', content: resolvedContent }]
      };
    }

    if (isUnresolved || wantsTicket) {
      console.log(`[chatHandler] AWAITING_RESOLUTION + unresolved/wantsTicket → auto-create incident + offer transfer`);
      const result = await createIncidentAndOfferTransfer({ event, sessionAttrs, message, lang, firstName, attrs });
      try { await appendTurn(sessionAttrs, event, result.content); } catch (e) { /* non-fatal */ }
      return {
        sessionState: {
          sessionAttributes: result.sessionAttributes,
          dialogAction: { type: 'ElicitIntent' },
          intent: {
            name             : 'FallbackIntent',
            slots            : {},
            state            : 'InProgress',
            confirmationState: 'None'
          }
        },
        messages: [{ contentType: 'PlainText', content: result.content }]
      };
    }

    const kbFollowUp = await handleKnowledgeQuery(message, sessionAttrs);
    if (kbFollowUp?.response || kbFollowUp?.botResponse) {
      const kbFollowUpContent = kbFollowUp.response || kbFollowUp.botResponse;
      try { await appendTurn(sessionAttrs, event, kbFollowUpContent); } catch (e) { /* non-fatal */ }
      return {
        sessionState: {
          sessionAttributes: {
            ...sessionAttrs,
            ...(kbFollowUp.attributesToSet || {}),
            conversationState: 'AWAITING_RESOLUTION'
          },
          dialogAction: { type: 'ElicitIntent' },
          intent: {
            name             : 'FallbackIntent',
            slots            : {},
            state            : 'Fulfilled',
            confirmationState: 'None'
          }
        },
        messages: [{ contentType: 'PlainText', content: kbFollowUpContent }]
      };
    }

    const repromptContent = getMsg(lang, {
      en: 'I\'m sorry, I didn\'t quite catch that. Did the information help, or would you like me to open a support ticket?',
      es: 'Lo siento, no entendí bien. ¿La información fue útil, o te gustaría que abriera un ticket de soporte?',
      pt: 'Desculpe, não entendi bem. As informações foram úteis, ou você gostaria que eu abrisse um ticket de suporte?',
      fr: 'Désolé, je n\'ai pas bien compris. L\'information a-t-elle aidé, ou souhaitez-vous que j\'ouvre un ticket de support?',
      de: 'Entschuldigung, ich habe das nicht ganz verstanden. Hat die Information geholfen, oder soll ich ein Support-Ticket öffnen?'
    });
    try { await appendTurn(sessionAttrs, event, repromptContent); } catch (e) { /* non-fatal */ }
    return {
      sessionState: {
        sessionAttributes: { ...sessionAttrs, conversationState: 'AWAITING_RESOLUTION' },
        dialogAction: { type: 'ElicitIntent' },
        intent: {
          name             : 'FallbackIntent',
          slots            : {},
          state            : 'InProgress',
          confirmationState: 'None'
        }
      },
      messages: buildQuickReply(
        repromptContent,
        [{ title: 'That helped' }, { title: 'Still need help' }, { title: 'Talk to agent' }],
        platform
      )
    };
  }

  if (prevState === 'AWAITING_DESCRIPTION') {
    if (message && message.length > 5) {
      const ticketResult = await handleCreateIncident({
        ...event,
        ticketTitle      : message,
        contactAttributes: {
          ...sessionAttrs,
          incidentTitle:       message,
          incidentDescription: message,
          Name:       event.customerName || attrs['HostedWidget-customerName'] || attrs.Name  || '',
          wdUsername: event.userID       || attrs['HostedWidget-userID']       || attrs.Email || '',
          userId:     event.userID       || attrs['HostedWidget-userID']       || attrs.Email || ''
        }
      });
      const content = ticketResult.response || ticketResult.botResponse || '';
      try { await appendTurn(sessionAttrs, event, content); } catch (e) { /* non-fatal */ }
      return wrapLexResponse(ticketResult, { ...sessionAttrs, conversationState: 'IDLE' }, 'LogIncident');
    }

    // Message too short — re-prompt
    const describeContent = getMsg(lang, MESSAGES.describeIssue);
    try { await appendTurn(sessionAttrs, event, describeContent); } catch (e) { /* non-fatal */ }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // INTENT ROUTING
  // ══════════════════════════════════════════════════════════════════════════

  if (CATALOG_INTENTS.includes(intent)) {
    const catalogResult = await handleCatalogRequest({
      ...event,
      userMessage      : message,
      contactAttributes: sessionAttrs
    });
    const catalogContent = catalogResult?.messages?.[0]?.content || '';
    try { await appendTurn(sessionAttrs, event, catalogContent); } catch (e) { /* non-fatal */ }
    return applyCatalogQuickReply(catalogResult, platform);
  }

  if (INCIDENT_INTENTS.includes(intent)) {

    const shortdescription = slots?.shortdescription?.value?.interpretedValue || null;
    if (!shortdescription) {
      console.log(`[chatHandler] LogIncident — shortdescription slot is null → ask for description`);
      const descContent = getMsg(lang, {
        en: 'Sure! Please describe your issue and I\'ll create a support ticket for you.',
        es: '¡Claro! Por favor describe tu problema y crearé un ticket de soporte para ti.',
        pt: 'Claro! Por favor descreva seu problema e criarei um ticket de suporte para você.',
        fr: 'Bien sûr! Veuillez décrire votre problème et je créerai un ticket de support pour vous.',
        de: 'Natürlich! Bitte beschreiben Sie Ihr Problem und ich erstelle ein Support-Ticket für Sie.'
      });
      try { await appendTurn(sessionAttrs, event, descContent); } catch (e) { /* non-fatal */ }
      return {
        sessionState: {
          sessionAttributes: { ...sessionAttrs, conversationState: 'AWAITING_DESCRIPTION' },
          dialogAction: { type: 'ElicitIntent' },
          intent: {
            name             : intent,
            slots            : {},
            state            : 'InProgress',
            confirmationState: 'None'
          }
        },
        messages: [{ contentType: 'PlainText', content: descContent }]
      };
    }
  
    const isPureCreateRequest = PURE_REQUEST_PATTERNS.some(p => msgLower.includes(p)) ||
      /^(create|open|log|submit|raise|report)\s+(a\s+|an\s+)?(new\s+)?(ticket|incident|issue|case|request)$/i.test(msgLower);
  
    if (isPureCreateRequest) {
      console.log(`[chatHandler] LogIncident pure create phrase → ask for description: "${message}"`);
      const pureDescContent = getMsg(lang, {
        en: 'Sure! Please describe your issue and I\'ll create a support ticket for you.',
        es: '¡Claro! Por favor describe tu problema y crearé un ticket de soporte para ti.',
        pt: 'Claro! Por favor descreva seu problema e criarei um ticket de suporte para você.',
        fr: 'Bien sûr! Veuillez décrire votre problème et je créerai un ticket de support pour vous.',
        de: 'Natürlich! Bitte beschreiben Sie Ihr Problem und ich erstelle ein Support-Ticket für Sie.'
      });
      try { await appendTurn(sessionAttrs, event, pureDescContent); } catch (e) { /* non-fatal */ }
      return {
        sessionState: {
          sessionAttributes: { ...sessionAttrs, conversationState: 'AWAITING_DESCRIPTION' },
          dialogAction: { type: 'ElicitIntent' },
          intent: {
            name             : intent,
            slots            : {},
            state            : 'InProgress',
            confirmationState: 'None'
          }
        },
        messages: [{ contentType: 'PlainText', content: pureDescContent }]
      };
    }
  
    const incidentResult = await handleCreateIncident({
      ...event,
      ticketTitle      : message,
      contactAttributes: {
        ...sessionAttrs,
        incidentTitle:       message,
        incidentDescription: message,
        Name:       event.customerName || attrs['HostedWidget-customerName'] || attrs.Name  || '',
        wdUsername: event.userID       || attrs['HostedWidget-userID']       || attrs.Email || '',
        userId:     event.userID       || attrs['HostedWidget-userID']       || attrs.Email || ''
      }
    });
    const incidentContent = incidentResult.response || incidentResult.botResponse || '';
    try { await appendTurn(sessionAttrs, event, incidentContent); } catch (e) { /* non-fatal */ }
    return wrapLexResponse(incidentResult, sessionAttrs, intent);
  }

  if (UPDATE_INTENTS.includes(intent)) {
    const { handleUpdateIncident } = require('./incidentHandler');
    const updateResult = await handleUpdateIncident({
      ...event,
      contactAttributes: sessionAttrs
    });
    const updateContent = updateResult.response || updateResult.botResponse || '';
    try { await appendTurn(sessionAttrs, event, updateContent); } catch (e) { /* non-fatal */ }
    return lexOpen(updateContent, { ...sessionAttrs, ...(updateResult.attributesToSet || {}) });
  }

  if ((intent === 'FallbackIntent' || !intent) && isCatalogRequest(msgLower, slots)) {
    const catalogResult = await handleCatalogRequest({
      ...event,
      userMessage      : message,
      contactAttributes: sessionAttrs
    });
    const catalogContent = catalogResult?.messages?.[0]?.content || '';
    try { await appendTurn(sessionAttrs, event, catalogContent); } catch (e) { /* non-fatal */ }
    return applyCatalogQuickReply(catalogResult, platform);
  }

  const TICKET_KEYWORDS = [
    'ticket', 'incident', 'report an issue', 'report issue',
    'incidente', 'problema', 'issue',
    'skechforce', 'skech force', 'clock in', 'clock out',
    'time off', 'timecard', 'time card', 'punch', 'my schedule'
  ];
  const TICKET_MATCH = TICKET_KEYWORDS.some(kw => msgLower.includes(kw));
  const PURE_REQUEST = PURE_REQUEST_PATTERNS.some(kw => msgLower.includes(kw));

  if ((intent === 'FallbackIntent' || !intent) && (TICKET_MATCH || PURE_REQUEST)) {
    if (PURE_REQUEST) {
      const pureReqContent = getMsg(lang, {
        en: 'Sure! Please describe your issue and I\'ll create a ticket for you.',
        es: '¡Claro! Por favor describe tu problema y crearé un ticket para ti.',
        pt: 'Claro! Por favor descreva seu problema e criarei um ticket para você.',
        fr: 'Bien sûr! Veuillez décrire votre problème et je créerai un ticket pour vous.',
        de: 'Natürlich! Bitte beschreiben Sie Ihr Problem und ich erstelle ein Ticket für Sie.'
      });
      try { await appendTurn(sessionAttrs, event, pureReqContent); } catch (e) { /* non-fatal */ }
      return {
        sessionState: {
          sessionAttributes: { ...sessionAttrs, conversationState: 'AWAITING_DESCRIPTION' },
          dialogAction: { type: 'ElicitIntent' },
          intent: {
            name             : 'FallbackIntent',
            slots            : {},
            state            : 'InProgress',
            confirmationState: 'None'
          }
        },
        messages: [{ contentType: 'PlainText', content: pureReqContent }]
      };
    }
    const ticketResult = await handleCreateIncident({
      ...event,
      ticketTitle      : message,
      contactAttributes: {
        ...sessionAttrs,
        incidentTitle:       message,
        incidentDescription: message,
        Name:       event.customerName || attrs['HostedWidget-customerName'] || attrs.Name  || '',
        wdUsername: event.userID       || attrs['HostedWidget-userID']       || attrs.Email || '',
        userId:     event.userID       || attrs['HostedWidget-userID']       || attrs.Email || ''
      }
    });
    const ticketContent = ticketResult.response || ticketResult.botResponse || '';
    try { await appendTurn(sessionAttrs, event, ticketContent); } catch (e) { /* non-fatal */ }
    return wrapLexResponse(ticketResult, sessionAttrs, 'LogIncident');
  }

  if (intent === 'FallbackIntent' || !intent) {
    if (!message) {
      const fallbackResult = await handleFallback({ ...event, contactAttributes: sessionAttrs });
      const fallbackContent = fallbackResult.response || fallbackResult.botResponse || '';
      try { await appendTurn(sessionAttrs, event, fallbackContent); } catch (e) { /* non-fatal */ }
      return wrapLexResponse(fallbackResult, sessionAttrs, 'FallbackIntent');
    }
    const kbResult = await handleKnowledgeQuery(message, sessionAttrs);
    if (!kbResult?.response && !kbResult?.botResponse) {
      const fallbackResult = await handleFallback({ ...event, contactAttributes: sessionAttrs });
      const fallbackContent = fallbackResult.response || fallbackResult.botResponse || '';
      try { await appendTurn(sessionAttrs, event, fallbackContent); } catch (e) { /* non-fatal */ }
      return wrapLexResponse(fallbackResult, sessionAttrs, 'FallbackIntent');
    }
    const kbContent = kbResult.response || kbResult.botResponse;
    try { await appendTurn(sessionAttrs, event, kbContent); } catch (e) { /* non-fatal */ }
    return {
      sessionState: {
        sessionAttributes: {
          ...sessionAttrs,
          ...(kbResult.attributesToSet || {}),
          conversationState: 'AWAITING_RESOLUTION'
        },
        dialogAction: { type: 'ElicitIntent' },
        intent: {
          name             : 'FallbackIntent',
          slots            : {},
          state            : 'Fulfilled',
          confirmationState: 'None'
        }
      },
      messages: [{ contentType: 'PlainText', content: kbContent }]
    };
  }

  if (!message) {
    const fallbackResult = await handleFallback({ ...event, contactAttributes: sessionAttrs });
    const fallbackContent = fallbackResult.response || fallbackResult.botResponse || '';
    try { await appendTurn(sessionAttrs, event, fallbackContent); } catch (e) { /* non-fatal */ }
    return wrapLexResponse(fallbackResult, sessionAttrs, 'FallbackIntent');
  }
  const defaultKbResult = await handleKnowledgeQuery(message, sessionAttrs);
  if (!defaultKbResult?.response && !defaultKbResult?.botResponse) {
    const fallbackResult = await handleFallback({ ...event, contactAttributes: sessionAttrs });
    const fallbackContent = fallbackResult.response || fallbackResult.botResponse || '';
    try { await appendTurn(sessionAttrs, event, fallbackContent); } catch (e) { /* non-fatal */ }
    return wrapLexResponse(fallbackResult, sessionAttrs, 'FallbackIntent');
  }
  const defaultContent = defaultKbResult.response || defaultKbResult.botResponse;
  try { await appendTurn(sessionAttrs, event, defaultContent); } catch (e) { /* non-fatal */ }
  return {
    sessionState: {
      sessionAttributes: {
        ...sessionAttrs,
        ...(defaultKbResult.attributesToSet || {}),
        conversationState: 'AWAITING_RESOLUTION'
      },
      dialogAction: { type: 'ElicitIntent' },
      intent: {
        name             : intent,
        slots            : {},
        state            : 'Fulfilled',
        confirmationState: 'None'
      }
    },
    messages: [{ contentType: 'PlainText', content: defaultContent }]
  };
};

module.exports = { handleChat };