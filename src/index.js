/**
 * Entry point - initializes all modules and starts the server
 */

import { mkdirSync } from 'fs';
import { config } from './config.js';
import { initTokenStore } from './auth/token-store.js';
import { initApiKeys } from './auth/api-keys.js';
import { discoverAllProjects } from './auth/project-discovery.js';
import { startHeartbeat } from './heartbeat/daemon.js';
import { startTelemetry } from './telemetry/simulator.js';
import app from './server.js';

// Ensure config directory exists
mkdirSync(config.paths.configDir, { recursive: true });

// Initialize modules
console.log('[Init] Starting Antigravity Stealth Proxy...');
console.log(`[Init] Accounts: ${config.accounts.filter(a => a.enabled !== false).length}`);
console.log(`[Init] Users: ${Object.keys(config.apiKeys).length}`);

initApiKeys();
initTokenStore();

// Discover project IDs for all accounts
console.log('[Init] Discovering project IDs...');
await discoverAllProjects();

// Start heartbeat daemon (background IDE activity simulation)
startHeartbeat();

// Start telemetry simulator (IDE usage events to avoid zero-telemetry fingerprint)
startTelemetry();

// Start server
app.listen(config.port, config.host, () => {
  console.log(`[Init] Listening on ${config.host}:${config.port}`);
  console.log(`[Init] Pacer: ${config.pacer.maxRequestsPerMinute} req/min, jitter ${config.pacer.jitterMinMs}-${config.pacer.jitterMaxMs}ms`);
  console.log(`[Init] Session lifecycle: ${config.session.minLifetimeMs / 3600000}-${config.session.maxLifetimeMs / 3600000}h`);
  console.log(`[Init] Heartbeat: ${config.heartbeat.enabled ? `every ${config.heartbeat.intervalMs / 60000}min` : 'disabled'}`);
  console.log('\n[Init] Ready. Configure Claude Code CLI:');
  console.log(`  export ANTHROPIC_BASE_URL=http://YOUR_SERVER_IP:${config.port}`);
  console.log('  export ANTHROPIC_AUTH_TOKEN=sk-your-api-key');
  console.log('  export ANTHROPIC_MODEL=claude-sonnet-4-6-thinking');
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n[Shutdown] Stopping...');
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\n[Shutdown] Stopping...');
  process.exit(0);
});
