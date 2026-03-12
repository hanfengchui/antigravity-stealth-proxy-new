/**
 * Token bucket rate limiter with human-like jitter
 * Controls request pacing to mimic natural IDE usage patterns
 */

import { config } from '../config.js';

// Per-account buckets: email -> { tokens, lastRefill, queue }
const buckets = new Map();

function randomBetween(min, max) {
  return min + Math.random() * (max - min);
}

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
  bucket.tokens = Math.min(bucket.maxTokens, bucket.tokens + newTokens);
  bucket.lastRefill = now;
}

/**
 * Wait for rate limit clearance + apply human-like jitter
 * @param {string} email - account email
 * @returns {Promise<void>} resolves when request can proceed
 */
export async function paceRequest(email) {
  const bucket = getBucket(email);
  refillBucket(bucket);

  // If no tokens available, calculate wait time
  if (bucket.tokens < 1) {
    const waitMs = (1 - bucket.tokens) / bucket.refillRate;
    await sleep(waitMs);
    refillBucket(bucket);
  }

  // Consume a token
  bucket.tokens -= 1;
  bucket.pending += 1;

  // Apply human-like jitter (normal distribution, mean ~2s)
  const jitterMean = (config.pacer.jitterMinMs + config.pacer.jitterMaxMs) / 2;
  const jitterStddev = (config.pacer.jitterMaxMs - config.pacer.jitterMinMs) / 4;
  const jitter = normalRandom(jitterMean, jitterStddev);
  const clampedJitter = Math.max(config.pacer.jitterMinMs, Math.min(config.pacer.jitterMaxMs, jitter));

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
  refillBucket(bucket);
  return {
    tokens: Math.floor(bucket.tokens * 10) / 10,
    pending: bucket.pending,
    maxPerMin: config.pacer.maxRequestsPerMinute
  };
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
