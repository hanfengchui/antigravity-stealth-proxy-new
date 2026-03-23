/**
 * Header generator - exact replication of real Antigravity client headers
 * Based on mitmproxy packet capture analysis of real Antigravity 1.20.6
 *
 * CRITICAL: Real client is a Node.js (google-api-nodejs-client) application.
 * Headers must be in fixed alphabetical order with NO extra headers.
 *
 * ANTI-DETECTION: Platform string and version numbers are configurable
 * via config.fingerprint to avoid exposing the real server OS (linux/x64).
 */

import { platform, arch } from 'os';
import * as grpc from '@grpc/grpc-js';
import { config } from '../config.js';

// Read versions from config (allows overriding when Antigravity updates)
const ANTIGRAVITY_VERSION = config.fingerprint.antigravityVersion;
const NODEJS_CLIENT_VERSION = config.fingerprint.nodejsClientVersion;
const NODE_VERSION = config.fingerprint.nodeVersion;
const VSCODE_VERSION = config.fingerprint.vscodeVersion;

// Platform string: use spoofed value from config, or real OS if set to "auto"
// CRITICAL: Running on linux/x64 with Antigravity UA is a detection vector —
// real Antigravity users are on darwin/arm64, darwin/x64, or win32/x64
const PLATFORM_STRING = config.fingerprint.platform === 'auto'
  ? `${platform()}/${arch()}`
  : config.fingerprint.platform;

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
 * @param {Object} [options]
 * @param {boolean} [options.isGeminiModel=false] - If true, use vscode UA for Gemini models
 * @returns {Object} headers in correct alphabetical order
 */
export function buildHeaders(accessToken, { isGeminiModel = false } = {}) {
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

  // CRITICAL: Claude models require antigravity UA, Gemini models require vscode UA
  // Using the wrong UA returns 404 Not Found
  if (isGeminiModel) {
    headers['user-agent'] = `vscode/${VSCODE_VERSION}`;
  } else {
    headers['user-agent'] = `antigravity/${ANTIGRAVITY_VERSION} ${PLATFORM_STRING} google-api-nodejs-client/${NODEJS_CLIENT_VERSION}`;
  }
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

/**
 * Build gRPC metadata headers that match the real Antigravity Go binary.
 *
 * The Go binary uses grpc-go and sends:
 *   - user-agent: grpc-go/1.80.0-dev
 *   - x-goog-api-client: gl-go/1.27 gccl/0.1.0
 *   - authorization: Bearer {token}
 *
 * content-type is NOT set here — @grpc/grpc-js automatically adds
 * content-type: application/grpc.
 *
 * @param {string} accessToken - OAuth2 Bearer token
 * @param {Object} [options]
 * @param {boolean} [options.isGeminiModel=false] - Model type
 * @returns {grpc.Metadata} gRPC metadata
 */
export function buildGrpcMetadata(accessToken, { isGeminiModel = false } = {}) {
  const metadata = new grpc.Metadata();

  metadata.set('authorization', `Bearer ${accessToken}`);
  metadata.set('user-agent', `grpc-go/${config.grpc.grpcGoVersion}`);
  metadata.set('x-goog-api-client', `gl-go/${config.grpc.goVersion} gccl/${config.grpc.gcclVersion}`);

  return metadata;
}
