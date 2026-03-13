/**
 * SSE streaming handler
 * Sends requests to Cloud Code API and streams responses back in Anthropic format
 * Uses undici connection pool for persistent connections (reduces TLS fingerprint exposure)
 */

import { Pool, ProxyAgent } from 'undici';
import { config } from '../config.js';
import { getAccessToken, invalidateToken } from '../auth/token-store.js';
import { discoverProjectId, getProjectInfo, invalidateProject } from '../auth/project-discovery.js';
import { buildHeaders } from '../fingerprint/header-generator.js';
import { getSession, invalidateSession } from '../fingerprint/session-lifecycle.js';
import { buildCloudCodeRequest } from './request.js';
import { resolveModel, isThinkingModel } from './model-map.js';
import { convertSSEEvent, buildStreamEnd, createStreamState } from './response.js';
import { paceRequest } from '../pacer/token-bucket.js';
import { incrementDailyCount } from '../pacer/daily-limit.js';
import { markCooldown, notifySuccess, notifyFailure } from '../routing/user-router.js';

// Connection pools per endpoint (persistent TCP connections, reduces TLS handshake frequency)
const connectionPools = new Map();

// Shared ProxyAgent if outbound proxy is configured
let proxyAgent = null;

/**
 * Get the dispatcher for making requests.
 * If outbound proxy is configured, uses ProxyAgent (all requests go through proxy).
 * Otherwise, uses per-endpoint Pool for persistent connections.
 * @param {string} endpoint - base URL
 * @returns {{ dispatcher: Pool | ProxyAgent, needsFullUrl: boolean }}
 */
function getDispatcher(endpoint) {
  // Proxy mode: single ProxyAgent handles all endpoints
  if (config.outboundProxy) {
    if (!proxyAgent) {
      proxyAgent = new ProxyAgent({
        uri: config.outboundProxy,
        keepAliveTimeout: 60000,
        keepAliveMaxTimeout: 300000,
        connect: {
          rejectUnauthorized: true
        }
      });
      console.log(`[Stream] Using outbound proxy: ${config.outboundProxy.replace(/\/\/.*@/, '//***@')}`);
    }
    return { dispatcher: proxyAgent, needsFullUrl: true };
  }

  // Direct mode: per-endpoint connection pool
  if (!connectionPools.has(endpoint)) {
    const pool = new Pool(endpoint, {
      connections: 4,
      pipelining: 1,
      keepAliveTimeout: 60000,
      keepAliveMaxTimeout: 300000,
      connect: {
        rejectUnauthorized: true
      }
    });
    connectionPools.set(endpoint, pool);
  }
  return { dispatcher: connectionPools.get(endpoint), needsFullUrl: false };
}

/**
 * Stream a message request through Cloud Code API
 * @param {Object} anthropicReq - Anthropic format request
 * @param {string} email - Account email to use
 * @param {string} apiKey - User's API key (for routing notifications)
 * @param {import('express').Response} res - Express response to stream to
 * @param {Object} [pacingContext] - Pacing context for intelligent delay
 */
export async function streamMessage(anthropicReq, email, apiKey, res, pacingContext) {
  // Use email as session key (shared with heartbeat daemon for unified fingerprint)
  const sessionKey = email;
  const requestedModel = anthropicReq.model || 'claude-sonnet-4-6-thinking';

  // Apply rate limiting + context-aware jitter
  await paceRequest(email, pacingContext);

  // Discover project ID for this account
  const projectId = await discoverProjectId(email);
  const projectInfo = getProjectInfo(email);
  const tier = projectInfo?.tier || 'standard-tier';

  // Resolve model name (maps Claude CLI names to available models)
  const resolved = resolveModel(requestedModel, tier);
  if (resolved.isFallback) {
    console.log(`[Stream] Model fallback: ${requestedModel} -> ${resolved.model} (tier: ${tier})`);
  }

  // Get or create session
  const session = getSession(sessionKey, projectId);
  if (session.isRestarting) {
    // Session is restarting (simulating IDE restart) - brief wait
    await sleep(config.session.restartDelayMs);
    const retrySession = getSession(sessionKey, projectId);
    if (retrySession.isRestarting) {
      throw new ProxyError(503, 'overloaded_error', 'Session restarting, please retry');
    }
    Object.assign(session, retrySession);
  }

  // Get access token
  const accessToken = await getAccessToken(email);

  // Build request with resolved model
  const resolvedReq = { ...anthropicReq, model: resolved.model };
  const payload = buildCloudCodeRequest(resolvedReq, projectId, sessionKey, session.sessionId);
  const headers = buildHeaders(accessToken, sessionKey, resolved.model, 'text/event-stream', session.sessionId);

  // Try endpoints in order (using connection pool for persistent connections)
  let lastError = null;
  for (const endpoint of config.api.endpoints) {
    try {
      const requestPath = '/v1internal:streamGenerateContent?alt=sse';
      const { dispatcher, needsFullUrl } = getDispatcher(endpoint);

      const { statusCode, headers: respHeaders, body } = await dispatcher.request({
        origin: needsFullUrl ? endpoint : undefined,
        path: requestPath,
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        headersTimeout: 30000,
        bodyTimeout: 600000 // 10 min timeout
      });

      if (statusCode < 200 || statusCode >= 300) {
        const chunks = [];
        for await (const chunk of body) {
          chunks.push(chunk);
        }
        const errorText = Buffer.concat(chunks).toString();
        lastError = { status: statusCode, text: errorText, endpoint };

        // Handle specific error codes
        if (statusCode === 401) {
          invalidateToken(email);
          invalidateProject(email);
          invalidateSession(sessionKey);
          continue; // Try next endpoint
        }

        if (statusCode === 429) {
          const resetMs = parseResetTimeFromUndici(respHeaders, errorText);
          markCooldown(email, resetMs);
          notifyFailure(apiKey);
          throw new ProxyError(429, 'rate_limit_error',
            `Rate limited. Retry after ${Math.ceil(resetMs / 1000)}s`,
            { 'retry-after': Math.ceil(resetMs / 1000).toString() }
          );
        }

        if (statusCode === 403) {
          notifyFailure(apiKey);
          throw new ProxyError(403, 'authentication_error', `Account access denied`);
        }

        if (statusCode === 400) {
          throw new ProxyError(400, 'invalid_request_error', errorText.slice(0, 500));
        }

        // Server error - try next endpoint
        continue;
      }

      // Success - stream the response and increment daily counter
      notifySuccess(apiKey);
      incrementDailyCount(email);
      await pipeUndiciSSEStream(body, resolved.originalModel, res);
      return;

    } catch (e) {
      if (e instanceof ProxyError) throw e;
      lastError = { status: 0, text: e.message, endpoint };
      continue;
    }
  }

  // All endpoints failed
  notifyFailure(apiKey);
  throw new ProxyError(
    lastError?.status || 502,
    'api_error',
    `All endpoints failed. Please try again later.`
  );
}

/**
 * Pipe undici response body (Readable) as SSE stream to Express response in Anthropic format
 */
async function pipeUndiciSSEStream(upstreamBody, model, res) {
  // Set SSE headers
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });

  const state = createStreamState(model);
  let buffer = '';

  try {
    for await (const chunk of upstreamBody) {
      buffer += chunk.toString();

      // Process complete SSE events
      const lines = buffer.split('\n');
      buffer = lines.pop() || ''; // Keep incomplete line in buffer

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = line.slice(6).trim();
          if (data === '[DONE]') continue;

          const events = convertSSEEvent(data, state);
          for (const event of events) {
            writeSSE(res, event);
          }
        }
      }
    }

    // Process any remaining buffer
    if (buffer.startsWith('data: ')) {
      const data = buffer.slice(6).trim();
      if (data && data !== '[DONE]') {
        const events = convertSSEEvent(data, state);
        for (const event of events) {
          writeSSE(res, event);
        }
      }
    }

    // Send stream end events
    const endEvents = buildStreamEnd(state);
    for (const event of endEvents) {
      writeSSE(res, event);
    }

  } catch (e) {
    // Stream error - try to send error event
    try {
      writeSSE(res, {
        type: 'error',
        error: { type: 'api_error', message: e.message }
      });
    } catch { /* response already closed */ }
  } finally {
    res.end();
  }
}

function writeSSE(res, event) {
  res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
}

/**
 * Parse rate limit reset time from undici response headers
 */
function parseResetTimeFromUndici(headers, errorText) {
  // Try Retry-After header (undici returns headers as flat array or object)
  const retryAfter = headers['retry-after'];
  if (retryAfter) {
    const seconds = parseInt(retryAfter, 10);
    if (!isNaN(seconds)) return seconds * 1000;
  }

  // Try to parse from error body
  try {
    const err = JSON.parse(errorText);
    const details = err.error?.details || [];
    for (const detail of details) {
      if (detail.retryDelay) {
        const match = detail.retryDelay.match(/(\d+)s/);
        if (match) return parseInt(match[1], 10) * 1000;
      }
    }
  } catch { /* ignore */ }

  // Default: 30 seconds
  return 30000;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export class ProxyError extends Error {
  constructor(status, type, message, headers = {}) {
    super(message);
    this.status = status;
    this.errorType = type;
    this.extraHeaders = headers;
  }
}
