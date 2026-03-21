/**
 * Heartbeat daemon - simulates IDE background activity
 * Sends periodic loadCodeAssist and fetchAvailableModels calls
 * to make accounts look like active IDE sessions
 *
 * CRITICAL: Uses exact same headers/body format as real Antigravity client.
 * Each request uses Connection: close (no persistent pool).
 */

import { config } from '../config.js';
import { Client, ProxyAgent } from 'undici';
import { getAccessToken } from '../auth/token-store.js';
import { buildHeaders, getClientMetadata } from '../fingerprint/header-generator.js';
import { getProjectInfo } from '../auth/project-discovery.js';

let heartbeatTimer = null;
const startupCompleted = new Set();

// Shared ProxyAgent for proxy mode
let heartbeatProxyAgent = null;

function getProxyAgent() {
  if (!config.outboundProxy) return null;
  if (!heartbeatProxyAgent) {
    heartbeatProxyAgent = new ProxyAgent({
      uri: config.outboundProxy,
      connect: { rejectUnauthorized: true }
    });
  }
  return heartbeatProxyAgent;
}

/**
 * Make a single request with Connection: close (matching real client behavior)
 */
async function heartbeatRequest(endpoint, path, headers, body) {
  const proxy = getProxyAgent();

  if (proxy) {
    return proxy.request({
      origin: endpoint,
      path,
      method: 'POST',
      headers: { ...headers, connection: 'close' },
      body,
      headersTimeout: 30000,
      bodyTimeout: 30000,
    });
  }

  // Direct mode — fresh client per request
  const client = new Client(endpoint, {
    pipelining: 0,
    keepAliveTimeout: 0,
    connect: { rejectUnauthorized: true }
  });

  try {
    return await client.request({
      path,
      method: 'POST',
      headers: { ...headers, connection: 'close' },
      body,
      headersTimeout: 30000,
      bodyTimeout: 30000,
    });
  } catch (e) {
    client.close();
    throw e;
  }
}

/**
 * Start heartbeat daemon for all active accounts
 */
export function startHeartbeat() {
  if (!config.heartbeat.enabled) return;

  runStartupSequence().then(() => {
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
 * Real IDE: cascadeNuxes → loadCodeAssist → fetchUserInfo → fetchAvailableModels
 */
async function runStartupSequence() {
  for (const account of config.accounts) {
    if (account.enabled === false) continue;

    try {
      // Step 1: cascadeNuxes (GET, real client does this first)
      await sendCascadeNuxes(account.email);
      await sleep(500 + Math.random() * 1000);

      // Step 2: loadCodeAssist
      await sendLoadCodeAssist(account.email);
      await sleep(1500 + Math.random() * 3000);

      // Step 3: fetchUserInfo
      await sendFetchUserInfo(account.email);
      await sleep(800 + Math.random() * 1500);

      // Step 4: fetchAvailableModels
      await sendFetchModels(account.email);

      startupCompleted.add(account.email);
      console.log(`[Heartbeat] Startup sequence complete for ${account.email}`);
    } catch (e) {
      console.warn(`[Heartbeat] Startup failed for ${account.email}: ${e.message}`);
    }

    // Stagger between accounts
    await sleep(3000 + Math.random() * 7000);
  }
}

/**
 * Check if current hour is "quiet time"
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
 * Send cascadeNuxes - GET request, real client does this on startup
 */
async function sendCascadeNuxes(email) {
  const token = await getAccessToken(email);
  const headers = buildHeaders(token); // GET request, no content-type

  const endpoint = config.api.endpoints[0];
  const proxy = getProxyAgent();

  if (proxy) {
    const { statusCode, body } = await proxy.request({
      origin: endpoint,
      path: '/v1internal/cascadeNuxes',
      method: 'GET',
      headers: { ...headers, connection: 'close' },
      headersTimeout: 15000,
      bodyTimeout: 15000,
    });
    for await (const _ of body) { /* drain */ }
    if (statusCode >= 200 && statusCode < 300) {
      console.log(`[Heartbeat] cascadeNuxes OK for ${email}`);
    }
    return;
  }

  const client = new Client(endpoint, {
    pipelining: 0,
    keepAliveTimeout: 0,
    connect: { rejectUnauthorized: true }
  });

  try {
    const { statusCode, body } = await client.request({
      path: '/v1internal/cascadeNuxes',
      method: 'GET',
      headers: { ...headers, connection: 'close' },
      headersTimeout: 15000,
      bodyTimeout: 15000,
    });
    for await (const _ of body) { /* drain */ }
    if (statusCode >= 200 && statusCode < 300) {
      console.log(`[Heartbeat] cascadeNuxes OK for ${email}`);
    }
  } finally {
    client.close();
  }
}

/**
 * Send loadCodeAssist - real client body format with string enums
 */
async function sendLoadCodeAssist(email) {
  const token = await getAccessToken(email);
  const headers = buildHeaders(token);

  const endpoint = config.api.endpoints[0];
  const body = JSON.stringify({
    metadata: getClientMetadata()
  });

  const { statusCode, body: respBody } = await heartbeatRequest(
    endpoint, '/v1internal:loadCodeAssist', headers, body
  );

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
 * Send fetchUserInfo - real client sends { project: "<projectId>" }
 */
async function sendFetchUserInfo(email) {
  const token = await getAccessToken(email);
  const headers = buildHeaders(token);
  const projectInfo = getProjectInfo(email);
  const projectId = projectInfo?.projectId || config.api.defaultProjectId;

  const endpoint = config.api.endpoints[0];
  const body = JSON.stringify({ project: projectId });

  const { statusCode, body: respBody } = await heartbeatRequest(
    endpoint, '/v1internal:fetchUserInfo', headers, body
  );

  for await (const _ of respBody) { /* drain */ }

  if (statusCode >= 200 && statusCode < 300) {
    console.log(`[Heartbeat] fetchUserInfo OK for ${email}`);
  }
}

/**
 * Send fetchAvailableModels - real client sends { project: "<projectId>" }
 */
async function sendFetchModels(email) {
  const token = await getAccessToken(email);
  const headers = buildHeaders(token);
  const projectInfo = getProjectInfo(email);
  const projectId = projectInfo?.projectId || config.api.defaultProjectId;

  const endpoint = config.api.endpoints[0];
  const body = JSON.stringify({ project: projectId });

  const { statusCode, body: respBody } = await heartbeatRequest(
    endpoint, '/v1internal:fetchAvailableModels', headers, body
  );

  for await (const _ of respBody) { /* drain */ }

  if (statusCode >= 200 && statusCode < 300) {
    console.log(`[Heartbeat] fetchModels OK for ${email}`);
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
