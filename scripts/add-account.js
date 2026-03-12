#!/usr/bin/env node
/**
 * Interactive account addition script
 * Launches OAuth flow to add a Google account
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { config } from '../src/config.js';
import { startOAuthLogin } from '../src/auth/oauth.js';
import { randomBytes } from 'crypto';

const accountsPath = config.paths.configDir;
const configPath = join(accountsPath, '..', '..', 'antigravity-stealth-proxy', 'config.json');

async function main() {
  console.log('=== Antigravity Stealth Proxy - Add Account ===\n');
  console.log('This will open a browser window for Google OAuth login.');
  console.log('Make sure you have a browser available (or use SSH port forwarding).\n');

  try {
    const { email, refreshToken } = await startOAuthLogin();
    console.log(`\nSuccessfully authenticated: ${email}`);

    // Load existing config or create new
    let existingConfig = {};
    const projectConfigPath = join(process.cwd(), 'config.json');

    if (existsSync(projectConfigPath)) {
      existingConfig = JSON.parse(readFileSync(projectConfigPath, 'utf-8'));
    }

    // Add account
    if (!existingConfig.accounts) existingConfig.accounts = [];

    const existing = existingConfig.accounts.find(a => a.email === email);
    if (existing) {
      existing.refreshToken = refreshToken;
      existing.enabled = true;
      console.log(`Updated existing account: ${email}`);
    } else {
      existingConfig.accounts.push({
        email,
        refreshToken,
        enabled: true
      });
      console.log(`Added new account: ${email}`);
    }

    // Generate API key for a new user if needed
    if (!existingConfig.apiKeys) existingConfig.apiKeys = {};
    if (!existingConfig.userBindings) existingConfig.userBindings = {};

    const userCount = Object.keys(existingConfig.apiKeys).length;
    const newUserLabel = `user${userCount + 1}`;
    const newApiKey = `sk-${randomBytes(24).toString('hex')}`;

    console.log(`\nGenerated API key for ${newUserLabel}: ${newApiKey}`);
    console.log('(Save this - it won\'t be shown again)\n');

    existingConfig.apiKeys[newUserLabel] = newApiKey;
    existingConfig.userBindings[newApiKey] = { primary: email };

    // If there's a second account, set it as backup
    if (existingConfig.accounts.length >= 2) {
      for (const [key, binding] of Object.entries(existingConfig.userBindings)) {
        if (!binding.backup) {
          const otherAccount = existingConfig.accounts.find(a => a.email !== binding.primary && a.enabled !== false);
          if (otherAccount) {
            binding.backup = otherAccount.email;
          }
        }
      }
    }

    writeFileSync(projectConfigPath, JSON.stringify(existingConfig, null, 2));
    console.log(`Config saved to: ${projectConfigPath}`);
    console.log(`\nTotal accounts: ${existingConfig.accounts.length}`);
    console.log(`Total users: ${Object.keys(existingConfig.apiKeys).length}`);

    console.log('\n=== Setup Complete ===');
    console.log('\nConfigure Claude Code CLI:');
    console.log(`  export ANTHROPIC_BASE_URL=http://YOUR_SERVER:${existingConfig.port || 8080}`);
    console.log(`  export ANTHROPIC_AUTH_TOKEN=${newApiKey}`);
    console.log('  export ANTHROPIC_MODEL=claude-sonnet-4-6-thinking');

  } catch (e) {
    console.error('\nFailed:', e.message);
    process.exit(1);
  }
}

main();
