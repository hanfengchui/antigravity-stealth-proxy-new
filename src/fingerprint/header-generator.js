/**
 * Dynamic fingerprint engine - version detection and header randomization
 * Generates realistic request headers that vary per-request to avoid static fingerprinting
 * Version pools are configurable via config.json (versionPools)
 */

import { randomUUID } from 'crypto';
import { config } from '../config.js';

// Default version pools (used when config.versionPools is not set)
const DEFAULT_ANTIGRAVITY_VERSIONS = [
  '1.104.0', '1.104.1', '1.105.0', '1.105.1', '1.105.2',
  '1.106.0', '1.106.1', '1.107.0', '1.107.1', '1.108.0',
  '1.108.1', '1.109.0', '1.109.1', '1.110.0'
];

const DEFAULT_VSCODE_VERSIONS = [
  '1.93.0', '1.93.1', '1.94.0', '1.94.1', '1.94.2',
  '1.95.0', '1.95.1', '1.96.0', '1.96.1', '1.96.2',
  '1.97.0', '1.97.1', '1.98.0'
];

// Go runtime versions (real Antigravity binary is written in Go)
const DEFAULT_GO_VERSIONS = [
  '1.23.0', '1.23.1', '1.23.2', '1.23.3', '1.23.4',
  '1.24.0', '1.24.1', '1.24.2'
];

// Google Cloud Client Library (gccl) versions
const DEFAULT_GCCL_VERSIONS = [
  '0.18.0', '0.19.0', '0.19.1', '0.20.0', '0.20.1', '0.21.0'
];

// Resolved version pools: config overrides > defaults
const ANTIGRAVITY_VERSIONS = config.versionPools?.antigravity || DEFAULT_ANTIGRAVITY_VERSIONS;
const VSCODE_VERSIONS = config.versionPools?.vscode || DEFAULT_VSCODE_VERSIONS;
const GO_VERSIONS = config.versionPools?.go || DEFAULT_GO_VERSIONS;
const GCCL_VERSIONS = config.versionPools?.gccl || DEFAULT_GCCL_VERSIONS;

// Platform pool using Go's runtime.GOOS/runtime.GOARCH format (NOT Node.js format)
// Real binary: darwin/arm64, darwin/amd64, linux/amd64, windows/amd64
const PLATFORM_POOL = [
  { str: 'darwin/arm64', enum: 2 },
  { str: 'darwin/amd64', enum: 1 },
  { str: 'linux/amd64', enum: 3 },
  { str: 'windows/amd64', enum: 5 },
];

// Pick a random simulated platform (not tied to actual server OS)
function getRandomPlatform() {
  return randomPick(PLATFORM_POOL);
}

function randomPick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

/**
 * Per-session fingerprint state - stays consistent within a session,
 * changes when session rotates (mimics IDE restart)
 */
const sessionFingerprints = new Map();

/**
 * Generate or retrieve a consistent fingerprint for a session
 * @param {string} sessionKey - unique key (e.g., "user:account")
 * @returns {Object} fingerprint with version info
 */
export function getSessionFingerprint(sessionKey) {
  if (sessionFingerprints.has(sessionKey)) {
    return sessionFingerprints.get(sessionKey);
  }

  const plat = getRandomPlatform();
  const fp = {
    antigravityVersion: randomPick(ANTIGRAVITY_VERSIONS),
    vscodeVersion: randomPick(VSCODE_VERSIONS),
    goVersion: randomPick(GO_VERSIONS),
    gcclVersion: randomPick(GCCL_VERSIONS),
    platformString: plat.str,
    platformEnum: plat.enum,
    createdAt: Date.now()
  };

  sessionFingerprints.set(sessionKey, fp);
  return fp;
}

/**
 * Rotate fingerprint for a session (called on session lifecycle restart)
 * @param {string} sessionKey
 */
export function rotateFingerprint(sessionKey) {
  sessionFingerprints.delete(sessionKey);
}

/**
 * Shuffle object key order to prevent header-order fingerprinting
 * Authorization and Content-Type must still be present but position varies
 * @param {Object} headers
 * @returns {Object} headers with randomized key order
 */
function shuffleHeaders(headers) {
  const keys = Object.keys(headers);
  // Fisher-Yates shuffle
  for (let i = keys.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const temp = keys[i];
    keys[i] = keys[j];
    keys[j] = temp;
  }
  const shuffled = {};
  for (const key of keys) {
    shuffled[key] = headers[key];
  }
  return shuffled;
}

/**
 * Build request headers for Cloud Code API
 * Headers are consistent within a session but vary between sessions
 * Header key order is randomized per-request to avoid order-based fingerprinting
 * @param {string} accessToken
 * @param {string} sessionKey
 * @param {string} model
 * @param {string} [accept] - Accept header value
 * @param {string} [sessionId] - Cloud Code session ID
 * @returns {Object} headers
 */
export function buildHeaders(accessToken, sessionKey, model, accept = 'text/event-stream', sessionId = null) {
  const fp = getSessionFingerprint(sessionKey);
  const isClaudeModel = (model || '').toLowerCase().includes('claude');

  // Claude models REQUIRE antigravity UA; Gemini models REQUIRE vscode UA
  const userAgent = isClaudeModel
    ? `antigravity/${fp.antigravityVersion} ${fp.platformString}`
    : `vscode/${fp.vscodeVersion}`;

  const headers = {
    'Authorization': `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
    'Accept': accept,
    'User-Agent': userAgent,
    'X-Client-Name': 'antigravity',
    'X-Client-Version': fp.antigravityVersion,
    'x-goog-api-client': `gl-go/${fp.goVersion} gccl/${fp.gcclVersion}`,
    'x-server-timeout': '600',
    'x-cloudaicompanion-trace-id': randomUUID()
  };

  if (sessionId) {
    headers['X-Machine-Session-Id'] = sessionId;
  }

  // Add interleaved thinking header for Claude thinking models
  const modelLower = (model || '').toLowerCase();
  if (modelLower.includes('claude') && modelLower.includes('thinking')) {
    headers['anthropic-beta'] = 'interleaved-thinking-2025-05-14';
  }

  // Randomize header key order to prevent order-based fingerprinting
  return shuffleHeaders(headers);
}

/**
 * Get client metadata for request body
 * @param {string} sessionKey
 * @returns {Object}
 */
export function getClientMetadata(sessionKey) {
  const fp = getSessionFingerprint(sessionKey);
  return {
    ideType: 9,           // ANTIGRAVITY
    platform: fp.platformEnum,
    pluginType: 2          // GEMINI
  };
}
