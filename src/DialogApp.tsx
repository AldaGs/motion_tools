import { useState, useEffect, useRef } from 'react';
import { loadConfig, saveConfig, getDialogPayload, relativizePath } from './utils/storage';
import type { AppData, Macro, MacroType, Profile, ProfileContext, EasingProfile } from './types';
import IconPicker from './components/IconPicker';
import TagsInput from './components/TagsInput';
import ConfirmDialog from './components/ConfirmDialog';
import Toaster from './components/Toaster';
import { toast } from './utils/toast';
import { formatHotkey } from './utils/hotkey';
import { parseEasingFile, mergeEasesUnique } from './utils/easingImport';
import COMMAND_IDS from './utils/2025.json';

const CONTEXT_LABELS: Record<ProfileContext, string> = {
  none: 'Default / Fallback',
  textLayer: 'Text Layer',
  shapeLayer: 'Shape Layer',
  cameraLayer: 'Camera',
  lightLayer: 'Light',
  nullLayer: 'Null',
  solidLayer: 'Solid',
  precomp: 'Pre-comp',
  footageLayer: 'Footage',
  mixed: 'Mixed Selection',
};
const CONTEXT_VALUES: ProfileContext[] = [
  'none', 'textLayer', 'shapeLayer', 'cameraLayer', 'lightLayer',
  'nullLayer', 'solidLayer', 'precomp', 'footageLayer', 'mixed',
];

export default function DialogApp() {
  const [appData, setAppData] = useState<AppData | null>(null);
  const [dialogMode, setDialogMode] = useState<'settings' | 'macro' | null>(null);
  const [editingMacroId, setEditingMacroId] = useState<string | null>(null);
  const originalMacro = useRef<Macro | null>(null);
  const [newMacro, setNewMacro] = useState<Omit<Macro, 'id'>>({ label: '', type: 'menuCommand', payload: '', color: '#3498db', icon: '', hotkey: '', tags: [], menuCommandName: '' });
  const [commandSearch, setCommandSearch] = useState('');
  const [showCommandList, setShowCommandList] = useState(false);
  const commandListRef = useRef<HTMLDivElement>(null);

  // Synchronous-rollback machinery. The dialog live-saves to disk on every
  // keystroke so the parent panel can reflect edits immediately. The downside
  // is that closing the dialog by any means *other* than the in-panel Apply
  // button must roll the disk back. We track the latest state in refs so a
  // beforeunload handler can read it synchronously.
  const appDataRef = useRef<AppData | null>(null);
  const editingMacroIdRef = useRef<string | null>(null);
  const dialogModeRef = useRef<'settings' | 'macro' | null>(null);
  const skipRollbackRef = useRef(false);
  useEffect(() => { appDataRef.current = appData; }, [appData]);
  useEffect(() => { editingMacroIdRef.current = editingMacroId; }, [editingMacroId]);
  useEffect(() => { dialogModeRef.current = dialogMode; }, [dialogMode]);

  // Debounced disk writes. Hot paths (typing into a label/payload, dragging a
  // slider, renaming a profile) used to call writeFileSync on every keystroke.
  // We batch them on a 200ms tail. saveFlush is called before Apply so the
  // committed state hits disk immediately; saveCancel by rollback so we don't
  // race a stale write past the rollback's final write.
  const saveTimerRef = useRef<number | null>(null);
  const pendingSaveRef = useRef<AppData | null>(null);
  const saveDebounced = (data: AppData) => {
    pendingSaveRef.current = data;
    if (saveTimerRef.current !== null) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = window.setTimeout(() => {
      if (pendingSaveRef.current) saveConfig(pendingSaveRef.current);
      pendingSaveRef.current = null;
      saveTimerRef.current = null;
    }, 200);
  };
  const saveFlush = () => {
    if (saveTimerRef.current !== null) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    if (pendingSaveRef.current) {
      saveConfig(pendingSaveRef.current);
      pendingSaveRef.current = null;
    }
  };
  const saveCancel = () => {
    if (saveTimerRef.current !== null) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    pendingSaveRef.current = null;
  };
  // Make sure nothing pending is left in memory when the dialog unmounts.
  useEffect(() => () => saveFlush(), []);


  // List the (otherProfileName, hotkey) pairs that already use the current
  // hotkey, so the Tool Editor can warn about collisions.
  const hotkeyCollisions = (() => {
    if (!appData || !newMacro.hotkey) return [] as { profile: string; label: string }[];
    const out: { profile: string; label: string }[] = [];
    for (const p of appData.profiles) {
      for (const m of p.macros) {
        if (m.id === editingMacroId) continue;
        if (m.hotkey === newMacro.hotkey) out.push({ profile: p.name, label: m.label });
      }
    }
    return out;
  })();

  useEffect(() => {
    // Initial load
    setAppData(loadConfig());
    
    const data = getDialogPayload();
    if (data) {
      if (data.mode === 'settings') {
        setDialogMode('settings');
        // Deep-link from the easing panel — scroll the easing-profiles
        // section into view once the dialog has rendered.
        if (data.focus === 'easingProfiles') {
          setTimeout(() => easingProfilesSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 60);
        }
      } else if (data.mode === 'macro') {
        setDialogMode('macro');
        if (data.macro) {
          originalMacro.current = typeof structuredClone === 'function'
            ? structuredClone(data.macro)
            : JSON.parse(JSON.stringify(data.macro));
          setEditingMacroId(data.macro.id);
          setNewMacro({ label: data.macro.label, type: data.macro.type, payload: data.macro.payload, color: data.macro.color, icon: data.macro.icon ?? '', hotkey: data.macro.hotkey ?? '', tags: data.macro.tags ?? [], menuCommandName: data.macro.menuCommandName ?? '' });
        } else {
          originalMacro.current = null;
          const newId = 'm_' + Date.now();
          setEditingMacroId(newId);
          setNewMacro({ label: '', type: 'menuCommand', payload: '', color: '#3498db', icon: '', hotkey: '', tags: [], menuCommandName: '' });
          // We don't save to disk immediately, we let the first edit trigger the live save
        }
      }
    } else {
      if (typeof window.__adobe_cep__ === 'undefined') {
        setDialogMode('settings');
      }
    }
  }, []);

  // Close command list when clicking outside
  useEffect(() => {
    const handleDown = (e: MouseEvent) => {
      if (commandListRef.current && !commandListRef.current.contains(e.target as Node)) {
        setShowCommandList(false);
      }
    };
    window.addEventListener('mousedown', handleDown);
    return () => window.removeEventListener('mousedown', handleDown);
  }, []);

  const notifyUpdate = () => {
    if (typeof window.__adobe_cep__ !== 'undefined') {
      window.__adobe_cep__.closeExtension();
    }
  };

  // --- MACRO LOGIC ---
  const updateMacro = (updates: Partial<Omit<Macro, 'id'>>) => {
    const updated = { ...newMacro, ...updates };
    setNewMacro(updated);
    
    if (!appData || !editingMacroId) return;
    const profileIndex = appData.profiles.findIndex((p) => p.id === appData.activeProfileId);
    if (profileIndex < 0) return;
    const macros = [...appData.profiles[profileIndex].macros];
    const mIdx = macros.findIndex((m) => m.id === editingMacroId);
    const macroPayload = { ...updated, id: editingMacroId };
    
    if (mIdx >= 0) {
      macros[mIdx] = macroPayload;
    } else {
      macros.push(macroPayload);
    }
    const nextAppData = { ...appData, profiles: [...appData.profiles] };
    nextAppData.profiles[profileIndex].macros = macros;
    setAppData(nextAppData);
    // Hot path — debounce the disk write. saveFlush runs on Apply.
    saveDebounced(nextAppData);
  };

  // Reverts the in-progress macro on disk: restores the snapshot taken at
  // dialog open, or removes the unsaved new macro entirely. Idempotent — runs
  // once even if invoked twice (e.g. Cancel button + beforeunload).
  const rollbackMacro = () => {
    if (skipRollbackRef.current) return;
    skipRollbackRef.current = true;

    // Discard any pending debounced write so it can't land *after* the
    // rollback's synchronous write below.
    saveCancel();

    const data = appDataRef.current;
    const macroId = editingMacroIdRef.current;
    if (!data || !macroId) return;

    const profileIndex = data.profiles.findIndex((p) => p.id === data.activeProfileId);
    if (profileIndex < 0) return;

    const macros = [...data.profiles[profileIndex].macros];
    const mIdx = macros.findIndex((m) => m.id === macroId);

    if (originalMacro.current) {
      if (mIdx >= 0) macros[mIdx] = originalMacro.current;
    } else {
      if (mIdx >= 0) macros.splice(mIdx, 1);
    }

    const nextAppData = { ...data, profiles: [...data.profiles] };
    nextAppData.profiles[profileIndex].macros = macros;
    saveConfig(nextAppData); // synchronous final write — beforeunload-safe
  };

  const handleApplyMacro = () => {
    // Edits are already live on disk; flush the latest pending write before
    // closing so the parent panel doesn't briefly show a stale config.
    saveFlush();
    skipRollbackRef.current = true;
    notifyUpdate();
  };

  const handleCancelMacro = () => {
    rollbackMacro();
    notifyUpdate();
  };

  // Catch closes that bypass the Cancel button: AE titlebar X, panel close,
  // workspace switch, etc. CEF doesn't always fire `beforeunload` reliably for
  // host-initiated closes, so we listen on `unload` and `pagehide` too —
  // `rollbackMacro` is idempotent via skipRollbackRef.
  useEffect(() => {
    const handler = () => {
      if (dialogModeRef.current === 'macro') {
        rollbackMacro();
      } else if (dialogModeRef.current === 'settings') {
        saveFlush();
      }
    };
    const events: Array<keyof WindowEventMap> = ['beforeunload', 'unload', 'pagehide'];
    events.forEach((evt) => window.addEventListener(evt, handler));
    return () => events.forEach((evt) => window.removeEventListener(evt, handler));
  }, []);

  const handleBrowseScript = () => {
    if (typeof window.cep === 'undefined') return toast.error("Only works in AE.");
    const result = window.cep.fs.showOpenDialog(false, false, "Select Script", "", ["jsx", "jsxbin"]);
    if (result.err === 0 && result.data.length > 0) {
      updateMacro({ payload: relativizePath(result.data[0].replace(/\\/g, "/")) });
    }
  };

  const updateSetting = <K extends keyof AppData['settings']>(key: K, value: AppData['settings'][K]) => {
    if (!appData) return;
    const newAppData: AppData = { ...appData, settings: { ...appData.settings, [key]: value } };
    setAppData(newAppData);
    // Slider drags are also a hot path — debounce.
    saveDebounced(newAppData);
  };

  const writeProfiles = (profiles: Profile[], extra?: Partial<AppData>) => {
    if (!appData) return;
    const newAppData: AppData = { ...appData, profiles, ...extra };
    setAppData(newAppData);
    // Profile rename inputs typed per-keystroke — debounce.
    saveDebounced(newAppData);
  };

  const handleAddProfile = () => {
    if (!appData) return;
    const newProfile: Profile = {
      id: 'p_' + Date.now(),
      name: 'New Profile',
      autoTriggerContext: 'none',
      macros: [],
    };
    writeProfiles([...appData.profiles, newProfile], { activeProfileId: newProfile.id });
  };

  const handleRenameProfile = (id: string, name: string) => {
    if (!appData) return;
    writeProfiles(appData.profiles.map((p) => (p.id === id ? { ...p, name } : p)));
  };

  const handleSetProfileContext = (id: string, ctx: ProfileContext) => {
    if (!appData) return;
    writeProfiles(appData.profiles.map((p) => (p.id === id ? { ...p, autoTriggerContext: ctx } : p)));
  };

  const handleDuplicateProfile = (id: string) => {
    if (!appData) return;
    const src = appData.profiles.find((p) => p.id === id);
    if (!src) return;
    const copy: Profile = {
      ...src,
      id: 'p_' + Date.now(),
      name: src.name + ' Copy',
      macros: src.macros.map((m) => ({ ...m, id: 'm_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7) })),
    };
    const idx = appData.profiles.findIndex((p) => p.id === id);
    const next = [...appData.profiles];
    next.splice(idx + 1, 0, copy);
    writeProfiles(next);
  };

  const easingProfilesSectionRef = useRef<HTMLDivElement>(null);
  const [confirmDeleteProfileId, setConfirmDeleteProfileId] = useState<string | null>(null);
  const handleDeleteProfile = (id: string) => {
    if (!appData) return;
    if (appData.profiles.length <= 1) return toast.error("Can't delete the last profile.");
    setConfirmDeleteProfileId(id);
  };
  const performDeleteProfile = () => {
    if (!appData || !confirmDeleteProfileId) return;
    const id = confirmDeleteProfileId;
    setConfirmDeleteProfileId(null);
    const next = appData.profiles.filter((p) => p.id !== id);
    const extra: Partial<AppData> = {};
    if (appData.activeProfileId === id) extra.activeProfileId = next[0].id;
    writeProfiles(next, extra);
  };

  const handleMoveProfile = (id: string, dir: -1 | 1) => {
    if (!appData) return;
    const idx = appData.profiles.findIndex((p) => p.id === id);
    const target = idx + dir;
    if (idx < 0 || target < 0 || target >= appData.profiles.length) return;
    const next = [...appData.profiles];
    [next[idx], next[target]] = [next[target], next[idx]];
    writeProfiles(next);
  };

  // --- EASING PROFILES ---
  const writeEasingProfiles = (
    profiles: EasingProfile[],
    extra?: { activeId?: string },
  ) => {
    if (!appData) return;
    // Keep the legacy `customEases` mirror in sync with whichever profile
    // is active (or about to be), so EasingEditor's existing readers don't
    // see a mismatch on the next file-watch reload.
    const activeId = extra?.activeId ?? appData.settings.activeEasingProfileId ?? profiles[0]?.id;
    const active = profiles.find((p) => p.id === activeId) ?? profiles[0];
    const newAppData: AppData = {
      ...appData,
      settings: {
        ...appData.settings,
        easingProfiles: profiles,
        activeEasingProfileId: active?.id,
        customEases: active?.eases ?? [],
      },
    };
    setAppData(newAppData);
    saveDebounced(newAppData);
  };

  const easingProfiles = appData?.settings.easingProfiles ?? [];

  const handleAddEasingProfile = () => {
    if (!appData) return;
    const newProfile: EasingProfile = {
      id: 'ep_' + Date.now(),
      name: 'New Easing Profile',
      eases: [],
    };
    writeEasingProfiles([...easingProfiles, newProfile], { activeId: newProfile.id });
  };

  const handleRenameEasingProfile = (id: string, name: string) => {
    writeEasingProfiles(easingProfiles.map((p) => (p.id === id ? { ...p, name } : p)));
  };

  const handleDuplicateEasingProfile = (id: string) => {
    const src = easingProfiles.find((p) => p.id === id);
    if (!src) return;
    const copy: EasingProfile = {
      ...src,
      id: 'ep_' + Date.now(),
      name: src.name + ' Copy',
      eases: src.eases.map((e) => ({ ...e })),
    };
    const idx = easingProfiles.findIndex((p) => p.id === id);
    const next = [...easingProfiles];
    next.splice(idx + 1, 0, copy);
    writeEasingProfiles(next);
  };

  const [confirmDeleteEasingProfileId, setConfirmDeleteEasingProfileId] = useState<string | null>(null);
  const handleDeleteEasingProfile = (id: string) => {
    if (easingProfiles.length <= 1) return toast.error("Can't delete the last easing profile.");
    setConfirmDeleteEasingProfileId(id);
  };
  const performDeleteEasingProfile = () => {
    if (!confirmDeleteEasingProfileId) return;
    const id = confirmDeleteEasingProfileId;
    setConfirmDeleteEasingProfileId(null);
    const next = easingProfiles.filter((p) => p.id !== id);
    const wasActive = appData?.settings.activeEasingProfileId === id;
    writeEasingProfiles(next, wasActive ? { activeId: next[0].id } : undefined);
  };

  const handleMoveEasingProfile = (id: string, dir: -1 | 1) => {
    const idx = easingProfiles.findIndex((p) => p.id === id);
    const target = idx + dir;
    if (idx < 0 || target < 0 || target >= easingProfiles.length) return;
    const next = [...easingProfiles];
    [next[idx], next[target]] = [next[target], next[idx]];
    writeEasingProfiles(next);
  };

  const handleSetActiveEasingProfile = (id: string) => {
    if (!easingProfiles.some((p) => p.id === id)) return;
    writeEasingProfiles(easingProfiles, { activeId: id });
  };

  // Default save/open location: same AGS-Extensions folder we use for config.
  // Falls back to MY_DOCUMENTS so the dialog still opens somewhere sensible
  // when CSInterface isn't available (which shouldn't happen here, but cheap
  // defensiveness).
  const getStartingDir = (): string => {
    try {
      if (typeof window.CSInterface !== 'undefined') {
        const cs = new window.CSInterface();
        const userData = cs.getSystemPath(window.SystemPath.USER_DATA);
        return (userData + '/AGS-Extensions').replace(/\\/g, '/');
      }
    } catch (e) { /* fall through */ }
    return 'C:/';
  };

  // Saves to disk via the native CEP save dialog. The browser-style
  // <a download> shortcut silently no-ops inside CEP — no download manager.
  const saveJsonViaDialog = (suggestedName: string, payload: unknown) => {
    if (typeof window.cep === 'undefined') {
      toast.error("Export requires the CEP environment.");
      return;
    }
    try {
      const startDir = getStartingDir();
      const initial = (startDir + '/' + suggestedName).replace(/\\/g, '/');
      const result = window.cep.fs.showSaveDialogEx
        ? window.cep.fs.showSaveDialogEx("Export", startDir, ["json"], suggestedName, initial)
        : window.cep.fs.showSaveDialog("Export", startDir, ["json"], suggestedName);

      if (!result || result.err !== 0 || !result.data) return; // user cancelled

      let target = String(result.data).replace(/\\/g, '/');
      if (!/\.json$/i.test(target)) target += '.json';

      const writeRes = window.cep.fs.writeFile(target, JSON.stringify(payload, null, 2));
      if (writeRes && writeRes.err !== 0) {
        toast.error("Could not write file (err " + writeRes.err + ").");
        return;
      }
      toast.success("Exported to " + target.split('/').pop());
    } catch (err) {
      toast.error("Export failed: " + (err as Error).message);
    }
  };

  // Opens the native CEP file picker and reads the chosen file synchronously.
  const loadJsonViaDialog = (title: string): any | null => {
    if (typeof window.cep === 'undefined') {
      toast.error("Import requires the CEP environment.");
      return null;
    }
    try {
      const result = window.cep.fs.showOpenDialog(false, false, title, getStartingDir(), ["json"]);
      if (!result || result.err !== 0 || !result.data || result.data.length === 0) return null;
      const path = String(result.data[0]).replace(/\\/g, '/');
      const read = window.cep.fs.readFile(path);
      if (!read || read.err !== 0 || typeof read.data !== 'string') {
        toast.error("Could not read file.");
        return null;
      }
      return JSON.parse(read.data);
    } catch (err) {
      toast.error("Failed to parse file.");
      return null;
    }
  };

  const handleExportMacros = () => {
    if (!appData) return;
    saveJsonViaDialog("motion-toolbar-macros.json", {
      kind: 'motion-toolbar/macros',
      version: 1,
      activeProfileId: appData.activeProfileId,
      profiles: appData.profiles,
    });
  };

  const handleImportMacros = () => {
    if (!appData) return;
    const data = loadJsonViaDialog("Import Macros");
    if (!data) return;
    const profiles = data?.profiles;
    if (!Array.isArray(profiles)) {
      toast.error("Invalid macros file.");
      return;
    }
    const next: AppData = {
      ...appData,
      profiles,
      activeProfileId: data.activeProfileId || profiles[0]?.id || appData.activeProfileId,
    };
    setAppData(next);
    saveConfig(next);
    toast.success("Macros imported.");
  };

  const handleExportEasing = () => {
    if (!appData) return;
    // Default behaviour: export the *active* profile only. The dropdown
    // alongside the button (below) lets the user pick a specific profile or
    // "All profiles" if they need a multi-pack file.
    const active = easingProfiles.find((p) => p.id === appData.settings.activeEasingProfileId)
      ?? easingProfiles[0];
    if (!active) return;
    const safeName = active.name.replace(/[^\w\-]+/g, '-').toLowerCase() || 'easing';
    saveJsonViaDialog(`motion-toolbar-easing-${safeName}.json`, {
      kind: 'motion-toolbar/easing',
      version: 1,
      profileName: active.name,
      customEases: active.eases,
    });
  };

  const handleExportAllEasingProfiles = () => {
    if (!appData) return;
    saveJsonViaDialog("motion-toolbar-easing-all.json", {
      kind: 'motion-toolbar/easing',
      version: 1,
      profiles: easingProfiles,
      // Also include a flat customEases of the active profile so older builds
      // that read this file still get something usable.
      customEases:
        easingProfiles.find((p) => p.id === appData.settings.activeEasingProfileId)?.eases ?? [],
    });
  };

  const handleImportEasing = () => {
    if (!appData) return;
    if (typeof window.cep === 'undefined') { toast.error("Import requires the CEP environment."); return; }
    // Read the file ourselves so we can hand the raw text to the unified
    // parser (loadJsonViaDialog parses-and-discards the source format).
    try {
      const result = window.cep.fs.showOpenDialog(false, false, "Import Easing Library", getStartingDir(), ["flow", "json"]);
      if (!result || result.err !== 0 || !result.data || result.data.length === 0) return;
      const path = String(result.data[0]).replace(/\\/g, '/');
      const read = window.cep.fs.readFile(path);
      if (!read || read.err !== 0 || typeof read.data !== 'string') { toast.error("Could not read file."); return; }

      const parsed = parseEasingFile(read.data);
      if (!parsed.ok) { toast.error(parsed.error); return; }

      const existing = appData.settings.customEases ?? [];
      const merged = mergeEasesUnique(parsed.eases, existing);
      if (merged.length === 0) { toast.info("Nothing new to import."); return; }
      const next: AppData = { ...appData, settings: { ...appData.settings, customEases: [...existing, ...merged] } };
      setAppData(next);
      saveConfig(next);
      const label = parsed.format === 'flow' ? 'Flow' : 'Motion Toolbar';
      toast.success(`Imported ${merged.length} ease${merged.length === 1 ? '' : 's'} from ${label}.`);
    } catch (err) {
      toast.error("Failed to import easing library.");
    }
  };

  if (!appData) return <div style={{ padding: '20px' }}>Loading...</div>;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', backgroundColor: 'var(--panel-bg-elev)', color: 'var(--panel-fg)', overflow: 'hidden' }}>
      
      {/* Draggable Header — no custom close button: AE's titlebar X is the
          single close affordance. unload/beforeunload/pagehide handlers above
          turn that into a Cancel for macro mode automatically. */}
      <div style={{ ['-webkit-app-region' as any]: 'drag', height: '30px', display: 'flex', alignItems: 'center', backgroundColor: 'var(--panel-bg-sunken)', borderBottom: '1px solid var(--panel-border)', padding: '0 10px', flexShrink: 0 }}>
        <span style={{ fontSize: '11px', color: 'var(--panel-fg-dim)', fontWeight: 'bold', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
          {dialogMode === 'macro' ? 'Tool Editor' : dialogMode === 'settings' ? 'Settings' : 'Dialog'}
        </span>
      </div>

      <div style={{ flex: 1, overflowY: 'auto' }}>
      
      {dialogMode === 'macro' && (
        <div style={{ padding: '20px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
          <h4 style={{ margin: 0, fontSize: '14px', color: 'var(--panel-fg)', borderBottom: '1px solid var(--panel-border)', paddingBottom: '8px' }}>{originalMacro.current ? 'Edit Tool' : 'Create New Tool'}</h4>
          <input type="text" placeholder="Button Label" value={newMacro.label} onChange={(e) => updateMacro({ label: e.target.value })} style={{ padding: '8px', backgroundColor: 'var(--panel-bg-sunken)', color: 'var(--panel-fg)', border: '1px solid var(--panel-border)', borderRadius: 'var(--radius-md)' }} />
          <select value={newMacro.type} onChange={(e) => updateMacro({ type: e.target.value as MacroType, payload: '' })} style={{ padding: '8px', backgroundColor: 'var(--panel-bg-sunken)', color: 'var(--panel-fg)', border: '1px solid var(--panel-border)', borderRadius: 'var(--radius-md)' }}>
            <option value="menuCommand">Menu Command (ID)</option>
            <option value="expression">Expression Code</option>
            <option value="script">Run Script (.jsx)</option>
            <option value="ffx">Effect Preset (.ffx)</option>
            <option value="sequence">Sequence (Chain)</option>
          </select>
          {newMacro.type === 'expression' ? (
             <textarea rows={5} placeholder="Expression..." value={newMacro.payload} onChange={(e) => updateMacro({ payload: e.target.value })} style={{ padding: '8px', backgroundColor: 'var(--panel-bg-sunken)', color: 'var(--panel-fg)', border: '1px solid var(--panel-border)', borderRadius: 'var(--radius-md)', fontFamily: 'monospace', resize: 'vertical' }} />
          ) : newMacro.type === 'sequence' ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              <span style={{ fontSize: '11px', color: 'var(--panel-fg-muted)' }}>
                <strong>JSON Chain:</strong> {"{ \"steps\": [ { \"type\": \"...\", \"payload\": \"...\" } ], \"delayMs\": 50 }"}
              </span>
              <textarea rows={4} placeholder='{"steps":[{"type":"menuCommand","payload":"2767","menuCommandName":"Separate Dimensions"},{"type":"expression","payload":"wiggle(5, 50)"}],"delayMs":100}' value={newMacro.payload} onChange={(e) => updateMacro({ payload: e.target.value })} style={{ padding: '8px', backgroundColor: 'var(--panel-bg-sunken)', color: 'var(--panel-fg)', border: '1px solid var(--panel-border)', borderRadius: 'var(--radius-md)', fontFamily: 'monospace', resize: 'vertical', fontSize: '11px' }} />
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              {newMacro.type === 'menuCommand' && (
                <div style={{ position: 'relative' }} ref={commandListRef}>
                  <input
                    type="text"
                    placeholder="Search After Effects commands..."
                    value={commandSearch || newMacro.menuCommandName || ''}
                    onFocus={() => setShowCommandList(true)}
                    onChange={(e) => {
                      setCommandSearch(e.target.value);
                      setShowCommandList(true);
                      updateMacro({ menuCommandName: e.target.value }); // temporarily update to show in search
                    }}
                    style={{ width: '100%', padding: '8px', backgroundColor: 'var(--panel-bg-sunken)', color: 'var(--panel-fg)', border: '1px solid var(--panel-border)', borderRadius: 'var(--radius-md)', fontSize: '12px' }}
                  />
                  {showCommandList && (
                    <div style={{
                      position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 100,
                      backgroundColor: 'var(--panel-bg-elev)', border: '1px solid var(--panel-border)',
                      borderRadius: 'var(--radius-md)', maxHeight: '200px', overflowY: 'auto',
                      marginTop: '4px', boxShadow: '0 8px 16px rgba(0,0,0,0.3)'
                    }} className="no-scrollbar">
                      {Object.entries(COMMAND_IDS)
                        .filter(([_, name]) => name.toLowerCase().includes((commandSearch || '').toLowerCase()))
                        .slice(0, 50)
                        .map(([id, name]) => (
                          <div
                            key={id}
                            onClick={() => {
                              updateMacro({ payload: id, menuCommandName: name, label: newMacro.label || name });
                              setCommandSearch(name);
                              setShowCommandList(false);
                            }}
                            style={{ padding: '6px 10px', cursor: 'pointer', fontSize: '11px', borderBottom: '1px solid var(--panel-border)' }}
                            onMouseEnter={(e) => e.currentTarget.style.backgroundColor = 'var(--panel-bg-sunken)'}
                            onMouseLeave={(e) => e.currentTarget.style.backgroundColor = 'transparent'}
                          >
                            <span style={{ fontWeight: 'bold' }}>{name}</span>
                            <span style={{ float: 'right', color: 'var(--panel-fg-dim)' }}>ID: {id}</span>
                          </div>
                        ))}
                    </div>
                  )}
                </div>
              )}
              
              <div style={{ display: 'flex', gap: '5px' }}>
                <input type="text" placeholder={newMacro.type === 'ffx' ? 'Path to .ffx preset' : 'ID / Payload'} value={newMacro.payload} onChange={(e) => updateMacro({ payload: e.target.value })} style={{ flex: 1, padding: '8px', backgroundColor: 'var(--panel-bg-sunken)', color: 'var(--panel-fg)', border: '1px solid var(--panel-border)', borderRadius: 'var(--radius-md)' }} />
                {newMacro.type === 'script' && <button onClick={handleBrowseScript} style={{ padding: '0 10px', backgroundColor: 'var(--panel-border)', color: 'var(--panel-fg)', border: 'none', borderRadius: 'var(--radius-md)', cursor: 'pointer' }}>Browse</button>}
                {newMacro.type === 'ffx' && <button onClick={() => {
                  if (typeof window.cep === 'undefined') return toast.error("Only works in AE.");
                  const result = window.cep.fs.showOpenDialog(false, false, "Select FFX Preset", "", ["ffx"]);
                  if (result.err === 0 && result.data.length > 0) {
                    updateMacro({ payload: relativizePath(result.data[0].replace(/\\/g, "/")) });
                  }
                }} style={{ padding: '0 10px', backgroundColor: 'var(--panel-border)', color: 'var(--panel-fg)', border: 'none', borderRadius: 'var(--radius-md)', cursor: 'pointer' }}>Browse</button>}
              </div>
            </div>
          )}

          {/* Hotkey */}
          <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
            <label style={{ color: 'var(--panel-fg-muted)', fontSize: '11px', flexShrink: 0 }}>Hotkey</label>
            <input
              type="text"
              placeholder="e.g. Alt+S (click and press)"
              value={newMacro.hotkey ?? ''}
              readOnly
              onKeyDown={(e) => {
                e.preventDefault();
                // Esc / Backspace clear the field. Use e.code so the clear
                // shortcut is layout-independent (e.key for Backspace can be
                // remapped on some keyboards).
                if (e.code === 'Escape' || e.code === 'Backspace') {
                  updateMacro({ hotkey: '' });
                  return;
                }
                const combo = formatHotkey(e);
                if (!combo) return; // pure modifier press — wait for the real key
                updateMacro({ hotkey: combo });
              }}
              style={{ flex: 1, padding: '6px 8px', backgroundColor: 'var(--panel-bg-sunken)', color: 'var(--panel-fg)', border: '1px solid var(--panel-border)', borderRadius: 'var(--radius-md)', fontSize: '12px', cursor: 'pointer' }}
            />
          </div>
          {hotkeyCollisions.length > 0 && (
            <div style={{ fontSize: '11px', color: 'var(--warning)', backgroundColor: 'rgba(251,191,36,0.08)', border: '1px solid var(--warning)', borderRadius: 'var(--radius-sm)', padding: '6px 8px' }}>
              ⚠ Hotkey already used by: {hotkeyCollisions.map((c) => `“${c.label}” (${c.profile})`).join(', ')}. First match wins.
            </div>
          )}

          {/* Tags — used by the Command Palette fuzzy search */}
          <div style={{ display: 'flex', gap: '6px', alignItems: 'flex-start' }}>
            <label style={{ color: 'var(--panel-fg-muted)', fontSize: '11px', flexShrink: 0, paddingTop: '6px' }}>Tags</label>
            <TagsInput
              value={newMacro.tags ?? []}
              onChange={(tags) => updateMacro({ tags })}
            />
          </div>

          <IconPicker value={newMacro.icon ?? ''} onChange={(icon) => updateMacro({ icon })} />

          <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
            <label style={{ color: 'var(--panel-fg-muted)', fontSize: '11px', flexShrink: 0 }}>Color</label>
            <input type="color" value={newMacro.color} onChange={(e) => updateMacro({ color: e.target.value })} style={{ flex: 1, padding: '0', border: '1px solid var(--panel-border)', borderRadius: 'var(--radius-sm)', height: '28px', cursor: 'pointer', backgroundColor: 'transparent' }} />
          </div>

          <div style={{ display: 'flex', gap: '8px', marginTop: '10px' }}>
            <button onClick={handleCancelMacro} style={{ flex: 1, padding: '10px', backgroundColor: 'var(--panel-border)', color: 'var(--panel-fg)', border: 'none', borderRadius: 'var(--radius-md)', cursor: 'pointer', fontWeight: 'bold' }}>Cancel</button>
            <button onClick={handleApplyMacro} style={{ flex: 1, padding: '10px', backgroundColor: 'var(--success)', color: '#fff', border: 'none', borderRadius: 'var(--radius-md)', cursor: 'pointer', fontWeight: 'bold' }}>Apply</button>
          </div>
        </div>
      )}

      {dialogMode === 'settings' && (
        <div style={{ padding: '20px', display: 'flex', flexDirection: 'column', gap: '15px', fontSize: '12px' }}>
          <h4 style={{ margin: 0, fontSize: '14px', color: 'var(--panel-fg)', borderBottom: '1px solid var(--panel-border)', paddingBottom: '8px' }}>Settings</h4>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <label>Auto-Context Switching</label>
            <input type="checkbox" checked={appData.settings.enableContext} onChange={(e) => updateSetting('enableContext', e.target.checked)} />
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '5px' }}>
            <label>Button Size ({appData.settings.buttonSize}px)</label>
            <input type="range" min="40" max="200" value={appData.settings.buttonSize} onChange={(e) => updateSetting('buttonSize', parseInt(e.target.value))} />
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '5px' }}>
            <label>Bezier Button Size ({appData.settings.bezierButtonSize ?? 40}px)</label>
            <input type="range" min="10" max="200" value={appData.settings.bezierButtonSize ?? 40} onChange={(e) => updateSetting('bezierButtonSize', parseInt(e.target.value))} />
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '5px' }}>
            <label>Grid Spacing ({appData.settings.spacing}px)</label>
            <input type="range" min="0" max="24" value={appData.settings.spacing} onChange={(e) => updateSetting('spacing', parseInt(e.target.value))} />
          </div>

          <hr style={{ borderColor: 'var(--panel-border)', width: '100%', margin: '5px 0' }} />

          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <label>Command Palette (Ctrl+Space)</label>
            <input type="checkbox" checked={appData.settings.enableCommandPalette ?? false} onChange={(e) => updateSetting('enableCommandPalette', e.target.checked)} />
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <label>Easing Click-to-Apply</label>
            <input type="checkbox" checked={appData.settings.easingClickToApply ?? false} onChange={(e) => updateSetting('easingClickToApply', e.target.checked)} />
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <label>Live Curve Preview</label>
            <input type="checkbox" checked={appData.settings.showCurvePreview ?? false} onChange={(e) => updateSetting('showCurvePreview', e.target.checked)} />
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <label>Lock Macros Panel</label>
            <input type="checkbox" checked={appData.settings.lockMacros ?? false} onChange={(e) => updateSetting('lockMacros', e.target.checked)} />
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px' }}>
            <label>Undo History Size</label>
            <input type="number" min={1} max={100} value={appData.settings.undoHistorySize ?? 10} onChange={(e) => updateSetting('undoHistorySize', Math.max(1, Math.min(100, parseInt(e.target.value) || 10)))} style={{ width: '60px', padding: '4px 6px', backgroundColor: 'var(--panel-bg-sunken)', color: 'var(--panel-fg)', border: '1px solid var(--panel-border)', borderRadius: 'var(--radius-sm)' }} />
          </div>

          {/* PROFILES SECTION */}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <label style={{ color: 'var(--panel-fg)', fontSize: '13px', fontWeight: 600 }}>Profiles</label>
            <button onClick={handleAddProfile} style={{ padding: '3px 8px', fontSize: '11px', backgroundColor: 'var(--panel-bg-sunken)', color: 'var(--panel-fg)', border: '1px solid var(--panel-border)', borderRadius: 'var(--radius-sm)', cursor: 'pointer' }}>+ Add</button>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {appData.profiles.map((p, idx) => {
              const ctxClash = appData.profiles.some((q) => q.id !== p.id && q.autoTriggerContext === p.autoTriggerContext && p.autoTriggerContext !== 'none');
              return (
                <div key={p.id} style={{ display: 'flex', flexDirection: 'column', gap: '4px', padding: '8px', backgroundColor: 'var(--panel-bg-sunken)', border: '1px solid var(--panel-border)', borderRadius: 'var(--radius-md)' }}>
                  <div style={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
                    <input
                      type="text"
                      value={p.name}
                      onChange={(e) => handleRenameProfile(p.id, e.target.value)}
                      style={{ flex: 1, minWidth: 0, padding: '4px 6px', backgroundColor: 'var(--panel-bg)', color: 'var(--panel-fg)', border: '1px solid var(--panel-border)', borderRadius: 'var(--radius-sm)', fontSize: '12px' }}
                    />
                    <button onClick={() => handleMoveProfile(p.id, -1)} disabled={idx === 0} title="Move up"
                      style={{ padding: '2px 6px', backgroundColor: 'transparent', color: idx === 0 ? 'var(--panel-fg-dim)' : 'var(--panel-fg-muted)', border: '1px solid var(--panel-border)', borderRadius: 'var(--radius-sm)', cursor: idx === 0 ? 'default' : 'pointer', fontSize: '11px' }}>↑</button>
                    <button onClick={() => handleMoveProfile(p.id, 1)} disabled={idx === appData.profiles.length - 1} title="Move down"
                      style={{ padding: '2px 6px', backgroundColor: 'transparent', color: idx === appData.profiles.length - 1 ? 'var(--panel-fg-dim)' : 'var(--panel-fg-muted)', border: '1px solid var(--panel-border)', borderRadius: 'var(--radius-sm)', cursor: idx === appData.profiles.length - 1 ? 'default' : 'pointer', fontSize: '11px' }}>↓</button>
                  </div>
                  <div style={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
                    <select
                      value={p.autoTriggerContext}
                      onChange={(e) => handleSetProfileContext(p.id, e.target.value as ProfileContext)}
                      title={ctxClash ? 'Another profile already uses this context — first match wins.' : 'Auto-trigger when this layer type is selected'}
                      style={{ flex: 1, minWidth: 0, padding: '4px 6px', backgroundColor: 'var(--panel-bg)', color: ctxClash ? 'var(--warning)' : 'var(--panel-fg)', border: `1px solid ${ctxClash ? 'var(--warning)' : 'var(--panel-border)'}`, borderRadius: 'var(--radius-sm)', fontSize: '11px' }}
                    >
                      {CONTEXT_VALUES.map((c) => (
                        <option key={c} value={c} style={{ backgroundColor: 'var(--panel-bg-elev)', color: 'var(--panel-fg)' }}>{CONTEXT_LABELS[c]}</option>
                      ))}
                    </select>
                    <span style={{ fontSize: '10px', color: 'var(--panel-fg-dim)', minWidth: '28px', textAlign: 'right' }}>{p.macros.length} ⚡</span>
                    <button onClick={() => handleDuplicateProfile(p.id)} title="Duplicate"
                      style={{ padding: '2px 6px', backgroundColor: 'transparent', color: 'var(--panel-fg-muted)', border: '1px solid var(--panel-border)', borderRadius: 'var(--radius-sm)', cursor: 'pointer', fontSize: '11px' }}>⎘</button>
                    <button onClick={() => handleDeleteProfile(p.id)} title="Delete" disabled={appData.profiles.length <= 1}
                      style={{ padding: '2px 6px', backgroundColor: 'transparent', color: appData.profiles.length <= 1 ? 'var(--panel-fg-dim)' : 'var(--danger)', border: `1px solid ${appData.profiles.length <= 1 ? 'var(--panel-border)' : 'var(--danger)'}`, borderRadius: 'var(--radius-sm)', cursor: appData.profiles.length <= 1 ? 'default' : 'pointer', fontSize: '11px' }}>×</button>
                  </div>
                </div>
              );
            })}
          </div>

          {/* EASING PROFILES SECTION */}
          <hr style={{ borderColor: 'var(--panel-border)', width: '100%', margin: '5px 0' }} />
          <div ref={easingProfilesSectionRef} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <label style={{ color: 'var(--panel-fg)', fontSize: '13px', fontWeight: 600 }}>Easing Profiles</label>
            <button onClick={handleAddEasingProfile} style={{ padding: '3px 8px', fontSize: '11px', backgroundColor: 'var(--panel-bg-sunken)', color: 'var(--panel-fg)', border: '1px solid var(--panel-border)', borderRadius: 'var(--radius-sm)', cursor: 'pointer' }}>+ Add</button>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {easingProfiles.map((p, idx) => {
              const isActive = appData.settings.activeEasingProfileId === p.id;
              return (
                <div key={p.id} style={{ display: 'flex', flexDirection: 'column', gap: '4px', padding: '8px', backgroundColor: 'var(--panel-bg-sunken)', border: `1px solid ${isActive ? 'var(--accent)' : 'var(--panel-border)'}`, borderRadius: 'var(--radius-md)' }}>
                  <div style={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
                    <input
                      type="text"
                      value={p.name}
                      onChange={(e) => handleRenameEasingProfile(p.id, e.target.value)}
                      style={{ flex: 1, minWidth: 0, padding: '4px 6px', backgroundColor: 'var(--panel-bg)', color: 'var(--panel-fg)', border: '1px solid var(--panel-border)', borderRadius: 'var(--radius-sm)', fontSize: '12px' }}
                    />
                    <button onClick={() => handleMoveEasingProfile(p.id, -1)} disabled={idx === 0} title="Move up"
                      style={{ padding: '2px 6px', backgroundColor: 'transparent', color: idx === 0 ? 'var(--panel-fg-dim)' : 'var(--panel-fg-muted)', border: '1px solid var(--panel-border)', borderRadius: 'var(--radius-sm)', cursor: idx === 0 ? 'default' : 'pointer', fontSize: '11px' }}>↑</button>
                    <button onClick={() => handleMoveEasingProfile(p.id, 1)} disabled={idx === easingProfiles.length - 1} title="Move down"
                      style={{ padding: '2px 6px', backgroundColor: 'transparent', color: idx === easingProfiles.length - 1 ? 'var(--panel-fg-dim)' : 'var(--panel-fg-muted)', border: '1px solid var(--panel-border)', borderRadius: 'var(--radius-sm)', cursor: idx === easingProfiles.length - 1 ? 'default' : 'pointer', fontSize: '11px' }}>↓</button>
                  </div>
                  <div style={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
                    <button
                      onClick={() => handleSetActiveEasingProfile(p.id)}
                      disabled={isActive}
                      title={isActive ? 'Currently active' : 'Set as active'}
                      style={{ flex: 1, padding: '4px 6px', backgroundColor: isActive ? 'var(--accent)' : 'var(--panel-bg)', color: isActive ? '#fff' : 'var(--panel-fg-muted)', border: '1px solid var(--panel-border)', borderRadius: 'var(--radius-sm)', fontSize: 11, cursor: isActive ? 'default' : 'pointer' }}
                    >{isActive ? '● Active' : 'Make active'}</button>
                    <span style={{ fontSize: '10px', color: 'var(--panel-fg-dim)', minWidth: '28px', textAlign: 'right' }}>{p.eases.length} ⌒</span>
                    <button onClick={() => handleDuplicateEasingProfile(p.id)} title="Duplicate"
                      style={{ padding: '2px 6px', backgroundColor: 'transparent', color: 'var(--panel-fg-muted)', border: '1px solid var(--panel-border)', borderRadius: 'var(--radius-sm)', cursor: 'pointer', fontSize: '11px' }}>⎘</button>
                    <button onClick={() => handleDeleteEasingProfile(p.id)} title="Delete" disabled={easingProfiles.length <= 1}
                      style={{ padding: '2px 6px', backgroundColor: 'transparent', color: easingProfiles.length <= 1 ? 'var(--panel-fg-dim)' : 'var(--danger)', border: `1px solid ${easingProfiles.length <= 1 ? 'var(--panel-border)' : 'var(--danger)'}`, borderRadius: 'var(--radius-sm)', cursor: easingProfiles.length <= 1 ? 'default' : 'pointer', fontSize: '11px' }}>×</button>
                  </div>
                </div>
              );
            })}
          </div>

          <hr style={{ borderColor: 'var(--panel-border)', width: '100%', margin: '5px 0' }} />
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            <label style={{ color: 'var(--panel-fg)', fontSize: '13px', fontWeight: 600 }}>Macros</label>
            <div style={{ display: 'flex', gap: '6px' }}>
              <button onClick={handleExportMacros} style={{ flex: 1, padding: '8px', backgroundColor: 'var(--accent)', color: 'white', border: 'none', borderRadius: 'var(--radius-md)', cursor: 'pointer' }}>Export</button>
              <button onClick={handleImportMacros} style={{ flex: 1, padding: '8px', backgroundColor: 'var(--success)', color: 'white', border: 'none', borderRadius: 'var(--radius-md)', cursor: 'pointer' }}>Import</button>
            </div>

            <label style={{ color: 'var(--panel-fg)', fontSize: '13px', fontWeight: 600, marginTop: '6px' }}>Easing Presets</label>
            <div style={{ display: 'flex', gap: '6px' }}>
              <button onClick={handleExportEasing} title="Export the active easing profile" style={{ flex: 1, padding: '8px', backgroundColor: 'var(--accent)', color: 'white', border: 'none', borderRadius: 'var(--radius-md)', cursor: 'pointer' }}>Export active</button>
              <button onClick={handleExportAllEasingProfiles} title="Export all easing profiles into one file" style={{ flex: 1, padding: '8px', backgroundColor: 'var(--panel-bg-elev)', color: 'var(--panel-fg)', border: '1px solid var(--panel-border)', borderRadius: 'var(--radius-md)', cursor: 'pointer' }}>Export all</button>
              <button onClick={handleImportEasing} title="Import a Flow library or Motion Toolbar easing pack" style={{ flex: 1, padding: '8px', backgroundColor: 'var(--success)', color: 'white', border: 'none', borderRadius: 'var(--radius-md)', cursor: 'pointer' }}>Import</button>
            </div>
          </div>
        </div>
      )}

      {dialogMode === null && (
        <div style={{ padding: '40px', textAlign: 'center', color: 'var(--panel-fg-muted)' }}>
          Waiting for data...
        </div>
      )}
      
      <Toaster />
      </div>

      <ConfirmDialog
        open={confirmDeleteEasingProfileId !== null}
        title="Delete easing profile"
        message={(() => {
          const p = easingProfiles.find((x) => x.id === confirmDeleteEasingProfileId);
          const count = p?.eases.length ?? 0;
          return `Delete "${p?.name ?? ''}"? This will remove ${count} ease${count === 1 ? '' : 's'}.`;
        })()}
        confirmLabel="Delete"
        destructive
        onConfirm={performDeleteEasingProfile}
        onCancel={() => setConfirmDeleteEasingProfileId(null)}
      />

      <ConfirmDialog
        open={confirmDeleteProfileId !== null}
        title="Delete profile"
        message={
          (() => {
            const p = appData.profiles.find((x) => x.id === confirmDeleteProfileId);
            const count = p?.macros.length ?? 0;
            return `Delete "${p?.name ?? ''}"? This will remove ${count} tool${count === 1 ? '' : 's'} in this profile. This action can be undone with Ctrl+Z in the macros panel.`;
          })()
        }
        confirmLabel="Delete"
        destructive
        onConfirm={performDeleteProfile}
        onCancel={() => setConfirmDeleteProfileId(null)}
      />
    </div>
  );
}
