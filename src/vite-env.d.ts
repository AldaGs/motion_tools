/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** OAuth 2.0 Desktop-app client ID (from Google Cloud Credentials). */
  readonly VITE_GOOGLE_CLIENT_ID?: string;
  /** OAuth 2.0 Desktop-app client secret. Not confidential for installed apps
   * (Google requires it even under PKCE), but kept out of source via .env.local. */
  readonly VITE_GOOGLE_CLIENT_SECRET?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
