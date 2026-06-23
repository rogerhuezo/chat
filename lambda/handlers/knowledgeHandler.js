// handlers/knowledgeHandler.js
'use strict';

const { queryKnowledgeBase } = require('../utils/bedrock');
const { ok, error }          = require('../utils/response');
const { getMsg }             = require('../utils/languageUtils');

const VALID_AUDIENCES = ['corporate', 'dc', 'retail', 'all'];
const VALID_PLATFORMS = ['windows', 'mac', 'mobile', 'any'];

// ── Language name map for Bedrock prompt ──────────────────────────────────────
const LANGUAGE_NAMES = {
  en: 'English',
  es: 'Spanish',
  pt: 'Portuguese',
  fr: 'French',
  de: 'German'
};

const buildFilter = (attrs = {}) => {
  const rawAudience = attrs.userAudience || '';
  const rawPlatform = attrs.userPlatform || '';

  const audience = rawAudience === 'IT' ? 'corporate' : rawAudience.toLowerCase();
  const platform = rawPlatform.toLowerCase();

  const hasAudience = VALID_AUDIENCES.includes(audience);
  const hasPlatform = VALID_PLATFORMS.includes(platform);

  if (!hasAudience && !hasPlatform) {
    console.log('[knowledgeHandler] no valid audience/platform — skipping filter');
    return null;
  }

  const conditions = [];

  if (hasAudience) {
    conditions.push({ orAll: [
      { equals: { key: 'ai_tags.audience', value: audience } },
      { equals: { key: 'ai_tags.audience', value: 'all'    } }
    ]});
  }

  if (hasPlatform) {
    conditions.push({ orAll: [
      { equals: { key: 'ai_tags.platform', value: platform } },
      { equals: { key: 'ai_tags.platform', value: 'any'   } }
    ]});
  }

  return conditions.length === 1 ? conditions[0] : { andAll: conditions };
};

const handleKnowledgeQuery = async (question, attrs = {}) => {
  if (!question || !question.trim()) {
    return error("I didn't receive a question. Could you please describe your issue?");
  }

  const lang         = (attrs.Language || attrs.language || 'en').toLowerCase().substring(0, 2);
  const languageName = LANGUAGE_NAMES[lang] || 'English';

  console.log(`[knowledgeHandler] question: "${question}"`);
  console.log(`[knowledgeHandler] lang: "${lang}" (${languageName})`);
  console.log(`[knowledgeHandler] attrs: ${JSON.stringify(attrs)}`);

  // ── Prepend conversation history for follow-up questions ───────────────────
  let enhancedQuestion = question;
  if (attrs.lastKbQuestion) {
    const prevAnswer = attrs.lastKbAnswer || '';
    enhancedQuestion = `Previous Q: "${attrs.lastKbQuestion}"\nPrevious A: "${prevAnswer}"\nCurrent Q: "${question}"`;
    console.log(`[knowledgeHandler] enhanced question with conversation context`);
  }

  try {
    const filter = buildFilter(attrs);
    console.log(`[knowledgeHandler] filter: ${JSON.stringify(filter)}`);

    const { found, answer } = await queryKnowledgeBase(enhancedQuestion, filter, languageName);

    if (found && answer) {
      return {
        ...ok(answer),
        attributesToSet: {
          lastKbQuestion:    question,
          lastKbAnswer:      answer.substring(0, 500),
          conversationState: 'AWAITING_RESOLUTION'
        }
      };
    }

    // ── No KB answer — localized fallback ────────────────────────────────────
    return ok(getMsg(lang, {
      en: 'I wasn\'t able to find a specific answer in our knowledge base. Would you like me to create a support ticket for you?',
      es: 'No pude encontrar una respuesta específica en nuestra base de conocimiento. ¿Te gustaría que creara un ticket de soporte?',
      pt: 'Não consegui encontrar uma resposta específica em nossa base de conhecimento. Você gostaria que eu criasse um ticket de suporte?',
      fr: 'Je n\'ai pas trouvé de réponse spécifique dans notre base de connaissances. Voulez-vous que je crée un ticket de support?',
      de: 'Ich konnte keine spezifische Antwort in unserer Wissensdatenbank finden. Möchten Sie, dass ich ein Support-Ticket erstelle?'
    }));

  } catch (err) {
    console.error('[knowledgeHandler] error:', err.message);
    return error(getMsg(lang, {
      en: 'I had trouble searching the knowledge base. Would you like me to create a support ticket instead?',
      es: 'Tuve problemas al buscar en la base de conocimiento. ¿Te gustaría que creara un ticket de soporte?',
      pt: 'Tive problemas ao pesquisar na base de conhecimento. Você gostaria que eu criasse um ticket de suporte?',
      fr: 'J\'ai eu du mal à rechercher dans la base de connaissances. Voulez-vous que je crée un ticket de support?',
      de: 'Ich hatte Probleme bei der Suche in der Wissensdatenbank. Möchten Sie stattdessen ein Support-Ticket erstellen?'
    }));
  }
};

module.exports = { handleKnowledgeQuery, buildFilter };
