/**
 * Header generator - exact replication of real Antigravity client headers
 * Based on mitmproxy packet capture analysis of real Antigravity 1.20.6
 *
 * CRITICAL: Real client is a Node.js (google-api-nodejs-client) application.
 * Headers must be in fixed alphabetical order with NO extra headers.
 */

import { platform, arch } from 'os';

// Real Antigravity version (from packet capture)
const ANTIGRAVITY_VERSION = '1.20.6';

// google-api-nodejs-client version (from real UA in packet capture)
const NODEJS_CLIENT_VERSION = '10.3.0';

// Node.js version reported in x-goog-api-client (from packet capture: gl-node/22.21.1)
const NODE_VERSION = '22.21.1';

// Platform string in Node.js format (darwin/arm64, linux/x64, etc.)
// Real client is Node.js (google-api-nodejs-client), NOT Go — uses Node.js arch names
function getPlatformString() {
  const os = platform();
  const cpu = arch();
  const osMap = { darwin: 'darwin', linux: 'linux', win32: 'windows' };
  // Node.js uses 'arm64' and 'x64' natively — do NOT convert to Go's 'amd64'
  return `${osMap[os] || os}/${cpu}`;
}

const PLATFORM_STRING = getPlatformString();

/**
 * Build request headers that exactly match the real Antigravity client.
 *
 * Real client sends headers in fixed alphabetical order:
 *   accept, accept-encoding, authorization, content-length (POST), content-type, user-agent, x-goog-api-client
 *   (Host and Connection are added by HTTP library)
 *
 * NO other headers. No X-Client-Name, no X-Client-Version, no x-server-timeout,
 * no X-Machine-Session-Id, no x-cloudaicompanion-trace-id, no anthropic-beta.
 *
 * @param {string} accessToken - OAuth2 Bearer token
 * @returns {Object} headers in correct alphabetical order
 */
export function buildHeaders(accessToken) {
  // Headers MUST be in this exact alphabetical order
  // Real client sends content-type: application/json for BOTH GET and POST
  // (confirmed by packet capture: cascadeNuxes GET also has content-type)
  // content-length is added automatically by the HTTP library for POST
  const headers = {
    'accept': '*/*',
    'accept-encoding': 'gzip, deflate, br',
    'authorization': `Bearer ${accessToken}`,
    'content-type': 'application/json',
  };

  headers['user-agent'] = `antigravity/${ANTIGRAVITY_VERSION} ${PLATFORM_STRING} google-api-nodejs-client/${NODEJS_CLIENT_VERSION}`;
  headers['x-goog-api-client'] = `gl-node/${NODE_VERSION}`;

  return headers;
}

/**
 * Get client metadata for loadCodeAssist request body.
 * Real client sends string enum values, not numeric.
 * @returns {Object}
 */
export function getClientMetadata() {
  return {
    ide_type: 'ANTIGRAVITY',
    ide_version: ANTIGRAVITY_VERSION,
    ide_name: 'antigravity'
  };
}

/**
 * Get the Antigravity version string
 * @returns {string}
 */
export function getAntigravityVersion() {
  return ANTIGRAVITY_VERSION;
}
