/**
 * Heartbeat daemon - simulates IDE background activity
 * Sends periodic loadCodeAssist and fetchAvailableModels calls
 * to make accounts look like active IDE sessions
 */

import { config } from '../config.js';
import { getAccessToken } from '../auth/token-store.js';
import { buildHeaders, getSessionFingerprint } from '../fingerprint/header-generator.js';
import { getSession } from '../fingerprint/session-lifecycle.js';

let heartbeatTimer = null;

/**
 * Start heartbeat daemon for all active accounts
 */
export function startHeartbeat() {
  if (!config.heartbeat.enabled) return;

  // Initial heartbeat after random delay (1-5 min)
  const initialDelay = 60000 + Math.random() * 240000;
  setTimeout(() => {
    runHeartbeat();
    // Then repeat at configured interval with jitter
    heartbeatTimer = setInterval(() => {
      runHeartbeat();
    }, config.heartbeat.intervalMs + (Math.random() - 0.5) * 60000);
  }, initialDelay);

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
 * Check if current hour is "quiet time" (midnight-7am in configured timezone)
 * Real developers rarely code at these hours — reduce heartbeat frequency
 * Uses config.heartbeat.timezone (e.g., 'America/Los_Angeles') or defaults to UTC
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
  // During quiet hours, skip ~80% of heartbeats (occasional activity is fine)
  if (isQuietHour() && Math.random() < 0.8) {
    return;
  }

  for (const account of config.accounts) {
    if (account.enabled === false) continue;

    try {
      // Random choice: loadCodeAssist (70%) or fetchAvailableModels (30%)
      if (Math.random() < 0.7) {
        await sendLoadCodeAssist(account.email);
      } else {
        await sendFetchModels(account.email);
      }
    } catch (e) {
      console.warn(`[Heartbeat] Failed for ${account.email}: ${e.message}`);
    }

    // Stagger between accounts (2-8s)
    await sleep(2000 + Math.random() * 6000);
  }
}

/**
 * Send loadCodeAssist - mimics IDE checking code assist availability
 */
async function sendLoadCodeAssist(email) {
  const sessionKey = `heartbeat:${email}`;
  const token = await getAccessToken(email);
  const session = getSession(sessionKey);
  const headers = buildHeaders(token, sessionKey, '', 'application/json', session.sessionId);

  const endpoint = config.api.endpoints[0]; // prod endpoint
  const url = `${endpoint}/v1internal:loadCodeAssist`;

  const body = {
    metadata: {
      ideType: 9,
      platform: getSessionFingerprint(sessionKey).platformEnum,
      pluginType: 2
    }
  };

  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000)
  });

  if (res.ok) {
    console.log(`[Heartbeat] loadCodeAssist OK for ${email}`);
  } else {
    const text = await res.text();
    console.warn(`[Heartbeat] loadCodeAssist ${res.status} for ${email}: ${text.slice(0, 100)}`);
  }
}

/**
 * Send fetchAvailableModels - mimics IDE refreshing model list
 */
async function sendFetchModels(email) {
  const sessionKey = `heartbeat:${email}`;
  const token = await getAccessToken(email);
  const headers = buildHeaders(token, sessionKey, '', 'application/json');

  const endpoint = config.api.endpoints[0];
  const url = `${endpoint}/v1internal:fetchAvailableModels`;

  const body = {
    metadata: {
      ideType: 9,
      platform: getSessionFingerprint(sessionKey).platformEnum,
      pluginType: 2
    }
  };

  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000)
  });

  if (res.ok) {
    console.log(`[Heartbeat] fetchModels OK for ${email}`);
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
