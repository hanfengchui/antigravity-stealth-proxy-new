/**
 * Token bucket rate limiter with context-aware human-like jitter
 * Controls request pacing to mimic natural IDE usage patterns
 * Supports intelligent delay based on request type (first message, follow-up, tool result)
 */

import { config } from '../config.js';

// Per-account buckets: email -> { tokens, lastRefill, pending }
const buckets = new Map();

// Normal distribution approximation (Box-Muller) for more natural jitter
function normalRandom(mean, stddev) {
  const u1 = Math.random();
  const u2 = Math.random();
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  return Math.max(0, mean + z * stddev);
}

function getBucket(email) {
  if (!buckets.has(email)) {
    buckets.set(email, {
      tokens: config.pacer.burstSize,
      maxTokens: config.pacer.burstSize,
      lastRefill: Date.now(),
      refillRate: config.pacer.maxRequestsPerMinute / 60000, // tokens per ms
      pending: 0
    });
  }
  return buckets.get(email);
}

function refillBucket(bucket) {
  const now = Date.now();
  const elapsed = now - bucket.lastRefill;
  const newTokens = elapsed * bucket.refillRate;
  return {
    ...bucket,
    tokens: Math.min(bucket.maxTokens, bucket.tokens + newTokens),
    lastRefill: now
  };
}

/**
 * Determine jitter range based on request context
 * - First message (messages.length === 1): longer delay (2-5s), simulates user typing
 * - Tool result follow-up: shorter delay (0.3-1.2s), simulates automated tool chain
 * - Normal follow-up: standard delay from config
 * @param {Object} [context] - optional request context
 * @returns {{ min: number, max: number }}
 */
function getContextualJitter(context) {
  if (!context) {
    return { min: config.pacer.jitterMinMs, max: config.pacer.jitterMaxMs };
  }

  const messageCount = context.messageCount || 0;
  const hasToolResult = context.hasToolResult || false;

  // First message in a conversation — user just opened chat and typed
  if (messageCount <= 1) {
    return { min: 2000, max: 5000 };
  }

  // Tool result follow-up — automated tool chain, quick turnaround
  if (hasToolResult) {
    return { min: 300, max: 1200 };
  }

  // Normal follow-up conversation
  return { min: config.pacer.jitterMinMs, max: config.pacer.jitterMaxMs };
}

/**
 * Wait for rate limit clearance + apply context-aware human-like jitter
 * @param {string} email - account email
 * @param {Object} [context] - optional context for intelligent delay
 * @param {number} [context.messageCount] - number of messages in the conversation
 * @param {boolean} [context.hasToolResult] - whether this is a tool result follow-up
 * @returns {Promise<void>} resolves when request can proceed
 */
export async function paceRequest(email, context) {
  const bucket = getBucket(email);
  const refilled = refillBucket(bucket);
  // Update bucket in-place for Map reference
  bucket.tokens = refilled.tokens;
  bucket.lastRefill = refilled.lastRefill;

  // If no tokens available, calculate wait time
  if (bucket.tokens < 1) {
    const waitMs = (1 - bucket.tokens) / bucket.refillRate;
    await sleep(waitMs);
    const refilled2 = refillBucket(bucket);
    bucket.tokens = refilled2.tokens;
    bucket.lastRefill = refilled2.lastRefill;
  }

  // Consume a token
  bucket.tokens -= 1;
  bucket.pending += 1;

  // Apply context-aware human-like jitter
  const jitterRange = getContextualJitter(context);
  const jitterMean = (jitterRange.min + jitterRange.max) / 2;
  const jitterStddev = (jitterRange.max - jitterRange.min) / 4;
  const jitter = normalRandom(jitterMean, jitterStddev);
  const clampedJitter = Math.max(jitterRange.min, Math.min(jitterRange.max, jitter));

  await sleep(clampedJitter);
  bucket.pending -= 1;
}

/**
 * Get rate limiter stats for monitoring
 * @param {string} email
 * @returns {{ tokens: number, pending: number, maxPerMin: number }}
 */
export function getPacerStats(email) {
  const bucket = getBucket(email);
  const refilled = refillBucket(bucket);
  bucket.tokens = refilled.tokens;
  bucket.lastRefill = refilled.lastRefill;
  return {
    tokens: Math.floor(bucket.tokens * 10) / 10,
    pending: bucket.pending,
    maxPerMin: config.pacer.maxRequestsPerMinute
  };
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
