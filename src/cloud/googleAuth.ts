// src/cloud/googleAuth.ts
//
// Desktop OAuth 2.0 (PKCE) for Google Drive, tailored to the CEP/Node runtime.
//
// Flow (Google's "loopback IP address" redirect, the sanctioned desktop
// pattern — the OOB "urn:ietf:wg:oauth:2.0:oob" flow was retired in 2022):
//
//   1. Spin up a throwaway http server on 127.0.0.1:<random free port>.
//   2. Build the consent URL with a PKCE code_challenge + a CSRF `state`, and
//      open it in the user's DEFAULT browser (not inside the CEP webview —
//      Google blocks embedded webviews with "disallowed_useragent").
//   3. User consents; Google redirects to http://127.0.0.1:<port>/?code=...
//   4. Our server captures the code, verifies `state`, shows a "you can close
//      this tab" page, and shuts down.
//   5. Exchange code + code_verifier at the token endpoint for access +
//      refresh tokens. Persist ONLY the refresh token to disk.
//
// Everything here is guarded so it no-ops gracefully outside CEP (e.g. the Vite
// dev server in a plain browser), where window.require is unavailable.

import {
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  DRIVE_APPDATA_SCOPE,
  OAUTH_AUTH_ENDPOINT,
  OAUTH_TOKEN_ENDPOINT,
  OAUTH_REVOKE_ENDPOINT,
} from './config';
import type { TokenSet, StoredAuth } from './types';

declare global {
  interface Window {
    require: any;
    CSInterface: any;
    SystemPath: any;
    __adobe_cep__: any;
  }
}

// ---- environment helpers ---------------------------------------------------

const hasNode = (): boolean =>
  typeof window !== 'undefined' && typeof window.require === 'function';

const nodeCrypto = () => window.require('crypto');
const nodeHttp = () => window.require('http');

// Reuse storage.ts's config-dir resolution so the auth file sits alongside the
// other panel config. We re-implement the tiny slice we need rather than import
// to avoid a cycle (storage.ts pulls in a lot of panel types).
const getConfigDir = (): string | null => {
  if (typeof window.CSInterface === 'undefined') return null;
  try {
    const cs = new window.CSInterface();
    const fs = window.require('fs');
    const path = window.require('path');
    let userData = String(cs.getSystemPath(window.SystemPath.USER_DATA) || '');
    userData = userData.replace(/^file:\/{0,3}/i, '');
    try { userData = decodeURIComponent(userData); } catch { /* keep raw */ }
    if (/^\/[A-Za-z]:\//.test(userData)) userData = userData.slice(1);
    if (!userData) return null;
    const dir = path.join(userData, 'AGS-Extensions');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return dir;
  } catch {
    return null;
  }
};

const authFilePath = (): string | null => {
  const dir = getConfigDir();
  if (!dir) return null;
  return window.require('path').join(dir, 'googleAuth.json');
};

// ---- PKCE ------------------------------------------------------------------

const base64url = (buf: any): string =>
  buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const makePkce = () => {
  const crypto = nodeCrypto();
  const verifier = base64url(crypto.randomBytes(32));
  const challenge = base64url(
    crypto.createHash('sha256').update(verifier).digest(),
  );
  return { verifier, challenge };
};

const randomState = (): string => base64url(nodeCrypto().randomBytes(16));

// ---- persisted refresh token ----------------------------------------------

const readStoredAuth = (): StoredAuth | null => {
  try {
    const p = authFilePath();
    if (!p) return null;
    const fs = window.require('fs');
    if (!fs.existsSync(p)) return null;
    const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (parsed && typeof parsed.refreshToken === 'string') return parsed;
    return null;
  } catch {
    return null;
  }
};

const writeStoredAuth = (auth: StoredAuth | null) => {
  try {
    const p = authFilePath();
    if (!p) return;
    const fs = window.require('fs');
    if (auth === null) {
      if (fs.existsSync(p)) fs.unlinkSync(p);
      return;
    }
    fs.writeFileSync(p, JSON.stringify(auth, null, 2), 'utf8');
  } catch (e) {
    console.error('Failed to persist Google auth', e);
  }
};

export const hasStoredSession = (): boolean => readStoredAuth() !== null;

// ---- in-memory token cache -------------------------------------------------

let cachedToken: TokenSet | null = null;

const tokenValid = (t: TokenSet | null): t is TokenSet =>
  !!t && Date.now() < t.expiresAt - 60_000; // 60s safety margin

// ---- loopback server -------------------------------------------------------

const openInBrowser = (url: string) => {
  // Prefer CEP's helper; fall back to Node child_process per-platform.
  try {
    if (typeof window.CSInterface !== 'undefined') {
      new window.CSInterface().openURLInDefaultBrowser(url);
      return;
    }
  } catch { /* fall through */ }
  try {
    const { exec } = window.require('child_process');
    const platform = window.require('process').platform;
    const cmd =
      platform === 'win32' ? `start "" "${url}"`
      : platform === 'darwin' ? `open "${url}"`
      : `xdg-open "${url}"`;
    exec(cmd);
  } catch (e) {
    console.error('Could not open browser for OAuth', e);
  }
};

// ---- token endpoint calls --------------------------------------------------

const toForm = (params: Record<string, string | undefined>): string =>
  Object.entries(params)
    .filter(([, v]) => v != null)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v as string)}`)
    .join('&');

const exchangeCode = async (
  code: string,
  verifier: string,
  redirectUri: string,
): Promise<TokenSet> => {
  const resp = await fetch(OAUTH_TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: toForm({
      client_id: GOOGLE_CLIENT_ID,
      // Required by Google even for Desktop-app/PKCE clients — see config.ts.
      client_secret: GOOGLE_CLIENT_SECRET || undefined,
      code,
      code_verifier: verifier,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri,
    }),
  });
  if (!resp.ok) throw new Error(`Token exchange failed: ${resp.status} ${await resp.text()}`);
  const j = await resp.json();
  return {
    accessToken: j.access_token,
    refreshToken: j.refresh_token,
    expiresAt: Date.now() + (j.expires_in ?? 3600) * 1000,
    scope: j.scope ?? DRIVE_APPDATA_SCOPE,
    tokenType: j.token_type ?? 'Bearer',
  };
};

const refreshAccessToken = async (refreshToken: string): Promise<TokenSet> => {
  const resp = await fetch(OAUTH_TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: toForm({
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET || undefined,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  });
  if (!resp.ok) throw new Error(`Token refresh failed: ${resp.status} ${await resp.text()}`);
  const j = await resp.json();
  return {
    accessToken: j.access_token,
    // Google usually omits refresh_token on refresh — keep the existing one.
    refreshToken,
    expiresAt: Date.now() + (j.expires_in ?? 3600) * 1000,
    scope: j.scope ?? DRIVE_APPDATA_SCOPE,
    tokenType: j.token_type ?? 'Bearer',
  };
};

// ---- public API ------------------------------------------------------------

export const isSupported = (): boolean => hasNode() && !!GOOGLE_CLIENT_ID;

/** Interactive sign-in. Binds the loopback port first, then opens the browser
 * to Google's consent screen, waits for the redirect, exchanges the code, and
 * persists the refresh token. Throws on failure/cancel. */
export const signIn = async (): Promise<StoredAuth> => {
  if (!hasNode()) throw new Error('Google sign-in requires the CEP/Node runtime.');
  if (!GOOGLE_CLIENT_ID) throw new Error('Missing Google client ID (see src/cloud/config.ts).');

  const { verifier, challenge } = makePkce();
  const state = randomState();
  const http = nodeHttp();

  // Phase 1: bind the loopback server and learn our port.
  const server: any = await new Promise((resolve, reject) => {
    const s = http.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
  const port = server.address().port;
  const redirectUri = `http://127.0.0.1:${port}`;

  // Phase 2: attach the request handler now that we know the port.
  const codePromise: Promise<string> = new Promise((resolve, reject) => {
    server.on('request', (req: any, res: any) => {
      try {
        const url = new URL(req.url, redirectUri);
        if (!url.searchParams.has('code') && !url.searchParams.has('error')) {
          res.statusCode = 404; res.end('Not found'); return;
        }
        const err = url.searchParams.get('error');
        const code = url.searchParams.get('code');
        const gotState = url.searchParams.get('state');
        res.statusCode = 200;
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.end(
          `<!doctype html><meta charset="utf-8"><title>MTAG</title>` +
          `<style>body{font-family:system-ui,sans-serif;background:#0d0e15;color:#e6e6e6;` +
          `display:grid;place-items:center;height:100vh;margin:0}div{text-align:center}` +
          `h1{font-size:1.2rem}p{color:#8a8f9c}</style>` +
          `<div><h1>${err ? 'Sign-in failed' : 'MTAG is connected ✓'}</h1>` +
          `<p>${err ? 'You can close this tab and try again.' : 'You can close this tab and return to Adobe.'}</p></div>`,
        );
        const done = () => { try { server.close(); } catch { /* ignore */ } };
        if (err) { done(); reject(new Error(`OAuth error: ${err}`)); return; }
        if (gotState !== state) { done(); reject(new Error('State mismatch (possible CSRF)')); return; }
        if (!code) { done(); reject(new Error('No authorization code returned')); return; }
        done(); resolve(code);
      } catch (e) {
        try { server.close(); } catch { /* ignore */ }
        reject(e);
      }
    });
    const timer: any = setTimeout(() => {
      try { server.close(); } catch { /* ignore */ }
      reject(new Error('Sign-in timed out. Please try again.'));
    }, 5 * 60_000);
    if (timer && typeof timer.unref === 'function') timer.unref();
  });

  // Build + open the consent URL.
  const authUrl =
    `${OAUTH_AUTH_ENDPOINT}?` +
    toForm({
      client_id: GOOGLE_CLIENT_ID,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: DRIVE_APPDATA_SCOPE,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state,
      access_type: 'offline',
      prompt: 'consent',
    });
  openInBrowser(authUrl);

  const code = await codePromise;
  const token = await exchangeCode(code, verifier, redirectUri);
  cachedToken = token;

  if (!token.refreshToken) {
    // No refresh token = we can use this session but can't restore it silently.
    // This happens if the user previously granted and Google withheld a new
    // refresh token; prompt=consent above should normally force one.
    console.warn('No refresh token returned; session will not persist.');
  }
  const stored: StoredAuth = {
    refreshToken: token.refreshToken ?? '',
    scope: token.scope,
  };
  if (stored.refreshToken) writeStoredAuth(stored);
  return stored;
};

/** Returns a valid access token, refreshing or (as a last resort) failing if
 * no stored session exists. Does NOT trigger interactive sign-in. */
export const getAccessToken = async (): Promise<string> => {
  if (tokenValid(cachedToken)) return cachedToken.accessToken;

  const stored = readStoredAuth();
  if (!stored?.refreshToken) throw new Error('Not signed in.');

  const refreshed = await refreshAccessToken(stored.refreshToken);
  cachedToken = refreshed;
  return refreshed.accessToken;
};

/** Signs out: revokes the refresh token at Google and clears local state. */
export const signOut = async (): Promise<void> => {
  const stored = readStoredAuth();
  const token = stored?.refreshToken || cachedToken?.refreshToken;
  cachedToken = null;
  writeStoredAuth(null);
  if (token) {
    try {
      await fetch(`${OAUTH_REVOKE_ENDPOINT}?token=${encodeURIComponent(token)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      });
    } catch (e) {
      // Non-fatal: local state is already cleared.
      console.warn('Token revoke request failed (local sign-out still applied)', e);
    }
  }
};
