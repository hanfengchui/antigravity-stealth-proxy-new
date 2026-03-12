/**
 * Token store - manages access tokens with caching and auto-refresh
 */

import { refreshAccessToken } from './oauth.js';
import { config } from '../config.js';

// In-memory token cache: email -> { accessToken, expiresAt, refreshToken }
const tokenCache = new Map();

/**
 * Initialize token store with accounts from config
 */
export function initTokenStore() {
  for (const account of config.accounts) {
    if (account.enabled !== false && account.refreshToken) {
      tokenCache.set(account.email, {
        accessToken: null,
        expiresAt: 0,
        refreshToken: account.refreshToken
      });
    }
  }
}

/**
 * Get a valid access token for an account, refreshing if needed
 * @param {string} email
 * @returns {Promise<string>} access token
 */
export async function getAccessToken(email) {
  const entry = tokenCache.get(email);
  if (!entry) throw new Error(`No token entry for ${email}`);

  // Return cached token if still valid (with 60s buffer)
  if (entry.accessToken && entry.expiresAt > Date.now() + 60000) {
    return entry.accessToken;
  }

  // Refresh
  const { accessToken, expiresAt } = await refreshAccessToken(entry.refreshToken);
  entry.accessToken = accessToken;
  entry.expiresAt = expiresAt;
  return accessToken;
}

/**
 * Invalidate cached token for an account (force re-refresh on next call)
 * @param {string} email
 */
export function invalidateToken(email) {
  const entry = tokenCache.get(email);
  if (entry) {
    entry.accessToken = null;
    entry.expiresAt = 0;
  }
}

/**
 * Add or update an account in the token store
 * @param {string} email
 * @param {string} refreshToken
 */
export function setAccount(email, refreshToken) {
  tokenCache.set(email, {
    accessToken: null,
    expiresAt: 0,
    refreshToken
  });
}

/**
 * Check if an account exists in the store
 * @param {string} email
 * @returns {boolean}
 */
export function hasAccount(email) {
  return tokenCache.has(email);
}

/**
 * Get all account emails
 * @returns {string[]}
 */
export function getAccountEmails() {
  return [...tokenCache.keys()];
}
