'use strict';

/**
 * aptosApiHandler.js
 * Aptos One POS API Integration for Skechers Retail Stores
 *
 * Capabilities:
 * - OAuth2 token acquisition (password grant via Keycloak)
 * - Look up POS user by username (staff code)
 * - Reset password to default
 * - Unlock account (set status to Active)
 * - Lock account (set status to Locked)
 *
 * Regions using Aptos One: NA, EU, Japan, Philippines
 * LATAM uses Xstore (not supported by this client)
 *
 * API: https://skechers.aptos-one.io
 * Auth: Keycloak realm skechers_default (password grant)
 * Creds: AWS Secrets Manager → skx_aptosOne
 *
 * Version: 1.0.0
 */

const https = require('https');
const {
  SecretsManagerClient,
  GetSecretValueCommand
} = require('@aws-sdk/client-secrets-manager');

const secretsClient = new SecretsManagerClient({
  region: process.env.AWS_REGION || 'us-east-1'
});

const APTOS_HOST      = 'skechers.aptos-one.io';
const APTOS_AUTH_PATH = '/auth/realms/skechers_default/protocol/openid-connect/token';
const APTOS_CLIENT_ID = 'localhost-dev';
const APTOS_TIMEOUT   = parseInt(process.env.APTOS_TIMEOUT) || 12000;
const APTOS_SECRET    = process.env.APTOS_SECRET_ARN || 'skx_aptosOne';
const USER_AGENT      = 'SKX-ITSM-ChatBot/1.0';

// Default password for POS reset
const DEFAULT_POS_PASSWORD = 'Skechers1';

// ── Token cache (reuse until 75% of expiry) ─────────────────────────────────
let _cachedToken  = null;
let _tokenExpiry  = 0;

// ── Credentials cache ─────────────────────────────────────────────────────────
let _cachedCreds  = null;
let _credsTs      = 0;
const CREDS_TTL   = 300000; // 5 min

// ── Aptos One regions ─────────────────────────────────────────────────────────
const APTOS_COUNTRY_CODES = [
  'US', 'CA', 'GB', 'UK', 'FR', 'DE', 'IT', 'ES', 'PT', 'NL', 'BE',
  'CH', 'AT', 'SE', 'DK', 'NO', 'FI', 'IE', 'PL', 'CZ', 'HU', 'GR',
  'RO', 'BG', 'JP', 'PH', 'IN', 'CN', 'KR', 'AU', 'NZ', 'SG', 'MY',
  'TH', 'VN', 'ID', 'TW', 'HK', 'AE', 'IL', 'TR', 'ZA'
];
const XSTORE_COUNTRY_CODES = [
  'BR', 'AR', 'CO', 'PE', 'CL', 'EC', 'BO', 'PY', 'UY', 'VE', 'MX',
  'CR', 'GT', 'SV', 'HN', 'PA'
];

// ============================================================
// CREDENTIALS
// ============================================================
async function getAptosCreds() {
  if (_cachedCreds && (Date.now() - _credsTs) < CREDS_TTL) {
    return _cachedCreds;
  }

  const secret = await secretsClient.send(
    new GetSecretValueCommand({ SecretId: APTOS_SECRET })
  );
  _cachedCreds = JSON.parse(secret.SecretString);
  _credsTs     = Date.now();

  if (!_cachedCreds.username || !_cachedCreds.password) {
    throw new Error('Aptos One credentials missing username/password in secret');
  }
  return _cachedCreds;
}

// ============================================================
// TOKEN
// ============================================================
async function getToken() {
  const now = Math.floor(Date.now() / 1000);
  if (_cachedToken && now < _tokenExpiry) {
    return _cachedToken;
  }

  const creds = await getAptosCreds();
  const postData = [
    'grant_type=password',
    `username=${encodeURIComponent(creds.username)}`,
    `password=${encodeURIComponent(creds.password)}`,
    `client_id=${APTOS_CLIENT_ID}`
  ].join('&');

  const tokenData = await aptosRequest('POST', APTOS_AUTH_PATH, postData, {
    'Content-Type': 'application/x-www-form-urlencoded',
    'Accept': 'application/json',
    'User-Agent': USER_AGENT
  });

  _cachedToken  = tokenData.access_token;
  _tokenExpiry  = now + Math.floor((tokenData.expires_in || 300) * 0.75);
  console.log(`[aptos] Token acquired, expires_in=${tokenData.expires_in}s`);
  return _cachedToken;
}

// ============================================================
// HTTP REQUEST
// ============================================================
function aptosRequest(method, path, body, customHeaders) {
  return new Promise((resolve, reject) => {
    const bodyStr = typeof body === 'string' ? body : (body ? JSON.stringify(body) : null);

    const headers = customHeaders || {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'User-Agent': USER_AGENT
    };
    if (bodyStr) headers['Content-Length'] = Buffer.byteLength(bodyStr);

    const req = https.request({
      hostname: APTOS_HOST,
      port: 443,
      path,
      method,
      headers
    }, (res) => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try {
            resolve(raw ? JSON.parse(raw) : { success: true, statusCode: res.statusCode });
          } catch (e) {
            resolve({ success: true, statusCode: res.statusCode, raw });
          }
        } else {
          const errMsg = raw.substring(0, 300);
          console.error(`[aptos] ${method} ${path} → ${res.statusCode}: ${errMsg}`);
          reject(new Error(`Aptos API ${res.statusCode}: ${errMsg}`));
        }
      });
    });

    req.on('error', e => reject(new Error(`Aptos network error: ${e.message}`)));
    req.setTimeout(APTOS_TIMEOUT, () => {
      req.destroy();
      reject(new Error(`Aptos timeout after ${APTOS_TIMEOUT}ms`));
    });

    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

/**
 * Authenticated GET/PATCH request
 */
async function authRequest(method, path, body = null) {
  const token = await getToken();
  const headers = {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    'User-Agent': USER_AGENT
  };
  const bodyStr = body ? JSON.stringify(body) : null;
  if (bodyStr) headers['Content-Length'] = Buffer.byteLength(bodyStr);

  return aptosRequest(method, path, bodyStr, headers);
}

// ============================================================
// USER LOOKUP
// ============================================================

/**
 * getUserByPosUsername(username)
 * Looks up a POS employee by their username/staff code in Aptos One
 * @param {string} username - POS login (e.g., "51494", "SKE51494")
 * @returns {object|null} Normalized user or null if not found
 */
async function getUserByPosUsername(username) {
  console.log(`[aptos] getUserByPosUsername: ${username}`);

  try {
    const response = await authRequest('GET', `/users/v2/users?username=${encodeURIComponent(username)}`);

    if (response && response.data && response.data.length > 0) {
      return normalizeUser(response.data[0]);
    }
    console.warn(`[aptos] user not found: ${username}`);
    return null;
  } catch (e) {
    if (e.message.includes('404') || e.message.includes('Not Found')) {
      console.warn(`[aptos] user not found (404): ${username}`);
      return null;
    }
    throw e;
  }
}

// ============================================================
// ACCOUNT ACTIONS
// ============================================================

/**
 * resetPassword(userId, password)
 * Resets POS login password to default
 */
async function resetPassword(userId, password) {
  console.log(`[aptos] resetPassword: ${userId}`);
  const payload = {
    password: password || DEFAULT_POS_PASSWORD,
    passwordUpdateRequired: false
  };
  const result = await authRequest('PATCH', `/users/v2/users/${userId}`, payload);
  return { success: !!(result && result.id), result };
}

/**
 * unlockAccount(userId)
 * Sets account status to Active (unlocks)
 */
async function unlockAccount(userId) {
  console.log(`[aptos] unlockAccount: ${userId}`);
  const payload = { accountStatus: 'Active' };
  const result = await authRequest('PATCH', `/users/v2/users/${userId}`, payload);
  return { success: !!(result && result.id), result };
}

/**
 * lockAccount(userId)
 * Sets account status to Locked
 */
async function lockAccount(userId) {
  console.log(`[aptos] lockAccount: ${userId}`);
  const payload = { accountStatus: 'Locked' };
  const result = await authRequest('PATCH', `/users/v2/users/${userId}`, payload);
  return { success: !!(result && result.id), result };
}

// ============================================================
// DISPATCH — single entry point
// ============================================================

/**
 * executePosAction(action, userId)
 * action: 'password_reset' | 'account_unlock'
 */
async function executePosAction(action, userId) {
  switch (action) {
    case 'password_reset': return resetPassword(userId);
    case 'account_unlock': return unlockAccount(userId);
    default:
      throw new Error(`Unknown POS action: ${action}`);
  }
}

// ============================================================
// NORMALIZE USER
// ============================================================
function normalizeUser(raw) {
  if (!raw) return null;
  return {
    aptosId:               raw.id,
    username:              raw.username,
    firstName:             raw.firstName  || '',
    lastName:              raw.lastName   || '',
    displayName:           `${raw.firstName || ''} ${raw.lastName || ''}`.trim(),
    accountStatus:         raw.accountStatus,
    passwordUpdateRequired: raw.passwordUpdateRequired || false,
    securityRoleId:        raw.securityRoleId,
    securityLevel:         getSecurityLevelLabel(raw.securityRoleId)
  };
}

// ============================================================
// REGION HELPERS
// ============================================================

/**
 * isAptosRegion(countryCode)
 * Returns true if the country uses Aptos One POS
 */
function isAptosRegion(countryCode) {
  if (!countryCode) return false;
  const cc = countryCode.toUpperCase().trim();
  return APTOS_COUNTRY_CODES.includes(cc);
}

/**
 * isXstoreRegion(countryCode)
 * Returns true if the country uses Xstore POS (LATAM)
 */
function isXstoreRegion(countryCode) {
  if (!countryCode) return false;
  const cc = countryCode.toUpperCase().trim();
  return XSTORE_COUNTRY_CODES.includes(cc);
}

/**
 * getPosSystem(countryCode)
 * Returns 'aptos' | 'xstore' | 'unknown'
 */
function getPosSystem(countryCode) {
  if (isAptosRegion(countryCode)) return 'aptos';
  if (isXstoreRegion(countryCode)) return 'xstore';
  return 'unknown';
}

// ============================================================
// SECURITY LEVELS
// ============================================================
function getSecurityLevelLabel(level) {
  const levels = {
    0:  '<None>',
    20: 'Sales Associate/Cashier',
    25: 'Stock Associate',
    30: 'Floor Associate',
    40: 'Assistant Store Manager',
    50: 'Store Manager/District Manager',
    55: 'Promotions Management',
    60: 'Inventory Control',
    70: 'Loss Prevention',
    80: 'Help Desk',
    90: 'Configuration',
    99: 'APTOS Client Care Admin'
  };
  return levels[level] || `Level ${level}`;
}

// ============================================================
// USERNAME NORMALIZATION
// ============================================================

/**
 * normalizePosUsername(input)
 * Normalizes various formats of employee IDs to POS username
 * - "51494" (5+ digits) → "SKE51494"
 * - "SKE51494" → "SKE51494"
 * - "1234" (< 5 digits) → "1234"
 */
function normalizePosUsername(input) {
  const cleaned = (input || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (cleaned.startsWith('SKE')) return cleaned;
  if (/^\d+$/.test(cleaned) && cleaned.length >= 5) return `SKE${cleaned}`;
  return cleaned;
}

/**
 * getAlternateUsername(username)
 * Returns an alternate format to try if first lookup fails
 */
function getAlternateUsername(username) {
  if (username.startsWith('SKE')) return username.replace('SKE', '');
  if (/^\d+$/.test(username)) return `SKE${username}`;
  return null;
}

// ============================================================
// EXPORTS
// ============================================================
module.exports = {
  getUserByPosUsername,
  resetPassword,
  unlockAccount,
  lockAccount,
  executePosAction,
  normalizeUser,
  normalizePosUsername,
  getAlternateUsername,
  isAptosRegion,
  isXstoreRegion,
  getPosSystem,
  getSecurityLevelLabel,
  DEFAULT_POS_PASSWORD
};

console.log('✅ aptosApiHandler.js v1.0.0 loaded');
console.log('   🔑 Secret     : skx_aptosOne');
console.log('   🌐 API Host   : skechers.aptos-one.io');
console.log('   👤 User lookup: by POS username');
console.log('   🔒 Actions    : password_reset, account_unlock');
