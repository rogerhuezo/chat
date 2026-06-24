// index.js — updated dedup logic only, everything else unchanged
'use strict';

const { handleChat }                                                           = require('./handlers/chatHandler');
const { handleCreateIncident, handleGetIncidentStatus, handleUpdateIncident } = require('./handlers/incidentHandler');
const { handleFallback }                                                       = require('./handlers/fallbackHandler');

// ── Dedup cache — prevents double-processing on Connect/Lex rapid retries ─────
// Key: sessionId + normalized input transcript
// TTL: 10 seconds — only blocks true duplicate rapid-fire retries
const processedRequests = new Map();

const isDuplicate = (sessionId, inputTranscript) => {
  if (!sessionId || !inputTranscript) return false;

  const now = Date.now();
  const TTL = 10000; // 10 seconds — tight window, only catches rapid retries

  // Clean up expired entries
  for (const [key, ts] of processedRequests.entries()) {
    if (now - ts > TTL) processedRequests.delete(key);
  }

  // Key = sessionId + normalized message
  const dedupKey = `${sessionId}::${inputTranscript.trim().toLowerCase()}`;

  if (processedRequests.has(dedupKey)) {
    console.warn(`[index.js] duplicate invocation detected — skipping: ${dedupKey}`);
    return true;
  }

  processedRequests.set(dedupKey, now);
  return false;
};

exports.handler = async (event) => {
  console.log('[index.js] event:', JSON.stringify(event, null, 2));

  // ── Normalize Amazon Connect contact flow events ───────────────────────────
  if (event && event.Details && event.Details.Parameters) {
    const params      = event.Details.Parameters;
    const contactData = event.Details.ContactData || {};
    Object.assign(event, params);
    event.contactAttributes = contactData.Attributes || {};
    event.contactId         = contactData.ContactId;
    event.channel           = contactData.Channel;
  }

  // ── Lex V2 DialogCodeHook ──────────────────────────────────────────────────
  if (event && event.sessionState && event.invocationSource && !event.Details) {
    const intent    = event.sessionState.intent?.name || '';
    const source    = event.invocationSource;
    const input     = (event.inputTranscript || '').replace(/[\n\r]/g, ' ').trim();
    const attrs     = event.sessionState.sessionAttributes || {};
    const sessionId = event.sessionId || '';

    console.log('[index.js] Lex V2 source:', source, 'intent:', intent, 'input:', input);

    // ── Dedup check — blocks rapid retries of the exact same message ──────────
    if (isDuplicate(sessionId, input)) {
      console.warn('[index.js] duplicate request dropped — returning wait message');
      return {
        sessionState: {
          sessionAttributes: attrs,
          dialogAction: { type: 'ElicitIntent' },
          intent: {
            name:              'FallbackIntent',
            slots:             {},
            state:             'InProgress',
            confirmationState: 'None'
          }
        },
        messages: [{
          contentType: 'PlainText',
          content:     "I'm still working on your request. Please wait a moment and try again."
        }]
      };
    }

    // ── Empty input guard ─────────────────────────────────────────────────────
    if (!input && intent === 'FallbackIntent') {
      return {
        sessionState: {
          sessionAttributes: attrs,
          dialogAction: { type: 'ElicitIntent' },
          intent: {
            name:              'FallbackIntent',
            slots:             {},
            state:             'InProgress',
            confirmationState: 'None'
          }
        },
        messages: [{
          contentType: 'PlainText',
          content:     "I'm sorry, I didn't understand that. Could you describe your issue?"
        }]
      };
    }

    return handleChat({
      action:            'chat_message',
      userMessage:       input,
      inputTranscript:   input,
      intent:            intent,
      sessionId:         sessionId,
      sessionState:      event.sessionState,
      requestAttributes: event.requestAttributes || {},
      contactAttributes: {
        ...attrs,
        userAudience: attrs.userAudience || '',
        userPlatform: attrs.userPlatform || ''
      }
    });
  }

  // ── Pre-Lex contact attribute hydration ───────────────────────────────────
  if (event.action === 'pre_lex') {
    const attrs = event.contactAttributes || {};
    return {
      userAudience:  attrs['HostedWidget-department']    || '',
      userPlatform:  attrs['HostedWidget-source']        || '',
      langCode:      'en',
      customerEmail: attrs['HostedWidget-customerEmail'] || event.customerEmail || '',
      customerName:  attrs['HostedWidget-customerName']  || event.customerName  || ''
    };
  }

  // ── Intent fulfillment ────────────────────────────────────────────────────
  if (event.action === 'fulfill_intent') {
    const intent = event.intentName || event.intent || '';
    const attrs  = event.contactAttributes || {};
    const ticket = (event.ticketTitle || '').trim();

    if (intent === 'FallbackIntent' || (!ticket && intent !== 'GetIncidentStatus' && intent !== 'TransferToAgent')) {
      return handleFallback({ action: 'fallback', contactAttributes: attrs });
    }

    if (intent === 'CreateIncident') {
      return handleCreateIncident({
        ticketTitle: ticket,
        contactAttributes: {
          incidentTitle:       ticket,
          incidentDescription: ticket,
          Name:       event.customerName || attrs['HostedWidget-customerName'] || '',
          wdUsername: event.userID       || attrs['HostedWidget-userID']       || '',
          userId:     event.userID       || attrs['HostedWidget-userID']       || ''
        }
      });
    }

    if (intent === 'GetIncidentStatus') {
      return handleGetIncidentStatus({ contactAttributes: attrs });
    }

    if (intent === 'UpdateIncident') {
      return handleUpdateIncident({ ticketTitle: ticket, contactAttributes: attrs });
    }

    if (intent === 'TransferToAgent') {
      const { transfer } = require('./utils/response');
      return transfer("Let me connect you with an IT support agent right away. Please hold.");
    }

    return handleChat({
      action:            'chat_message',
      userMessage:       ticket,
      intent:            intent,
      contactAttributes: attrs
    });
  }

  // ── Direct chat_message action ────────────────────────────────────────────
  if (event.action === 'chat_message') {
    return handleChat(event);
  }

  // ── Direct create_incident action ─────────────────────────────────────────
  if (event.action === 'create_incident') {
    return handleCreateIncident(event);
  }

  // ── Unknown action fallback ───────────────────────────────────────────────
  console.warn('[index.js] unknown action:', event.action);
  return {
    response:          "I'm sorry, something went wrong. Please try again.",
    botResponse:       "I'm sorry, something went wrong. Please try again.",
    conversationState: 'ERROR',
    nextAction:        'none',
    attributesToSet:   {}
  };
};