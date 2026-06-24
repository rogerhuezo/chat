// utils/languageUtils.js
'use strict';

const LANG_MARKERS = {
  es: {
    strong: ['hola', 'necesito', 'estoy', 'también', 'cómo', 'qué', 'gracias', 'adiós', 'adios'],
    normal: [
      'ayuda', 'tengo', 'problema', 'puedo', 'crear', 'estado', 'actualizar',
      'por favor', 'computadora', 'contraseña', 'usuario', 'pantalla', 'equipo',
      'no puedo', 'no funciona', 'acceso', 'red', 'buenos dias', 'buenas tardes',
      'buenas noches', 'soporte', 'acceder', 'sistema'
    ]
  },
  pt: {
    strong: ['não', 'você', 'está', 'obrigado', 'obrigada', 'preciso', 'posso', 'tchau'],
    normal: [
      'ajuda', 'tenho', 'problema', 'criar', 'atualizar', 'por favor',
      'computador', 'senha', 'usuário', 'tela', 'equipe', 'rede',
      'não consigo', 'não funciona', 'acesso', 'bom dia', 'boa tarde',
      'boa noite', 'ola', 'olá'
    ]
  },
  fr: {
    strong: ['bonjour', 'merci', 'je ne peux pas', 's\'il vous plaît', 'au revoir'],
    normal: [
      'aide', 'problème', 'créer', 'mettre à jour', 'mot de passe',
      'accès', 'réseau', 'ordinateur', 'ticket'
      // ← removed 'support' — too ambiguous in English context
    ]
  },
  de: {
    strong: ['hallo', 'danke', 'bitte', 'ich kann nicht', 'auf wiedersehen'],
    normal: [
      'hilfe', 'problem', 'erstellen', 'aktualisieren', 'passwort',
      'zugang', 'netzwerk', 'computer', 'ticket'
      // ← removed 'support' — too ambiguous in English context
    ]
  }
};

const ENGLISH_ONLY_INTENTS = [
    'GetIncidentStatus', 'LogIncident',
    'CreateIncident', 'UpdateIncident'
  ];

/**
 * Detect language from input text
 * Returns language code or null (default to 'en')
 * Minimum score of 2 required to avoid false positives on short inputs
 */
const detectLanguage = (inputText, intentName = '') => {
  // Skip detection for explicit English intents
  if (ENGLISH_ONLY_INTENTS.includes(intentName)) {
    console.log(`[languageUtils] skipping detection — explicit intent: "${intentName}"`);
    return null;
  }

  if (!inputText) return null;

  // Skip detection for very short inputs (< 4 words) — too ambiguous
  const wordCount = inputText.trim().split(/\s+/).length;
  if (wordCount < 4) {
    console.log(`[languageUtils] skipping detection — too short (${wordCount} words)`);
    return null;
  }

  const lower  = inputText.toLowerCase();
  const scores = {};

  for (const [lang, markers] of Object.entries(LANG_MARKERS)) {
    scores[lang] = 0;
    markers.strong.forEach(w => { if (lower.includes(w)) scores[lang] += 3; });
    markers.normal.forEach(w => { if (lower.includes(w)) scores[lang] += 1; });
  }

  console.log(`[languageUtils] scores: ${JSON.stringify(scores)} | input: "${inputText.substring(0, 60)}"`);

  // ← Minimum score of 2 to avoid false positives
  const best = Object.entries(scores)
    .filter(([, score]) => score >= 2)
    .sort(([, a], [, b]) => b - a)[0];

  return best ? best[0] : null;
};

/**
 * Resolve language from session attrs + current input
 * Session language always wins; auto-detects only if not set
 */
const resolveLanguage = (attrs, inputText, intentName = '') => {
  const sessionLang = (attrs.Language || attrs.language || '').toLowerCase().substring(0, 2);
  if (sessionLang && sessionLang !== '') return sessionLang;
  return detectLanguage(inputText, intentName) || 'en';
};

/**
 * Get localized message
 */
const getMsg = (lang, messages) => {
  const code = (lang || 'en').toLowerCase().substring(0, 2);
  return messages[code] || messages['en'];
};

// ── Standard bot messages ──────────────────────────────────────────────────────
const MESSAGES = {
  welcome: {
    en: 'Hello! How can I help you today?',
    es: '¡Hola! ¿Cómo puedo ayudarte hoy?',
    pt: 'Olá! Como posso ajudá-lo hoje?',
    fr: 'Bonjour! Comment puis-je vous aider aujourd\'hui?',
    de: 'Hallo! Wie kann ich Ihnen heute helfen?'
  },
  anythingElse: {
    en: 'Is there anything else I can help you with?',
    es: '¿Hay algo más en lo que pueda ayudarte?',
    pt: 'Há mais alguma coisa em que posso ajudá-lo?',
    fr: 'Y a-t-il autre chose que je puisse faire pour vous?',
    de: 'Gibt es noch etwas, womit ich Ihnen helfen kann?'
  },
  goodbye: {
    en: 'Have a great day. Goodbye! 👋',
    es: '¡Que tengas un excelente día. Adiós! 👋',
    pt: 'Tenha um ótimo dia. Tchau! 👋',
    fr: 'Bonne journée. Au revoir! 👋',
    de: 'Einen schönen Tag noch. Auf Wiedersehen! 👋'
  },
  youreWelcome: {
    en: 'You\'re welcome!',
    es: '¡De nada!',
    pt: 'De nada!',
    fr: 'De rien!',
    de: 'Gern geschehen!'
  },
  transferring: {
    en: (name, region) => `🤝 Connecting you with a live IT agent${name ? ', ' + name : ''}...\n\nPlease hold while we transfer you to the ${region} support team.`,
    es: (name, region) => `🤝 Conectándote con un agente de TI${name ? ', ' + name : ''}...\n\nPor favor espera mientras te transferimos al equipo de soporte de ${region}.`,
    pt: (name, region) => `🤝 Conectando você com um agente de TI${name ? ', ' + name : ''}...\n\nPor favor aguarde enquanto transferimos você para a equipe de suporte de ${region}.`,
    fr: (name, region) => `🤝 Je vous connecte avec un agent IT${name ? ', ' + name : ''}...\n\nVeuillez patienter pendant que nous vous transférons à l'équipe de support ${region}.`,
    de: (name, region) => `🤝 Ich verbinde Sie mit einem IT-Agenten${name ? ', ' + name : ''}...\n\nBitte warten Sie, während wir Sie an das ${region} Support-Team weiterleiten.`
  },
  ticketCreated: {
    en: (name, number) => `Thank you${name ? ' ' + name : ''}! Your support ticket **${number}** has been created. An IT analyst will follow up with you shortly.`,
    es: (name, number) => `¡Gracias${name ? ' ' + name : ''}! Tu ticket de soporte **${number}** ha sido creado. Un analista de TI te dará seguimiento en breve.`,
    pt: (name, number) => `Obrigado${name ? ' ' + name : ''}! Seu ticket de suporte **${number}** foi criado. Um analista de TI fará o acompanhamento em breve.`,
    fr: (name, number) => `Merci${name ? ' ' + name : ''}! Votre ticket de support **${number}** a été créé. Un analyste IT vous contactera bientôt.`,
    de: (name, number) => `Danke${name ? ' ' + name : ''}! Ihr Support-Ticket **${number}** wurde erstellt. Ein IT-Analyst wird sich in Kürze bei Ihnen melden.`
  },
  describeIssue: {
    en: 'Please describe your issue so I can create a ticket.',
    es: 'Por favor describe tu problema para que pueda crear un ticket.',
    pt: 'Por favor descreva seu problema para que eu possa criar um ticket.',
    fr: 'Veuillez décrire votre problème afin que je puisse créer un ticket.',
    de: 'Bitte beschreiben Sie Ihr Problem, damit ich ein Ticket erstellen kann.'
  },
  sorryError: {
    en: 'I\'m sorry, something went wrong. Please try again or type "agent" to speak with someone.',
    es: 'Lo siento, algo salió mal. Por favor intenta de nuevo o escribe "agente".',
    pt: 'Desculpe, algo deu errado. Por favor tente novamente ou digite "agente".',
    fr: 'Désolé, quelque chose s\'est mal passé. Veuillez réessayer ou tapez "agent".',
    de: 'Es tut mir leid, etwas ist schiefgelaufen. Bitte versuchen Sie es erneut oder geben Sie "Agent" ein.'
  },
  incidentCreatedOfferTransfer: {
    en: (name, number) => `I've created incident **${number}** for your issue${name ? ', ' + name : ''}. Would you like me to connect you with a live agent for further assistance?\n\nReply **yes** or **no**.`,
    es: (name, number) => `He creado el incidente **${number}** para tu problema${name ? ', ' + name : ''}. ¿Te gustaría que te conectara con un agente en vivo para más asistencia?\n\nResponde **sí** o **no**.`,
    pt: (name, number) => `Criei o incidente **${number}** para o seu problema${name ? ', ' + name : ''}. Gostaria que eu conectasse você com um agente ao vivo para mais assistência?\n\nResponda **sim** ou **não**.`,
    fr: (name, number) => `J'ai créé l'incident **${number}** pour votre problème${name ? ', ' + name : ''}. Souhaitez-vous que je vous connecte avec un agent en direct pour une assistance supplémentaire?\n\nRépondez **oui** ou **non**.`,
    de: (name, number) => `Ich habe Incident **${number}** für Ihr Problem erstellt${name ? ', ' + name : ''}. Möchten Sie, dass ich Sie mit einem Live-Agenten für weitere Unterstützung verbinde?\n\nAntworten Sie mit **ja** oder **nein**.`
  }
};

module.exports = { detectLanguage, resolveLanguage, getMsg, MESSAGES };
