/**
 * Heartbeat daemon - simulates IDE background activity
 * Sends periodic loadCodeAssist and fetchAvailableModels calls
 * to make accounts look like active IDE sessions
 *
 * IMPORTANT: Uses the same session key as main request path (email)
 * so heartbeat and API requests share one session fingerprint per account.
 */

import { config } from '../config.js';
import { Pool, ProxyAgent } from 'undici';
import { getAccessToken } from '../auth/token-store.js';
import { buildHeaders, getSessionFingerprint } from '../fingerprint/header-generator.js';
import { getSession } from '../fingerprint/session-lifecycle.js';

let heartbeatTimer = null;

// Track which accounts have completed startup sequence
const startupCompleted = new Set();

// Heartbeat HTTP dispatcher (proxy or direct)
let heartbeatDispatcher = null;

function getHeartbeatDispatcher() {
  if (heartbeatDispatcher) return heartbeatDispatcher;

  if (config.outboundProxy) {
    heartbeatDispatcher = new ProxyAgent({
      uri: config.outboundProxy,
      keepAliveTimeout: 60000,
      connect: { rejectUnauthorized: true }
    });
  } else {
    heartbeatDispatcher = new Pool(config.api.endpoints[0], {
      connections: 2,
      pipelining: 1,
      keepAliveTimeout: 60000,
      connect: { rejectUnauthorized: true }
    });
  }
  return heartbeatDispatcher;
}

/**
 * Start heartbeat daemon for all active accounts
 * Runs IDE startup sequence first, then periodic heartbeats
 */
export function startHeartbeat() {
  if (!config.heartbeat.enabled) return;

  // Run startup sequence for all accounts first (staggered)
  runStartupSequence().then(() => {
    // After startup, begin periodic heartbeats with random initial delay (2-8 min)
    const initialDelay = 120000 + Math.random() * 360000;
    setTimeout(() => {
      runHeartbeat();
      heartbeatTimer = setInterval(() => {
        runHeartbeat();
      }, config.heartbeat.intervalMs + (Math.random() - 0.5) * 60000);
    }, initialDelay);
  });

  console.log(`[Heartbeat] Daemon started (interval: ${Math.round(config.heartbeat.intervalMs / 60000)}min)`);
}

/**
 * Stop heartbeat daemon
 */
export function stopHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

/**
 * Simulate IDE startup sequence for all accounts
 * Real IDE does: loadCodeAssist → fetchAvailableModels → (ready)
 * This runs once per account on proxy start
 */
async function runStartupSequence() {
  for (const account of config.accounts) {
    if (account.enabled === false) continue;

    try {
      // Step 1: loadCodeAssist (IDE checks if code assist is available)
      await sendLoadCodeAssist(account.email);
      await sleep(1500 + Math.random() * 3000);

      // Step 2: fetchAvailableModels (IDE loads model list)
      await sendFetchModels(account.email);

      startupCompleted.add(account.email);
      console.log(`[Heartbeat] Startup sequence complete for ${account.email}`);
    } catch (e) {
      console.warn(`[Heartbeat] Startup failed for ${account.email}: ${e.message}`);
    }

    // Stagger between accounts (3-10s)
    await sleep(3000 + Math.random() * 7000);
  }
}

/**
 * Check if current hour is "quiet time" (midnight-7am in configured timezone)
 * Real developers rarely code at these hours — reduce heartbeat frequency
 */
function isQuietHour() {
  const tz = config.heartbeat.timezone || 'America/Los_Angeles';
  const hour = parseInt(new Date().toLocaleString('en-US', { hour: 'numeric', hour12: false, timeZone: tz }), 10);
  return hour >= 0 && hour < 7;
}

/**
 * Run one heartbeat cycle for all accounts
 */
async function runHeartbeat() {
  if (isQuietHour() && Math.random() < 0.8) {
    return;
  }

  for (const account of config.accounts) {
    if (account.enabled === false) continue;

    try {
      if (Math.random() < 0.7) {
        await sendLoadCodeAssist(account.email);
      } else {
        await sendFetchModels(account.email);
      }
    } catch (e) {
      console.warn(`[Heartbeat] Failed for ${account.email}: ${e.message}`);
    }

    await sleep(2000 + Math.random() * 6000);
  }
}

/**
 * Send loadCodeAssist - mimics IDE checking code assist availability
 * Uses email as session key (shared with main request path)
 */
async function sendLoadCodeAssist(email) {
  const sessionKey = email;
  const token = await getAccessToken(email);
  const session = getSession(sessionKey);
  const headers = buildHeaders(token, sessionKey, '', 'application/json', session.sessionId);

  const endpoint = config.api.endpoints[0];
  const requestPath = '/v1internal:loadCodeAssist';
  const dispatcher = getHeartbeatDispatcher();
  const useProxy = !!config.outboundProxy;

  const body = JSON.stringify({
    metadata: {
      ideType: 9,
      platform: getSessionFingerprint(sessionKey).platformEnum,
      pluginType: 2
    }
  });

  const { statusCode, body: respBody } = await dispatcher.request({
    origin: useProxy ? endpoint : undefined,
    path: requestPath,
    method: 'POST',
    headers,
    body,
    headersTimeout: 30000,
    bodyTimeout: 30000
  });

  // Consume response body
  const chunks = [];
  for await (const chunk of respBody) chunks.push(chunk);

  if (statusCode >= 200 && statusCode < 300) {
    console.log(`[Heartbeat] loadCodeAssist OK for ${email}`);
  } else {
    const text = Buffer.concat(chunks).toString();
    console.warn(`[Heartbeat] loadCodeAssist ${statusCode} for ${email}: ${text.slice(0, 100)}`);
  }
}

/**
 * Send fetchAvailableModels - mimics IDE refreshing model list
 * Uses email as session key (shared with main request path)
 */
async function sendFetchModels(email) {
  const sessionKey = email;
  const token = await getAccessToken(email);
  const headers = buildHeaders(token, sessionKey, '', 'application/json');

  const endpoint = config.api.endpoints[0];
  const requestPath = '/v1internal:fetchAvailableModels';
  const dispatcher = getHeartbeatDispatcher();
  const useProxy = !!config.outboundProxy;

  const body = JSON.stringify({
    metadata: {
      ideType: 9,
      platform: getSessionFingerprint(sessionKey).platformEnum,
      pluginType: 2
    }
  });

  const { statusCode, body: respBody } = await dispatcher.request({
    origin: useProxy ? endpoint : undefined,
    path: requestPath,
    method: 'POST',
    headers,
    body,
    headersTimeout: 30000,
    bodyTimeout: 30000
  });

  // Consume response body to avoid memory leak
  for await (const _ of respBody) { /* drain */ }

  if (statusCode >= 200 && statusCode < 300) {
    console.log(`[Heartbeat] fetchModels OK for ${email}`);
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
