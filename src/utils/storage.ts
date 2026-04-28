// src/utils/storage.ts

import type { AppData, CustomEase } from '../types';

declare global {
  interface Window {
    require: any;
    CSInterface: any;
    SystemPath: any;
    __adobe_cep__: any;
  }
}

export const defaultProfile: AppData = {
  activeProfileId: "profile-1",
  settings: {
    buttonSize: 80,        // Minimum width of buttons in px
    bezierButtonSize: 40,  // Mini curve preset size in the easing editor
    spacing: 8,            // Gap between buttons in px
    enableContext: true,   // Toggle the heartbeat
    customEases: [
      { name: 'My Snappy', p1: { x: 0.8, y: 0 }, p2: { x: 0.2, y: 1 } }
    ],
    easingTopHeight: 240,
    lastOverrideProfileId: null,
    easingClickToApply: false,
    showCurvePreview: false,
    enableCommandPalette: false,
    commandPaletteHotkey: 'Ctrl+Space',
    lockMacros: false,
    undoHistorySize: 10,
  },
  profiles: [
    {
      id: "profile-1",
      name: "Global Tools",
      autoTriggerContext: "none", // Always shows if nothing else matches
      macros: [
        { id: "m1", label: "Add Null", type: "menuCommand", payload: "2767", color: "#3498db" }
      ]
    },
    {
      id: "profile-2",
      name: "Text Tools",
      autoTriggerContext: "textLayer", // ONLY shows when a text layer is selected
      macros: [
        { id: "m2", label: "Center Anchor", type: "menuCommand", payload: "3742", color: "#e67e22" },
        { id: "m3", label: "Convert to Shapes", type: "menuCommand", payload: "3781", color: "#f1c40f" }
      ]
    },
    {
      id: "profile-3",
      name: "Shape Tools",
      autoTriggerContext: "shapeLayer", // ONLY shows when a shape layer is selected
      macros: [
        { id: "m4", label: "Group Shapes", type: "menuCommand", payload: "3741", color: "#9b59b6" }
      ]
    }
  ]
};

// Settings keys belonging to the easing config file. Anything not in this set
// is persisted to the macros file.
const EASING_SETTING_KEYS: ReadonlyArray<keyof AppData['settings']> = [
  'customEases',
  'easingProfiles',
  'activeEasingProfileId',
  'easingSourceFilter',
  'easingTopHeight',
  'bezierButtonSize',
  'easingClickToApply',
  'showCurvePreview',
];

const getConfigDir = (): string | null => {
  if (typeof window.CSInterface === 'undefined') return null;
  const cs = new window.CSInterface();
  const fs = window.require('fs');
  const path = window.require('path');

  const userDataPath = cs.getSystemPath(window.SystemPath.USER_DATA);
  const configDir = path.join(userDataPath, 'AGS-Extensions');

  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
  }

  return configDir;
};

const joinPath = (dir: string, name: string): string => {
  const path = window.require('path');
  return path.join(dir, name);
};

// Backwards-compatible: returns the macros file path. Used by file-watchers.
export const getConfigPath = () => {
  const dir = getConfigDir();
  return dir ? joinPath(dir, 'macros.json') : null;
};

export const getMacrosPath = getConfigPath;

export const getEasingPath = () => {
  const dir = getConfigDir();
  return dir ? joinPath(dir, 'easing.json') : null;
};

const getLegacyPath = () => {
  const dir = getConfigDir();
  return dir ? joinPath(dir, 'config.json') : null;
};

const writeAtomic = (filePath: string, contents: string) => {
  const fs = window.require('fs');
  const tempPath = filePath + '.tmp';
  fs.writeFileSync(tempPath, contents, 'utf8');
  // Windows: rename-over-existing can transiently fail with EPERM/EBUSY when
  // another panel/file-watcher has the destination briefly open. Retry a few
  // times with a tiny backoff before giving up. We use a busy-wait loop
  // because writeAtomic must stay synchronous (called from beforeunload).
  let lastErr: any = null;
  const deadlines = [0, 8, 24, 60]; // ~92ms total worst case
  for (const wait of deadlines) {
    if (wait > 0) {
      const until = Date.now() + wait;
      while (Date.now() < until) { /* spin */ }
    }
    try {
      fs.renameSync(tempPath, filePath);
      return;
    } catch (err: any) {
      lastErr = err;
      const code = err?.code;
      if (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES') break;
    }
  }
  // Best-effort cleanup of the .tmp so it doesn't accumulate.
  try { fs.unlinkSync(tempPath); } catch { /* ignore */ }
  throw lastErr;
};

const splitSettings = (settings: AppData['settings']) => {
  const easing: any = {};
  const macro: any = {};
  for (const k of Object.keys(settings) as Array<keyof AppData['settings']>) {
    if (EASING_SETTING_KEYS.indexOf(k) >= 0) easing[k] = (settings as any)[k];
    else macro[k] = (settings as any)[k];
  }
  return { easing, macro };
};

// Best-effort schema sanitiser. Returns a value matching the shape of T,
// dropping any sub-entries that fail validation. We don't reject the whole
// config on a single bad macro — a corrupted file should still leave the
// user with a usable panel.

const VALID_MACRO_TYPES = new Set(['menuCommand', 'expression', 'script', 'sequence', 'ffx']);

const sanitizeMacro = (raw: any): any | null => {
  if (!raw || typeof raw !== 'object') return null;
  if (typeof raw.id !== 'string' || !raw.id) return null;
  if (typeof raw.label !== 'string') return null;
  if (typeof raw.type !== 'string' || !VALID_MACRO_TYPES.has(raw.type)) return null;
  if (typeof raw.payload !== 'string') return null;
  if (typeof raw.color !== 'string') return null;
  return {
    id: raw.id,
    label: raw.label,
    type: raw.type,
    payload: raw.payload,
    color: raw.color,
    icon: typeof raw.icon === 'string' ? raw.icon : undefined,
    hotkey: typeof raw.hotkey === 'string' ? raw.hotkey : undefined,
    tags: Array.isArray(raw.tags) ? raw.tags.filter((t: unknown) => typeof t === 'string') : undefined,
    menuCommandName: typeof raw.menuCommandName === 'string' ? raw.menuCommandName : undefined,
  };
};

const sanitizeProfile = (raw: any): any | null => {
  if (!raw || typeof raw !== 'object') return null;
  if (typeof raw.id !== 'string' || !raw.id) return null;
  if (typeof raw.name !== 'string') return null;
  const macros = Array.isArray(raw.macros) ? raw.macros.map(sanitizeMacro).filter(Boolean) : [];
  return {
    id: raw.id,
    name: raw.name,
    autoTriggerContext: typeof raw.autoTriggerContext === 'string' ? raw.autoTriggerContext : 'none',
    macros,
  };
};

const sanitizeEase = (raw: any): any | null => {
  if (!raw || typeof raw !== 'object') return null;
  if (typeof raw.name !== 'string') return null;
  const p1 = raw.p1, p2 = raw.p2;
  if (!p1 || !p2) return null;
  const nums = [p1.x, p1.y, p2.x, p2.y];
  if (!nums.every((n: any) => typeof n === 'number' && isFinite(n))) return null;
  const source = raw.source === 'flow' || raw.source === 'mt' || raw.source === 'user'
    ? raw.source
    : undefined;
  return { name: raw.name, p1: { x: p1.x, y: p1.y }, p2: { x: p2.x, y: p2.y }, source };
};

const sanitizeEasingProfile = (raw: any): any | null => {
  if (!raw || typeof raw !== 'object') return null;
  if (typeof raw.id !== 'string' || !raw.id) return null;
  if (typeof raw.name !== 'string') return null;
  const eases = Array.isArray(raw.eases) ? raw.eases.map(sanitizeEase).filter(Boolean) : [];
  return { id: raw.id, name: raw.name, eases };
};

const sanitizeProfiles = (raw: any): any[] | null => {
  if (!Array.isArray(raw)) return null;
  const out = raw.map(sanitizeProfile).filter(Boolean);
  return out.length > 0 ? out : null;
};

export const loadConfig = (): AppData => {
  try {
    const fs = window.require('fs');
    const macrosPath = getMacrosPath();
    const easingPath = getEasingPath();
    const legacyPath = getLegacyPath();

    // Migration: legacy config.json present, split files absent.
    if (
      legacyPath && fs.existsSync(legacyPath) &&
      macrosPath && !fs.existsSync(macrosPath)
    ) {
      try {
        const raw = JSON.parse(fs.readFileSync(legacyPath, 'utf8')) as AppData;
        if (raw && raw.profiles) {
          saveConfig({
            ...raw,
            settings: { ...defaultProfile.settings, ...(raw.settings || {}) },
          });
        }
      } catch (e) { console.error("Legacy migration failed", e); }
    }

    let macroData: any = null;
    let easingData: any = null;
    if (macrosPath && fs.existsSync(macrosPath)) {
      macroData = JSON.parse(fs.readFileSync(macrosPath, 'utf8'));
    }
    if (easingPath && fs.existsSync(easingPath)) {
      easingData = JSON.parse(fs.readFileSync(easingPath, 'utf8'));
    }

    if (!macroData && !easingData) return defaultProfile;

    const settings: AppData['settings'] = {
      ...defaultProfile.settings,
      ...(macroData?.settings ?? {}),
      ...(easingData?.settings ?? {}),
    };
    if (!Array.isArray(settings.customEases)) settings.customEases = [];

    // --- Easing profiles migration / sanitisation ---
    // Pre-existing installs only have `customEases`. On first read with the
    // new code, wrap it into a "Default" profile and stop using the flat
    // field going forward. We keep `customEases` populated as a one-release
    // safety mirror so older builds don't lose data if a user downgrades.
    let easingProfilesRaw: any = settings.easingProfiles;
    let easingProfiles: any[] | null = Array.isArray(easingProfilesRaw)
      ? easingProfilesRaw.map(sanitizeEasingProfile).filter(Boolean)
      : null;
    if (!easingProfiles || easingProfiles.length === 0) {
      const seed = (settings.customEases ?? []).map(sanitizeEase).filter(Boolean);
      easingProfiles = [{ id: 'ep_default', name: 'Default', eases: seed }];
    }
    settings.easingProfiles = easingProfiles;

    // Validate / repoint the active id.
    if (
      typeof settings.activeEasingProfileId !== 'string' ||
      !easingProfiles.some((p: any) => p.id === settings.activeEasingProfileId)
    ) {
      settings.activeEasingProfileId = easingProfiles[0].id;
    }

    // Mirror the active profile's eases into the legacy `customEases` slot
    // so existing callers (and an older build, briefly, if the user downgrades)
    // keep seeing the active set.
    const active = easingProfiles.find((p: any) => p.id === settings.activeEasingProfileId);
    settings.customEases = active ? active.eases : [];

    // Strip malformed profile/macro entries instead of crashing the panel.
    const sanitizedProfiles = sanitizeProfiles(macroData?.profiles) ?? defaultProfile.profiles;
    const activeProfileId =
      typeof macroData?.activeProfileId === 'string'
      && sanitizedProfiles.some((p: any) => p.id === macroData.activeProfileId)
        ? macroData.activeProfileId
        : sanitizedProfiles[0].id;

    return {
      activeProfileId,
      profiles: sanitizedProfiles,
      settings,
    };
  } catch (err) {
    console.error("Failed to load config, using default.", err);
  }
  return defaultProfile;
};

/** Returns the active easing profile. Falls back to a synthetic empty
 * profile if state is somehow torn — the easing panel should always have
 * something to render. */
export const getActiveEasingProfile = (data: AppData) => {
  const list = data.settings.easingProfiles ?? [];
  const id = data.settings.activeEasingProfileId;
  return list.find((p) => p.id === id) ?? list[0] ?? { id: 'ep_default', name: 'Default', eases: [] };
};

/** Replaces the active profile's `eases` and returns the updated AppData.
 * Also keeps the legacy `customEases` mirror in sync. */
export const setActiveEases = (data: AppData, eases: CustomEase[]): AppData => {
  const list = data.settings.easingProfiles ?? [];
  const id = data.settings.activeEasingProfileId;
  const nextProfiles = list.map((p) => (p.id === id ? { ...p, eases } : p));
  return {
    ...data,
    settings: {
      ...data.settings,
      easingProfiles: nextProfiles,
      customEases: eases, // legacy mirror — see migration note in loadConfig
    },
  };
};

/** Sets the active easing profile id and refreshes the legacy mirror. */
export const setActiveEasingProfileId = (data: AppData, id: string): AppData => {
  const list = data.settings.easingProfiles ?? [];
  if (!list.some((p) => p.id === id)) return data;
  const target = list.find((p) => p.id === id)!;
  return {
    ...data,
    settings: {
      ...data.settings,
      activeEasingProfileId: id,
      customEases: target.eases,
    },
  };
};

export const saveConfig = (data: AppData) => {
  try {
    const macrosPath = getMacrosPath();
    const easingPath = getEasingPath();
    if (!macrosPath || !easingPath) return;

    const { macro, easing } = splitSettings(data.settings);

    const macroFile = {
      activeProfileId: data.activeProfileId,
      profiles: data.profiles,
      settings: macro,
    };
    const easingFile = {
      settings: easing,
    };

    writeAtomic(macrosPath, JSON.stringify(macroFile, null, 2));
    writeAtomic(easingPath, JSON.stringify(easingFile, null, 2));
  } catch (err) {
    console.error("Failed to save config.", err);
  }
};

export const setDialogPayload = (payload: any) => {
  try {
    const fs = window.require('fs');
    const path = window.require('path');
    const configPath = getConfigPath();
    if (configPath) {
      const payloadPath = path.join(path.dirname(configPath), 'dialogPayload.json');
      fs.writeFileSync(payloadPath, JSON.stringify(payload), 'utf8');
    }
  } catch (e) { }
};

// Reads and *consumes* the dialog payload. The file is unlinked after parse so
// a later panel relaunch (without a fresh setDialogPayload call) can't replay
// a stale action. Best-effort cleanup — any IO error is swallowed and we
// return whatever we managed to parse.
export const getDialogPayload = (): any => {
  try {
    const fs = window.require('fs');
    const path = window.require('path');
    const configPath = getConfigPath();
    if (!configPath) return null;
    const payloadPath = path.join(path.dirname(configPath), 'dialogPayload.json');
    if (!fs.existsSync(payloadPath)) return null;
    const parsed = JSON.parse(fs.readFileSync(payloadPath, 'utf8'));
    try { fs.unlinkSync(payloadPath); } catch (_) { /* ignore */ }
    return parsed;
  } catch (e) { }
  return null;
};

// src/utils/storage.ts

export const getFilesInDirectory = (dirPath: string) => {
  try {
    const fs = window.require('fs');
    const path = window.require('path');

    // Read the directory contents
    const dirents = fs.readdirSync(dirPath, { withFileTypes: true });

    const items = dirents.map((dirent: any) => ({
      name: dirent.name,
      isDirectory: dirent.isDirectory(),
      path: path.join(dirPath, dirent.name).replace(/\\/g, "/")
    }));

    // Filter out hidden files (starting with '.') and keep only folders or .jsx/.jsxbin files
    const filteredItems = items.filter((item: any) => {
      if (item.name.startsWith('.')) return false;
      if (item.isDirectory) return true;
      return item.name.endsWith('.jsx') || item.name.endsWith('.jsxbin');
    });

    // Sort: Folders first, then files alphabetically
    return filteredItems.sort((a: any, b: any) => {
      if (a.isDirectory && !b.isDirectory) return -1;
      if (!a.isDirectory && b.isDirectory) return 1;
      return a.name.localeCompare(b.name);
    });

  } catch (err) {
    console.error("Error reading directory", err);
    return [];
  }
};

// Helper to get the user's Documents folder as a safe starting point
export const getDefaultStartingPath = () => {
  if (typeof window.CSInterface === 'undefined') return "C:/";
  const cs = new window.CSInterface();
  return cs.getSystemPath(window.SystemPath.MY_DOCUMENTS).replace(/\\/g, "/");
};

/**
 * Converts an absolute path to a relative one if it's inside the AppData/AG folder.
 * The user specified 'AppData/AG' as the base for relative scripts.
 */
export const relativizePath = (absPath: string): string => {
  if (typeof window.CSInterface === 'undefined') return absPath;
  const cs = new window.CSInterface();
  const path = window.require('path');
  const userData = cs.getSystemPath(window.SystemPath.USER_DATA);
  const agBase = path.join(userData, 'AGS-Extensions').replace(/\\/g, "/");

  if (absPath.startsWith(agBase)) {
    return "AG://" + absPath.slice(agBase.length + 1);
  }
  return absPath;
};

/**
 * Resolves a potentially relative path back to an absolute one.
 */
export const resolvePath = (relPath: string): string => {
  if (!relPath.startsWith("AG://")) return relPath;
  if (typeof window.CSInterface === 'undefined') return relPath.replace("AG://", "C:/AGS-Extensions/");
  const cs = new window.CSInterface();
  const path = window.require('path');
  const userData = cs.getSystemPath(window.SystemPath.USER_DATA);
  const agBase = path.join(userData, 'AGS-Extensions').replace(/\\/g, "/");
  return agBase + "/" + relPath.slice(5);
};