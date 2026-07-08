// src/cloud/types.ts
import type { PanelId } from './config';

/** OAuth token bundle held in memory + persisted (access token stripped) for
 * silent refresh. Times are epoch milliseconds. */
export interface TokenSet {
  accessToken: string;
  /** Absent when the user declined offline access; without it we re-prompt. */
  refreshToken?: string;
  /** When the access token stops working and must be refreshed. */
  expiresAt: number;
  scope: string;
  tokenType: string;
}

/** Persisted auth state (refresh token only — access tokens are never written
 * to disk). Lives in the config dir as googleAuth.json. */
export interface StoredAuth {
  refreshToken: string;
  scope: string;
  /** Best-effort display label; we do NOT request profile scope, so this is
   * only ever populated if the user typed it. Usually undefined. */
  account?: string;
}

/** One file inside appDataFolder as returned by files.list. */
export interface DriveFileMeta {
  id: string;
  name: string;
  /** Bytes, as a string in the Drive API; parsed to number on read. */
  size?: number;
  modifiedTime?: string;
  appProperties?: Record<string, string>;
}

/** Envelope written to each per-panel Drive document. The body is the bundle
 * of local files; `updatedAt` drives last-write-wins conflict resolution. */
export interface BackupEnvelope {
  schema: 1;
  panel: PanelId;
  /** epoch ms of the local save that produced this snapshot. */
  updatedAt: number;
  /** Machine label so the UI can say "last synced from DESKTOP-ABC". */
  origin: string;
  /** basename -> file contents (UTF-8 JSON text, or base64 for binary). */
  files: Record<string, { encoding: 'utf8' | 'base64'; data: string }>;
}

export type SyncState = 'idle' | 'syncing' | 'error' | 'ok' | 'conflict';

export interface PanelSyncStatus {
  panel: PanelId;
  state: SyncState;
  /** epoch ms of last successful push/pull. */
  lastSyncedAt?: number;
  message?: string;
}

export type AuthState =
  | { status: 'signed-out' }
  | { status: 'signing-in' }
  | { status: 'signed-in'; account?: string }
  | { status: 'error'; message: string };
