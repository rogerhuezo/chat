#!/bin/bash
# ============================================================================
# update-lex-utterances.sh
#
# Updates the OktaAccountManagement intent on the Lex V2 bot with additional
# sample utterances to improve intent classification for password/login issues.
#
# This script:
#   1. Calls aws lexv2-models update-intent with ALL utterances (existing + new)
#   2. Rebuilds the bot locale so changes take effect
#
# Prerequisites:
#   - AWS CLI v2 configured with appropriate permissions
#   - chmod +x scripts/update-lex-utterances.sh
#
# Usage:
#   ./scripts/update-lex-utterances.sh
# ============================================================================

set -euo pipefail

BOT_ID="IWXPUYQOJC"
BOT_VERSION="DRAFT"
LOCALE_ID="en_US"
INTENT_ID="121L0EK7IL"
INTENT_NAME="OktaAccountManagement"
DESCRIPTION="Handles Okta account management for Retail Store Managers — password reset, account unlock, account reset"

# All sample utterances: existing + new
read -r -d '' UTTERANCES_JSON << 'EOF' || true
[
  {"utterance": "reset okta password"},
  {"utterance": "unlock okta account"},
  {"utterance": "okta account reset"},
  {"utterance": "reset password for employee"},
  {"utterance": "unlock account for employee"},
  {"utterance": "i need to reset an employee password"},
  {"utterance": "i need to unlock an employee account"},
  {"utterance": "reset mfa for employee"},
  {"utterance": "account is locked"},
  {"utterance": "employee is locked out"},
  {"utterance": "employee account is locked"},
  {"utterance": "employee locked out of okta"},
  {"utterance": "need to reset employee okta password"},
  {"utterance": "okta password reset for store employee"},
  {"utterance": "unlock employee okta account"},
  {"utterance": "reset okta account for employee"},
  {"utterance": "employee cannot login to okta"},
  {"utterance": "employee forgot okta password"},
  {"utterance": "employee okta account locked"},
  {"utterance": "reset factors for employee"},
  {"utterance": "clear mfa for employee"},
  {"utterance": "employee needs new okta password"},
  {"utterance": "resetear contrasena okta"},
  {"utterance": "desbloquear cuenta okta"},
  {"utterance": "restablecer cuenta okta"},
  {"utterance": "empleado bloqueado en okta"},
  {"utterance": "cuenta bloqueada okta"},
  {"utterance": "resetear contrasena de empleado"},
  {"utterance": "empleado no puede entrar a okta"},
  {"utterance": "desbloquear empleado okta"},
  {"utterance": "password is not working for an employee"},
  {"utterance": "employee password is not working"},
  {"utterance": "password isn't working"},
  {"utterance": "employee password isn't working"},
  {"utterance": "we have a password issue"},
  {"utterance": "having a problem with an employee password"},
  {"utterance": "employee can't log in"},
  {"utterance": "employee cannot log in"},
  {"utterance": "employee can't sign in"},
  {"utterance": "an employee is having login issues"},
  {"utterance": "employee having trouble logging in"},
  {"utterance": "we need help with a password issue"},
  {"utterance": "password problem for an employee"},
  {"utterance": "employee login not working"},
  {"utterance": "hi we need help an employee password isn't working"},
  {"utterance": "good morning an employee account password is not working"},
  {"utterance": "we requested a password reset but it still isn't working"},
  {"utterance": "employee still can't log in after password reset"},
  {"utterance": "the password we reset still doesn't work"},
  {"utterance": "la contraseña de un empleado no funciona"},
  {"utterance": "empleado no puede iniciar sesión"},
  {"utterance": "problema con la contraseña de un empleado"},
  {"utterance": "tenemos un problema de contraseña"},
  {"utterance": "el empleado no puede entrar"},
  {"utterance": "la contraseña no está funcionando"}
]
EOF

# Initial response setting (invoke dialog code hook)
read -r -d '' INITIAL_RESPONSE_JSON << 'EOF' || true
{
  "codeHook": {
    "isActive": true,
    "enableCodeHookInvocation": true,
    "postCodeHookSpecification": {
      "failureNextStep": {
        "dialogAction": {"type": "EndConversation"}
      },
      "successNextStep": {
        "dialogAction": {"type": "FulfillIntent"}
      },
      "timeoutNextStep": {
        "dialogAction": {"type": "EndConversation"}
      }
    }
  },
  "nextStep": {
    "dialogAction": {"type": "InvokeDialogCodeHook"}
  }
}
EOF

# Fulfillment code hook settings
read -r -d '' FULFILLMENT_JSON << 'EOF' || true
{
  "postFulfillmentStatusSpecification": {
    "failureNextStep": {
      "dialogAction": {"type": "EndConversation"}
    },
    "successNextStep": {
      "dialogAction": {"type": "EndConversation"}
    },
    "timeoutNextStep": {
      "dialogAction": {"type": "EndConversation"}
    }
  },
  "enabled": true
}
EOF

echo "============================================"
echo "Updating OktaAccountManagement intent..."
echo "  Bot ID:     ${BOT_ID}"
echo "  Version:    ${BOT_VERSION}"
echo "  Locale:     ${LOCALE_ID}"
echo "  Intent ID:  ${INTENT_ID}"
echo "============================================"

# Update the intent with all utterances
aws lexv2-models update-intent \
  --bot-id "${BOT_ID}" \
  --bot-version "${BOT_VERSION}" \
  --locale-id "${LOCALE_ID}" \
  --intent-id "${INTENT_ID}" \
  --intent-name "${INTENT_NAME}" \
  --description "${DESCRIPTION}" \
  --sample-utterances "${UTTERANCES_JSON}" \
  --dialog-code-hook '{"enabled": true}' \
  --fulfillment-code-hook "${FULFILLMENT_JSON}" \
  --initial-response-setting "${INITIAL_RESPONSE_JSON}" \
  --output text > /dev/null

if [ $? -eq 0 ]; then
  echo "SUCCESS: Intent updated with $(echo "${UTTERANCES_JSON}" | grep -c '"utterance"') utterances."
else
  echo "FAILED: Could not update intent. Check AWS credentials and permissions."
  exit 1
fi

echo ""
echo "Building bot locale..."

# Rebuild the bot locale so changes take effect
aws lexv2-models build-bot-locale \
  --bot-id "${BOT_ID}" \
  --bot-version "${BOT_VERSION}" \
  --locale-id "${LOCALE_ID}"

if [ $? -eq 0 ]; then
  echo "SUCCESS: Bot locale build initiated."
  echo ""
  echo "NOTE: The build runs asynchronously. Use the following command to check status:"
  echo "  aws lexv2-models describe-bot-locale --bot-id ${BOT_ID} --bot-version ${BOT_VERSION} --locale-id ${LOCALE_ID} --query 'botLocaleStatus'"
else
  echo "FAILED: Could not initiate bot locale build."
  exit 1
fi

echo ""
echo "Done."
