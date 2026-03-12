/**
 * User → Account sticky router
 * Each user is bound to a primary account with optional backup failover
 */

import { config } from '../config.js';
import { getUserBinding } from '../auth/api-keys.js';

// Runtime state: apiKey -> { current: email, switchedAt: number, failCount: number }
const routeState = new Map();

// Account-level cooldowns: email -> { until: number, reason: string }
const cooldowns = new Map();

/**
 * Get the account to use for a given API key
 * Implements sticky routing with conservative failover
 * @param {string} apiKey
 * @returns {{ email: string | null, isBackup: boolean, waitMs: number }}
 */
export function routeRequest(apiKey) {
  const binding = getUserBinding(apiKey);
  if (!binding) {
    // No binding - use first available account
    const firstAccount = config.accounts.find(a => a.enabled !== false);
    return { email: firstAccount?.email || null, isBackup: false, waitMs: 0 };
  }

  const state = getRouteState(apiKey);
  const primaryCooldown = getCooldown(binding.primary);
  const now = Date.now();

  // Primary is available - always prefer it
  if (!primaryCooldown || primaryCooldown.until <= now) {
    // If we were on backup, switch back to primary
    if (state.current !== binding.primary) {
      state.current = binding.primary;
      state.switchedAt = now;
      state.failCount = 0;
    }
    return { email: binding.primary, isBackup: false, waitMs: 0 };
  }

  // Primary is in cooldown - check remaining wait
  const remainingMs = primaryCooldown.until - now;

  // If wait is short enough, wait instead of switching (conservative approach)
  if (remainingMs <= config.retry.waitBeforeSwitch) {
    return { email: binding.primary, isBackup: false, waitMs: remainingMs + 500 };
  }

  // Wait is too long - try backup if available
  if (binding.backup) {
    const backupCooldown = getCooldown(binding.backup);
    if (!backupCooldown || backupCooldown.until <= now) {
      state.current = binding.backup;
      state.switchedAt = now;
      return { email: binding.backup, isBackup: true, waitMs: 0 };
    }

    // Both in cooldown - return the one with shorter wait
    const backupRemaining = backupCooldown.until - now;
    if (backupRemaining < remainingMs) {
      return { email: binding.backup, isBackup: true, waitMs: backupRemaining + 500 };
    }
  }

  // Only primary available, must wait
  return { email: binding.primary, isBackup: false, waitMs: remainingMs + 500 };
}

/**
 * Mark an account as rate-limited (cooldown)
 * @param {string} email
 * @param {number} durationMs
 * @param {string} [reason]
 */
export function markCooldown(email, durationMs, reason = 'rate_limited') {
  cooldowns.set(email, {
    until: Date.now() + durationMs,
    reason
  });
}

/**
 * Clear cooldown for an account
 * @param {string} email
 */
export function clearCooldown(email) {
  cooldowns.delete(email);
}

/**
 * Notify successful request (resets fail count)
 * @param {string} apiKey
 */
export function notifySuccess(apiKey) {
  const state = getRouteState(apiKey);
  state.failCount = 0;
}

/**
 * Notify failed request
 * @param {string} apiKey
 */
export function notifyFailure(apiKey) {
  const state = getRouteState(apiKey);
  state.failCount += 1;
}

function getRouteState(apiKey) {
  if (!routeState.has(apiKey)) {
    const binding = getUserBinding(apiKey);
    routeState.set(apiKey, {
      current: binding?.primary || null,
      switchedAt: Date.now(),
      failCount: 0
    });
  }
  return routeState.get(apiKey);
}

function getCooldown(email) {
  const cd = cooldowns.get(email);
  if (cd && cd.until <= Date.now()) {
    cooldowns.delete(email);
    return null;
  }
  return cd;
}

/**
 * Get routing stats for monitoring
 * @returns {Array}
 */
export function getRoutingStats() {
  const stats = [];
  for (const [key, state] of routeState) {
    const cd = cooldowns.get(state.current);
    stats.push({
      apiKey: key.slice(0, 10) + '...',
      currentAccount: state.current,
      failCount: state.failCount,
      cooldownRemaining: cd ? Math.max(0, cd.until - Date.now()) : 0
    });
  }
  return stats;
}
