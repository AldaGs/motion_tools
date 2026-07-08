// src/cloud/syncEngine.ts
//
// Bridges the local AGS-Extensions config dir <-> per-panel Drive documents.
//
// Strategy: local-first with last-write-wins. Each panel's local files are
// bundled into a BackupEnvelope carrying an `updatedAt` timestamp. On push we
// overwrite the remote document; on pull we compare the remote `updatedAt`
// against a locally recorded high-water mark and only overwrite local files if
// the remote is newer. Conflicts (both changed since last sync) resolve to the
// newer timestamp — these are single-user personal settings, not collaborative
// documents, so LWW is the right call.

import { PANELS, PANEL_ASSET_DIRS } from './config';
import type { PanelId } from './config';
import { upsertFile, findByName, downloadText } from './driveClient';
import type { BackupEnvelope, PanelSyncStatus } from './types';

declare global {
  interface Window {
    require: any;
    CSInterface: any;
    SystemPath: any;
  }
}

// ---- local fs helpers (mirror storage.ts's config-dir resolution) ----------

const hasNode = () => typeof window !== 'undefined' && typeof window.require === 'function';

const configDir = (): string | null => {
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

const machineName = (): string => {
  try {
    return window.require('os').hostname() || 'unknown';
  } catch {
    return 'unknown';
  }
};

// ---- local sync high-water marks ------------------------------------------
// Records the updatedAt we last reconciled per panel, so we can distinguish
// "remote is genuinely newer" from "remote is our own last push".

const syncMetaPath = (): string | null => {
  const dir = configDir();
  if (!dir) return null;
  return window.require('path').join(dir, 'cloudSync.json');
};

type SyncMeta = Record<PanelId, { lastSyncedAt: number }>;

const readSyncMeta = (): Partial<SyncMeta> => {
  try {
    const p = syncMetaPath();
    if (!p) return {};
    const fs = window.require('fs');
    if (!fs.existsSync(p)) return {};
    return JSON.parse(fs.readFileSync(p, 'utf8')) ?? {};
  } catch {
    return {};
  }
};

const writeSyncMeta = (meta: Partial<SyncMeta>) => {
  try {
    const p = syncMetaPath();
    if (!p) return;
    window.require('fs').writeFileSync(p, JSON.stringify(meta, null, 2), 'utf8');
  } catch (e) {
    console.error('Failed to write cloudSync.json', e);
  }
};

// ---- envelope build / apply ------------------------------------------------

// Binary-ish assets (icons, ffx) are base64-encoded; JSON stays utf8 text.
const isBinary = (name: string) => /\.(ffx|jsx|jsxbin|png|jpg|jpeg|gif|ico)$/i.test(name);

const readLocalFile = (dir: string, rel: string): { encoding: 'utf8' | 'base64'; data: string } | null => {
  try {
    const fs = window.require('fs');
    const path = window.require('path');
    const full = path.join(dir, rel);
    if (!fs.existsSync(full)) return null;
    if (isBinary(rel)) {
      return { encoding: 'base64', data: fs.readFileSync(full).toString('base64') };
    }
    return { encoding: 'utf8', data: fs.readFileSync(full, 'utf8') };
  } catch {
    return null;
  }
};

const writeLocalFile = (dir: string, rel: string, file: { encoding: 'utf8' | 'base64'; data: string }) => {
  const fs = window.require('fs');
  const path = window.require('path');
  const full = path.join(dir, rel);
  const parent = path.dirname(full);
  if (!fs.existsSync(parent)) fs.mkdirSync(parent, { recursive: true });
  if (file.encoding === 'base64') {
    const NodeBuffer = window.require('buffer').Buffer;
    fs.writeFileSync(full, NodeBuffer.from(file.data, 'base64'));
  } else {
    fs.writeFileSync(full, file.data, 'utf8');
  }
};

// Expands a panel's file list, including any asset directories (recursively),
// into a flat list of config-dir-relative paths.
const collectPanelFiles = (dir: string, panel: PanelId): string[] => {
  const fs = window.require('fs');
  const path = window.require('path');
  const spec = PANELS[panel];
  const out: string[] = [...spec.files];

  for (const sub of PANEL_ASSET_DIRS[panel] ?? []) {
    const walk = (relDir: string) => {
      const abs = path.join(dir, relDir);
      if (!fs.existsSync(abs)) return;
      for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
        const rel = `${relDir}/${entry.name}`;
        if (entry.isDirectory()) walk(rel);
        else out.push(rel);
      }
    };
    walk(sub);
  }
  return out;
};

/** The newest mtime across a panel's local files, as epoch ms. 0 if none. */
const localUpdatedAt = (dir: string, panel: PanelId): number => {
  const fs = window.require('fs');
  const path = window.require('path');
  let newest = 0;
  for (const rel of collectPanelFiles(dir, panel)) {
    try {
      const st = fs.statSync(path.join(dir, rel));
      newest = Math.max(newest, st.mtimeMs);
    } catch { /* missing file — skip */ }
  }
  return newest;
};

const buildEnvelope = (dir: string, panel: PanelId): BackupEnvelope => {
  const files: BackupEnvelope['files'] = {};
  for (const rel of collectPanelFiles(dir, panel)) {
    const f = readLocalFile(dir, rel);
    if (f) files[rel] = f;
  }
  return {
    schema: 1,
    panel,
    updatedAt: localUpdatedAt(dir, panel) || Date.now(),
    origin: machineName(),
    files,
  };
};

const applyEnvelope = (dir: string, env: BackupEnvelope) => {
  for (const [rel, file] of Object.entries(env.files)) {
    writeLocalFile(dir, rel, file);
  }
};

// ---- public: push / pull / sync -------------------------------------------

/** Uploads the panel's current local state to Drive, overwriting the remote
 * document. Records the new high-water mark. */
export const pushPanel = async (panel: PanelId): Promise<PanelSyncStatus> => {
  if (!hasNode()) return { panel, state: 'error', message: 'Not in CEP runtime' };
  const dir = configDir();
  if (!dir) return { panel, state: 'error', message: 'No config dir' };

  try {
    const env = buildEnvelope(dir, panel);
    await upsertFile(PANELS[panel].remoteName, JSON.stringify(env), {
      appProperties: { updatedAt: String(env.updatedAt), panel },
    });
    const meta = readSyncMeta();
    meta[panel] = { lastSyncedAt: env.updatedAt };
    writeSyncMeta(meta);
    return { panel, state: 'ok', lastSyncedAt: env.updatedAt };
  } catch (e: any) {
    return { panel, state: 'error', message: e?.message ?? String(e) };
  }
};

/** Pulls the panel's remote document if it exists and is newer than what we
 * last reconciled, writing it over local files. */
export const pullPanel = async (panel: PanelId): Promise<PanelSyncStatus> => {
  if (!hasNode()) return { panel, state: 'error', message: 'Not in CEP runtime' };
  const dir = configDir();
  if (!dir) return { panel, state: 'error', message: 'No config dir' };

  try {
    const remote = await findByName(PANELS[panel].remoteName);
    if (!remote) return { panel, state: 'idle', message: 'No remote backup yet' };

    const env = JSON.parse(await downloadText(remote.id)) as BackupEnvelope;
    const localTs = localUpdatedAt(dir, panel);

    // Remote wins only if strictly newer than local working state.
    if (env.updatedAt > localTs) {
      applyEnvelope(dir, env);
      const meta = readSyncMeta();
      meta[panel] = { lastSyncedAt: env.updatedAt };
      writeSyncMeta(meta);
      return { panel, state: 'ok', lastSyncedAt: env.updatedAt };
    }
    return { panel, state: 'ok', lastSyncedAt: localTs, message: 'Local is up to date' };
  } catch (e: any) {
    return { panel, state: 'error', message: e?.message ?? String(e) };
  }
};

/**
 * Two-way reconcile for a panel: whichever side (local mtime vs. remote
 * updatedAt) is newer wins. Used on panel open and on manual "Sync now".
 */
export const syncPanel = async (panel: PanelId): Promise<PanelSyncStatus> => {
  if (!hasNode()) return { panel, state: 'error', message: 'Not in CEP runtime' };
  const dir = configDir();
  if (!dir) return { panel, state: 'error', message: 'No config dir' };

  try {
    const remote = await findByName(PANELS[panel].remoteName);
    const localTs = localUpdatedAt(dir, panel);

    if (!remote) {
      // Nothing remote yet — push if we have anything locally.
      return localTs > 0 ? pushPanel(panel) : { panel, state: 'idle' };
    }

    const env = JSON.parse(await downloadText(remote.id)) as BackupEnvelope;
    if (env.updatedAt > localTs) {
      applyEnvelope(dir, env);
      const meta = readSyncMeta();
      meta[panel] = { lastSyncedAt: env.updatedAt };
      writeSyncMeta(meta);
      return { panel, state: 'ok', lastSyncedAt: env.updatedAt, message: 'Pulled newer remote' };
    }
    if (localTs > env.updatedAt) {
      return pushPanel(panel);
    }
    return { panel, state: 'ok', lastSyncedAt: localTs, message: 'In sync' };
  } catch (e: any) {
    return { panel, state: 'error', message: e?.message ?? String(e) };
  }
};

/** Syncs every panel. Returns per-panel status. */
export const syncAll = async (): Promise<PanelSyncStatus[]> => {
  const ids = Object.keys(PANELS) as PanelId[];
  const results: PanelSyncStatus[] = [];
  for (const id of ids) {
    // Sequential to keep Drive rate-limits and the UI progress simple.
    results.push(await syncPanel(id));
  }
  return results;
};
