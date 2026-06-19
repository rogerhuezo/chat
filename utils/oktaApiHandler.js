'use strict';

/**
 * oktaApiHandler.js
 * Okta REST API Integration for Skechers Retail Store Account Management
 *
 * Capabilities:
 * - Get user by email or employee ID (via Workday → Okta profile)
 * - Password reset (send email link)
 * - Account unlock
 * - Account reset (clear MFA factors)
 * - Get user status
 *
 * Version: 1.0.0
 */

const https         = require('https');
const {
  SecretsManagerClient,
  GetSecretValueCommand
} = require('@aws-sdk/client-secrets-manager');

const secretsClient = new SecretsManagerClient({
  region: process.env.AWS_REGION || 'us-east-1'
});

const OKTA_DOMAIN  = process.env.OKTA_DOMAIN || 'skechers.okta.com';
const OKTA_TIMEOUT = parseInt(process.env.OKTA_TIMEOUT) || 8000;

// Simple in-memory cache for the API key (5 min TTL)
let _cachedKey = null;
let _cacheTs   = 0;
const CACHE_TTL = 300000;

// ============================================================
// CREDENTIALS
// ============================================================
async function getOktaApiKey() {
  if (_cachedKey && (Date.now() - _cacheTs) < CACHE_TTL) {
    return _cachedKey;
  }

  const secret = await secretsClient.send(
    new GetSecretValueCommand({ SecretId: 'skx_lex_okta' })
  );
  const data    = JSON.parse(secret.SecretString);
  _cachedKey    = data.OKTA_API_KEY;
  _cacheTs      = Date.now();

  if (!_cachedKey) throw new Error('OKTA_API_KEY not found in secret skx_lex_okta');
  return _cachedKey;
}

// ============================================================
// CORE HTTP
// ============================================================
function oktaRequest(method, path, body, apiKey) {
  return new Promise((resolve, reject) => {
    const bodyStr = body ? JSON.stringify(body) : null;

    const req = https.request({
      hostname: OKTA_DOMAIN,
      port    : 443,
      path,
      method,
      headers : {
        'Authorization' : `SSWS ${apiKey}`,
        'Accept'        : 'application/json',
        'Content-Type'  : 'application/json',
        ...(bodyStr && { 'Content-Length': Buffer.byteLength(bodyStr) })
      }
    }, (res) => {
      let raw = '';
      res.on('data', c  => raw += c);
      res.on('end',  () => {
        // 204 No Content = success with no body
        if (res.statusCode === 204) {
          return resolve({ success: true, statusCode: 204 });
        }
        try {
          const parsed = JSON.parse(raw);
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(parsed);
          } else {
            const msg = parsed?.errorSummary
                     || parsed?.errorCauses?.[0]?.errorSummary
                     || `HTTP ${res.statusCode}`;
            reject(new Error(`Okta API: ${msg}`));
          }
        } catch (e) {
          reject(new Error(`Okta JSON parse error: ${e.message}`));
        }
      });
    });

    req.on('error', e =>
      reject(new Error(`Okta network error: ${e.message}`))
    );
    req.setTimeout(OKTA_TIMEOUT, () => {
      req.destroy();
      reject(new Error(`Okta timeout after ${OKTA_TIMEOUT}ms`));
    });

    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

// ============================================================
// USER LOOKUP
// ============================================================

/**
 * getUserByEmail(email)
 * Returns Okta user object or null
 */
async function getUserByEmail(email) {
  console.log(`[okta] getUserByEmail: ${email}`);
  const apiKey = await getOktaApiKey();

  try {
    const user = await oktaRequest(
      'GET',
      `/api/v1/users/${encodeURIComponent(email)}`,
      null, apiKey
    );
    return normalizeUser(user);
  } catch (e) {
    if (e.message.includes('404') || e.message.includes('Not Found')) {
      console.warn(`[okta] user not found: ${email}`);
      return null;
    }
    throw e;
  }
}

/**
 * getUserByEmployeeId(employeeId)
 * Searches Okta by Workday employee ID stored in profile.employeeNumber
 */
async function getUserByEmployeeId(employeeId) {
  console.log(`[okta] getUserByEmployeeId: ${employeeId}`);
  const apiKey = await getOktaApiKey();

  const res = await oktaRequest(
    'GET',
    `/api/v1/users?search=${encodeURIComponent(
      `profile.employeeNumber eq "${employeeId}"`
    )}&limit=5`,
    null, apiKey
  );

  if (!Array.isArray(res) || res.length === 0) {
    console.warn(`[okta] no user found for employeeId: ${employeeId}`);
    return null;
  }

  return normalizeUser(res[0]);
}

/**
 * getUserStatus(oktaUserId)
 * Returns current Okta status: ACTIVE, LOCKED_OUT, PASSWORD_EXPIRED, etc.
 */
async function getUserStatus(oktaUserId) {
  console.log(`[okta] getUserStatus: ${oktaUserId}`);
  const apiKey = await getOktaApiKey();
  const user   = await oktaRequest(
    'GET',
    `/api/v1/users/${encodeURIComponent(oktaUserId)}`,
    null, apiKey
  );
  return user?.status || null;
}

// ============================================================
// ACCOUNT ACTIONS
// ============================================================

/**
 * resetPassword(oktaUserId)
 * Sends a password reset email to the user's personal email
 * (Workday → Okta personal email is used, not store email)
 * Returns: { success, activationUrl }
 */
async function resetPassword(oktaUserId) {
  console.log(`[okta] resetPassword: ${oktaUserId}`);
  const apiKey = await getOktaApiKey();

  // sendEmail=true → Okta sends the reset link directly to user
  const res = await oktaRequest(
    'POST',
    `/api/v1/users/${encodeURIComponent(oktaUserId)}/lifecycle/reset_password?sendEmail=true`,
    null, apiKey
  );

  return {
    success      : true,
    activationUrl: res?.activationUrl || null,
    statusCode   : res?.statusCode    || 200
  };
}

/**
 * unlockAccount(oktaUserId)
 * Unlocks a LOCKED_OUT Okta account
 */
async function unlockAccount(oktaUserId) {
  console.log(`[okta] unlockAccount: ${oktaUserId}`);
  const apiKey = await getOktaApiKey();

  await oktaRequest(
    'POST',
    `/api/v1/users/${encodeURIComponent(oktaUserId)}/lifecycle/unlock`,
    null, apiKey
  );

  return { success: true };
}

/**
 * resetFactors(oktaUserId)
 * Resets all MFA factors — user must re-enroll on next login
 */
async function resetFactors(oktaUserId) {
  console.log(`[okta] resetFactors: ${oktaUserId}`);
  const apiKey = await getOktaApiKey();

  await oktaRequest(
    'POST',
    `/api/v1/users/${encodeURIComponent(oktaUserId)}/lifecycle/reset_factors`,
    null, apiKey
  );

  return { success: true };
}

/**
 * resetAccount(oktaUserId)
 * Full account reset: reset password + reset MFA factors
 */
async function resetAccount(oktaUserId) {
  console.log(`[okta] resetAccount: ${oktaUserId}`);

  const [pwResult, mfaResult] = await Promise.allSettled([
    resetPassword(oktaUserId),
    resetFactors(oktaUserId)
  ]);

  return {
    success         : pwResult.status === 'fulfilled',
    passwordReset   : pwResult.status  === 'fulfilled',
    factorsReset    : mfaResult.status === 'fulfilled',
    passwordError   : pwResult.reason?.message  || null,
    factorsError    : mfaResult.reason?.message || null
  };
}

// ============================================================
// DISPATCH — single entry point for chatHandler
// ============================================================

/**
 * executeOktaAction(action, oktaUserId)
 * action: 'password_reset' | 'account_unlock' | 'account_reset'
 */
async function executeOktaAction(action, oktaUserId) {
  switch (action) {
    case 'password_reset': return resetPassword(oktaUserId);
    case 'account_unlock': return unlockAccount(oktaUserId);
    case 'account_reset' : return resetAccount(oktaUserId);
    default:
      throw new Error(`Unknown Okta action: ${action}`);
  }
}

// ============================================================
// NORMALIZE USER
// ============================================================
function normalizeUser(raw) {
  if (!raw) return null;
  const p = raw.profile || {};
  return {
    oktaId        : raw.id,
    status        : raw.status,                    // ACTIVE, LOCKED_OUT, etc.
    login         : p.login,
    email         : p.email,
    personalEmail : p.secondEmail || p.primaryPhone || null,
    firstName     : p.firstName,
    lastName      : p.lastName,
    displayName   : `${p.firstName || ''} ${p.lastName || ''}`.trim(),
    employeeNumber: p.employeeNumber || p.employeeId || null,
    department    : p.department     || null,
    title         : p.title          || null,
    mobilePhone   : p.mobilePhone    || null,
    manager       : p.manager        || null,
    created       : raw.created,
    lastLogin     : raw.lastLogin,
    statusChanged : raw.statusChanged
  };
}

// ============================================================
// EXPORTS
// ============================================================
module.exports = {
  getUserByEmail,
  getUserByEmployeeId,
  getUserStatus,
  resetPassword,
  unlockAccount,
  resetFactors,
  resetAccount,
  executeOktaAction,
  normalizeUser,
  getOktaApiKey
};

console.log('✅ oktaApiHandler.js v1.0.0 loaded');
console.log('   🔑 Secret     : skx_lex_okta → OKTA_API_KEY');
console.log('   👤 User lookup: by email, by employeeNumber');
console.log('   🔒 Actions    : password_reset, account_unlock, account_reset');