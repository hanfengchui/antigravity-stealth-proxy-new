/**
 * Telemetry simulator - sends realistic IDE usage events
 *
 * Real Antigravity IDE sends telemetry via play.googleapis.com/log (Protobuf)
 * and cclog scope. A proxy that sends ZERO telemetry is an obvious automated
 * fingerprint. This module fills that gap.
 *
 * CRITICAL: Uses exact same headers as real client (from buildHeaders).
 */

import { config } from '../config.js';
import { getAccessToken } from '../auth/token-store.js';
import { buildHeaders, getAntigravityVersion } from '../fingerprint/header-generator.js';
import { getSession } from '../fingerprint/session-lifecycle.js';
import { proxyFetch } from '../http-client.js';

let telemetryTimer = null;

const IDE_EVENTS = [
  'selected_model_changed',
  'workbench_editor_restore',
  'agent_side_panel_init',
  'LS_STARTUP',
  'ANTIGRAVITY_EXTENSION_ACTIVATED',
  'editor.file.open',
  'editor.file.save',
  'codeAssist.completion.shown',
  'codeAssist.completion.accepted',
  'codeAssist.chat.open',
  'codeAssist.chat.send',
];

// Per-event-type realistic properties (real IDE sends different fields per event)
const EVENT_PROPERTIES = {
  'editor.file.open': () => ({
    fileExtension: randomPick(['.ts', '.js', '.py', '.go', '.rs', '.java', '.tsx', '.jsx', '.json', '.md']),
    languageId: randomPick(['typescript', 'javascript', 'python', 'go', 'rust', 'java', 'typescriptreact', 'json', 'markdown']),
  }),
  'editor.file.save': () => ({
    fileExtension: randomPick(['.ts', '.js', '.py', '.go', '.tsx', '.json']),
    languageId: randomPick(['typescript', 'javascript', 'python', 'go', 'typescriptreact', 'json']),
  }),
  'codeAssist.completion.shown': () => ({
    languageId: randomPick(['typescript', 'javascript', 'python', 'go']),
    completionLength: Math.floor(randomBetween(10, 200)),
  }),
  'codeAssist.completion.accepted': () => ({
    languageId: randomPick(['typescript', 'javascript', 'python', 'go']),
    completionLength: Math.floor(randomBetween(10, 150)),
    acceptLatencyMs: Math.floor(randomBetween(500, 5000)),
  }),
  'codeAssist.chat.send': () => ({
    messageLength: Math.floor(randomBetween(20, 500)),
    modelId: randomPick(['claude-sonnet-4-6', 'claude-sonnet-4-6-thinking', 'claude-opus-4-6-thinking']),
  }),
  'selected_model_changed': () => ({
    modelId: randomPick(['claude-sonnet-4-6', 'claude-sonnet-4-6-thinking', 'claude-opus-4-6-thinking']),
  }),
};

function randomPick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function randomBetween(min, max) {
  return min + Math.random() * (max - min);
}

function isQuietHour() {
  const tz = config.heartbeat.timezone || 'America/Los_Angeles';
  const hour = parseInt(new Date().toLocaleString('en-US', { hour: 'numeric', hour12: false, timeZone: tz }), 10);
  return hour >= 0 && hour < 7;
}

export function startTelemetry() {
  if (!config.heartbeat.enabled) return;
  const initialDelay = 120000 + Math.random() * 360000;
  setTimeout(() => {
    runTelemetryCycle();
    telemetryTimer = setInterval(() => {
      runTelemetryCycle();
    }, randomBetween(600000, 1200000));
  }, initialDelay);
  console.log('[Telemetry] Simulator started');
}

export function stopTelemetry() {
  if (telemetryTimer) {
    clearInterval(telemetryTimer);
    telemetryTimer = null;
  }
}

async function runTelemetryCycle() {
  if (isQuietHour() && Math.random() < 0.9) return;

  for (const account of config.accounts) {
    if (account.enabled === false) continue;
    try {
      const batchCount = Math.floor(randomBetween(1, 4));
      for (let i = 0; i < batchCount; i++) {
        await sendEventBatch(account.email);
        await sleep(randomBetween(500, 2000));
      }
    } catch (e) {
      // Silent fail - telemetry errors should not affect main proxy
    }
    await sleep(randomBetween(3000, 8000));
  }
}

async function sendEventBatch(email) {
  const token = await getAccessToken(email);
  const sessionKey = email;
  const session = getSession(sessionKey);

  const eventCount = Math.floor(randomBetween(2, 7));
  const events = [];
  const now = Date.now();

  for (let i = 0; i < eventCount; i++) {
    const eventType = randomPick(IDE_EVENTS);
    // Build realistic properties per event type
    const extraProps = EVENT_PROPERTIES[eventType] ? EVENT_PROPERTIES[eventType]() : {};
    events.push({
      eventType,
      timestamp: new Date(now - Math.floor(randomBetween(0, 300000))).toISOString(),
      sessionId: session.sessionId,
      properties: {
        ideName: 'antigravity',
        ideVersion: getAntigravityVersion(),
        ...extraProps
      }
    });
  }

  const endpoint = config.api.endpoints[0];
  const url = endpoint + '/v1internal:logEvents';

  // Use exact same headers as real client
  const headers = buildHeaders(token);

  try {
    const res = await proxyFetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        events,
        metadata: {
          ide_type: 'ANTIGRAVITY',
          ide_version: getAntigravityVersion(),
          ide_name: 'antigravity'
        }
      }),
      signal: AbortSignal.timeout(15000)
    });
    if (res.ok) {
      console.log('[Telemetry] Sent ' + eventCount + ' events for ' + email);
    }
  } catch (e) {
    // Network errors are fine
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
