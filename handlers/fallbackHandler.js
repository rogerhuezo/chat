// handlers/fallbackHandler.js
'use strict';

const { ok } = require('../utils/response');

const handleFallback = async (event) => {
  const attrs = event.contactAttributes || {};
  const name  = attrs['HostedWidget-customerName'] || attrs.Name || '';
  const first = name ? ' ' + name.split(' ')[0] : '';

  console.log('[fallbackHandler] FallbackIntent triggered');

  return ok(
    `I'm sorry${first}, I didn't quite understand that. Here's what I can help you with:\n\n` +
    `• **Create a ticket** — describe your IT issue\n` +
    `• **Check ticket status** — say "check my tickets"\n` +
    `• **Update a ticket** — say "update my ticket"\n` +
    `• **Talk to an agent** — say "transfer to agent"\n\n` +
    `What would you like to do?`
  );
};

module.exports = { handleFallback };
