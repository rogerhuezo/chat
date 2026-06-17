#!/bin/bash
# ============================================================================
# deploy-all-improvements.sh
#
# Comprehensive deployment script that:
#   1. Creates OktaAccountManagement intent in es_US locale
#   2. Updates LogIncident intent in en_US with enriched utterances
#   3. Updates GetIncidentStatus intent in en_US with enriched utterances
#   4. Rebuilds both en_US and es_US bot locales
#
# Prerequisites:
#   - AWS CLI v2 configured with appropriate permissions
#   - chmod +x scripts/deploy-all-improvements.sh
#
# Usage:
#   ./scripts/deploy-all-improvements.sh
# ============================================================================

set -euo pipefail

BOT_ID="IWXPUYQOJC"
BOT_VERSION="DRAFT"
REGION="us-east-1"

echo "============================================"
echo " Lex Bot Deployment - All Improvements"
echo " Bot ID: ${BOT_ID}"
echo " Region: ${REGION}"
echo "============================================"
echo ""

# ============================================================================
# SECTION 1: Create OktaAccountManagement intent in es_US
# ============================================================================

echo "--------------------------------------------"
echo " Section 1: Create OktaAccountManagement in es_US"
echo "--------------------------------------------"

ES_LOCALE_ID="es_US"
OKTA_INTENT_NAME="OktaAccountManagement"

# Spanish utterances for Okta account management
read -r -d '' ES_OKTA_UTTERANCES << 'EOF' || true
[
  {"utterance": "resetear contraseña okta"},
  {"utterance": "desbloquear cuenta okta"},
  {"utterance": "restablecer cuenta okta"},
  {"utterance": "empleado bloqueado en okta"},
  {"utterance": "cuenta bloqueada okta"},
  {"utterance": "resetear contraseña de empleado"},
  {"utterance": "empleado no puede entrar a okta"},
  {"utterance": "desbloquear empleado okta"},
  {"utterance": "la contraseña de un empleado no funciona"},
  {"utterance": "empleado no puede iniciar sesión"},
  {"utterance": "problema con la contraseña de un empleado"},
  {"utterance": "tenemos un problema de contraseña"},
  {"utterance": "el empleado no puede entrar"},
  {"utterance": "la contraseña no está funcionando"},
  {"utterance": "necesito resetear la contraseña de un empleado"},
  {"utterance": "un empleado está bloqueado"},
  {"utterance": "cuenta de empleado bloqueada"},
  {"utterance": "empleado no puede acceder"},
  {"utterance": "problema de contraseña de empleado"},
  {"utterance": "resetear contraseña de empleado en okta"}
]
EOF

# Fulfillment code hook for es_US (uses 'active' not 'isActive')
read -r -d '' ES_OKTA_FULFILLMENT << 'EOF' || true
{
  "active": true,
  "enabled": true,
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
  }
}
EOF

# Initial response setting for es_US (uses 'active' not 'isActive')
read -r -d '' ES_OKTA_INITIAL_RESPONSE << 'EOF' || true
{
  "codeHook": {
    "enableCodeHookInvocation": true,
    "active": true,
    "postCodeHookSpecification": {
      "successNextStep": {
        "dialogAction": {"type": "FulfillIntent"}
      },
      "failureNextStep": {
        "dialogAction": {"type": "EndConversation"}
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

echo "Creating OktaAccountManagement intent in es_US locale..."

aws lexv2-models create-intent \
  --region "${REGION}" \
  --bot-id "${BOT_ID}" \
  --bot-version "${BOT_VERSION}" \
  --locale-id "${ES_LOCALE_ID}" \
  --intent-name "${OKTA_INTENT_NAME}" \
  --sample-utterances "${ES_OKTA_UTTERANCES}" \
  --dialog-code-hook '{"enabled": true}' \
  --fulfillment-code-hook "${ES_OKTA_FULFILLMENT}" \
  --initial-response-setting "${ES_OKTA_INITIAL_RESPONSE}" \
  --cli-binary-format raw-in-base64-out \
  --output text > /dev/null

if [ $? -eq 0 ]; then
  echo "SUCCESS: OktaAccountManagement intent created in es_US with 20 Spanish utterances."
else
  echo "FAILED: Could not create OktaAccountManagement intent in es_US."
  exit 1
fi

echo ""

# ============================================================================
# SECTION 2: Update LogIncident in en_US
# ============================================================================

echo "--------------------------------------------"
echo " Section 2: Update LogIncident in en_US"
echo "--------------------------------------------"

EN_LOCALE_ID="en_US"
LOG_INCIDENT_INTENT_ID="QVGODQDBN0"
LOG_INCIDENT_INTENT_NAME="LogIncident"

# All utterances: 15 existing + 30 new = 45 total
read -r -d '' LOG_INCIDENT_UTTERANCES << 'EOF' || true
[
  {"utterance": "Open a ticket for {shortdescription}"},
  {"utterance": "Create a ticket for {shortdescription}"},
  {"utterance": "I am having trouble, please open a ticket for {shortdescription}"},
  {"utterance": "create a ticket"},
  {"utterance": "I need to create a ticket"},
  {"utterance": "log a ticket"},
  {"utterance": "open a ticket"},
  {"utterance": "submit a ticket"},
  {"utterance": "I have an issue"},
  {"utterance": "I need help"},
  {"utterance": "report a problem"},
  {"utterance": "create an incident"},
  {"utterance": "log an incident"},
  {"utterance": "I want to create a ticket"},
  {"utterance": "can you create a ticket for me"},
  {"utterance": "I have a problem with my computer"},
  {"utterance": "my laptop is not working"},
  {"utterance": "my computer won't turn on"},
  {"utterance": "I can't access my email"},
  {"utterance": "my screen is frozen"},
  {"utterance": "the system is down"},
  {"utterance": "I'm having trouble with my application"},
  {"utterance": "something is wrong with my computer"},
  {"utterance": "I need to report an IT issue"},
  {"utterance": "my internet is not working"},
  {"utterance": "I can't connect to the network"},
  {"utterance": "my printer won't print"},
  {"utterance": "I'm getting an error message"},
  {"utterance": "my software crashed"},
  {"utterance": "I can't open my files"},
  {"utterance": "my phone is not working"},
  {"utterance": "the VPN is not connecting"},
  {"utterance": "my account is not working"},
  {"utterance": "I have a hardware issue"},
  {"utterance": "my docking station is not working"},
  {"utterance": "Teams is not working"},
  {"utterance": "Outlook keeps crashing"},
  {"utterance": "I can't access SharePoint"},
  {"utterance": "my webcam is not working"},
  {"utterance": "the system is very slow"},
  {"utterance": "I need IT help"},
  {"utterance": "something broke on my computer"},
  {"utterance": "I'm locked out of my computer"},
  {"utterance": "my keyboard is not responding"},
  {"utterance": "my monitor won't display"}
]
EOF

# Fulfillment code hook for LogIncident en_US (uses 'isActive')
read -r -d '' LOG_INCIDENT_FULFILLMENT << 'EOF' || true
{
  "isActive": true,
  "enabled": true,
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
  }
}
EOF

# Initial response setting for LogIncident (successNextStep is ElicitSlot for shortdescription)
read -r -d '' LOG_INCIDENT_INITIAL_RESPONSE << 'EOF' || true
{
  "codeHook": {
    "isActive": true,
    "enableCodeHookInvocation": true,
    "postCodeHookSpecification": {
      "successNextStep": {
        "dialogAction": {
          "type": "ElicitSlot",
          "slotToElicit": "shortdescription"
        }
      },
      "failureNextStep": {
        "dialogAction": {"type": "EndConversation"}
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

echo "Updating LogIncident intent in en_US with 45 utterances..."

aws lexv2-models update-intent \
  --region "${REGION}" \
  --bot-id "${BOT_ID}" \
  --bot-version "${BOT_VERSION}" \
  --locale-id "${EN_LOCALE_ID}" \
  --intent-id "${LOG_INCIDENT_INTENT_ID}" \
  --intent-name "${LOG_INCIDENT_INTENT_NAME}" \
  --sample-utterances "${LOG_INCIDENT_UTTERANCES}" \
  --dialog-code-hook '{"enabled": true}' \
  --fulfillment-code-hook "${LOG_INCIDENT_FULFILLMENT}" \
  --initial-response-setting "${LOG_INCIDENT_INITIAL_RESPONSE}" \
  --slot-priorities '[{"priority": 1, "slotName": "shortdescription"}]' \
  --cli-binary-format raw-in-base64-out \
  --output text > /dev/null

if [ $? -eq 0 ]; then
  echo "SUCCESS: LogIncident intent updated with 45 utterances (15 existing + 30 new)."
else
  echo "FAILED: Could not update LogIncident intent in en_US."
  exit 1
fi

echo ""

# ============================================================================
# SECTION 3: Update GetIncidentStatus in en_US
# ============================================================================

echo "--------------------------------------------"
echo " Section 3: Update GetIncidentStatus in en_US"
echo "--------------------------------------------"

GET_STATUS_INTENT_ID="VOTXX1KMBN"
GET_STATUS_INTENT_NAME="GetIncidentStatus"

# All utterances: 10 existing + 20 new = 30 total
read -r -d '' GET_STATUS_UTTERANCES << 'EOF' || true
[
  {"utterance": "check my ticket"},
  {"utterance": "check ticket status"},
  {"utterance": "what is the status of my ticket"},
  {"utterance": "look up my incident"},
  {"utterance": "check INC"},
  {"utterance": "status of INC"},
  {"utterance": "find my ticket"},
  {"utterance": "ticket status"},
  {"utterance": "what happened to my ticket"},
  {"utterance": "any update on my ticket"},
  {"utterance": "what's the status of INC"},
  {"utterance": "check on my incident"},
  {"utterance": "do I have any open tickets"},
  {"utterance": "where is my ticket at"},
  {"utterance": "is my ticket resolved"},
  {"utterance": "has anyone looked at my ticket"},
  {"utterance": "any progress on my incident"},
  {"utterance": "I want to check my ticket"},
  {"utterance": "can you look up my ticket"},
  {"utterance": "what's happening with my request"},
  {"utterance": "is there an update on my case"},
  {"utterance": "track my ticket"},
  {"utterance": "follow up on my ticket"},
  {"utterance": "check RITM"},
  {"utterance": "status of my request"},
  {"utterance": "has my issue been fixed"},
  {"utterance": "when will my ticket be resolved"},
  {"utterance": "who is working on my ticket"},
  {"utterance": "I submitted a ticket and want to check on it"},
  {"utterance": "can you find my ticket"}
]
EOF

# Fulfillment code hook for GetIncidentStatus en_US (uses 'isActive')
read -r -d '' GET_STATUS_FULFILLMENT << 'EOF' || true
{
  "isActive": true,
  "enabled": true,
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
  }
}
EOF

# Initial response setting for GetIncidentStatus (successNextStep is FulfillIntent)
read -r -d '' GET_STATUS_INITIAL_RESPONSE << 'EOF' || true
{
  "codeHook": {
    "isActive": true,
    "enableCodeHookInvocation": true,
    "postCodeHookSpecification": {
      "successNextStep": {
        "dialogAction": {"type": "FulfillIntent"}
      },
      "failureNextStep": {
        "dialogAction": {"type": "EndConversation"}
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

echo "Updating GetIncidentStatus intent in en_US with 30 utterances..."

aws lexv2-models update-intent \
  --region "${REGION}" \
  --bot-id "${BOT_ID}" \
  --bot-version "${BOT_VERSION}" \
  --locale-id "${EN_LOCALE_ID}" \
  --intent-id "${GET_STATUS_INTENT_ID}" \
  --intent-name "${GET_STATUS_INTENT_NAME}" \
  --sample-utterances "${GET_STATUS_UTTERANCES}" \
  --dialog-code-hook '{"enabled": true}' \
  --fulfillment-code-hook "${GET_STATUS_FULFILLMENT}" \
  --initial-response-setting "${GET_STATUS_INITIAL_RESPONSE}" \
  --slot-priorities '[]' \
  --cli-binary-format raw-in-base64-out \
  --output text > /dev/null

if [ $? -eq 0 ]; then
  echo "SUCCESS: GetIncidentStatus intent updated with 30 utterances (10 existing + 20 new)."
else
  echo "FAILED: Could not update GetIncidentStatus intent in en_US."
  exit 1
fi

echo ""

# ============================================================================
# SECTION 4: Rebuild both bot locales
# ============================================================================

echo "--------------------------------------------"
echo " Section 4: Rebuild bot locales"
echo "--------------------------------------------"

echo "Building en_US locale..."

aws lexv2-models build-bot-locale \
  --region "${REGION}" \
  --bot-id "${BOT_ID}" \
  --bot-version "${BOT_VERSION}" \
  --locale-id "en_US"

if [ $? -eq 0 ]; then
  echo "SUCCESS: en_US locale build initiated."
else
  echo "FAILED: Could not initiate en_US locale build."
  exit 1
fi

echo ""
echo "Building es_US locale..."

aws lexv2-models build-bot-locale \
  --region "${REGION}" \
  --bot-id "${BOT_ID}" \
  --bot-version "${BOT_VERSION}" \
  --locale-id "es_US"

if [ $? -eq 0 ]; then
  echo "SUCCESS: es_US locale build initiated."
else
  echo "FAILED: Could not initiate es_US locale build."
  exit 1
fi

echo ""
echo "============================================"
echo " Deployment Complete!"
echo "============================================"
echo ""
echo "NOTE: Bot locale builds run asynchronously."
echo "Check build status with:"
echo "  aws lexv2-models describe-bot-locale --region ${REGION} --bot-id ${BOT_ID} --bot-version ${BOT_VERSION} --locale-id en_US --query 'botLocaleStatus'"
echo "  aws lexv2-models describe-bot-locale --region ${REGION} --bot-id ${BOT_ID} --bot-version ${BOT_VERSION} --locale-id es_US --query 'botLocaleStatus'"
echo ""
echo "Done."
