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

module.exports = { ok, error, transfer, lexOpen, lexElicit, lexClose, lexDelegate };