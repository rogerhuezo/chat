#!/bin/bash
# Updates TransferToAgent intent with additional utterances for analyst/frustration cases
# and rebuilds the en_US locale.
#
# Usage: chmod +x scripts/deploy-transfer-fix.sh && ./scripts/deploy-transfer-fix.sh

set -euo pipefail

BOT_ID="IWXPUYQOJC"
BOT_VERSION="DRAFT"
REGION="us-east-1"
INTENT_ID="II9JGZH1PY"

echo "Updating TransferToAgent intent in en_US..."

aws lexv2-models update-intent \
  --region "${REGION}" \
  --bot-id "${BOT_ID}" \
  --bot-version "${BOT_VERSION}" \
  --locale-id en_US \
  --intent-id "${INTENT_ID}" \
  --intent-name TransferToAgent \
  --sample-utterances '[{"utterance":"transfer to agent"},{"utterance":"talk to a human"},{"utterance":"speak to someone"},{"utterance":"live agent"},{"utterance":"live support"},{"utterance":"connect me to support"},{"utterance":"I need a human"},{"utterance":"speak to a person"},{"utterance":"talk to a real person"},{"utterance":"agent please"},{"utterance":"human please"},{"utterance":"connect me to an agent"},{"utterance":"I want to speak to someone"},{"utterance":"transfer"},{"utterance":"connect me with an analyst"},{"utterance":"I want to talk to an analyst"},{"utterance":"put me through to support"},{"utterance":"let me talk to IT"},{"utterance":"escalate"},{"utterance":"escalate this"},{"utterance":"I want to escalate this"},{"utterance":"this isnt helping can I talk to someone"},{"utterance":"I give up just transfer me"},{"utterance":"the bot cant help me"},{"utterance":"I need real help"},{"utterance":"can someone call me"},{"utterance":"please pick up the phone"},{"utterance":"someone help me please"},{"utterance":"I need to speak with a person"},{"utterance":"connect me with someone"},{"utterance":"talk to support"},{"utterance":"get me a human"},{"utterance":"I want a real person"},{"utterance":"this is not working let me talk to someone"},{"utterance":"mettimi in contatto con un analista"},{"utterance":"collegami con un agente"},{"utterance":"ho bisogno di parlare con qualcuno"},{"utterance":"transferir para um agente"},{"utterance":"falar com um agente"},{"utterance":"preciso de um agente"},{"utterance":"quero falar com alguem"},{"utterance":"preciso falar com alguem"},{"utterance":"preciso de alguem"},{"utterance":"conectar com um agente"},{"utterance":"conectar com suporte"},{"utterance":"falar com uma pessoa"},{"utterance":"falar com um humano"},{"utterance":"preciso de um humano"},{"utterance":"agente por favor"},{"utterance":"preciso de suporte ao vivo"},{"utterance":"quero suporte ao vivo"},{"utterance":"transferir por favor"},{"utterance":"quero falar com uma pessoa real"},{"utterance":"preciso de ajuda de uma pessoa"},{"utterance":"transferir a un agente"},{"utterance":"transferirme con un agente"},{"utterance":"hablar con un agente"},{"utterance":"necesito un agente"},{"utterance":"quiero hablar con alguien"},{"utterance":"necesito hablar con alguien"},{"utterance":"necesito a alguien"},{"utterance":"conectame con un agente"},{"utterance":"conectame con soporte"},{"utterance":"hablar con una persona"},{"utterance":"hablar con un humano"},{"utterance":"necesito un humano"},{"utterance":"soporte en vivo"},{"utterance":"quiero soporte en vivo"},{"utterance":"quiero hablar con una persona real"},{"utterance":"humano por favor"},{"utterance":"necesito ayuda de una persona"},{"utterance":"transférer à un agent"},{"utterance":"parler à un agent"},{"utterance":"jai besoin dun agent"},{"utterance":"je veux parler à quelquun"},{"utterance":"connecter avec un agent"},{"utterance":"parler à une personne"},{"utterance":"parler à un humain"},{"utterance":"agent sil vous plait"},{"utterance":"support en direct"},{"utterance":"je veux parler à une vraie personne"},{"utterance":"mit einem agenten sprechen"},{"utterance":"zu einem agenten weiterleiten"},{"utterance":"ich brauche einen agenten"},{"utterance":"ich mochte mit jemandem sprechen"},{"utterance":"mit einer person sprechen"},{"utterance":"mit einem menschen sprechen"},{"utterance":"agent bitte"},{"utterance":"live-support bitte"},{"utterance":"ich mochte mit einer echten person sprechen"},{"utterance":"weiterleiten bitte"}]' \
  --dialog-code-hook '{"enabled":true}' \
  --fulfillment-code-hook '{"enabled":true,"postFulfillmentStatusSpecification":{"successNextStep":{"dialogAction":{"type":"EndConversation"}},"failureNextStep":{"dialogAction":{"type":"EndConversation"}},"timeoutNextStep":{"dialogAction":{"type":"EndConversation"}}}}' \
  --initial-response-setting '{"codeHook":{"enableCodeHookInvocation":true,"active":true,"postCodeHookSpecification":{"successNextStep":{"dialogAction":{"type":"FulfillIntent"}},"failureNextStep":{"dialogAction":{"type":"EndConversation"}},"timeoutNextStep":{"dialogAction":{"type":"EndConversation"}}}},"nextStep":{"dialogAction":{"type":"InvokeDialogCodeHook"}}}' \
  --output text > /dev/null

if [ $? -eq 0 ]; then
  echo "SUCCESS: TransferToAgent updated with expanded utterances."
else
  echo "FAILED: Could not update TransferToAgent."
  exit 1
fi

echo ""
echo "Building en_US locale..."

aws lexv2-models build-bot-locale \
  --region "${REGION}" \
  --bot-id "${BOT_ID}" \
  --bot-version "${BOT_VERSION}" \
  --locale-id en_US

echo "SUCCESS: Build initiated."
echo ""
echo "Check status:"
echo "  aws lexv2-models describe-bot-locale --bot-id ${BOT_ID} --bot-version ${BOT_VERSION} --locale-id en_US --region ${REGION} --query 'botLocaleStatus'"
