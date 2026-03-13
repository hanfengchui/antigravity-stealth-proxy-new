/**
 * Express server - Anthropic-compatible API routes
 * Main entry point for Claude Code CLI requests
 */

import express from 'express';
import { config } from './config.js';
import { validateApiKey } from './auth/api-keys.js';
import { routeRequest, getRoutingStats } from './routing/user-router.js';
import { streamMessage, ProxyError } from './translator/streaming.js';
import { getSessionStats } from './fingerprint/session-lifecycle.js';
import { getPacerStats } from './pacer/token-bucket.js';
import { checkDailyLimit, getDailyStats } from './pacer/daily-limit.js';
import { getAdvertisedModels } from './translator/model-map.js';
import { mountWebUI } from './webui/index.js';

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '50mb' }));

/**
 * Auth middleware - validates API key and attaches user info
 */
function authMiddleware(req, res, next) {
  const auth = validateApiKey(req.headers.authorization || req.headers['x-api-key']);
  if (!auth.valid) {
    return res.status(401).json({
      type: 'error',
      error: { type: 'authentication_error', message: 'Invalid API key' }
    });
  }
  req.user = auth.user;
  req.apiKey = auth.apiKey;
  next();
}

/**
 * POST /v1/messages - Anthropic Messages API (streaming)
 * Main endpoint for Claude Code CLI
 */
app.post('/v1/messages', authMiddleware, async (req, res) => {
  try {
    const { email, isBackup, waitMs } = routeRequest(req.apiKey);

    if (!email) {
      return res.status(503).json({
        type: 'error',
        error: { type: 'overloaded_error', message: 'No accounts available' }
      });
    }

    // If router says to wait (account in short cooldown), wait then proceed
    if (waitMs > 0) {
      await sleep(waitMs);
    }

    if (isBackup) {
      console.log(`[Server] Using backup account for ${req.user}`);
    }

    // Check daily limit
    const dailyCheck = checkDailyLimit(email);
    if (!dailyCheck.allowed) {
      return res.status(429).json({
        type: 'error',
        error: {
          type: 'rate_limit_error',
          message: `Daily request limit reached (${dailyCheck.limit}/day). Resets at UTC midnight.`
        }
      });
    }

    // Force streaming (Claude Code always uses streaming)
    req.body.stream = true;

    // Build pacing context from request for intelligent delay
    const messages = req.body.messages || [];
    const lastMessage = messages[messages.length - 1];
    const pacingContext = {
      messageCount: messages.length,
      hasToolResult: lastMessage?.role === 'tool' || lastMessage?.content?.some?.(b => b.type === 'tool_result')
    };

    await streamMessage(req.body, email, req.apiKey, res, pacingContext);

  } catch (e) {
    if (e instanceof ProxyError) {
      for (const [k, v] of Object.entries(e.extraHeaders)) {
        res.setHeader(k, v);
      }
      if (!res.headersSent) {
        return res.status(e.status).json({
          type: 'error',
          error: { type: e.errorType, message: e.message }
        });
      }
    } else {
      console.error(`[Server] Unhandled error:`, e);
      if (!res.headersSent) {
        return res.status(500).json({
          type: 'error',
          error: { type: 'api_error', message: 'An unexpected error occurred. Please try again later.' }
        });
      }
    }
  }
});

/**
 * GET /v1/models - List available models
 * Returns models in Anthropic format for Claude Code compatibility
 */
app.get('/v1/models', authMiddleware, (req, res) => {
  res.json({
    data: getAdvertisedModels()
  });
});

/**
 * GET /health - Health check
 */
app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

/**
 * GET /admin/status - Detailed status (no auth for local access)
 */
app.get('/admin/status', (req, res) => {
  const dailyStats = getDailyStats();
  res.json({
    uptime: Math.round(process.uptime()),
    sessions: getSessionStats(),
    routing: getRoutingStats(),
    dailyUsage: dailyStats,
    accounts: config.accounts
      .filter(a => a.enabled !== false)
      .map(a => ({
        email: a.email,
        pacer: getPacerStats(a.email),
        daily: dailyStats[a.email] || { used: 0, limit: config.pacer.dailyLimitPerAccount || 0 }
      }))
  });
});

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Mount WebUI (must be after API routes so /v1/* takes priority)
mountWebUI(app);

export default app;
