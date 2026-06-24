// utils/response.js
'use strict';

const ok = (response, attrs = {}) => ({
  response,
  botResponse:       response,
  conversationState: 'IDLE',
  nextAction:        'none',
  attributesToSet:   attrs
});

const error = (msg = "I'm sorry, something went wrong. Please try again.") => ({
  response:          msg,
  botResponse:       msg,
  conversationState: 'IDLE',
  nextAction:        'none',
  attributesToSet:   {}
});

const transfer = (msg = "Let me transfer you to an agent.") => ({
  response:          msg,
  botResponse:       msg,
  conversationState: 'TRANSFER',
  nextAction:        'transfer',
  attributesToSet:   { conversationState: 'TRANSFER' }
});

// ── Lex V2 response builders ───────────────────────────────────────────────

// Keep chat open — ElicitIntent + FallbackIntent/InProgress
// Use this for any response that should NOT close the Connect chat
const lexOpen = (message, sessionAttributes = {}) => ({
  sessionState: {
    sessionAttributes: {
      ...sessionAttributes,
      conversationState: sessionAttributes.conversationState || 'IDLE'
    },
    dialogAction: { type: 'ElicitIntent' },
    intent: {
      name:              'FallbackIntent',  // never use a terminal intent name
      slots:             {},
      state:             'InProgress',      // InProgress keeps Connect alive
      confirmationState: 'None'
    }
  },
  messages: [{ contentType: 'PlainText', content: message }]
});

// Keep chat open with full event context (carries existing session attrs)
const lexElicit = (event, message, sessionAttributes = {}) => ({
  sessionState: {
    sessionAttributes: {
      ...event.sessionState.sessionAttributes,
      ...sessionAttributes
    },
    dialogAction: { type: 'ElicitIntent' },
    intent: event.sessionState.intent
  },
  messages: [{ contentType: 'PlainText', content: message }]
});

// Close the chat — use only for intentional goodbye/transfer
const lexClose = (event, message, sessionAttributes = {}) => ({
  sessionState: {
    sessionAttributes: {
      ...event.sessionState.sessionAttributes,
      ...sessionAttributes
    },
    dialogAction: { type: 'Close' },
    intent: { ...event.sessionState.intent, state: 'Fulfilled' }
  },
  messages: [{ contentType: 'PlainText', content: message }]
});

const lexDelegate = (event, sessionAttributes = {}) => ({
  sessionState: {
    sessionAttributes: {
      ...event.sessionState.sessionAttributes,
      ...sessionAttributes
    },
    dialogAction: { type: 'Delegate' },
    intent: event.sessionState.intent
  }
});

// ── Quick Reply builder for Amazon Connect Chat ────────────────────────────

/**
 * buildQuickReply - Returns a Lex V2 messages array using QuickReply CustomPayload
 * for Amazon Connect Chat, or PlainText fallback for other platforms (e.g. Lex console).
 *
 * @param {string} title - The question/prompt text shown to the user
 * @param {Array<string|{title:string, subtitle?:string}>} options - Quick reply button labels
 * @param {string} platform - The channel platform (e.g. 'Connect Chat')
 * @returns {Array<{contentType:string, content:string}>} messages array for Lex V2 response
 */
const buildQuickReply = (title, options, platform) => {
  if (platform === 'Connect Chat') {
    const elements = options.map(o => (typeof o === 'string' ? { title: o } : o));
    const payload = {
      templateType: 'QuickReply',
      version: '1.0',
      data: {
        content: {
          title,
          elements
        }
      }
    };
    return [{ contentType: 'CustomPayload', content: JSON.stringify(payload) }];
  }
  // Fallback for Lex test console and other non-Connect platforms
  return [{ contentType: 'PlainText', content: title }];
};

module.exports = { ok, error, transfer, lexOpen, lexElicit, lexClose, lexDelegate, buildQuickReply };
