// utils/bedrock.js
'use strict';

const {
  BedrockAgentRuntimeClient,
  RetrieveAndGenerateCommand,
  RetrieveCommand
} = require('@aws-sdk/client-bedrock-agent-runtime');

const client = new BedrockAgentRuntimeClient({ region: process.env.AWS_REGION || 'us-east-1' });
const KB_ID  = process.env.BEDROCK_KB_ID;
const MODEL  = 'anthropic.claude-3-haiku-20240307-v1:0';

// ── Bedrock timeout — must stay under Connect's 8s Lambda limit ───────────────
const BEDROCK_TIMEOUT_MS = 6000;

// ── Timeout race wrapper ───────────────────────────────────────────────────────
const withTimeout = (promise, ms) =>
  Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('BEDROCK_TIMEOUT')), ms)
    )
  ]);

// ── Build language-aware system prompt ────────────────────────────────────────
const buildPrompt = (languageName = 'English') => {
  const isEnglish = languageName === 'English';

  return isEnglish
    // ── English prompt — concise, no language instruction needed ─────────────
    ? `You are an IT support assistant for Skechers employees.
Use the retrieved knowledge base articles to answer the question clearly and concisely.
If the knowledge base does not contain a relevant answer, say exactly:
"I wasn't able to find a specific answer for that."
Do not make up information. Keep responses focused and practical.
$search_results$`

    // ── Non-English prompt — enforce language response ────────────────────────
    : `You are an IT support assistant for Skechers employees.
CRITICAL INSTRUCTION: You MUST respond ONLY in ${languageName}. 
The user is communicating in ${languageName}. Your entire response must be in ${languageName}.
Do NOT respond in English under any circumstances.
Use the retrieved knowledge base articles to answer the question clearly and concisely.
If the knowledge base does not contain a relevant answer, say exactly in ${languageName}:
"No encontré una respuesta específica para eso." (if Spanish)
"Não encontrei uma resposta específica para isso." (if Portuguese)
"Je n'ai pas trouvé de réponse spécifique pour cela." (if French)
"Ich konnte keine spezifische Antwort dafür finden." (if German)
Do not make up information. Keep responses focused and practical.
$search_results$`;
};

const queryKnowledgeBase = async (question, filter = null, languageName = 'English') => {
  if (!question || !question.trim()) {
    console.warn('[bedrock] empty question — skipping KB query');
    return { found: false, answer: null };
  }

  console.log(`[bedrock] queryKnowledgeBase: "${question}"`);
  console.log(`[bedrock] KB_ID: "${KB_ID}" MODEL: "${MODEL}" REGION: "${process.env.AWS_REGION}" LANG: "${languageName}"`);

  const prompt = buildPrompt(languageName);

  const input = {
    input: { text: question },
    retrieveAndGenerateConfiguration: {
      type: 'KNOWLEDGE_BASE',
      knowledgeBaseConfiguration: {
        knowledgeBaseId: KB_ID,
        modelArn:        MODEL,
        // ── Language-aware generation config ──────────────────────────────────
        generationConfiguration: {
          promptTemplate: {
            textPromptTemplate: prompt
          }
        },
        // ── Retrieval filter (if provided) ────────────────────────────────────
        ...(filter ? {
          retrievalConfiguration: {
            vectorSearchConfiguration: { filter }
          }
        } : {})
      }
    }
  };

  console.log('[bedrock] input:', JSON.stringify(input));

  try {
    // ── Race Bedrock against timeout to avoid Connect retry cascade ───────────
    const response = await withTimeout(
      client.send(new RetrieveAndGenerateCommand(input)),
      BEDROCK_TIMEOUT_MS
    );

    const answer    = response.output?.text?.trim();
    const citations = response.citations || [];

    console.log(`[bedrock] raw answer: "${answer}"`);
    console.log(`[bedrock] citations count: ${citations.length}`);

    if (citations.length > 0) {
      const firstRef = citations[0]?.retrievedReferences?.[0];
      console.log('[bedrock] first ref content:', JSON.stringify(firstRef?.content?.text || '').substring(0, 200));
    }

    // ── No useful answer detection ─────────────────────────────────────────────
    const noAnswerPhrases = [
      'unable to assist',
      'sorry, i am unable',
      'i cannot assist',
      "i wasn't able to find a specific answer",
      'no encontré una respuesta',         // ES fallback
      'não encontrei uma resposta',        // PT fallback
      "je n'ai pas trouvé de réponse",     // FR fallback
      'ich konnte keine spezifische'       // DE fallback
    ];

    const lowerAnswer = (answer || '').toLowerCase();
    const isNoAnswer  = !answer || noAnswerPhrases.some(p => lowerAnswer.includes(p));

    if (isNoAnswer) {
      console.warn('[bedrock] KB returned no useful answer — raw:', answer);
      return { found: false, answer: null };
    }

    return { found: true, answer };

  } catch (err) {
    // ── Timeout — return graceful fallback, do NOT throw ──────────────────────
    if (err.message === 'BEDROCK_TIMEOUT') {
      console.warn(`[bedrock] timeout after ${BEDROCK_TIMEOUT_MS}ms — returning graceful fallback`);
      return {
        found:   true,
        answer:  "I'm looking that up but it's taking a moment. Please try again in a few seconds, or I can connect you with the IT Service Desk.",
        timeout: true
      };
    }

    console.error('[bedrock] ERROR name:',    err.name);
    console.error('[bedrock] ERROR message:', err.message);
    console.error('[bedrock] ERROR status:',  err.$metadata?.httpStatusCode);
    return { found: false, answer: null };
  }
};

const retrieveDocs = async (question, filter = null, n = 5) => {
  if (!question || !question.trim()) return [];

  const input = {
    knowledgeBaseId: KB_ID,
    retrievalQuery:  { text: question },
    retrievalConfiguration: {
      vectorSearchConfiguration: {
        numberOfResults: n,
        ...(filter ? { filter } : {})
      }
    }
  };

  try {
    const response = await withTimeout(
      client.send(new RetrieveCommand(input)),
      BEDROCK_TIMEOUT_MS
    );
    return response.retrievalResults || [];
  } catch (err) {
    if (err.message === 'BEDROCK_TIMEOUT') {
      console.warn('[bedrock] retrieveDocs timeout — returning empty');
      return [];
    }
    console.error('[bedrock] retrieveDocs error:', err.message);
    return [];
  }
};

module.exports = { queryKnowledgeBase, retrieveDocs };