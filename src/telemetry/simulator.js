/**
 * Telemetry simulator - sends realistic IDE usage events
 *
 * Real Antigravity IDE sends telemetry via cclog scope and experiments config.
 * A proxy that ONLY sends AI requests + heartbeats but ZERO telemetry is an
 * obvious automated fingerprint. This module fills that gap.
 */

import { randomUUID } from 'crypto';
import { config } from '../config.js';
import { getAccessToken } from '../auth/token-store.js';
import { getSessionFingerprint } from '../fingerprint/header-generator.js';
import { getSession } from '../fingerprint/session-lifecycle.js';

let telemetryTimer = null;

const IDE_EVENTS = [
  'editor.file.open',
  'editor.file.close',
  'editor.file.save',
  'codeAssist.completion.shown',
  'codeAssist.completion.accepted',
  'codeAssist.completion.dismissed',
  'codeAssist.chat.open',
  'codeAssist.chat.send',
  'codeAssist.agent.start',
  'codeAssist.agent.complete',
  'editor.search.open',
  'editor.terminal.open',
  'editor.debug.start',
];

const FILE_EXTENSIONS = [
  '.ts', '.tsx', '.js', '.jsx', '.py', '.go', '.rs',
  '.java', '.css', '.html', '.json', '.yaml', '.md',
  '.sql', '.sh', '.dockerfile', '.toml'
];

const LANGUAGES = [
  'typescript', 'javascript', 'python', 'go', 'rust',
  'java', 'css', 'html', 'json', 'yaml', 'markdown'
];

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
      if (Math.random() < 0.2) {
        await fetchExperimentConfigs(account.email);
      }
    } catch (e) {
      // Silent fail - telemetry errors should not affect main proxy
    }
    await sleep(randomBetween(3000, 8000));
  }
}

async function sendEventBatch(email) {
  const sessionKey = 'telemetry:' + email;
  const token = await getAccessToken(email);
  const fp = getSessionFingerprint(sessionKey);
  const session = getSession(sessionKey);

  const eventCount = Math.floor(randomBetween(2, 7));
  const events = [];
  const now = Date.now();

  for (let i = 0; i < eventCount; i++) {
    const eventType = randomPick(IDE_EVENTS);
    events.push({
      eventType,
      timestamp: new Date(now - Math.floor(randomBetween(0, 300000))).toISOString(),
      sessionId: session.sessionId,
      properties: buildEventProperties(eventType, fp)
    });
  }

  const endpoint = config.api.endpoints[0];
  const url = endpoint + '/v1internal:logEvents';

  const headers = {
    'Authorization': 'Bearer ' + token,
    'Content-Type': 'application/json',
    'User-Agent': 'antigravity/' + fp.antigravityVersion + ' ' + fp.platformString,
    'X-Client-Name': 'antigravity',
    'X-Client-Version': fp.antigravityVersion,
    'x-goog-api-client': 'gl-go/' + fp.goVersion + ' gccl/' + fp.gcclVersion
  };

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        events,
        metadata: {
          ideType: 9,
          platform: fp.platformEnum,
          pluginType: 2,
          clientVersion: fp.antigravityVersion
        }
      }),
      signal: AbortSignal.timeout(15000)
    });
    if (res.ok) {
      console.log('[Telemetry] Sent ' + eventCount + ' events for ' + email);
    }
  } catch (e) {
    // Network errors are fine - we tried
  }
}

function buildEventProperties(eventType, fp) {
  const props = {
    clientVersion: fp.antigravityVersion,
    platform: fp.platformString
  };

  if (eventType.startsWith('editor.file')) {
    props.fileExtension = randomPick(FILE_EXTENSIONS);
    props.fileSize = Math.floor(randomBetween(100, 50000));
  }

  if (eventType.includes('completion')) {
    props.language = randomPick(LANGUAGES);
    props.latencyMs = Math.floor(randomBetween(80, 2000));
    props.completionLength = Math.floor(randomBetween(10, 500));
    if (eventType.includes('accepted')) {
      props.acceptedLength = Math.floor(randomBetween(5, props.completionLength));
    }
  }

  if (eventType.includes('chat') || eventType.includes('agent')) {
    props.model = Math.random() < 0.6 ? 'claude-sonnet-4-6' : 'gemini-2.5-pro';
    props.tokenCount = Math.floor(randomBetween(50, 4000));
  }

  if (eventType.includes('terminal')) {
    props.shellType = randomPick(['bash', 'zsh', 'powershell', 'fish']);
  }

  return props;
}

async function fetchExperimentConfigs(email) {
  const sessionKey = 'telemetry:' + email;
  const token = await getAccessToken(email);
  const fp = getSessionFingerprint(sessionKey);

  const endpoint = config.api.endpoints[0];
  const url = endpoint + '/v1internal:getExperimentConfigs';

  const headers = {
    'Authorization': 'Bearer ' + token,
    'Content-Type': 'application/json',
    'User-Agent': 'antigravity/' + fp.antigravityVersion + ' ' + fp.platformString,
    'X-Client-Name': 'antigravity',
    'X-Client-Version': fp.antigravityVersion,
    'x-goog-api-client': 'gl-go/' + fp.goVersion + ' gccl/' + fp.gcclVersion
  };

  try {
    await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        metadata: {
          ideType: 9,
          platform: fp.platformEnum,
          pluginType: 2,
          clientVersion: fp.antigravityVersion
        }
      }),
      signal: AbortSignal.timeout(15000)
    });
  } catch (e) {
    // Silent
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
