/**
 * Google OAuth2 authentication flow
 * Handles login, token refresh, and token management
 */

import { config } from '../config.js';

/**
 * Exchange a refresh token for a fresh access token
 * @param {string} refreshToken - Google OAuth2 refresh token
 * @returns {Promise<{accessToken: string, expiresAt: number}>}
 */
export async function refreshAccessToken(refreshToken) {
  const res = await fetch(config.oauth.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: config.oauth.clientId,
      client_secret: config.oauth.clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token'
    })
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Token refresh failed (${res.status}): ${err}`);
  }

  const data = await res.json();
  return {
    accessToken: data.access_token,
    expiresAt: Date.now() + (data.expires_in - 60) * 1000  // 60s buffer
  };
}

/**
 * Start interactive OAuth login flow (for add-account script)
 * Opens browser for Google login, receives callback with auth code
 * @returns {Promise<{email: string, refreshToken: string}>}
 */
export async function startOAuthLogin() {
  const { createServer } = await import('http');
  const { randomBytes } = await import('crypto');

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

  return new Promise((resolve, reject) => {
    const server = createServer(async (req, res) => {
      try {
        const url = new URL(req.url, `http://localhost:${port}`);
        if (url.pathname !== '/oauth-callback') {
          res.writeHead(404);
          res.end('Not found');
          return;
        }

        const code = url.searchParams.get('code');
        const returnedState = url.searchParams.get('state');

        if (returnedState !== state) {
          res.writeHead(400);
          res.end('State mismatch');
          reject(new Error('OAuth state mismatch'));
          server.close();
          return;
        }

        // Exchange code for tokens
        const tokenRes = await fetch(config.oauth.tokenUrl, {
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
          res.writeHead(500);
          res.end(`Token exchange failed: ${err}`);
          reject(new Error(`Token exchange failed: ${err}`));
          server.close();
          return;
        }

        const tokens = await tokenRes.json();

        // Get user email
        const userRes = await fetch('https://www.googleapis.com/oauth2/v1/userinfo', {
          headers: { Authorization: `Bearer ${tokens.access_token}` }
        });
        const userInfo = await userRes.json();

        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<h1>Login successful!</h1><p>You can close this window.</p>');
        server.close();

        resolve({
          email: userInfo.email,
          refreshToken: tokens.refresh_token
        });
      } catch (e) {
        reject(e);
        server.close();
      }
    });

    server.listen(port, () => {
      console.log(`\nOpen this URL in your browser:\n\n${authUrl.toString()}\n`);
      console.log(`Waiting for OAuth callback on port ${port}...`);
    });

    server.on('error', reject);

    // Timeout after 5 minutes
    setTimeout(() => {
      server.close();
      reject(new Error('OAuth login timed out (5 min)'));
    }, 5 * 60 * 1000);
  });
}

/**
 * Get user info from access token
 * @param {string} accessToken
 * @returns {Promise<{email: string, name: string}>}
 */
export async function getUserInfo(accessToken) {
  const res = await fetch('https://www.googleapis.com/oauth2/v1/userinfo', {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  if (!res.ok) throw new Error(`Failed to get user info: ${res.status}`);
  return res.json();
}
