/**
 * API Key authentication - maps incoming API keys to user identities
 */

import { config } from '../config.js';

// Reverse map: apiKey -> userLabel
const keyToUser = new Map();

export function initApiKeys() {
  for (const [label, key] of Object.entries(config.apiKeys)) {
    keyToUser.set(key, label);
  }
}

/**
 * Validate an API key and return the user label
 * @param {string} authHeader - "Bearer sk-xxx" or just "sk-xxx"
 * @returns {{ valid: boolean, user?: string, apiKey?: string }}
 */
export function validateApiKey(authHeader) {
  if (!authHeader) return { valid: false };

  const key = authHeader.startsWith('Bearer ')
    ? authHeader.slice(7).trim()
    : authHeader.trim();

  const user = keyToUser.get(key);
  if (!user) return { valid: false };

  return { valid: true, user, apiKey: key };
}

/**
 * Get account binding for a user's API key
 * @param {string} apiKey
 * @returns {{ primary: string, backup?: string } | null}
 */
export function getUserBinding(apiKey) {
  return config.userBindings[apiKey] || null;
}
