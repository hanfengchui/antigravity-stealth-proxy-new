/**
 * SSE streaming handler
 * Sends requests to Cloud Code API and streams responses back in Anthropic format
 *
 * CRITICAL: Real Antigravity client uses Connection: close on every request.
 * No persistent connection pools. Each request is a fresh TCP connection.
 */

import { Client, ProxyAgent } from 'undici';
import { config } from '../config.js';
import { getAccessToken, invalidateToken } from '../auth/token-store.js';
import { discoverProjectId, getProjectInfo, invalidateProject } from '../auth/project-discovery.js';
import { buildHeaders } from '../fingerprint/header-generator.js';
import { getSession, invalidateSession } from '../fingerprint/session-lifecycle.js';
import { buildCloudCodeRequest } from './request.js';
import { resolveModel } from './model-map.js';
import { convertSSEEvent, buildStreamEnd, createStreamState } from './response.js';
import { paceRequest } from '../pacer/token-bucket.js';
import { incrementDailyCount } from '../pacer/daily-limit.js';
import { markCooldown, notifySuccess, notifyFailure } from '../routing/user-router.js';

// Shared ProxyAgent if outbound proxy is configured
let proxyAgent = null;

function getProxyAgent() {
  if (!config.outboundProxy) return null;
  if (!proxyAgent) {
    proxyAgent = new ProxyAgent({
      uri: config.outboundProxy,
      connect: { rejectUnauthorized: true }
    });
    console.log(`[Stream] Using outbound proxy: ${config.outboundProxy.replace(/\/\/.*@/, '//***@')}`);
  }
  return proxyAgent;
}

/**
 * Make a single request with Connection: close behavior.
 * Real client creates a new TCP connection per request.
 */
async function singleRequest(endpoint, path, method, headers, body, timeouts) {
  const proxy = getProxyAgent();

  if (proxy) {
    // ProxyAgent mode — use undici fetch-like request
    return proxy.request({
      origin: endpoint,
      path,
      method,
      headers: { ...headers, connection: 'close' },
      body,
      headersTimeout: timeouts.headers || 30000,
      bodyTimeout: timeouts.body || 600000,
    });
  }

  // Direct mode — create a fresh Client per request (Connection: close)
  const client = new Client(endpoint, {
    pipelining: 0,
    keepAliveTimeout: 0,
    connect: { rejectUnauthorized: true }
  });

  try {
    return await client.request({
      path,
      method,
      headers: { ...headers, connection: 'close' },
      body,
      headersTimeout: timeouts.headers || 30000,
      bodyTimeout: timeouts.body || 600000,
    });
  } catch (e) {
    client.close();
    throw e;
  }
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
  const sessionKey = email;
  const requestedModel = anthropicReq.model || 'claude-sonnet-4-6-thinking';

  // Apply rate limiting + context-aware jitter
  await paceRequest(email, pacingContext);

  // Discover project ID for this account
  const projectId = await discoverProjectId(email);
  const projectInfo = getProjectInfo(email);
  const tier = projectInfo?.tier || 'standard-tier';

  // Resolve model name
  const resolved = resolveModel(requestedModel, tier);
  if (resolved.isFallback) {
    console.log(`[Stream] Model fallback: ${requestedModel} -> ${resolved.model} (tier: ${tier})`);
  }

  // Get or create session
  const session = getSession(sessionKey, projectId);
  if (session.isRestarting) {
    await sleep(config.session.restartDelayMs);
    const retrySession = getSession(sessionKey, projectId);
    if (retrySession.isRestarting) {
      throw new ProxyError(503, 'overloaded_error', 'The server is temporarily overloaded. Please try again later.');
    }
    Object.assign(session, retrySession);
  }

  // Get access token
  const accessToken = await getAccessToken(email);

  // Build request
  const resolvedReq = { ...anthropicReq, model: resolved.model };
  const payload = buildCloudCodeRequest(resolvedReq, projectId, sessionKey, session.sessionId);
  const headers = buildHeaders(accessToken);

  // Try endpoints in order
  let lastError = null;
  for (const endpoint of config.api.endpoints) {
    try {
      const requestPath = '/v1internal:streamGenerateContent?alt=sse';

      const { statusCode, headers: respHeaders, body } = await singleRequest(
        endpoint, requestPath, 'POST', headers, JSON.stringify(payload),
        { headers: 30000, body: 600000 }
      );

      if (statusCode < 200 || statusCode >= 300) {
        const chunks = [];
        for await (const chunk of body) {
          chunks.push(chunk);
        }
        const errorText = Buffer.concat(chunks).toString();
        lastError = { status: statusCode, text: errorText, endpoint };

        if (statusCode === 401) {
          invalidateToken(email);
          invalidateProject(email);
          invalidateSession(sessionKey);
          continue;
        }

        if (statusCode === 429) {
          const resetMs = parseResetTime(respHeaders, errorText);
          markCooldown(email, resetMs);
          notifyFailure(apiKey);
          throw new ProxyError(429, 'rate_limit_error',
            'Number of request tokens has exceeded your per-model rate limit.',
            { 'retry-after': Math.ceil(resetMs / 1000).toString() }
          );
        }

        if (statusCode === 403) {
          notifyFailure(apiKey);
          throw new ProxyError(403, 'authentication_error', 'Your API key does not have permission to use the specified resource.');
        }

        if (statusCode === 400) {
          throw new ProxyError(400, 'invalid_request_error', 'There was an issue with the format or content of your request.');
        }

        continue;
      }

      // Success
      notifySuccess(apiKey);
      incrementDailyCount(email);
      await pipeSSEStream(body, resolved.originalModel, res);
      return;

    } catch (e) {
      if (e instanceof ProxyError) throw e;
      lastError = { status: 0, text: e.message, endpoint };
      continue;
    }
  }

  notifyFailure(apiKey);
  throw new ProxyError(
    lastError?.status || 502,
    'api_error',
    'An error occurred while processing your request.'
  );
}

/**
 * Pipe upstream SSE stream to Express response in Anthropic format
 */
async function pipeSSEStream(upstreamBody, model, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive'
  });

  const state = createStreamState(model);
  let buffer = '';

  try {
    for await (const chunk of upstreamBody) {
      buffer += chunk.toString();

      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

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

    if (buffer.startsWith('data: ')) {
      const data = buffer.slice(6).trim();
      if (data && data !== '[DONE]') {
        const events = convertSSEEvent(data, state);
        for (const event of events) {
          writeSSE(res, event);
        }
      }
    }

    const endEvents = buildStreamEnd(state);
    for (const event of endEvents) {
      writeSSE(res, event);
    }

  } catch (e) {
    // Do NOT leak Node.js/undici internal error messages to the client
    console.error('[Stream] SSE pipe error:', e.message);
    try {
      writeSSE(res, {
        type: 'error',
        error: { type: 'api_error', message: 'An unexpected error occurred.' }
      });
    } catch { /* response already closed */ }
  } finally {
    res.end();
  }
}

function writeSSE(res, event) {
  res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
}

function parseResetTime(headers, errorText) {
  const retryAfter = headers['retry-after'];
  if (retryAfter) {
    const seconds = parseInt(retryAfter, 10);
    if (!isNaN(seconds)) return seconds * 1000;
  }

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
