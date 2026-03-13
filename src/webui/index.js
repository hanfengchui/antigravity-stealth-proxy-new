/**
 * WebUI backend - API routes for the Antigravity Console frontend
 * Adapts the original antigravity-claude-proxy WebUI to our stealth proxy
 */

import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { randomBytes, randomUUID } from 'crypto';
import { config } from '../config.js';
import { getAccessToken, initTokenStore, setAccount, getAccountEmails, invalidateToken } from '../auth/token-store.js';
import { refreshAccessToken, startOAuthLogin, getUserInfo } from '../auth/oauth.js';
import { proxyFetch } from '../http-client.js';
import { getSessionStats } from '../fingerprint/session-lifecycle.js';
import { getPacerStats } from '../pacer/token-bucket.js';
import { checkDailyLimit, getDailyStats } from '../pacer/daily-limit.js';
import { getRoutingStats } from '../routing/user-router.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(__dirname, '..', '..', 'config.json');

// Pending OAuth flows: state -> { timestamp }
const pendingOAuthFlows = new Map();

// Log buffer for streaming
const logBuffer = [];
const MAX_LOG_BUFFER = 500;

// Intercept console.log/warn/error for log streaming
const originalLog = console.log;
const originalWarn = console.warn;
const originalError = console.error;

function captureLog(level, args) {
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    message: args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ')
  };
  logBuffer.push(entry);
  if (logBuffer.length > MAX_LOG_BUFFER) logBuffer.shift();
}

console.log = (...args) => { captureLog('info', args); originalLog(...args); };
console.warn = (...args) => { captureLog('warn', args); originalWarn(...args); };
console.error = (...args) => { captureLog('error', args); originalError(...args); };

function loadConfig() {
  if (existsSync(CONFIG_PATH)) {
    return JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
  }
  return {};
}

function saveConfig(data) {
  writeFileSync(CONFIG_PATH, JSON.stringify(data, null, 2));
}

/**
 * Mount WebUI routes onto Express app
 */
export function mountWebUI(app) {
  const publicDir = path.join(__dirname, '..', '..', 'public');

  // Serve static frontend files
  app.use(express.static(publicDir));

  // ============ Account Management ============

  // GET /api/accounts - List all accounts with status
  app.get('/api/accounts', async (req, res) => {
    try {
      const cfg = loadConfig();
      const accounts = (cfg.accounts || []).map(a => {
        const stats = getPacerStats(a.email);
        return {
          email: a.email,
          enabled: a.enabled !== false,
          addedAt: a.addedAt || null,
          label: a.label || null,
          pacer: stats,
          isInvalid: false,
          invalidReason: null
        };
      });
      res.json({
        accounts,
        maxAccounts: 10,
        strategy: 'sticky',
        accountCount: accounts.length
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // POST /api/accounts/:email/toggle - Enable/disable account
  app.post('/api/accounts/:email/toggle', async (req, res) => {
    try {
      const cfg = loadConfig();
      const account = (cfg.accounts || []).find(a => a.email === req.params.email);
      if (!account) return res.status(404).json({ error: 'Account not found' });
      account.enabled = !account.enabled;
      saveConfig(cfg);
      res.json({ success: true, enabled: account.enabled });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // POST /api/accounts/:email/refresh - Force token refresh
  app.post('/api/accounts/:email/refresh', async (req, res) => {
    try {
      invalidateToken(req.params.email);
      const token = await getAccessToken(req.params.email);
      res.json({ success: true, message: 'Token refreshed' });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // DELETE /api/accounts/:email - Remove account
  app.delete('/api/accounts/:email', async (req, res) => {
    try {
      const cfg = loadConfig();
      const idx = (cfg.accounts || []).findIndex(a => a.email === req.params.email);
      if (idx === -1) return res.status(404).json({ error: 'Account not found' });
      cfg.accounts.splice(idx, 1);
      saveConfig(cfg);
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ============ OAuth Flow ============

  // GET /api/auth/url - Get OAuth authorization URL
  app.get('/api/auth/url', async (req, res) => {
    try {
      const state = randomBytes(16).toString('hex');
      const port = config.oauth.callbackPort;

      const authUrl = new URL(config.oauth.authUrl);
      authUrl.searchParams.set('client_id', config.oauth.clientId);
      authUrl.searchParams.set('redirect_uri', `http://localhost:${port}/oauth-callback`);
      authUrl.searchParams.set('response_type', 'code');
      authUrl.searchParams.set('scope', config.oauth.scopes.join(' '));
      authUrl.searchParams.set('state', state);
      authUrl.searchParams.set('access_type', 'offline');
      authUrl.searchParams.set('prompt', 'consent');

      pendingOAuthFlows.set(state, { timestamp: Date.now() });

      // Clean old flows (> 10 min)
      for (const [k, v] of pendingOAuthFlows) {
        if (Date.now() - v.timestamp > 600000) pendingOAuthFlows.delete(k);
      }

      res.json({
        url: authUrl.toString(),
        state,
        callbackPort: port,
        manualMode: true
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // POST /api/auth/complete - Complete OAuth with authorization code
  app.post('/api/auth/complete', async (req, res) => {
    try {
      const { code, state } = req.body;
      if (!code) return res.status(400).json({ error: 'Missing authorization code' });

      const port = config.oauth.callbackPort;

      // Exchange code for tokens
      const tokenRes = await proxyFetch(config.oauth.tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: config.oauth.clientId,
          client_secret: config.oauth.clientSecret,
          code,
          grant_type: 'authorization_code',
          redirect_uri: `http://localhost:${port}/oauth-callback`
        })
      });

      if (!tokenRes.ok) {
        const err = await tokenRes.text();
        return res.status(400).json({ error: `Token exchange failed: ${err}` });
      }

      const tokens = await tokenRes.json();
      if (!tokens.refresh_token) {
        return res.status(400).json({ error: 'No refresh token received. Make sure to use prompt=consent.' });
      }

      // Get user email
      const userRes = await proxyFetch('https://www.googleapis.com/oauth2/v1/userinfo', {
        headers: { Authorization: `Bearer ${tokens.access_token}` }
      });
      const userInfo = await userRes.json();

      // Save to config
      const cfg = loadConfig();
      if (!cfg.accounts) cfg.accounts = [];

      const existing = cfg.accounts.find(a => a.email === userInfo.email);
      if (existing) {
        existing.refreshToken = tokens.refresh_token;
        existing.enabled = true;
        existing.isInvalid = false;
      } else {
        cfg.accounts.push({
          email: userInfo.email,
          refreshToken: tokens.refresh_token,
          enabled: true,
          addedAt: new Date().toISOString()
        });
      }

      saveConfig(cfg);

      // Update runtime token store
      setAccount(userInfo.email, tokens.refresh_token);

      if (state) pendingOAuthFlows.delete(state);

      res.json({
        success: true,
        email: userInfo.email,
        isNew: !existing
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // OAuth callback handler (for direct browser redirect)
  app.get('/oauth-callback', async (req, res) => {
    const { code, state } = req.query;
    if (!code) {
      return res.status(400).send('Missing authorization code');
    }
    // Sanitize inputs to prevent XSS — encode for safe embedding in JS strings
    const safeCode = encodeURIComponent(code);
    const safeState = encodeURIComponent(state || '');
    res.send(`<!DOCTYPE html><html><head><title>OAuth Complete</title></head><body>
      <h2>Authorization successful!</h2>
      <p>Completing login...</p>
      <script>
        var code = decodeURIComponent('${safeCode}');
        var state = decodeURIComponent('${safeState}');
        if (window.opener) {
          window.opener.postMessage({ type: 'oauth-callback', code: code, state: state }, '*');
          setTimeout(function() { window.close(); }, 2000);
        } else {
          document.body.innerHTML = '<h2>Success!</h2><p>Paste this code in the WebUI Add Account dialog:</p><pre>' +
            code.replace(/</g,'&lt;') + '</pre>';
        }
      </script>
    </body></html>`);
  });

  // ============ Quota / Models ============

  // GET /api/config - Get public config for dashboard
  app.get('/api/config', (req, res) => {
    const cfg = loadConfig();
    res.json({
      port: cfg.port || 8080,
      accountCount: (cfg.accounts || []).filter(a => a.enabled !== false).length,
      maxAccounts: 10,
      strategy: 'sticky',
      version: '1.0.0',
      fallbackEnabled: false,
      pacer: cfg.pacer || config.pacer,
      dailyLimitPerAccount: (cfg.pacer || config.pacer).dailyLimitPerAccount || 500,
      session: cfg.session || config.session,
      retry: cfg.retry || config.retry,
      heartbeat: cfg.heartbeat || config.heartbeat,
      apiKeys: Object.keys(cfg.apiKeys || {}),
      userBindings: Object.fromEntries(
        Object.entries(cfg.userBindings || {}).map(([k, v]) => [k.slice(0, 10) + '...', v])
      )
    });
  });

  // POST /api/config - Update config
  app.post('/api/config', async (req, res) => {
    try {
      const cfg = loadConfig();
      const updates = req.body;

      // Merge allowed fields
      if (updates.pacer) cfg.pacer = { ...cfg.pacer, ...updates.pacer };
      if (updates.session) cfg.session = { ...cfg.session, ...updates.session };
      if (updates.retry) cfg.retry = { ...cfg.retry, ...updates.retry };
      if (updates.heartbeat) cfg.heartbeat = { ...cfg.heartbeat, ...updates.heartbeat };
      if (updates.port) cfg.port = updates.port;

      saveConfig(cfg);
      res.json({ success: true, message: 'Config updated. Restart service to apply.' });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // GET /api/settings - Get settings for WebUI
  app.get('/api/settings', (req, res) => {
    res.json({
      version: '1.0.0',
      uptime: Math.round(process.uptime()),
      nodeVersion: process.version,
      platform: process.platform,
      sessions: getSessionStats(),
      routing: getRoutingStats()
    });
  });

  // GET /api/strategy/health - Account health for dashboard
  app.get('/api/strategy/health', (req, res) => {
    const cfg = loadConfig();
    const health = (cfg.accounts || [])
      .filter(a => a.enabled !== false)
      .map(a => ({
        email: a.email,
        score: 70,
        tokens: getPacerStats(a.email).tokens,
        isRateLimited: false,
        isCoolingDown: false
      }));
    res.json({ accounts: health });
  });

  // ============ API Key Management ============

  // GET /api/apikeys - List API keys
  app.get('/api/apikeys', (req, res) => {
    const cfg = loadConfig();
    const keys = Object.entries(cfg.apiKeys || {}).map(([label, key]) => ({
      label,
      key: key.slice(0, 10) + '...' + key.slice(-4),
      fullKey: key,
      binding: cfg.userBindings?.[key] || null
    }));
    res.json({ keys });
  });

  // POST /api/apikeys - Create new API key
  app.post('/api/apikeys', (req, res) => {
    try {
      const cfg = loadConfig();
      if (!cfg.apiKeys) cfg.apiKeys = {};
      if (!cfg.userBindings) cfg.userBindings = {};

      const label = req.body.label || `user${Object.keys(cfg.apiKeys).length + 1}`;
      const key = `sk-${randomBytes(24).toString('hex')}`;
      const primaryAccount = req.body.primaryAccount || (cfg.accounts?.[0]?.email || null);
      const backupAccount = req.body.backupAccount || null;

      cfg.apiKeys[label] = key;
      if (primaryAccount) {
        cfg.userBindings[key] = { primary: primaryAccount };
        if (backupAccount) cfg.userBindings[key].backup = backupAccount;
      }

      saveConfig(cfg);
      res.json({ success: true, label, key, binding: cfg.userBindings[key] });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // DELETE /api/apikeys/:label - Delete API key
  app.delete('/api/apikeys/:label', (req, res) => {
    try {
      const cfg = loadConfig();
      const key = cfg.apiKeys?.[req.params.label];
      if (!key) return res.status(404).json({ error: 'Key not found' });

      delete cfg.apiKeys[req.params.label];
      delete cfg.userBindings?.[key];
      saveConfig(cfg);
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ============ Quota Query ============

  // GET /api/quota - Fetch model quotas from Antigravity API
  app.get('/api/quota', async (req, res) => {
    try {
      const cfg = loadConfig();
      const accounts = (cfg.accounts || []).filter(a => a.enabled !== false);
      if (accounts.length === 0) return res.json({ quotas: {} });

      // Use first available account to query
      const email = accounts[0].email;
      const token = await getAccessToken(email);

      const apiRes = await proxyFetch('https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
          'X-Client-Name': 'antigravity',
          'X-Client-Version': '1.107.0',
          'x-goog-api-client': 'gl-node/18.18.2 fire/0.8.6 grpc/1.10.x',
          'User-Agent': 'antigravity/1.107.0 linux/amd64'
        },
        body: JSON.stringify({})
      });

      if (!apiRes.ok) {
        const err = await apiRes.text();
        return res.status(apiRes.status).json({ error: err });
      }

      const data = await apiRes.json();
      const quotas = {};
      for (const [modelId, info] of Object.entries(data.models || {})) {
        if (modelId.includes('claude') || modelId.includes('gemini')) {
          quotas[modelId] = {
            remainingFraction: info.quotaInfo?.remainingFraction ?? null,
            resetTime: info.quotaInfo?.resetTime ?? null,
            maxTokens: info.maxTokens || null,
            maxOutputTokens: info.maxOutputTokens || null
          };
        }
      }

      res.json({ quotas, account: email, fetchedAt: new Date().toISOString() });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ============ Daily Usage ============

  // GET /api/daily-usage - Get daily usage stats for all accounts
  app.get('/api/daily-usage', (req, res) => {
    const dailyStats = getDailyStats();
    const cfg = loadConfig();
    const limit = cfg.pacer?.dailyLimitPerAccount || config.pacer.dailyLimitPerAccount || 0;
    const accounts = (cfg.accounts || []).filter(a => a.enabled !== false);

    const usage = accounts.map(a => {
      const stats = dailyStats[a.email] || { used: 0, limit, remaining: limit, percentage: 0 };
      return {
        email: a.email,
        used: stats.used,
        limit,
        remaining: limit ? Math.max(0, limit - stats.used) : Infinity,
        percentage: limit ? Math.round((stats.used / limit) * 100) : 0
      };
    });

    res.json({ usage, limit, resetAt: 'UTC 00:00' });
  });

  // ============ Logs ============

  // GET /api/logs - Get recent logs
  app.get('/api/logs', (req, res) => {
    const level = req.query.level || 'all';
    const filtered = level === 'all' ? logBuffer : logBuffer.filter(l => l.level === level);
    res.json({ logs: filtered.slice(-200) });
  });

  // GET /api/logs/stream - SSE log streaming
  app.get('/api/logs/stream', (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive'
    });

    let lastIndex = logBuffer.length;
    const interval = setInterval(() => {
      while (lastIndex < logBuffer.length) {
        const entry = logBuffer[lastIndex++];
        res.write(`data: ${JSON.stringify(entry)}\n\n`);
      }
    }, 1000);

    req.on('close', () => clearInterval(interval));
  });

  // ============ Claude CLI Presets (compatibility stubs) ============

  app.get('/api/claude/config', (req, res) => {
    res.json({ config: {}, path: '' });
  });

  app.get('/api/claude/presets', (req, res) => {
    const cfg = loadConfig();
    res.json({
      presets: [
        {
          name: 'Claude Thinking',
          config: {
            ANTHROPIC_AUTH_TOKEN: 'test',
            ANTHROPIC_BASE_URL: `http://localhost:${cfg.port || 8080}`,
            ANTHROPIC_MODEL: 'claude-opus-4-6-thinking'
          }
        },
        {
          name: 'Gemini Pro',
          config: {
            ANTHROPIC_AUTH_TOKEN: 'test',
            ANTHROPIC_BASE_URL: `http://localhost:${cfg.port || 8080}`,
            ANTHROPIC_MODEL: 'gemini-3.1-pro-high'
          }
        }
      ],
      defaultPresets: []
    });
  });

  app.get('/api/server/presets', (req, res) => {
    res.json({ presets: [], defaultPresets: [] });
  });

  app.post('/api/models/config', (req, res) => {
    res.json({ success: true });
  });

  app.get('/api/claude/mode', (req, res) => {
    res.json({ mode: 'proxy', available: true });
  });

  // Fallback: serve index.html for SPA routing
  app.use((req, res, next) => {
    if (req.path.startsWith('/v1/') || req.path.startsWith('/api/') || req.path.startsWith('/health') || req.path.startsWith('/admin/')) return next();
    if (req.method !== 'GET') return next();
    const indexPath = path.join(publicDir, 'index.html');
    if (existsSync(indexPath)) {
      res.sendFile(indexPath);
    } else {
      next();
    }
  });

  console.log('[WebUI] Mounted at /');
}
