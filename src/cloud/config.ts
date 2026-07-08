// src/cloud/config.ts
//
// Static configuration for the Google Drive backup feature. This is Google's
// "installed app" / Desktop OAuth flow. PKCE (a fresh challenge per sign-in) is
// what actually protects the token exchange against interception — but note
// Google's quirk: even Desktop-app clients are ISSUED a client_secret and
// Google's token endpoint REQUIRES it in the code exchange. For installed apps
// this secret is not truly confidential (it necessarily ships inside the app);
// PKCE is the real protection. So both the client ID and secret are embedded
// here on purpose, per Google's documented installed-app model.
//
// To wire this up: create an OAuth 2.0 Client ID of type "Desktop app" in the
// Google Cloud console for the project whose consent screen points at
// https://www.aldairgonzalez.me/mtag/ , then put both values in a local,
// gitignored .env.local (copy .env.example). They're read at build time via
// Vite and inlined into the bundle — kept out of source control, not out of
// the shipped app (for an installed app neither value is truly confidential).

/** OAuth 2.0 Desktop-app client ID. Sourced from .env.local at build time. */
export const GOOGLE_CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID ?? '';

/**
 * OAuth 2.0 Desktop-app client secret. NOT confidential for installed apps —
 * Google requires it in the token exchange even under PKCE. Sourced from
 * .env.local at build time so it never enters version control.
 */
export const GOOGLE_CLIENT_SECRET = import.meta.env.VITE_GOOGLE_CLIENT_SECRET ?? '';

/**
 * The single OAuth scope we request. `drive.appdata` grants access ONLY to a
 * hidden, per-app folder inside the user's Drive — it cannot see or touch any
 * of the user's other files. This keeps us out of Google's "restricted scope"
 * verification tier (no annual security assessment required).
 */
export const DRIVE_APPDATA_SCOPE = 'https://www.googleapis.com/auth/drive.appdata';

/** Google OAuth 2.0 + Drive endpoints. */
export const OAUTH_AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
export const OAUTH_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
export const OAUTH_REVOKE_ENDPOINT = 'https://oauth2.googleapis.com/revoke';
export const DRIVE_API_FILES = 'https://www.googleapis.com/drive/v3/files';
export const DRIVE_UPLOAD_FILES = 'https://www.googleapis.com/upload/drive/v3/files';

/**
 * The five MTAG panels that participate in cloud sync. Each maps to one JSON
 * document in appDataFolder. `files` lists the local file basenames (relative
 * to the AGS-Extensions config dir) that make up that panel's backup.
 *
 * The Palettes/ directory and Motion Toolbar's user assets (.ffx/.jsx/icons)
 * are handled as separate multi-file bundles by the sync engine — see
 * PANEL_ASSET_DIRS below — because their contents are dynamic.
 */
export type PanelId = 'color' | 'gifs' | 'eases' | 'toolbar' | 'switch';

export interface PanelSpec {
  id: PanelId;
  label: string;
  /** Remote file name inside appDataFolder. */
  remoteName: string;
  /** Local config-dir basenames bundled into this panel's backup document. */
  files: string[];
}

export const PANELS: Record<PanelId, PanelSpec> = {
  color: {
    id: 'color',
    label: 'MTAG Color',
    remoteName: 'mtag-color.json',
    files: ['colorSettings.json', 'colorState.json', 'colorHistory.json', 'paletteState.json'],
  },
  gifs: {
    id: 'gifs',
    label: 'MTAG GIFs',
    remoteName: 'mtag-gifs.json',
    files: ['gifSettings.json'],
  },
  eases: {
    id: 'eases',
    label: 'MTAG Eases',
    remoteName: 'mtag-eases.json',
    files: ['easing.json'],
  },
  toolbar: {
    id: 'toolbar',
    label: 'Motion Toolbar',
    remoteName: 'mtag-toolbar.json',
    files: ['macros.json'],
  },
  switch: {
    id: 'switch',
    label: 'MTAG Switch',
    remoteName: 'mtag-switch.json',
    files: ['switchSettings.json'],
  },
};

/**
 * Config-dir subfolders whose full contents sync as a bundle (variable file
 * lists). Keyed by the panel that owns them.
 *  - color  → the named Palettes/ collection
 *  - toolbar→ user-provided script/preset/icon assets referenced by macros
 */
export const PANEL_ASSET_DIRS: Partial<Record<PanelId, string[]>> = {
  color: ['Palettes'],
};
