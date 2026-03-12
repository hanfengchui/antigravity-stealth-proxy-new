/**
 * SSE streaming handler
 * Sends requests to Cloud Code API and streams responses back in Anthropic format
 */

import { config } from '../config.js';
import { getAccessToken, invalidateToken } from '../auth/token-store.js';
import { discoverProjectId, getProjectInfo, invalidateProject } from '../auth/project-discovery.js';
import { buildHeaders } from '../fingerprint/header-generator.js';
import { getSession, invalidateSession } from '../fingerprint/session-lifecycle.js';
import { buildCloudCodeRequest } from './request.js';
import { resolveModel, isThinkingModel } from './model-map.js';
import { convertSSEEvent, buildStreamEnd, createStreamState } from './response.js';
import { paceRequest } from '../pacer/token-bucket.js';
import { markCooldown, notifySuccess, notifyFailure } from '../routing/user-router.js';

/**
 * Stream a message request through Cloud Code API
 * @param {Object} anthropicReq - Anthropic format request
 * @param {string} email - Account email to use
 * @param {string} apiKey - User's API key (for routing notifications)
 * @param {import('express').Response} res - Express response to stream to
 */
export async function streamMessage(anthropicReq, email, apiKey, res) {
  const sessionKey = `${apiKey}:${email}`;
  const requestedModel = anthropicReq.model || 'claude-sonnet-4-6-thinking';

  // Apply rate limiting + jitter
  await paceRequest(email);

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

  // Try endpoints in order
  let lastError = null;
  for (const endpoint of config.api.endpoints) {
    try {
      const url = `${endpoint}/v1internal:streamGenerateContent?alt=sse`;

      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(600000) // 10 min timeout
      });

      if (!response.ok) {
        const errorText = await response.text();
        lastError = { status: response.status, text: errorText, endpoint };

        // Handle specific error codes
        if (response.status === 401) {
          invalidateToken(email);
          invalidateProject(email);
          invalidateSession(sessionKey);
          continue; // Try next endpoint
        }

        if (response.status === 429) {
          const resetMs = parseResetTime(response, errorText);
          markCooldown(email, resetMs);
          notifyFailure(apiKey);
          throw new ProxyError(429, 'rate_limit_error',
            `Rate limited. Retry after ${Math.ceil(resetMs / 1000)}s`,
            { 'retry-after': Math.ceil(resetMs / 1000).toString() }
          );
        }

        if (response.status === 403) {
          notifyFailure(apiKey);
          throw new ProxyError(403, 'authentication_error', `Account forbidden: ${errorText.slice(0, 200)}`);
        }

        if (response.status === 400) {
          throw new ProxyError(400, 'invalid_request_error', errorText.slice(0, 500));
        }

        // Server error - try next endpoint
        continue;
      }

      // Success - stream the response
      notifySuccess(apiKey);
      await pipeSSEStream(response, resolved.originalModel, res);
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
    `All endpoints failed. Last error: ${lastError?.text?.slice(0, 200) || 'unknown'}`
  );
}

/**
 * Pipe Google SSE stream to Express response in Anthropic format
 */
async function pipeSSEStream(upstreamResponse, model, res) {
  // Set SSE headers
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });

  const state = createStreamState(model);
  const reader = upstreamResponse.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

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
 * Parse rate limit reset time from response
 */
function parseResetTime(response, errorText) {
  // Try Retry-After header
  const retryAfter = response.headers.get('retry-after');
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
