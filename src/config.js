/**
 * Configuration loader
 * Loads from config.json with environment variable overrides
 */

import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { homedir } from 'os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..');
const CONFIG_DIR = join(homedir(), '.config', 'antigravity-stealth-proxy');

function loadJsonSafe(path) {
  try {
    if (existsSync(path)) {
      return JSON.parse(readFileSync(path, 'utf-8'));
    }
  } catch (e) {
    console.error(`[Config] Failed to load ${path}:`, e.message);
  }
  return {};
}

// Load config from multiple locations (project dir, then user config dir)
const projectConfig = loadJsonSafe(join(PROJECT_ROOT, 'config.json'));
const userConfig = loadJsonSafe(join(CONFIG_DIR, 'config.json'));
const merged = { ...projectConfig, ...userConfig };

export const config = {
  // Server
  port: parseInt(process.env.PORT || merged.port || '8080', 10),
  host: process.env.HOST || merged.host || '0.0.0.0',

  // Auth
  apiKeys: merged.apiKeys || {},  // { "user-label": "sk-xxx" }

  // Accounts
  accounts: merged.accounts || [],
  // Format: [{ email, refreshToken, label?, enabled? }]

  // User → Account binding
  userBindings: merged.userBindings || {},
  // Format: { "sk-xxx": { primary: "email1", backup: "email2" } }

  // Rate limiting (per account)
  pacer: {
    maxRequestsPerMinute: merged.pacer?.maxRequestsPerMinute || 5,
    burstSize: merged.pacer?.burstSize || 3,
    jitterMinMs: merged.pacer?.jitterMinMs || 1000,
    jitterMaxMs: merged.pacer?.jitterMaxMs || 4000,
    dailyLimitPerAccount: merged.pacer?.dailyLimitPerAccount || 500,
    ...merged.pacer
  },

  // Session lifecycle
  session: {
    minLifetimeMs: merged.session?.minLifetimeMs || (2 * 60 * 60 * 1000),   // 2h
    maxLifetimeMs: merged.session?.maxLifetimeMs || (6 * 60 * 60 * 1000),   // 6h
    restartDelayMs: merged.session?.restartDelayMs || 10000,                  // 10s
    ...merged.session
  },

  // Retry (conservative)
  retry: {
    maxRetries: merged.retry?.maxRetries || 2,
    waitBeforeSwitch: merged.retry?.waitBeforeSwitch || 60000,  // 60s before switching account
    maxWaitMs: merged.retry?.maxWaitMs || 120000,
    ...merged.retry
  },

  // Heartbeat
  heartbeat: {
    enabled: merged.heartbeat?.enabled !== false,
    intervalMs: merged.heartbeat?.intervalMs || (30 * 60 * 1000),  // 30min
    timezone: merged.heartbeat?.timezone || 'America/Los_Angeles', // Quiet hours timezone
    ...merged.heartbeat
  },

  // Paths
  paths: {
    configDir: CONFIG_DIR,
    dbPath: join(CONFIG_DIR, 'state.db'),
    accountsPath: join(CONFIG_DIR, 'accounts.json'),
  },

  // OAuth (Antigravity's client credentials)
  oauth: {
    clientId: merged.oauth?.clientId || '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com',
    clientSecret: merged.oauth?.clientSecret || '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',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    scopes: [
      'https://www.googleapis.com/auth/cloud-platform',
      'https://www.googleapis.com/auth/userinfo.email',
      'https://www.googleapis.com/auth/userinfo.profile',
      'https://www.googleapis.com/auth/cclog',
      'https://www.googleapis.com/auth/experimentsandconfigs'
    ],
    callbackPort: 51121,
    ...merged.oauth
  },

  // Cloud Code API
  api: {
    endpoints: [
      'https://cloudcode-pa.googleapis.com',
      'https://daily-cloudcode-pa.googleapis.com'
    ],
    defaultProjectId: 'rising-fact-p41fc',
    ...merged.api
  },

  // Version pools (override defaults in header-generator.js)
  versionPools: merged.versionPools || null,

  // Outbound proxy for API requests (residential IP / Cloudflare WARP)
  // Supports HTTP/HTTPS/SOCKS5 proxies
  // Example: "socks5://127.0.0.1:40000" or "http://user:pass@proxy.example.com:8080"
  outboundProxy: process.env.OUTBOUND_PROXY || merged.outboundProxy || null
};

export default config;
