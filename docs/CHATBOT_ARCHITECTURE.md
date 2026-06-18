# Skechers IT Chatbot - Architecture Documentation

## 1. Overview

The Skechers IT chatbot is an AI-powered IT support assistant for Skechers employees. It is embedded as a widget in the ServiceNow portal and provides self-service IT support capabilities including:

- **QnA** - Answers IT questions using a Bedrock Knowledge Base (KB articles)
- **Ticket Creation** - Creates ServiceNow incidents for break/fix issues
- **Ticket Status Lookup** - Retrieves status of existing incidents, requests, changes, etc.
- **Catalog Search** - Searches the ServiceNow service catalog for access/software requests
- **Okta Password Management** - Resets passwords, unlocks accounts, and resets accounts for retail store users
- **Live Agent Transfer** - Transfers conversations to human agents with regional queue routing

### Architecture Stack

```
User (Skechers Employee)
    |
ServiceNow Portal Widget
    |
Amazon Connect (Chat)
    |
Amazon Lex V2 Bot (NLU)
    |
AWS Lambda (Business Logic)
    |
+---+---+---+
|   |   |   |
Bedrock KB   ServiceNow API   Okta API
(Claude 3    (Incidents,       (Password Reset,
 Haiku)       Catalog,          Unlock,
              Interactions)     Account Reset)
```

---

## 2. Architecture Diagram

```
+------------------+       +------------------+       +------------------+
|                  |       |                  |       |                  |
|  ServiceNow     | ----> |  Amazon Connect  | ----> |  Lex V2 Bot     |
|  Chat Widget    |       |  (Chat Flow)     |       |  SkechersITSM_EN |
|                  |       |                  |       |                  |
+------------------+       +------------------+       +--------+---------+
                                                               |
                                                               v
                                                     +------------------+
                                                     |                  |
                                                     |  Lambda Function |
                                                     |  (DialogCodeHook)|
                                                     |                  |
                                                     +--------+---------+
                                                              |
                           +----------------------------------+----------------------------------+
                           |                                  |                                  |
                           v                                  v                                  v
                 +------------------+               +------------------+               +------------------+
                 |                  |               |                  |               |                  |
                 |  Amazon Bedrock  |               |  ServiceNow API  |               |  Okta API        |
                 |  Knowledge Base  |               |  - Incidents     |               |  - getUserById   |
                 |  (Claude 3      |               |  - Catalog       |               |  - resetPassword |
                 |   Haiku)        |               |  - Interactions  |               |  - unlockAccount |
                 |                  |               |                  |               |  - resetAccount  |
                 +------------------+               +------------------+               +------------------+
```

### Flow Summary

1. User types a message in the ServiceNow chat widget
2. Message is sent to Amazon Connect via chat channel
3. Connect passes the message to the Lex V2 bot for NLU classification
4. Lex invokes the Lambda function via DialogCodeHook for every turn
5. Lambda routes the message through a priority-based waterfall
6. Lambda calls external services (Bedrock, ServiceNow, Okta) as needed
7. Lambda returns a response to Lex, which passes it back through Connect to the user

---

## 3. AWS Resources

| Resource | Name / ID | Notes |
|----------|-----------|-------|
| Lambda (Production) | `serverlessrepo-amazon-con-InteractiveMessagingLamb-CHATLIVE` | 512MB memory |
| Lambda (Test) | `serverlessrepo-amazon-con-InteractiveMessagingLamb-lSSoD4wlH22w` | 1024MB memory |
| Lex Bot (Production) | `SkechersITSM_EN` (ID: `TY4JYUWM4S`) | Alias: `live` (ID: `08ODLCJXGH`) |
| Lex Bot (Test) | `SkechersITSM_TEST` (ID: `IWXPUYQOJC`) | Used for development |
| Bedrock Knowledge Base | `ZNTFYRLMJE` | Claude 3 Haiku model |
| Region | `us-east-1` | All resources |
| Secrets Manager | `skx_lex_servicenowkb` | ServiceNow credentials |
| Secrets Manager | `skx_lex_okta` | Okta API key |

---

## 4. Lex Bot Configuration

### Locales

| Locale | Language | Status |
|--------|----------|--------|
| `en_US` | English (US) | Primary - full intent set |
| `es_US` | Spanish (US) | Active - full intent set |
| `pt_BR` | Portuguese (Brazil) | Active - full intent set |

### Intents (per locale)

| Intent | Purpose |
|--------|---------|
| `OktaAccountManagement` | Password reset, account unlock, account reset |
| `TransferToAgent` | Transfer conversation to live agent |
| `LogIncident` | Create a new ServiceNow incident |
| `GetIncidentStatus` | Look up status of an existing ticket |
| `FallbackIntent` | Catches unmatched utterances (routes to KB, catalog, or ticket creation) |

### Configuration

- **NLU Confidence Threshold**: 0.4 (below this, FallbackIntent fires)
- **Dialog Code Hook**: All intents use DialogCodeHook - Lambda processes every turn
- **Fulfillment Code Hook**: Enabled on all intents for conversation closure

---

## 5. Lambda Code Structure

```
lambda/
+-- index.js                    -- Entry point, Lex V2 event normalization, dedup
+-- handlers/
|   +-- chatHandler.js          -- Main routing logic (priority-based waterfall)
|   +-- oktaHandler.js          -- Okta password/unlock/reset state machine
|   +-- catalogHandler.js       -- Service catalog search with BREAKFIX guards
|   +-- knowledgeHandler.js     -- Bedrock KB queries with conversation history
|   +-- incidentHandler.js      -- ServiceNow incident CRUD
|   +-- fallbackHandler.js      -- Generic fallback menu
+-- utils/
|   +-- bedrock.js              -- Bedrock RetrieveAndGenerate with 6s timeout
|   +-- servicenow.js           -- ServiceNow REST API client
|   +-- catalogSearch.js        -- Catalog search with aliases and keyword matching
|   +-- oktaApiHandler.js       -- Okta API (getUserByEmployeeId, executeOktaAction)
|   +-- languageUtils.js        -- Language detection (es/pt/fr/de) + messages
|   +-- regionUtils.js          -- Country -> region -> queue mapping
|   +-- interactionLogger.js    -- ServiceNow interaction logging (create/append/close)
|   +-- response.js             -- Response helper utilities
+-- scripts/
    +-- deploy-all-improvements.sh
    +-- deploy-transfer-fix.sh
    +-- update-lex-utterances.sh
```

### Key Files

- **index.js**: Entry point invoked by Lex. Normalizes Lex V2 event format, implements a 10-second deduplication cache (for Connect rapid retries), extracts contact attributes and session state, then delegates to `chatHandler.handleChat()`.

- **chatHandler.js**: The brain of the bot. Implements priority-based routing through a waterfall of checks (see Section 6).

- **oktaHandler.js**: Manages the multi-turn Okta flow as a state machine (see Section 8).

- **knowledgeHandler.js**: Queries Bedrock KB with conversation history context for follow-up questions.

---

## 6. Message Routing Priority (chatHandler.js)

The `handleChat` function uses a priority-based waterfall to determine how to handle each message. The first match wins.

### Priority 0: SNOW Ticket Number Detection

If the message contains a ServiceNow ticket number pattern (INC, RITM, REQ, PRB, CHG, TASK, SCTASK, IMS, WO, WTASK followed by digits), immediately look up that ticket in ServiceNow and return its status.

### Priority 1: Okta Account Management

Triggered by either:
- Lex classifying the intent as `OktaAccountManagement`
- Keyword-based override (`shouldHandleOkta` function matching password/unlock/reset keywords)

Routing depends on user type:
- **Retail stores** (`store####@skechers.com`): Full Okta self-service flow
- **Corporate users**: KB lookup for password instructions, then offer transfer to agent

### Priority 1.5: AWAITING_OKTA_TRANSFER_CONFIRM State

Handles the yes/no confirmation when a corporate user is offered a transfer after the Okta KB response.

### Priority 2: Status Lookup (GetIncidentStatus Intent)

When Lex matches `GetIncidentStatus`, routes to the incident status handler.

### Priority 3: Access Request Guard

If the message matches access request patterns (e.g., "I need access to...", "request access..."), routes directly to catalog search.

### Priority 4: Transfer to Agent

Triggered by:
- Lex classifying `TransferToAgent` intent
- Keyword triggers ("talk to agent", "live agent", "human", etc.)

Sets `transferRequested = "true"` in session attributes and returns a transfer confirmation message.

### Priority 5: Social/Conversational Patterns

Handles greetings ("hello", "hi"), thanks ("thank you", "thanks"), and goodbye ("bye", "see you") with appropriate responses without invoking any backend service.

### Context States (Session-Based)

When the conversation is in a specific state (tracked via session attributes):

| State | Behavior |
|-------|----------|
| `AWAITING_CATALOG_TERM` | User's response is used as catalog search term |
| `AWAITING_CATALOG_FALLBACK` | User chose to refine catalog search |
| `AWAITING_RESOLUTION` | User confirmed resolution (close interaction) |
| `AWAITING_DESCRIPTION` | User providing incident description |

### Intent-Based Routing

If no priority rule matched, route by Lex intent:
- `CATALOG_INTENTS` -> catalog search
- `INCIDENT_INTENTS` -> incident creation
- `UPDATE_INTENTS` -> incident update

### FallbackIntent Handling

When Lex fires FallbackIntent (no intent matched above threshold):

1. If `isCatalogRequest` heuristic matches -> catalog search
2. If message contains `TICKET_KEYWORDS` -> ticket creation flow
3. Otherwise -> Bedrock Knowledge Base query

---

## 7. Safety Nets & Overrides

### Confidence-Based FallbackIntent Override

When Lex fires FallbackIntent, the Lambda checks `event.interpretations` for other intents with confidence > 0.6. If found, it overrides FallbackIntent with that higher-confidence intent. This catches cases where Lex's threshold is too conservative.

### Keyword-Based Okta Override

After the confidence override, if the intent is still FallbackIntent, the Lambda checks `shouldHandleOkta(msgLower, resolvedAttrs)`. This catches verbose messages about password issues that Lex's NLU misses (e.g., "my store password expired and I can't log in to anything").

### BREAKFIX_PATTERNS Guard (catalogHandler)

An array of patterns (troubleshooting language like "not working", "broken", "error", "won't load") that prevents break/fix messages from accidentally hitting the catalog search. These messages should go to KB or ticket creation instead.

### Null-Safe Catalog Return

If `catalogHandler` returns null (no catalog results found), the flow falls through to the Knowledge Base query rather than returning an empty response.

### Global Try/Catch Error Recovery

The entire `handleChat` function body is wrapped in a try/catch. If any unhandled error occurs, the bot returns a friendly message suggesting the user rephrase or type "agent" for help. The bot never crashes.

### Dedup Cache (10s TTL)

Amazon Connect sometimes sends duplicate messages during rapid retries. The Lambda maintains an in-memory cache with a 10-second TTL. If the same message arrives within 10 seconds, it returns the cached response.

---

## 8. Okta Flow (oktaHandler.js)

The Okta handler implements a state machine for multi-turn password management conversations.

### State Machine

```
+-------+     +---------------+     +-------------------+     +--------+
|  NEW  | --> | AWAITING_IDS  | --> | AWAITING_CONFIRM  | --> |  DONE  |
+-------+     +---------------+     +-------------------+     +--------+
                     |                       |
                     v                       v
          +----------------------+    +-----------+
          | AWAITING_NOT_FOUND   |    | CANCELLED |
          | _CHOICE              |    +-----------+
          +----------------------+
```

### States

| State | Description |
|-------|-------------|
| `NEW` | Initial state - detect action type, ask for employee IDs |
| `AWAITING_IDS` | Parse employee IDs from user input, look up in Okta |
| `AWAITING_CONFIRM` | User confirms yes/no to proceed with the action |
| `AWAITING_NOT_FOUND_CHOICE` | User not found - retry or create incident |

### User Type Guard

- **Retail stores** (`store####@skechers.com`): Full self-service Okta flow
- **Corporate users**: Returns a `corporateFallback` signal, which triggers a KB lookup for password instructions followed by an offer to transfer to an agent

### Supported Actions

| Action | Description |
|--------|-------------|
| `password_reset` | Resets the user's Okta password |
| `account_unlock` | Unlocks a locked Okta account |
| `account_reset` | Full account reset (unlock + password reset) |

### Audit Trail

After each successful Okta action, the handler creates a ServiceNow incident with:
- Short description of the action performed
- Work notes containing the employee IDs, action type, and result
- Assignment to the appropriate regional service desk group

---

## 9. Catalog Search (catalogHandler.js + catalogSearch.js)

### Guard Patterns

| Pattern Type | Purpose |
|-------------|---------|
| `BREAKFIX_PATTERNS` | Prevents troubleshooting messages from hitting catalog |
| `HOW_TO_PATTERNS` | How-to questions go to Knowledge Base instead |
| `ACCESS_REQUEST_PATTERNS` | Explicit access requests route to catalog |

### Search Logic

1. **CATALOG_ITEM_KEYWORDS** + **CATALOG_TRIGGER_WORDS** combination determines if a message is a catalog request
2. **SEARCH_TERM_ALIASES** maps common names to actual catalog terms (e.g., "Teams" -> "Microsoft Teams")
3. Searches ServiceNow `sc_cat_item` table
4. Uses 2-pass search: first by name match, then broad search if no results

### Retail vs Corporate Catalog

Different catalog IDs are used depending on whether the user is from a retail store or corporate, ensuring users see only relevant catalog items.

---

## 10. Knowledge Base (knowledgeHandler.js + bedrock.js)

### Bedrock Integration

- **Service**: Amazon Bedrock RetrieveAndGenerate
- **Knowledge Base ID**: `ZNTFYRLMJE`
- **Model**: Claude 3 Haiku
- **Timeout**: 6000ms (must stay under Connect's 8-second limit)

### Conversation Context

For follow-up questions, the handler prepends `lastKbQuestion` and `lastKbAnswer` from session attributes to the current query. This gives Bedrock context about the prior exchange for more relevant answers.

### Language-Aware Prompts

The system prompt instructs the model to respond in the user's detected language (stored in session).

### Audience/Platform Filtering

When available, audience and platform metadata are included in the query to filter KB results.

### No-Answer Detection

An array of `noAnswerPhrases` (e.g., "I don't have information", "I couldn't find") is checked against the Bedrock response. If detected, the bot offers to create a ticket or transfer to an agent instead of showing an unhelpful response.

---

## 11. Language Support

### Detection (languageUtils.js)

Language detection uses keyword scoring:
- **Strong markers**: 3 points (highly specific words like "necesito", "preciso")
- **Normal markers**: 1 point
- **Minimum score to classify**: 2 points

### Supported Languages

| Code | Language | Support Level |
|------|----------|--------------|
| `en` | English | Full (default) |
| `es` | Spanish | Full (all bot messages localized) |
| `pt` | Portuguese | Full (all bot messages localized) |
| `fr` | French | Detected only (limited responses) |
| `de` | German | Detected only (limited responses) |

### Session Persistence

Once detected, the language is stored in session attributes and persists across all subsequent turns. All bot messages use localized versions from `languageUtils.js`.

---

## 12. Regional Routing

### Country to Region Mapping

| Region | Countries |
|--------|-----------|
| North America | US, CA, MX |
| Europe | UK, DE, FR, IT, ES, NL, BE, AT, CH, IE, PL, CZ, SK |
| Latin America | BR, CL, CO, PE, AR, PA |
| Asia Pacific | CN, JP, KR, IN, AU, NZ, SG, MY, TH, PH, VN, ID |

### Connect Queues

| Region | Queue Name |
|--------|-----------|
| North America | NA Service Chat |
| Europe | EU Service Chat |
| Latin America | Latam Service Chat |

### ServiceNow Assignment Groups

| Region | Assignment Group |
|--------|-----------------|
| North America | NA SN SDESK |
| Europe | EU SN SDESK |
| Latin America | LATAM SN SDESK |
| Asia Pacific | APAC SN SDESK |

---

## 13. Connect Flow (SkechersITSM_Chat_Flow.json)

### Key Blocks

1. **ConnectParticipantWithLexBot** - Handles the main conversation loop between user and Lex bot
2. **Intent Conditions** - Routes based on the Lex intent returned:
   - `TransferToAgent` -> transfer flow
   - `FallbackIntent` -> check `transferRequested` session attribute
   - Other intents -> disconnect hook
3. **transferRequested Fallback** - When the intent does not match `TransferToAgent` directly, checks the `transferRequested` session attribute. This handles cases where Lambda sets the transfer flag but Lex still reports `FallbackIntent`.
4. **Transfer Region Check** - Reads the region from session attributes and sets the appropriate Connect queue
5. **TransferContactToQueue** - Transfers the chat to the selected regional queue
6. **Error Handling** - Returns "We're sorry, something went wrong" on unrecoverable errors

### Flow Logic

```
Start -> ConnectParticipantWithLexBot -> Check Intent
    |
    +-> TransferToAgent intent ---------> Get Region -> Set Queue -> Transfer
    |
    +-> FallbackIntent -----------------> Check transferRequested attr
    |                                         |
    |                                         +-> "true" -> Get Region -> Transfer
    |                                         +-> else -> Disconnect
    |
    +-> Other intents ------------------> Disconnect hook
    |
    +-> Error ---------------------------> "Something went wrong" -> Disconnect
```

---

## 14. ServiceNow Integration

### Interactions (interactionLogger.js)

Every conversation is tracked as a ServiceNow interaction:
- **Create**: New interaction record created when conversation starts
- **Append**: Each turn (user message + bot response) is appended as work notes
- **Close**: Interaction is closed when conversation ends

### Incidents (incidentHandler.js)

Incidents are created for:
- Break/fix issues reported by users
- Okta actions performed (audit trail)
- Issues that cannot be resolved by the bot

### Ticket Lookup

Supports lookup of multiple ServiceNow record types:

| Prefix | Record Type |
|--------|-------------|
| INC | Incident |
| RITM | Request Item |
| REQ | Request |
| PRB | Problem |
| CHG | Change Request |
| TASK | Task |
| SCTASK | Catalog Task |
| IMS | Interaction |
| WO | Work Order |
| WTASK | Work Order Task |

### Catalog Search (servicenow.js + catalogSearch.js)

Queries the `sc_cat_item` table with a 2-pass strategy:
1. **First pass**: Search by item name (exact/partial match)
2. **Second pass**: Broader search across description and keywords if first pass returns no results

---

## 15. Deployment Guide

### Lambda Deployment

1. Clone the repository:
   ```bash
   git clone <repo-url>
   cd chat
   git checkout fix/routing-password-to-okta
   ```

2. Download the deployment package:
   - File: `lambda-deploy-latest.zip` (from the branch root)

3. Upload via AWS Lambda console:
   - Navigate to the Lambda function in AWS Console
   - Upload the zip file to **both** functions:
     - `serverlessrepo-amazon-con-InteractiveMessagingLamb-CHATLIVE` (production)
     - `serverlessrepo-amazon-con-InteractiveMessagingLamb-lSSoD4wlH22w` (test)

4. Verify deployment:
   - Check `CodeSize` in function configuration
   - Expected size: ~3,077,455 bytes

### Lex Bot Updates

```bash
# Update existing intent (en_US)
aws lexv2-models update-intent \
  --bot-id TY4JYUWM4S \
  --bot-version DRAFT \
  --locale-id en_US \
  --intent-id <INTENT_ID> \
  --intent-name <IntentName> \
  --sample-utterances '<JSON>' \
  --region us-east-1

# Create new intent (for locales missing it)
aws lexv2-models create-intent \
  --bot-id TY4JYUWM4S \
  --bot-version DRAFT \
  --locale-id es_US \
  --intent-name OktaAccountManagement \
  --sample-utterances '<JSON>' \
  --region us-east-1

# Build locale after changes
aws lexv2-models build-bot-locale \
  --bot-id TY4JYUWM4S \
  --bot-version DRAFT \
  --locale-id en_US \
  --region us-east-1

# Create a new version
aws lexv2-models create-bot-version \
  --bot-id TY4JYUWM4S \
  --region us-east-1

# Update alias to point to new version
aws lexv2-models update-bot-alias \
  --bot-id TY4JYUWM4S \
  --bot-alias-id 08ODLCJXGH \
  --bot-version <NEW_VERSION> \
  --region us-east-1
```

### Connect Flow

1. Download `SkechersITSM_Chat_Flow.json` from the repository
2. In Amazon Connect console, go to **Contact flows**
3. Click **Create contact flow** > **Import** (or update existing)
4. Upload the JSON file
5. Click **Publish**

---

## 16. Key Configuration Values

| Parameter | Value | Location |
|-----------|-------|----------|
| Bedrock timeout | 6000ms | `utils/bedrock.js` |
| Dedup TTL | 10000ms (10s) | `index.js` |
| Lambda memory (prod) | 512MB | AWS Lambda config |
| Lambda memory (test) | 1024MB | AWS Lambda config |
| NLU confidence override threshold | 0.6 | `handlers/chatHandler.js` |
| NLU base threshold (Lex) | 0.4 | Lex bot locale config |
| Language detection minimum score | 2 | `utils/languageUtils.js` |
| FallbackIntent transfer check | `transferRequested = "true"` | Connect flow + `chatHandler.js` |

---

## 17. Common Issues & Troubleshooting

### "Support chat session has ended" after transfer

**Cause**: Connect flow does not properly detect the transfer request, or no agents are available in the queue.

**Fix**:
1. Verify the Connect flow has the `transferRequested` fallback check (FallbackIntent branch checks session attribute)
2. Verify agents are logged in and available in the target queue
3. Check that the Lambda is setting `transferRequested = "true"` in session attributes

### Message routed to wrong handler

**Cause**: Priority order conflict or missing guard pattern.

**Fix**:
1. Check the priority order in `chatHandler.js` - higher priority rules fire first
2. Review `BREAKFIX_PATTERNS` in `catalogHandler.js` - troubleshooting messages should not hit catalog
3. Check if the intent confidence override (>0.6) is incorrectly overriding FallbackIntent

### Language detection false positive

**Cause**: Overlapping words between languages in `LANG_MARKERS`.

**Fix**:
1. Check `utils/languageUtils.js` for the `LANG_MARKERS` object
2. Look for words that exist in multiple languages
3. Increase the strong marker weight or remove ambiguous words

### Bedrock timeout

**Cause**: KB query takes longer than 6 seconds.

**Fix**:
- The bot automatically returns a graceful fallback message offering to create a ticket or transfer
- If happening frequently, check Bedrock KB indexing status and model availability
- Consider reducing the query complexity or conversation history length

### CodeSize unchanged after deploy

**Cause**: Wrong zip file uploaded.

**Fix**:
- Must use `lambda-deploy-latest.zip` from the branch (not `lambda-deploy.zip` or other artifacts)
- Verify the zip was built from the latest code
- Expected CodeSize: ~3,077,455 bytes

### Okta flow not triggering for password messages

**Cause**: Lex NLU did not match `OktaAccountManagement` and keyword override did not fire.

**Fix**:
1. Check that `shouldHandleOkta` in `oktaHandler.js` includes the relevant keywords
2. Verify the keyword-based Okta override block exists in `chatHandler.js` (after confidence override)
3. Add new utterances to the Lex `OktaAccountManagement` intent

---

## 18. Future Enhancements

- **Additional Languages**: Add full French and German response support (currently detected but with limited localized responses)
- **Conversation Summarization**: Implement AI-powered conversation summarization on close for ServiceNow interaction records
- **Proactive Notifications**: Add proactive ticket update notifications when incidents are resolved or updated
- **Fuzzy Catalog Search**: Enhance catalog search with fuzzy matching and Levenshtein distance for typo tolerance
- **User Satisfaction Survey**: Add an end-of-conversation satisfaction survey (1-5 rating) that feeds back into ServiceNow
