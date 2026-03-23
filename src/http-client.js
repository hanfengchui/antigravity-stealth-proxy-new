/**
 * Shared HTTP client with outbound proxy support
 * All outbound requests to Google APIs should use this module
 * to ensure they go through the configured proxy (if any)
 */

import { ProxyAgent, fetch as undiciFetch } from 'undici';
import { config } from './config.js';

let sharedProxyAgent = null;

/**
 * Get the shared proxy dispatcher (lazy init)
 * @returns {ProxyAgent | undefined}
 */
function getProxyDispatcher() {
  if (!config.outboundProxy) return undefined;

  if (!sharedProxyAgent) {
    sharedProxyAgent = new ProxyAgent({
      uri: config.outboundProxy,
      keepAliveTimeout: 0,  // No persistent connections — match real client behavior
      connect: { rejectUnauthorized: true }
    });
  }
  return sharedProxyAgent;
}

/**
 * Fetch with outbound proxy support
 * Drop-in replacement for global fetch() — routes through proxy if configured
 * CRITICAL: Always adds Connection: close to match real client behavior
 * (real Antigravity client creates a fresh TCP connection per request)
 * @param {string | URL} url
 * @param {RequestInit & { signal?: AbortSignal }} init
 * @returns {Promise<Response>}
 */
export async function proxyFetch(url, init = {}) {
  // Ensure Connection: close to match real client behavior
  const headers = { ...init.headers, connection: 'close' };
  const opts = { ...init, headers };

  const dispatcher = getProxyDispatcher();
  if (dispatcher) {
    return undiciFetch(url, { ...opts, dispatcher });
  }
  return fetch(url, opts);
}
