/**
 * Session lifecycle manager
 * Simulates realistic IDE session behavior with periodic restarts
 */

import { randomUUID } from 'crypto';
import { config } from '../config.js';
// No longer need rotateFingerprint — we use fixed real version info, not random pools

// Active sessions: sessionKey -> { sessionId, projectId, createdAt, expiresAt }
const sessions = new Map();

// Sessions currently in "restart" cooldown
const restartingKeys = new Set();

function randomBetween(min, max) {
  return min + Math.random() * (max - min);
}

/**
 * Get or create a session for a user-account pair
 * @param {string} sessionKey - "user:account" key
 * @param {string} [projectId] - Cloud Code project ID
 * @returns {{ sessionId: string, projectId: string, isRestarting: boolean }}
 */
export function getSession(sessionKey, projectId = config.api.defaultProjectId) {
  // Check if session is in restart cooldown
  if (restartingKeys.has(sessionKey)) {
    return { sessionId: null, projectId, isRestarting: true };
  }

  const existing = sessions.get(sessionKey);

  // Return existing if still alive
  if (existing && existing.expiresAt > Date.now()) {
    return { sessionId: existing.sessionId, projectId: existing.projectId, isRestarting: false };
  }

  // Session expired or doesn't exist - create new one
  // If expired (not first time), simulate restart delay
  if (existing) {
    triggerRestart(sessionKey, projectId);
    return { sessionId: null, projectId, isRestarting: true };
  }

  // First time - create immediately
  return createSession(sessionKey, projectId);
}

/**
 * Create a new session
 */
function createSession(sessionKey, projectId) {
  const lifetime = randomBetween(config.session.minLifetimeMs, config.session.maxLifetimeMs);
  const sessionId = randomUUID();

  const session = {
    sessionId,
    projectId,
    createdAt: Date.now(),
    expiresAt: Date.now() + lifetime
  };

  sessions.set(sessionKey, session);
  return { sessionId, projectId, isRestarting: false };
}

/**
 * Simulate IDE restart - brief cooldown then new session
 */
function triggerRestart(sessionKey, projectId) {
  restartingKeys.add(sessionKey);

  // Random restart delay (5-15s)
  const delay = randomBetween(5000, 15000);

  setTimeout(() => {
    sessions.delete(sessionKey);
    createSession(sessionKey, projectId);
    restartingKeys.delete(sessionKey);
  }, delay);
}

/**
 * Force invalidate a session (e.g., on auth error)
 * @param {string} sessionKey
 */
export function invalidateSession(sessionKey) {
  sessions.delete(sessionKey);
}

/**
 * Get session info for monitoring
 * @returns {Array<{key: string, sessionId: string, age: number, remainingMs: number}>}
 */
export function getSessionStats() {
  const now = Date.now();
  const stats = [];
  for (const [key, s] of sessions) {
    stats.push({
      key,
      sessionId: s.sessionId.slice(0, 8) + '...',
      ageMinutes: Math.round((now - s.createdAt) / 60000),
      remainingMinutes: Math.round(Math.max(0, s.expiresAt - now) / 60000)
    });
  }
  return stats;
}
