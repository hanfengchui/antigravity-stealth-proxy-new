/**
 * Project ID discovery - discovers Cloud Code project IDs per account
 * Uses loadCodeAssist API to find each account's cloudaicompanionProject
 *
 * CRITICAL: Must use exact same headers and body format as real Antigravity client.
 * Real client sends: { metadata: { ide_type: "ANTIGRAVITY", ide_version: "1.20.6", ide_name: "antigravity" } }
 * NOT numeric enums.
 */

import { config } from '../config.js';
import { getAccessToken } from './token-store.js';
import { proxyFetch } from '../http-client.js';
import { buildHeaders, getClientMetadata } from '../fingerprint/header-generator.js';

// Cache: email -> { projectId, tier, discoveredAt }
const projectCache = new Map();

/**
 * Discover project ID for an account via loadCodeAssist
 * @param {string} email
 * @returns {Promise<string>} project ID
 */
export async function discoverProjectId(email) {
  const cached = projectCache.get(email);
  if (cached && cached.projectId) {
    return cached.projectId;
  }

  const token = await getAccessToken(email);
  // Use exact same headers as real client (alphabetical order, no extras)
  // Add connection: close to match real client behavior
  const headers = { ...buildHeaders(token), connection: 'close' };

  const endpoints = [
    'https://cloudcode-pa.googleapis.com',
    'https://daily-cloudcode-pa.googleapis.com'
  ];

  for (const endpoint of endpoints) {
    try {
      const res = await proxyFetch(`${endpoint}/v1internal:loadCodeAssist`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          metadata: getClientMetadata()
        }),
        signal: AbortSignal.timeout(15000)
      });

      if (!res.ok) continue;

      const data = await res.json();

      let projectId = null;
      if (typeof data.cloudaicompanionProject === 'string') {
        projectId = data.cloudaicompanionProject;
      } else if (data.cloudaicompanionProject?.id) {
        projectId = data.cloudaicompanionProject.id;
      }

      if (projectId) {
        const tier = data.currentTier?.id || 'unknown';
        projectCache.set(email, {
          projectId,
          tier,
          tierName: data.currentTier?.name || 'Unknown',
          discoveredAt: Date.now()
        });
        console.log(`[ProjectDiscovery] ${email}: project=${projectId}, tier=${tier}`);
        return projectId;
      }
    } catch (e) {
      console.warn(`[ProjectDiscovery] ${endpoint} failed for ${email}: ${e.message}`);
    }
  }

  const fallback = config.api.defaultProjectId;
  console.warn(`[ProjectDiscovery] Using fallback project ID for ${email}: ${fallback}`);
  return fallback;
}

/**
 * Get cached project info for an account
 * @param {string} email
 * @returns {{ projectId: string, tier: string, tierName: string } | null}
 */
export function getProjectInfo(email) {
  return projectCache.get(email) || null;
}

/**
 * Discover project IDs for all enabled accounts
 * Called on startup
 */
export async function discoverAllProjects() {
  const accounts = config.accounts.filter(a => a.enabled !== false);
  for (const account of accounts) {
    try {
      await discoverProjectId(account.email);
    } catch (e) {
      console.error(`[ProjectDiscovery] Failed for ${account.email}: ${e.message}`);
    }
  }
}

/**
 * Invalidate cached project for an account (e.g., on auth error)
 * @param {string} email
 */
export function invalidateProject(email) {
  projectCache.delete(email);
}
