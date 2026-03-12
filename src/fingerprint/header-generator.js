/**
 * Dynamic fingerprint engine - version detection and header randomization
 * Generates realistic request headers that vary per-request to avoid static fingerprinting
 */

import { config } from '../config.js';

// Antigravity version ranges (for X-Client-Version, NOT User-Agent)
const ANTIGRAVITY_VERSIONS = [
  '1.104.0', '1.104.1', '1.105.0', '1.105.1', '1.105.2',
  '1.106.0', '1.106.1', '1.107.0', '1.107.1', '1.108.0',
  '1.108.1', '1.109.0', '1.109.1', '1.110.0'
];

// VS Code versions for User-Agent (Google blocks "antigravity" in UA)
const VSCODE_VERSIONS = [
  '1.93.0', '1.93.1', '1.94.0', '1.94.1', '1.94.2',
  '1.95.0', '1.95.1', '1.96.0', '1.96.1', '1.96.2',
  '1.97.0', '1.97.1', '1.98.0'
];

// Realistic Node.js versions
const NODE_VERSIONS = [
  '18.18.2', '18.19.0', '18.19.1', '18.20.0', '18.20.2', '18.20.4',
  '20.11.0', '20.11.1', '20.12.0', '20.12.2', '20.13.1', '20.14.0',
  '22.11.0', '22.12.0'
];

// Firebase/gRPC version combos seen in the wild
const GRPC_COMBOS = [
  'fire/0.8.6 grpc/1.10.x',
  'fire/0.8.7 grpc/1.10.x',
  'fire/0.8.8 grpc/1.10.x',
  'fire/0.9.0 grpc/1.10.x',
  'fire/0.9.1 grpc/1.10.x',
  'fire/0.8.6 grpc/1.11.x',
  'fire/0.8.7 grpc/1.11.x',
  'fire/0.9.0 grpc/1.11.x'
];

// Simulated platform diversity (server always reports as one of these)
// Real binary uses: darwin/arm64, darwin/x64, linux/x64, win32/x64
// (Node.js os.platform() + process.arch format, NOT friendly names)
const PLATFORM_POOL = [
  { str: 'darwin/arm64', enum: 2 },
  { str: 'darwin/x64', enum: 1 },
  { str: 'linux/x64', enum: 3 },
  { str: 'win32/x64', enum: 5 },
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
    nodeVersion: randomPick(NODE_VERSIONS),
    grpcCombo: randomPick(GRPC_COMBOS),
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
 * Build request headers for Cloud Code API
 * Headers are consistent within a session but vary between sessions
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
    'x-goog-api-client': `gl-node/${fp.nodeVersion} ${fp.grpcCombo}`,
    'x-server-timeout': '600'
  };

  if (sessionId) {
    headers['X-Machine-Session-Id'] = sessionId;
  }

  // Add interleaved thinking header for Claude thinking models
  const modelLower = (model || '').toLowerCase();
  if (modelLower.includes('claude') && modelLower.includes('thinking')) {
    headers['anthropic-beta'] = 'interleaved-thinking-2025-05-14';
  }

  return headers;
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
