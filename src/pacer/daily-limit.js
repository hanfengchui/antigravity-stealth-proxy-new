/**
 * Daily request limit per account
 * Prevents extreme usage patterns that could trigger anomaly detection
 * Resets at UTC midnight
 */

import { config } from '../config.js';

// Per-account daily counters: email -> { count, resetDate }
const dailyCounters = new Map();

/**
 * Get today's date string in UTC (YYYY-MM-DD)
 * @returns {string}
 */
function getUTCDateString() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Get or create counter for an account
 * Auto-resets if the date has changed (UTC midnight)
 * @param {string} email
 * @returns {{ count: number, resetDate: string }}
 */
function getCounter(email) {
  const today = getUTCDateString();
  const existing = dailyCounters.get(email);

  if (!existing || existing.resetDate !== today) {
    const counter = { count: 0, resetDate: today };
    dailyCounters.set(email, counter);
    return counter;
  }

  return existing;
}

/**
 * Check if account has exceeded daily limit
 * @param {string} email
 * @returns {{ allowed: boolean, remaining: number, limit: number, used: number }}
 */
export function checkDailyLimit(email) {
  const limit = config.pacer.dailyLimitPerAccount;

  // If limit is 0 or not set, no limit enforced
  if (!limit) {
    return { allowed: true, remaining: Infinity, limit: 0, used: 0 };
  }

  const counter = getCounter(email);
  const remaining = Math.max(0, limit - counter.count);

  return {
    allowed: counter.count < limit,
    remaining,
    limit,
    used: counter.count
  };
}

/**
 * Increment daily counter for an account (call after successful request)
 * @param {string} email
 */
export function incrementDailyCount(email) {
  const counter = getCounter(email);
  counter.count += 1;
}

/**
 * Get daily usage stats for all tracked accounts
 * @returns {Object} email -> { used, limit, remaining, percentage }
 */
export function getDailyStats() {
  const limit = config.pacer.dailyLimitPerAccount || 0;
  const stats = {};

  for (const [email, counter] of dailyCounters) {
    const today = getUTCDateString();
    const used = counter.resetDate === today ? counter.count : 0;
    stats[email] = {
      used,
      limit,
      remaining: limit ? Math.max(0, limit - used) : Infinity,
      percentage: limit ? Math.round((used / limit) * 100) : 0,
      resetDate: counter.resetDate
    };
  }

  return stats;
}
