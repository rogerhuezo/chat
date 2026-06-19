// utils/catalogSearch.js
'use strict';

const { SecretsManagerClient, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');

const SNOW_HOST   = process.env.SNOW_HOST   || 'skx.service-now.com';
const SNOW_BASE   = `https://${SNOW_HOST}`;
const SECRET_NAME = process.env.SECRET_NAME || 'skx_lex_servicenowkb';
const MAX_RESULTS = 5;

const smClient = new SecretsManagerClient({ region: process.env.AWS_REGION || 'us-east-1' });

let cachedCreds = null;

const getCreds = async () => {
  if (cachedCreds) return cachedCreds;
  const res   = await smClient.send(new GetSecretValueCommand({ SecretId: SECRET_NAME }));
  cachedCreds = JSON.parse(res.SecretString);
  return cachedCreds;
};

const CATALOGS = {
  RETAIL:    '6f629c031b0581101095eb95604bcb8d',
  CORPORATE: 'e0d08b13c3330100c8b837659bba8fb4'
};

const SEARCH_TERM_ALIASES = {
  // Remote Access
  'vpn'                         : 'remote access',
  'npa'                         : 'remote access',
  'netskope'                    : 'remote access',
  'fortinet'                    : 'remote access',
  'fortinet vpn'                : 'remote access',
  'global protect'              : 'remote access',
  'citrix'                      : 'remote access',
  'remote access request'       : 'remote access',

  // Atlassian — catalog item: "Atlassian Platform"
  'jira'                        : 'atlassian',
  'confluence'                  : 'atlassian',
  'bitbucket'                   : 'atlassian',
  'trello'                      : 'atlassian',
  'jira access'                 : 'atlassian',
  'confluence access'           : 'atlassian',
  'atlassian access'            : 'atlassian',
  'jira software'               : 'atlassian',
  'jira service management'     : 'atlassian',
  'jsm'                         : 'atlassian',

  // GARPAC
  'garpac access'               : 'garpac',
  'garpac user'                 : 'garpac',
  'garpac reports'              : 'garpac',
  'garpac breakfix'             : 'garpac',
  'garpac services'             : 'garpac',
  'garpac enhancement'          : 'garpac',
  'omega'                       : 'garpac',
  'aptos'                       : 'garpac',

  // Microsoft
  'excel'                       : 'microsoft',
  'word'                        : 'microsoft',
  'powerpoint'                  : 'microsoft',
  'onenote'                     : 'microsoft',
  'outlook'                     : 'microsoft',
  'sharepoint'                  : 'microsoft',
  'visio'                       : 'microsoft',
  'publisher'                   : 'microsoft',
  'teams'                       : 'microsoft teams',
  'ms teams'                    : 'microsoft teams',
  'microsoft teams phone'       : 'microsoft teams',
  'new team'                    : 'ms teams',
  'teams channel'               : 'ms teams',
  'o365'                        : 'microsoft',
  'office 365'                  : 'microsoft',
  'office365'                   : 'microsoft',
  'm365'                        : 'microsoft',

  // Adobe — catalog items: "Acrobat DC Pro", "Creative Cloud",
  //          "Photoshop", "Illustrator", "InDesign", "Dreamweaver"
  'photoshop'                   : 'adobe',
  'illustrator'                 : 'adobe',
  'indesign'                    : 'adobe',
  'dreamweaver'                 : 'adobe',
  'acrobat'                     : 'adobe acrobat',
  'acrobat dc'                  : 'acrobat dc pro',
  'acrobat dc pro'              : 'acrobat dc pro',
  'adobe acrobat'               : 'acrobat dc pro',
  'adobe acrobat premium'       : 'acrobat dc pro',
  'creative cloud'              : 'creative cloud',
  'adobe creative cloud'        : 'creative cloud',
  'adobe cc'                    : 'creative cloud',
  'adobe suite'                 : 'creative cloud',
  'cc'                          : 'creative cloud',

  // Oracle / OCF
  'oracle erp'                  : 'oracle',
  'oracle cloud'                : 'oracle',
  'oracle cloud financials'     : 'oracle',
  'ocf'                         : 'ocf',
  'ocf access'                  : 'ocf',
  'oracle financials'           : 'ocf',

  // Salesforce
  'sfdc'                        : 'salesforce',
  'crm'                         : 'salesforce',
  'salesforce access'           : 'salesforce',

  // Workday
  'workday access'              : 'workday',
  'workday roles'               : 'workday',
  'workday permissions'         : 'workday',
  'workday report'              : 'workday',
  'hris'                        : 'workday',

  // Hardware
  'order a keyboard'            : 'keyboard',
  'wireless keyboard'           : 'keyboard',
  'standard keyboard'           : 'keyboard',
  'need a keyboard'             : 'keyboard',
  'order a mouse'               : 'mouse',
  'wireless mouse'              : 'mouse',
  'need a mouse'                : 'mouse',
  'order a monitor'             : 'monitor',
  'need a monitor'              : 'monitor',
  'second monitor'              : 'monitor',
  'dual monitor'                : 'monitor',
  'order a laptop'              : 'laptop',
  'need a laptop'               : 'laptop',
  'new laptop'                  : 'laptop',
  'macbook pro'                 : 'macbook pro',
  'macbook air'                 : 'macbook air',
  'macbook'                     : 'laptop',
  'apple laptop'                : 'laptop',
  'windows laptop'              : 'laptop',
  'order a headset'             : 'headset',
  'need a headset'              : 'headset',
  'hp blackwire'                : 'headset',
  'order a webcam'              : 'webcam',
  'need a webcam'               : 'webcam',
  'order a docking station'     : 'docking station',
  'thunderbolt dock'            : 'docking station',
  'dock'                        : 'docking station',
  'order a speaker'             : 'speaker',
  'order a desktop computer'    : 'computer',
  'desktop computer'            : 'computer',
  'imac'                        : 'imac',
  'ipad'                        : 'ipad',
  'apple ipad'                  : 'ipad',
  'tablet'                      : 'ipad',
  'mobile phone'                : 'mobile phone',
  'cell phone'                  : 'mobile phone',
  'smartphone'                  : 'mobile phone',
  'new phone'                   : 'mobile phone',
  'phone replacement'           : 'device replacement',
  'replace phone'               : 'device replacement',
  'replace laptop'              : 'device replacement',

  // VDI
  'vdi'                         : 'virtual desktop',
  'virtual personal desktop'    : 'virtual desktop',
  'contingent vdi'              : 'virtual desktop',

  // Password / Account
  'forgot password'             : 'password',
  'reset password'              : 'password',
  'unlock account'              : 'password',
  'locked out'                  : 'password',
  'locked account'              : 'password',
  'password expired'            : 'password',
  'password manager'            : 'lastpass',
  'lastpass access'             : 'lastpass',

  // Okta / SSO
  'sso'                         : 'okta',
  'okta access'                 : 'okta',
  'single sign on'              : 'okta',
  'new sso'                     : 'okta sso',
  'sso integration'             : 'okta sso',

  // AWS
  'aws access'                  : 'aws',
  'aws iam'                     : 'aws iam',
  'aws s3'                      : 'aws s3',
  'aws sftp'                    : 'aws sftp',
  's3 bucket'                   : 'aws s3',
  'sftp'                        : 'aws sftp',
  'aws idc'                     : 'aws idc',
  'aws compass'                 : 'aws compass',

  // Other software
  'dam'                         : 'digital asset management',
  'digital asset'               : 'digital asset management',
  'vm'                          : 'virtual machine',
  'virtual machine'             : 'virtual machine',
  'new vm'                      : 'virtual machine',
  'usb storage'                 : 'usb',
  'enable usb'                  : 'enable usb storage',
  'box'                         : 'box cloud drive',
  'box drive'                   : 'box cloud drive',
  'file share'                  : 'box cloud drive',
  'docusign'                    : 'docusign',
  'clm'                         : 'docusign',
  'contract'                    : 'contract review',
  'lucidchart'                  : 'lucid chart',
  'lucid chart'                 : 'lucid chart',
  'snagit'                      : 'snagit',
  'teamviewer'                  : 'teamviewer',
  'ultraedit'                   : 'ultraedit',
  'github'                      : 'github',
  'git'                         : 'github',
  'github access'               : 'github',
  'blackline'                   : 'blackline',
  'blackline access'            : 'blackline',
  'alteryx'                     : 'alteryx',
  'alteryx access'              : 'alteryx',
  'veza'                        : 'veza',
  'veza access'                 : 'veza',
  'compass'                     : 'compass',
  'sessionm'                    : 'sessionm',
  'sessionm access'             : 'sessionm',
  'kip'                         : 'kip',
  'kip access'                  : 'kip',
  'freshdesk'                   : 'freshdesk',
  'apropos'                     : 'apropos',
  'apropos access'              : 'apropos',
  'aqua data studio'            : 'aqua data studio',
  'actioniq'                    : 'actioniq',
  'lucernex'                    : 'lucernex',
  'lucernex access'             : 'lucernex',
  'smartway2'                   : 'smartway2',
  'manhattan'                   : 'manhattan active omni',
  'klarna'                      : 'klarna',
  'klarna access'               : 'klarna',
  'peoplesoft'                  : 'peoplesoft',
  'sap'                         : 'sap',
  'sap connection'              : 'sap connection setup',
  'thomson reuters'             : 'thomson reuters',
  'onesource'                   : 'thomson reuters',
  'flexplm'                     : 'flexplm',
  'flex plm'                    : 'flexplm',
  'plm'                         : 'flexplm',
  'wof'                         : 'wof access',
  'wof access'                  : 'wof access',
  'o9'                          : 'o9',
  'skechai'                     : 'skechai',
  'skechers ai'                 : 'skechai',
  'itsthes'                     : 'itsthes',
  'ecommerce'                   : 'e-commerce',
  'e-commerce access'           : 'e-commerce',
  'informix'                    : 'informix',
  'mongodb'                     : 'mongodb',
  'rds'                         : 'rds databases',
  'parallels'                   : 'parallels',

  // Printer / Office equipment
  'printer'                     : 'laserjet',
  'office printer'              : 'laserjet',
  'color printer'               : 'color laserjet',
  'laser printer'               : 'laserjet',
  'wireless printer'            : 'officejet',
  'home office printer'         : 'officejet',

  // Store / Retail specific
  'pos issue'                   : 'report a pos',
  'register issue'              : 'report a pos',
  'point of sale'               : 'report a pos',
  'store hardware'              : 'request store hardware',
  'store supplies'              : 'stockroom supplies',
  'supply order'                : 'skxshop',
  'skxshop'                     : 'skxshop',
  'store incident'              : 'store incident report',
  'robbery'                     : 'robbery incident',
  'burglary'                    : 'burglary incident',
  'shoplifting'                 : 'shoplifting incident',
  'customer injury'             : 'customer accident',
  'slip and fall'               : 'customer accident',
  'paid in'                     : 'paid in paid out',
  'paid out'                    : 'paid in paid out',
  'gift certificate'            : 'gift certificates',
  'price gun'                   : 'price gun',
  'variance report'             : 'variance report',
  'loss prevention'             : 'loss prevention',
  'charge send'                 : 'charge send',

  // Networking / Infrastructure
  'dns'                         : 'dns request',
  'dns change'                  : 'dns request',
  'firewall'                    : 'firewall',
  'firewall rule'               : 'firewall',
  'palo alto'                   : 'palo alto firewall',
  'ssl certificate'             : 'ssl certificate',
  'ssl cert'                    : 'ssl certificate',
  'new server'                  : 'virtual machine',
  'decommission'                : 'decommission server',
  'local admin'                 : 'local admin access',
  'admin rights'                : 'local admin access',

  // HR / Onboarding
  'onboarding'                  : 'onboarding',
  'new hire'                    : 'onboarding',
  'offboarding'                 : 'termination',
  'termination'                 : 'termination request',
  'contractor extension'        : 'contractor expiration',
  'hr support'                  : 'hr solutions center',
  'hr request'                  : 'hr solutions center',

  // Purchasing
  'purchase request'            : 'purchasing request',
  'buy hardware'                : 'purchasing request hardware',
  'buy software'                : 'purchasing request software',
  'career development'          : 'purchasing request career',
  'training request'            : 'purchasing request career',
  'credit card'                 : 'corporate credit card',

  // Security
  'security assessment'         : 'vendor security assessment',
  'penetration test'            : 'penetration testing',
  'pentest'                     : 'penetration testing',
  'policy exception'            : 'policy exception',
  'privacy'                     : 'privacy compliance'
};

// Tools with no catalog entry — return helpful message instead of silence
const KNOWN_TOOLS_FALLBACK = {
  'zoom'      : { vendor: 'Zoom',       tools: 'Zoom' },
  'slack'     : { vendor: 'Slack',      tools: 'Slack' },
  'notion'    : { vendor: 'Notion',     tools: 'Notion' },
  'figma'     : { vendor: 'Figma',      tools: 'Figma' },
  'miro'      : { vendor: 'Miro',       tools: 'Miro' },
  'tableau'   : { vendor: 'Tableau',    tools: 'Tableau' },
  'power bi'  : { vendor: 'Microsoft',  tools: 'Power BI' },
  'powerbi'   : { vendor: 'Microsoft',  tools: 'Power BI' },
  'copilot'   : { vendor: 'Microsoft',  tools: 'Microsoft Copilot' },
  'azure'     : { vendor: 'Azure',      tools: 'Azure' }
};

const getStoreNumber = (email) => {
  const match = (email || '').match(/^store(\d+)@skechers\.com$/i);
  return match ? match[1] : null;
};

const isRetailEmail = (email) => !!getStoreNumber(email);

const resolveAlias = (term) => {
  if (!term) return term;
  const lower = term.toLowerCase().trim();
  const alias = SEARCH_TERM_ALIASES[lower];
  if (alias) {
    console.log(`[catalogSearch] alias: "${term}" → "${alias}"`);
    return alias;
  }
  return term;
};

const extractPrimaryKeyword = (term) => {
  if (!term) return term;
  const stripped = term
    .toLowerCase()
    .replace(/\b(access|request|setup|set up|install|configure|provision|needed|please|for|to|a|an|the|new|my|our)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const words   = stripped.split(/\s+/).filter(w => w.length > 1);
  const primary = words[0] || term;
  console.log(`[catalogSearch] keyword: "${term}" → "${primary}"`);
  return primary;
};

const extractSearchTerm = (message, slots) => {
  const safeSlots = slots || {};

  // Check Lex slots first
  const slotValue =
    safeSlots.CatalogItemName?.value?.interpretedValue ||
    safeSlots.CatalogItemName?.value?.originalValue    ||
    safeSlots.SoftwareApplications?.value?.interpretedValue ||
    safeSlots.software?.value?.interpretedValue        ||
    safeSlots.application?.value?.interpretedValue     ||
    safeSlots.device?.value?.interpretedValue;

  if (slotValue) {
    console.log(`[catalogSearch] term from slot: "${slotValue}"`);
    return slotValue;
  }

  const input = message.toLowerCase();

  const patterns = [
    /(?:access to|need access to|request access to|i need access to)\s+([a-zA-Z0-9\s]+)/,
    /(?:i need|need|want|require)\s+([a-zA-Z0-9\s]+)/,
    /(?:install|setup|configure|order|get)\s+([a-zA-Z0-9\s]+)/
  ];

  for (const pattern of patterns) {
    const match = input.match(pattern);
    if (match && !match[1].includes('help') && !match[1].includes('ticket')) {
      return match[1].trim();
    }
  }

  // Keyword scan — longest first to avoid partial matches
  const keywords = [
    'acrobat dc pro', 'adobe creative cloud', 'creative cloud', 'adobe acrobat',
    'microsoft teams', 'office 365', 'atlassian platform',
    'digital asset management', 'virtual personal desktop', 'virtual machine',
    'docking station', 'local admin', 'aws sftp', 'aws iam', 'aws s3', 'aws idc',
    'remote access', 'box cloud drive', 'thomson reuters', 'palo alto',
    'corporate credit card', 'sap connection',
    'adobe', 'microsoft', 'atlassian', 'jira', 'confluence', 'bitbucket', 'trello',
    'salesforce', 'oracle', 'workday', 'garpac', 'photoshop', 'illustrator',
    'indesign', 'dreamweaver', 'acrobat', 'compass', 'sessionm', 'apropos',
    'kip', 'sap', 'blackline', 'alteryx', 'veza', 'freshdesk', 'lucernex',
    'smartway2', 'klarna', 'docusign', 'snagit', 'teamviewer', 'ultraedit',
    'github', 'mongodb', 'informix', 'flexplm', 'parallels', 'lastpass', 'okta',
    'vpn', 'netskope', 'citrix', 'laptop', 'computer', 'tablet', 'phone',
    'printer', 'monitor', 'keyboard', 'mouse', 'webcam', 'headset',
    'ipad', 'imac', 'macbook', 'firewall', 'dns', 'usb',
    'onboarding', 'termination', 'o9', 'skechai', 'itsthes', 'actioniq',
    'peoplesoft', 'shoplifting', 'robbery', 'burglary', 'variance', 'aws',
    'zoom', 'slack', 'notion', 'figma', 'miro', 'tableau', 'power bi', 'azure'
  ];

  for (const kw of keywords) {
    if (input.includes(kw)) {
      console.log(`[catalogSearch] keyword match: "${kw}"`);
      return kw;
    }
  }

  return null;
};

// Build result array with ServiceNow URLs — unchanged from original
const buildResult = (rawItems, keyword, userType, storeNo) => {
  const items = rawItems.map(item => ({
    ...item,
    url: `${SNOW_BASE}/sp?id=sc_cat_item&sys_id=${item.sys_id}`,
    userType,
    storeNo
  }));
  return { items, keyword, userType, storeNo };
};

const searchCatalog = async (searchTerm, email) => {
  const storeNo   = getStoreNumber(email);
  const isRetail  = !!storeNo;
  const catalogId = isRetail ? CATALOGS.RETAIL : CATALOGS.CORPORATE;
  const userType  = isRetail ? 'retail' : 'corporate';

  const resolved = resolveAlias(searchTerm);
  const keyword  = extractPrimaryKeyword(resolved);

  console.log(`[catalogSearch] searching ${userType} catalog for: "${keyword}"`);

  const creds   = await getCreds();
  const token   = Buffer.from(`${creds.username}:${creds.password}`).toString('base64');
  const headers = {
    'Authorization': `Basic ${token}`,
    'Content-Type':  'application/json',
    'Accept':        'application/json'
  };
  const encoded = encodeURIComponent(keyword);
  const fields  = 'sysparm_fields=sys_id,name,short_description,active';
  const limit   = `sysparm_limit=${MAX_RESULTS}`;
  const catalog = `sc_catalogs=${catalogId}`;

  // Pass 1 — name match (precise)
  const queryNameOnly = encodeURIComponent(
    'active=true^nameLIKE' + encoded + '^ORDERBYname'
  );
  const urlNameOnly = SNOW_BASE + '/api/now/table/sc_cat_item?' + fields + '&' + limit + '&sysparm_query=' + queryNameOnly + '&' + catalog;

  console.log('[catalogSearch] pass 1 — name match');
  const res1  = await fetch(urlNameOnly, { method: 'GET', headers: headers });
  const json1 = await res1.json();

  if (!res1.ok) {
    console.error('[catalogSearch] API error (pass 1):', JSON.stringify(json1));
    throw new Error('ServiceNow catalog error ' + res1.status + ': ' + (json1 && json1.error ? json1.error.message : res1.statusText));
  }

  const items1 = json1.result || [];
  if (items1.length > 0) {
    console.log('[catalogSearch] found ' + items1.length + ' items (name match)');
    return buildResult(items1, keyword, userType, storeNo);
  }

  // Pass 2 — name + short_description (broader)
  console.log('[catalogSearch] pass 2 — broad match (no name results)');
  const queryBroad = encodeURIComponent(
    'active=true^nameLIKE' + encoded + '^ORshort_descriptionLIKE' + encoded + '^ORDERBYname'
  );
  const urlBroad = SNOW_BASE + '/api/now/table/sc_cat_item?' + fields + '&' + limit + '&sysparm_query=' + queryBroad + '&' + catalog;

  const res2  = await fetch(urlBroad, { method: 'GET', headers: headers });
  const json2 = await res2.json();

  if (!res2.ok) {
    console.error('[catalogSearch] API error (pass 2):', JSON.stringify(json2));
    throw new Error('ServiceNow catalog error ' + res2.status + ': ' + (json2 && json2.error ? json2.error.message : res2.statusText));
  }

  const items2 = json2.result || [];
  if (items2.length > 0) {
    console.log('[catalogSearch] found ' + items2.length + ' items (broad match)');
    return buildResult(items2, keyword, userType, storeNo);
  }

  // Pass 3 — known tool fallback (not in catalog but IT-managed)
  const lookupTerms = [
    searchTerm ? searchTerm.toLowerCase().trim() : null,
    resolved   ? resolved.toLowerCase().trim()   : null,
    keyword    ? keyword.toLowerCase().trim()     : null
  ].filter(function(t) { return t !== null; });

  var matchedTool = null;
  for (var i = 0; i < lookupTerms.length; i++) {
    if (KNOWN_TOOLS_FALLBACK[lookupTerms[i]]) {
      matchedTool = KNOWN_TOOLS_FALLBACK[lookupTerms[i]];
      break;
    }
  }

  if (matchedTool) {
    console.log('[catalogSearch] pass 3 — known tool fallback: "' + matchedTool.tools + '"');
    return {
      items:     [],
      keyword:   keyword,
      userType:  userType,
      storeNo:   storeNo,
      knownTool: matchedTool
    };
  }

  // 0 results
  console.log('[catalogSearch] found 0 items');
  return buildResult([], keyword, userType, storeNo);
};

module.exports = {
  searchCatalog:        searchCatalog,
  extractSearchTerm:    extractSearchTerm,
  resolveAlias:         resolveAlias,
  extractPrimaryKeyword: extractPrimaryKeyword,
  getStoreNumber:       getStoreNumber,
  isRetailEmail:        isRetailEmail,
  SEARCH_TERM_ALIASES:  SEARCH_TERM_ALIASES,
  KNOWN_TOOLS_FALLBACK: KNOWN_TOOLS_FALLBACK
};
