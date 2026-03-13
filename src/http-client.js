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
      keepAliveTimeout: 60000,
      connect: { rejectUnauthorized: true }
    });
  }
  return sharedProxyAgent;
}

/**
 * Fetch with outbound proxy support
 * Drop-in replacement for global fetch() — routes through proxy if configured
 * @param {string | URL} url
 * @param {RequestInit & { signal?: AbortSignal }} init
 * @returns {Promise<Response>}
 */
export async function proxyFetch(url, init = {}) {
  const dispatcher = getProxyDispatcher();
  if (dispatcher) {
    return undiciFetch(url, { ...init, dispatcher });
  }
  return fetch(url, init);
}
