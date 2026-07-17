// src/App.tsx
import React, { useState, useEffect, useRef } from 'react';
import { evalScript } from './utils/adobe';
import { loadConfig, saveConfig, setDialogPayload, resolvePath, getLastLoadDiagnostics, HELPERS_PROFILE_ID } from './utils/storage';
import MotionStagger from './MotionStagger';
import { subscribeConfigChanges } from './utils/configWatcher';
import type { AppData, Macro, Profile, StaggerSettings } from './types';
import EasingEditor from './EasingEditor';
import DialogApp from './DialogApp';
import MotionColor from './MotionColor';
import MotionGifs from './MotionGifs';
import MotionGifsSettings from './MotionGifsSettings';
import MtagSwitch from './MtagSwitch';
import MtagCloud from './MtagCloud';
import CommandPalette from './components/CommandPalette';
import ContextMenu, { type ContextMenuItem } from './components/ContextMenu';
import Toaster from './components/Toaster';
import { toast } from './utils/toast';
import { formatHotkey } from './utils/hotkey';
import { sanitizeSvg } from './utils/svg';
import * as lucideIcons from 'lucide-react';
import './App.css';

const renderIcon = (iconStr: string | undefined, color?: string) => {
  if (!iconStr) return null;
  if (iconStr.startsWith('<svg')) {
    return <div dangerouslySetInnerHTML={{ __html: sanitizeSvg(iconStr) }} style={{ width: '18px', height: '18px', color: color || 'inherit', display: 'flex', alignItems: 'center', justifyContent: 'center' }} />;
  }
  const LucideIcon = (lucideIcons as any)[iconStr];
  if (LucideIcon) {
    return <LucideIcon size={18} color={color || 'currentColor'} />;
  }
  return <span style={{ fontSize: '18px', lineHeight: 1, color: color || 'inherit' }}>{iconStr}</span>;
};

function App() {
  const [appData, setAppData] = useState<AppData | null>(null);
  const [isEditMode, setIsEditMode] = useState(false);
  const [draggedMacroId, setDraggedMacroId] = useState<string | null>(null);
  const [dragOverMacroId, setDragOverMacroId] = useState<string | null>(null);
  const [dragSide, setDragSide] = useState<'left' | 'right' | null>(null);
  const [pendingDeleteMacroId, setPendingDeleteMacroId] = useState<string | null>(null);
  const [moveMenu, setMoveMenu] = useState<{ macroId: string; x: number; y: number } | null>(null);
  const moveMenuRef = useRef<HTMLDivElement>(null);
  const [showCommandPalette, setShowCommandPalette] = useState(false);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  // In-memory undo ring buffer for macro-panel mutations (reorder / delete /
  // move-to-profile). Snapshots are pushed *before* each mutation; Ctrl+Z pops.
  const undoStackRef = useRef<AppData[]>([]);
  const pushUndo = (snapshot: AppData) => {
    const limit = Math.max(1, snapshot.settings.undoHistorySize ?? 10);
    // structuredClone handles Map/Set/Date if Settings ever grows them, and
    // is faster than JSON.parse(JSON.stringify(...)) on V8/CEF.
    const clone = typeof structuredClone === 'function'
      ? structuredClone(snapshot)
      : JSON.parse(JSON.stringify(snapshot));
    undoStackRef.current.push(clone);
    while (undoStackRef.current.length > limit) undoStackRef.current.shift();
  };
  const handleUndo = () => {
    const prev = undoStackRef.current.pop();
    if (!prev) {
      toast.info("Nothing to undo.");
      return;
    }
    setAppData(prev);
    saveConfig(prev);
    toast.info("Undone.");
  };
  
  // The panel's view is fixed at startup based on which CEP extension is hosting
  // it: the dedicated "easing" panel shows the EasingEditor, every other panel
  // shows the macro grid. No runtime switching, no tab bar.
  // Exact match against the IDs registered in CSXS/manifest.xml — a loose
  // substring would mis-route any future panel whose ID contained the words
  // "easing" or "dialog".
  const view: 'macros' | 'easing' | 'dialog' | 'color' | 'gifs' | 'gifsettings' | 'switch' | 'cloud' = (() => {
    if (typeof window.__adobe_cep__ !== 'undefined') {
      const extId = window.__adobe_cep__.getExtensionId();
      if (extId === 'com.motiontoolbar.panel.easing') return 'easing';
      if (extId === 'com.motiontoolbar.panel.dialog') return 'dialog';
      // The dedicated (nameless) settings panels reuse DialogApp, which scopes
      // itself to toolbar-only or easing-only settings based on its own
      // extension id.
      if (extId === 'com.motiontoolbar.panel.toolbarsettings') return 'dialog';
      if (extId === 'com.motiontoolbar.panel.easingsettings') return 'dialog';
      if (extId === 'com.motiontoolbar.panel.color') return 'color';
      if (extId === 'com.motiontoolbar.panel.gifs') return 'gifs';
      if (extId === 'com.motiontoolbar.panel.gifsettings') return 'gifsettings';
      if (extId === 'com.motiontoolbar.panel.switch') return 'switch';
      if (extId === 'com.motiontoolbar.panel.cloud') return 'cloud';
    }
    return 'macros';
  })();

  // Identity of THIS panel instance (main vs secondary vs …). Per-panel view
  // state (chosen profile, override, pin) is keyed by it so the two macro
  // panels don't mirror each other. 'dev' outside CEP.
  const panelKey: string = (typeof window.__adobe_cep__ !== 'undefined'
    ? window.__adobe_cep__.getExtensionId()
    : 'dev') || 'dev';

  const [activeContext, setActiveContext] = useState<string>("none");
  const activeContextRef = useRef<string>("none");

  // NEW: State to track manual profile selection
  const [overrideProfileId, setOverrideProfileId] = useState<string | null>(null);
  const overrideProfileIdRef = useRef<string | null>(null);
  useEffect(() => { overrideProfileIdRef.current = overrideProfileId; }, [overrideProfileId]);
  const appDataRef = useRef<AppData | null>(null);
  useEffect(() => { appDataRef.current = appData; }, [appData]);

  const openDialog = (mode: 'settings' | 'macro', payload?: any) => {
    if (typeof window.__adobe_cep__ !== 'undefined') {
      setDialogPayload({ mode, macro: payload });
      window.__adobe_cep__.requestOpenExtension('com.motiontoolbar.panel.dialog', '');
    } else {
      toast.error("Dialog only works in the CEP environment.");
    }
  };

  const openCreateMacro = () => openDialog('macro');
  const openEditMacro = (macro: Macro) => openDialog('macro', macro);

  // Each toolbar has its own dedicated (nameless) settings panel now, so
  // settings no longer share the Tool Editor's `dialog` extension.
  const openSettings = (scope: 'toolbar' | 'easing') => {
    if (typeof window.__adobe_cep__ !== 'undefined') {
      const ext = scope === 'easing'
        ? 'com.motiontoolbar.panel.easingsettings'
        : 'com.motiontoolbar.panel.toolbarsettings';
      window.__adobe_cep__.requestOpenExtension(ext, '');
    } else {
      toast.error("Settings only works in the CEP environment.");
    }
  };

  useEffect(() => {
    // Initial load
    const data = loadConfig();
    setAppData(data);
    // Restore THIS panel's own override (legacy global field as a fallback for
    // configs written before per-panel state existed).
    const restored = data.settings.panels?.[panelKey]?.overrideProfileId ?? data.settings.lastOverrideProfileId;
    if (restored) {
      setOverrideProfileId(restored);
    }

    // Surface load problems once on startup so a corrupt config doesn't
    // silently revert the user to defaults. Shown only on the macros view
    // (the easing view would double-toast the same info).
    if (view === 'macros') {
      const diag = getLastLoadDiagnostics();
      if (diag.errors.length > 0) {
        toast.error(`Couldn't fully load config — ${diag.errors[0]}. Default values shown for the unreadable parts. Backup saved next to the file.`);
      } else if (
        diag.droppedMacros + diag.droppedProfiles + diag.droppedEases + diag.droppedEasingProfiles > 0
      ) {
        const parts: string[] = [];
        if (diag.droppedMacros) parts.push(`${diag.droppedMacros} macro${diag.droppedMacros === 1 ? '' : 's'}`);
        if (diag.droppedProfiles) parts.push(`${diag.droppedProfiles} profile${diag.droppedProfiles === 1 ? '' : 's'}`);
        if (diag.droppedEases) parts.push(`${diag.droppedEases} ease${diag.droppedEases === 1 ? '' : 's'}`);
        if (diag.droppedEasingProfiles) parts.push(`${diag.droppedEasingProfiles} easing profile${diag.droppedEasingProfiles === 1 ? '' : 's'}`);
        toast.info(`Skipped ${parts.join(', ')} with missing required fields.`);
      }
    }

    return subscribeConfigChanges(() => setAppData(loadConfig()));
  }, []);

  useEffect(() => {
    if (isEditMode || view !== 'macros' || !appData?.settings?.enableContext) return; 
    
    const clearOverride = () => {
      setOverrideProfileId(null);
      setAppData((cur) => {
        if (!cur || cur.settings.panels?.[panelKey]?.overrideProfileId == null) return cur;
        const prev = cur.settings.panels?.[panelKey] ?? {};
        const next: AppData = {
          ...cur,
          settings: { ...cur.settings, panels: { ...cur.settings.panels, [panelKey]: { ...prev, overrideProfileId: null } } },
        };
        saveConfig(next);
        return next;
      });
    };

    const heartbeat = setInterval(async () => {
      const context = await evalScript('getSelectionContext()');
      const contextChanged = activeContextRef.current !== context;
      activeContextRef.current = context;
      setActiveContext(context);

      const curOverride = overrideProfileIdRef.current;
      const cur = appDataRef.current;
      if (!curOverride || !cur) {
        if (contextChanged) clearOverride();
        return;
      }
      // Clear when the AE context flipped, OR when the override now points
      // at the same profile auto-context would pick (otherwise the header
      // shows a stale [Manual] badge for what is effectively auto).
      const autoMatch =
        cur.profiles.find((p) => p.autoTriggerContext === context) ||
        cur.profiles.find((p) => p.autoTriggerContext === 'none') ||
        cur.profiles[0];
      const overrideIsRedundant = autoMatch && autoMatch.id === curOverride;
      if (contextChanged || overrideIsRedundant) clearOverride();
    }, 500); 
    
    return () => {
      clearInterval(heartbeat);
      // Clean up override when the panel is closed/switched if you want, 
      // but here we want it to survive so we do nothing.
    };
  }, [isEditMode, view, appData?.settings?.enableContext]);

  // --- MACRO EXECUTION LOGIC ---
  const handleMacroClick = async (macro: Macro) => {
    if (isEditMode) return;

    // Resolve the top-level payload, plus any nested step.payload inside a
    // sequence — the host script has no access to AG:// resolution.
    let resolvedPayload = resolvePath(macro.payload);
    if (macro.type === 'sequence') {
      try {
        const seq = JSON.parse(macro.payload);
        if (seq && Array.isArray(seq.steps)) {
          seq.steps = seq.steps.map((s: any) => ({
            ...s,
            payload: typeof s.payload === 'string' ? resolvePath(s.payload) : s.payload,
          }));
          resolvedPayload = JSON.stringify(seq);
        }
      } catch { /* malformed sequence — fall through and let host report */ }
    }

    const action = {
      label: macro.label,
      type: macro.type,
      payload: resolvedPayload,
      menuCommandName: macro.menuCommandName,
    };
    // Use JSON.stringify on the JSON string itself to produce a properly
    // escaped ExtendScript string literal (handles backslashes, quotes,
    // newlines, U+2028/U+2029, and other awkward chars correctly).
    const literal = JSON.stringify(JSON.stringify(action));
    const result = await evalScript(`executeAction(${literal})`);
    if (typeof result === 'string') {
      if (result.indexOf('Error:') === 0) toast.error(result.slice(6).trim());
      else if (result.indexOf('Warning:') === 0) toast.info(result.slice(8).trim());
    }
  };

  // --- COMMAND PALETTE & HOTKEY LISTENERS ---
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Bail when typing into a text input — otherwise typing characters that
      // happen to match a hotkey combo would fire the macro mid-keystroke.
      const tgt = e.target as HTMLElement | null;
      const tag = tgt?.tagName;
      const isTextTarget =
        tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' ||
        (tgt && (tgt as HTMLElement).isContentEditable);
      if (isTextTarget) return;

      // Undo (Ctrl+Z) for the macros panel.
      if (view === 'macros' && (e.ctrlKey || e.metaKey) && !e.shiftKey && (e.key === 'z' || e.key === 'Z')) {
        e.preventDefault();
        handleUndo();
        return;
      }
      // Command Palette toggle — gated to the macros view, otherwise the
      // shortcut would silently flip state in panels that don't render it.
      if (view === 'macros' && appData?.settings?.enableCommandPalette) {
        const paletteCombo = appData.settings.commandPaletteHotkey || 'Ctrl+Space';
        if (formatHotkey(e) === paletteCombo) {
          e.preventDefault();
          setShowCommandPalette((prev) => !prev);
          return;
        }
      }
      // Macro hotkeys — only when not in edit mode and no dialog/palette open
      if (isEditMode || showCommandPalette) return;
      if (!appData) return;
      const combo = formatHotkey(e);
      if (!combo) return;
      for (const profile of appData.profiles) {
        for (const macro of profile.macros) {
          if (macro.hotkey && macro.hotkey === combo) {
            e.preventDefault();
            handleMacroClick(macro);
            return;
          }
        }
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [appData, isEditMode, showCommandPalette]);


  const handleDragStart = (id: string) => setDraggedMacroId(id);
  const handleDragOver = (e: React.DragEvent, id?: string) => {
    e.preventDefault();
    if (id && id !== draggedMacroId) {
      setDragOverMacroId(id);
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
      const relX = e.clientX - rect.left;
      setDragSide(relX < rect.width / 2 ? 'left' : 'right');
    }
  };
  const handleDragLeave = (id: string) => {
    setDragOverMacroId((cur) => (cur === id ? null : cur));
  };
  const handleDragEnd = () => {
    setDraggedMacroId(null);
    setDragOverMacroId(null);
    setDragSide(null);
  };
  const handleDrop = (targetId: string) => {
    if (!appData || !draggedMacroId || draggedMacroId === targetId) {
      handleDragEnd();
      return;
    }
    const profileIndex = appData.profiles.findIndex((p) => p.id === appData.activeProfileId);
    if (profileIndex < 0) return;
    pushUndo(appData);
    const macros = [...appData.profiles[profileIndex].macros];
    const draggedIndex = macros.findIndex((m) => m.id === draggedMacroId);
    const [draggedItem] = macros.splice(draggedIndex, 1);

    let targetIndex = macros.findIndex((m) => m.id === targetId);
    if (dragSide === 'right') targetIndex += 1;

    macros.splice(targetIndex, 0, draggedItem);
    const newAppData: AppData = { ...appData, profiles: appData.profiles.map((p) => ({ ...p })) };
    newAppData.profiles[profileIndex].macros = macros;
    setAppData(newAppData);
    saveConfig(newAppData);
    handleDragEnd();
  };

  const requestDeleteMacro = (id: string) => {
    if (pendingDeleteMacroId === id) {
      setPendingDeleteMacroId(null);
      doDeleteMacro(id);
      return;
    }
    setPendingDeleteMacroId(id);
    window.setTimeout(() => {
      setPendingDeleteMacroId((cur) => (cur === id ? null : cur));
    }, 2500);
  };

  const doDeleteMacro = (id: string) => {
    if (!appData) return;
    const profileIndex = appData.profiles.findIndex((p) => p.id === appData.activeProfileId);
    if (profileIndex < 0) return;
    pushUndo(appData);
    const newAppData: AppData = { ...appData, profiles: appData.profiles.map((p) => ({ ...p })) };
    newAppData.profiles[profileIndex].macros = newAppData.profiles[profileIndex].macros.filter((m) => m.id !== id);
    setAppData(newAppData);
    saveConfig(newAppData);
    toast.info("Macro deleted.");
  };

  // Open the per-macro "move to profile" popover, anchored under its trigger.
  const openMoveMenu = (macroId: string, anchor: HTMLElement) => {
    const rect = anchor.getBoundingClientRect();
    const MENU_W = 180, PAD = 4;
    const x = Math.max(PAD, Math.min(rect.left, window.innerWidth - MENU_W - PAD));
    const y = Math.min(rect.bottom + 4, window.innerHeight - 40);
    setMoveMenu({ macroId, x, y });
  };

  // Move a macro to another profile and switch the panel to that profile so
  // the user can immediately see where it landed.
  const handleMoveMacroToProfile = (macroId: string, targetProfileId: string) => {
    if (!appData) return;
    const sourceIdx = appData.profiles.findIndex((p) => p.id === appData.activeProfileId);
    const targetIdx = appData.profiles.findIndex((p) => p.id === targetProfileId);
    if (sourceIdx < 0 || targetIdx < 0 || sourceIdx === targetIdx) {
      setMoveMenu(null);
      return;
    }
    pushUndo(appData);
    const sourceMacros = [...appData.profiles[sourceIdx].macros];
    const i = sourceMacros.findIndex((m) => m.id === macroId);
    if (i < 0) { setMoveMenu(null); return; }
    const [moved] = sourceMacros.splice(i, 1);

    const newProfiles = appData.profiles.map((p, idx) => {
      if (idx === sourceIdx) return { ...p, macros: sourceMacros };
      if (idx === targetIdx) return { ...p, macros: [...p.macros, moved] };
      return p;
    });

    const newAppData: AppData = {
      ...appData,
      profiles: newProfiles,
      activeProfileId: targetProfileId,
    };
    setAppData(newAppData);
    saveConfig(newAppData);
    setOverrideProfileId(targetProfileId);
    setMoveMenu(null);

    const targetName = appData.profiles[targetIdx].name;
    toast.info(`Moved to "${targetName}".`);
  };

  // Copy a macro into another profile, leaving the original in place. `linked`
  // controls whether the copy shares a `linkId` with the source (edits to
  // shared fields propagate) or is a fully independent standalone button.
  // Stays on the current profile — the copy is a background action.
  const handleCopyMacroToProfile = (macroId: string, targetProfileId: string, linked: boolean) => {
    if (!appData) return;
    const sourceIdx = appData.profiles.findIndex((p) => p.id === appData.activeProfileId);
    const targetIdx = appData.profiles.findIndex((p) => p.id === targetProfileId);
    if (sourceIdx < 0 || targetIdx < 0) { setMoveMenu(null); return; }
    const src = appData.profiles[sourceIdx].macros.find((m) => m.id === macroId);
    if (!src) { setMoveMenu(null); return; }

    pushUndo(appData);
    const newId = 'm_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
    // For a linked copy, reuse the source's linkId or lazily mint one and stamp
    // it back onto the source so the two instances form a group.
    const linkId = linked ? (src.linkId ?? ('lk_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7))) : undefined;
    const copy: Macro = {
      ...src,
      id: newId,
      linkId,
      tags: src.tags ? [...src.tags] : undefined,
      hotkey: undefined, // keep hotkeys per-instance to avoid cross-profile collisions
    };

    const newProfiles = appData.profiles.map((p, idx) => {
      if (idx === targetIdx) return { ...p, macros: [...p.macros, copy] };
      if (idx === sourceIdx && linked && !src.linkId) {
        // Backfill the freshly-minted linkId onto the source instance.
        return { ...p, macros: p.macros.map((m) => (m.id === macroId ? { ...m, linkId } : m)) };
      }
      return p;
    });

    setAppData({ ...appData, profiles: newProfiles });
    saveConfig({ ...appData, profiles: newProfiles });
    setMoveMenu(null);
    const targetName = appData.profiles[targetIdx].name;
    toast.info(`${linked ? 'Linked' : 'Copied'} to "${targetName}".`);
  };

  // Fork a linked instance so future edits no longer propagate to/from it.
  // If unlinking leaves a single remaining instance in the group, that lone
  // survivor is reverted to standalone too (a group of one isn't a link).
  const handleUnlinkMacro = (macroId: string) => {
    if (!appData) return;
    const profileIndex = appData.profiles.findIndex((p) => p.id === appData.activeProfileId);
    if (profileIndex < 0) return;
    const target = appData.profiles[profileIndex].macros.find((m) => m.id === macroId);
    if (!target?.linkId) return;
    const linkId = target.linkId;

    pushUndo(appData);
    // Count remaining instances (across all profiles) that stay in the group.
    let remaining = 0;
    for (const p of appData.profiles)
      for (const m of p.macros)
        if (m.linkId === linkId && m.id !== macroId) remaining++;

    const newProfiles = appData.profiles.map((p) => ({
      ...p,
      macros: p.macros.map((m) => {
        if (m.id === macroId) return { ...m, linkId: undefined };
        // Collapse a lone survivor back to standalone.
        if (remaining === 1 && m.linkId === linkId) return { ...m, linkId: undefined };
        return m;
      }),
    }));

    setAppData({ ...appData, profiles: newProfiles });
    saveConfig({ ...appData, profiles: newProfiles });
    toast.info('Unlinked — edits no longer sync.');
  };

  // Close the move menu on outside-click / Escape. Uses ref+contains so it
  // doesn't rely on React's synthetic stopPropagation also stopping the
  // native event (it does today, but that's an implementation detail).
  useEffect(() => {
    if (!moveMenu) return;
    const onMouseDown = (e: MouseEvent) => {
      if (moveMenuRef.current && moveMenuRef.current.contains(e.target as Node)) return;
      setMoveMenu(null);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMoveMenu(null); };
    window.addEventListener('mousedown', onMouseDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onMouseDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [moveMenu]);

  // --- PROFILE SELECTION LOGIC ---
  if (!appData) return <div style={{ padding: '20px' }}>Loading tools...</div>;

  // Resolve the visible profile WITHOUT considering isEditMode — edit mode
  // shouldn't jump the user to a different profile than they were just
  // looking at. The auto-context heartbeat is paused while editing, so the
  // resolution stays stable through the edit session.
  const panelState = appData.settings.panels?.[panelKey] ?? {};
  // Legacy configs only stored a boolean Helpers pin; map it onto the id.
  const pinnedProfileId = panelState.pinnedProfileId
    ?? ((panelState.pinHelpers ?? appData.settings.pinHelpers) ? HELPERS_PROFILE_ID : null);
  const pinnedProfile = !isEditMode && pinnedProfileId
    ? appData.profiles.find((p) => p.id === pinnedProfileId)
    : undefined;
  const panelPinned = !!pinnedProfile;
  let profileToShow: Profile | undefined;
  if (pinnedProfile) {
    // Highest precedence: a pinned view ignores auto-context and any
    // manual override so a layer selection can't switch it away.
    profileToShow = pinnedProfile;
  } else if (overrideProfileId) {
    profileToShow = appData.profiles.find((p) => p.id === overrideProfileId);
  } else if (!appData.settings.enableContext) {
    // This panel's own chosen profile (falls back to the global default).
    profileToShow = appData.profiles.find((p) => p.id === (panelState.activeProfileId ?? appData.activeProfileId));
  } else {
    profileToShow = appData.profiles.find((p) => p.autoTriggerContext === activeContext);
    if (!profileToShow) profileToShow = appData.profiles.find((p) => p.autoTriggerContext === "none") || appData.profiles[0];
  }
  if (!profileToShow) profileToShow = appData.profiles[0];

  // Toggling Edit needs to pin activeProfileId to whatever's visible right
  // now — every macro mutation (add/edit/move/delete/reorder) targets
  // activeProfileId, so without this they'd silently land in the wrong profile
  // when the user is viewing an auto-context-routed or override-selected one.
  const handleToggleEdit = () => {
    if (appData.settings.lockMacros) {
      toast.info("Macros panel is locked. Unlock in Settings to edit.");
      return;
    }
    if (!isEditMode && profileToShow && profileToShow.id !== appData.activeProfileId) {
      const next: AppData = { ...appData, activeProfileId: profileToShow.id };
      setAppData(next);
      saveConfig(next);
    }
    setIsEditMode((v) => !v);
  };

  // Handle manual dropdown selection
  const handleProfileSelect = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const selectedId = e.target.value;

    // Set the manual override for THIS panel and persist it per-panel. Also
    // releases the Helpers pin (otherwise the pick would snap back) and records
    // the chosen profile as this panel's non-context / edit target. Does NOT
    // touch the global activeProfileId, so the other panel is unaffected.
    setOverrideProfileId(selectedId);
    writePanel({ activeProfileId: selectedId, overrideProfileId: selectedId, pinnedProfileId: null, pinHelpers: false });
  };

  if (view === 'dialog') {
    return <DialogApp />;
  }

  if (view === 'color') {
    return (
      <>
        <MotionColor />
        <Toaster />
      </>
    );
  }

  if (view === 'gifs') {
    return (
      <>
        <MotionGifs />
        <Toaster />
      </>
    );
  }

  if (view === 'gifsettings') {
    return (
      <>
        <MotionGifsSettings />
        <Toaster />
      </>
    );
  }

  if (view === 'switch') {
    return (
      <>
        <MtagSwitch />
        <Toaster />
      </>
    );
  }

  if (view === 'cloud') {
    return (
      <>
        <MtagCloud />
        <Toaster />
      </>
    );
  }

  // Merge a patch into THIS panel's per-panel state and persist.
  const writePanel = (patch: Partial<import('./types').PanelState>, base?: AppData) => {
    const src = base ?? appData;
    if (!src) return;
    const prev = src.settings.panels?.[panelKey] ?? {};
    const nd: AppData = {
      ...src,
      settings: {
        ...src.settings,
        panels: { ...src.settings.panels, [panelKey]: { ...prev, ...patch } },
      },
    };
    setAppData(nd);
    saveConfig(nd);
  };

  // Pin / unpin the currently visible profile as this panel's active view.
  const togglePin = () => {
    if (!appData) return;
    const pin = panelPinned ? null : profileToShow.id;
    // Dropping a manual override on pin avoids a stale [Manual] badge fighting
    // the pin once it's turned back off.
    if (pin) setOverrideProfileId(null);
    // pinHelpers is cleared so the legacy fallback can't resurrect the old pin.
    writePanel({ pinnedProfileId: pin, pinHelpers: false, ...(pin ? { overrideProfileId: null } : {}) });
    toast.info(pin ? `${profileToShow.name} pinned.` : 'Profile unpinned.');
  };

  // Persist the Helpers "Stagger" tool state.
  const updateStagger = (next: StaggerSettings) => {
    if (!appData) return;
    const nd: AppData = { ...appData, settings: { ...appData.settings, stagger: next } };
    setAppData(nd);
    saveConfig(nd);
  };

  // A single macro tile. Shared by the normal auto-fill grid and the fixed
  // 3×3 anchor square so both stay visually identical.
  const renderTile = (macro: Macro) => {
    const isDropTarget = isEditMode && dragOverMacroId === macro.id && draggedMacroId !== macro.id;
    const pendingDelete = pendingDeleteMacroId === macro.id;
    const isGhost = !!(macro.icon && macro.color);
    const isDragging = draggedMacroId === macro.id;

    const tileClass = [
      isEditMode ? 'mt-wiggle' : 'mt-press',
      'mt-tile',
      isEditMode && 'is-edit',
      isGhost && 'is-ghost',
      isDragging && 'is-dragging',
    ].filter(Boolean).join(' ');

    return (
      <div
        key={macro.id}
        className={tileClass}
        draggable={isEditMode}
        onDragStart={() => handleDragStart(macro.id)}
        onDragOver={(e) => handleDragOver(e, macro.id)}
        onDragLeave={() => handleDragLeave(macro.id)}
        onDragEnd={handleDragEnd}
        onDrop={() => handleDrop(macro.id)}
        onClick={() => (isEditMode ? openEditMacro(macro) : handleMacroClick(macro))}
        data-drop-side={isDropTarget ? dragSide ?? undefined : undefined}
        style={{
          ['--mt-color' as any]: macro.color,
          backgroundColor: isGhost ? 'transparent' : (macro.color + '40'),
        }}
        title={isEditMode ? `Edit: ${macro.label}` : macro.label}
      >
        {renderIcon(macro.icon, isGhost ? macro.color : undefined)}
        {!macro.icon && macro.label && <span className="mt-tile-label">{macro.label}</span>}
        {macro.hotkey && <span className="mt-hotkey-badge">{macro.hotkey}</span>}
        {macro.linkId && (
          isEditMode ? (
            <div
              className="mt-tile-badge is-unlink"
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => { e.stopPropagation(); handleUnlinkMacro(macro.id); }}
              title="Unlink — stop syncing edits with copies in other profiles"
            >🔗</div>
          ) : (
            <span className="mt-link-badge" title="Linked — edits sync across profiles">🔗</span>
          )
        )}
        {isEditMode && appData.profiles.length > 1 && (
          <div
            className="mt-tile-badge is-move"
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => { e.stopPropagation(); openMoveMenu(macro.id, e.currentTarget); }}
            title="Move to profile…"
          >⇆</div>
        )}
        {isEditMode && (
          <div
            className={`mt-tile-badge is-delete${pendingDelete ? ' is-confirming' : ''}`}
            onClick={(e) => { e.stopPropagation(); requestDeleteMacro(macro.id); }}
            title={pendingDelete ? 'Click again to confirm' : 'Delete'}
          >{pendingDelete ? '✓' : '×'}</div>
        )}
      </div>
    );
  };

  // Consecutive builtin "anchor:*" macros render as one fixed 3×3 square so the
  // grid never gets stretched into a single wide row by narrow/short layouts.
  const isAnchorMacro = (m: Macro) => m.type === 'builtin' && m.payload.indexOf('anchor:') === 0;

  return (
    <div
      style={{ display: 'flex', flexDirection: 'column', height: '100vh', position: 'relative', overflow: 'hidden' }}
      onContextMenu={(e) => {
        // Suppress while dragging — otherwise the menu pops under the
        // dragged tile and traps the user.
        if (draggedMacroId) return;
        e.preventDefault();
        setContextMenu({ x: e.clientX, y: e.clientY });
      }}
    >
      
        {/* Header content varies per view */}
        {view === 'macros' && (
          <>
            <div style={{ padding: '10px 15px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', backgroundColor: 'var(--panel-bg-sunken)', borderBottom: '1px solid var(--panel-border)' }}>
            
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flex: 1, minWidth: 0 }}>
                <select
                  value={profileToShow.id}
                  onChange={handleProfileSelect}
                  style={{
                    backgroundColor: 'transparent', color: 'var(--panel-fg)', fontSize: '14px', fontWeight: 'bold',
                    border: 'none', cursor: 'pointer', outline: 'none', flexShrink: 1, textOverflow: 'ellipsis'
                  }}
                >
                  {appData.profiles.map((p) => (
                    <option key={p.id} value={p.id} style={{ backgroundColor: 'var(--panel-bg-elev)', color: 'var(--panel-fg)' }}>
                      {p.name}
                    </option>
                  ))}
                </select>

                {!isEditMode && panelPinned ? (
                  <span style={{ fontSize: '10px', color: 'var(--accent)', flexShrink: 0 }} title={`${profileToShow.name} pinned — auto/manual switching is paused`}>
                    [Pinned]
                  </span>
                ) : (!isEditMode && appData.settings.enableContext && (
                  <span style={{ fontSize: '10px', color: overrideProfileId ? 'var(--warning)' : 'var(--panel-fg-muted)', flexShrink: 0 }} title={overrideProfileId ? 'Manual Override Active' : 'Auto-Context Active'}>
                    [{overrideProfileId ? 'Manual' : activeContext}]
                  </span>
                ))}
              </div>

              <div style={{ display: 'flex', gap: '5px', flexShrink: 0 }}>
                <button onClick={togglePin} title={panelPinned ? `Unpin ${profileToShow.name} (resume auto/manual)` : `Pin ${profileToShow.name} as the active profile`} style={{ padding: '4px 8px', fontSize: '11px', cursor: 'pointer', backgroundColor: panelPinned ? 'var(--accent)' : 'var(--panel-bg-elev)', color: panelPinned ? '#fff' : 'var(--panel-fg)', border: '1px solid var(--panel-border)', borderRadius: 'var(--radius-sm)' }}>
                  📌
                </button>
                <button onClick={handleToggleEdit} title={appData.settings.lockMacros ? 'Locked — toggle in Settings' : (isEditMode ? 'Exit edit mode' : 'Edit')} style={{ padding: '4px 8px', fontSize: '11px', cursor: appData.settings.lockMacros ? 'not-allowed' : 'pointer', backgroundColor: isEditMode ? 'var(--danger)' : 'var(--panel-bg-elev)', color: appData.settings.lockMacros ? 'var(--panel-fg-dim)' : 'var(--panel-fg)', border: '1px solid var(--panel-border)', borderRadius: 'var(--radius-sm)', opacity: appData.settings.lockMacros ? 0.6 : 1 }}>
                  {appData.settings.lockMacros ? '🔒' : (isEditMode ? 'Done' : 'Edit')}
                </button>
                <button onClick={() => openSettings('toolbar')} style={{ padding: '4px 8px', fontSize: '11px', cursor: 'pointer', backgroundColor: 'var(--panel-bg-elev)', color: 'var(--panel-fg)', border: '1px solid var(--panel-border)', borderRadius: 'var(--radius-sm)' }}>
                ⚙️
                </button>
              </div>
            </div>
          </>
        )}

      {/* BODY (Scrollable Area) */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '15px' }}>

        {/* VIEW 1: MACRO GRID
            In edit mode we force a 15px gap (regardless of user's spacing
            setting) so the corner badges + wiggle have breathing room and
            don't overlap neighbouring tiles. */}
        {view === 'macros' && (
          <div style={{
            display: 'grid',
            gridTemplateColumns: `repeat(auto-fill, minmax(${appData.settings.buttonSize}px, 1fr))`,
            gap: `${isEditMode ? 15 : appData.settings.spacing}px`,
            // In edit mode the corner badges (×, ⇆) sit at -7px outside each
            // tile. Pad the grid so those badges always have room and never
            // clip against the body's overflow:auto boundary or scrollbar
            // gutter, regardless of panel width.
            padding: isEditMode ? '10px' : '0',
            // No transition on `gap` / `padding` — both trigger layout, and
            // animating them reflowed every tile on every frame for 300ms,
            // which collided with the wiggle animation and looked janky.
            // Snapping is fine; the wiggle itself sells the mode change.
          }}>
            {(() => {
              // Walk the macros, collapsing each run of anchor:* builtins into
              // one fixed 3×3 square block; everything else renders inline.
              const out: React.ReactNode[] = [];
              const macros = profileToShow.macros;
              const gap = isEditMode ? 15 : appData.settings.spacing;
              for (let i = 0; i < macros.length; i++) {
                if (isAnchorMacro(macros[i])) {
                  const run: Macro[] = [];
                  while (i < macros.length && isAnchorMacro(macros[i])) run.push(macros[i++]);
                  i--; // for-loop will re-increment
                  out.push(
                    <div
                      key={`anchor-grid-${run[0].id}`}
                      style={{
                        gridColumn: '1 / -1',
                        justifySelf: 'start',
                        display: 'grid',
                        gridTemplateColumns: 'repeat(3, 1fr)',
                        gridTemplateRows: 'repeat(3, 1fr)',
                        gap: `${gap}px`,
                        // Cap so 3 columns stay square even in wide panels; keep
                        // it shrinkable so narrow panels don't overflow.
                        width: `min(100%, ${appData.settings.buttonSize * 3 + gap * 2}px)`,
                        aspectRatio: '1 / 1',
                        padding: isEditMode ? '10px' : '0',
                      }}
                    >
                      {run.map(renderTile)}
                    </div>
                  );
                } else {
                  out.push(renderTile(macros[i]));
                }
              }
              return out;
            })()}

            {isEditMode && (
              <div onClick={openCreateMacro} className="mt-add-tile">
                + Add
              </div>
            )}
          </div>
        )}

        {/* Helpers-only interactive tools (rendered below the button grid). */}
        {view === 'macros' && profileToShow.id === HELPERS_PROFILE_ID && (
          <MotionStagger
            value={appData.settings.stagger ?? { type: 'tb', offset: 10, step: 2 }}
            onChange={updateStagger}
          />
        )}

        {/* VIEW 2: EASING EDITOR */}
        {view === 'easing' && (
          <div style={{ width: '100%', height: '100%' }}>
            <EasingEditor />
          </div>
        )}

      </div>

      {moveMenu && (() => {
        // Resolve the source macro's link group so we can prevent creating a
        // second instance of the same linked button inside one profile — that
        // includes re-linking back into the origin profile.
        const activeProfile = appData.profiles.find((p) => p.id === appData.activeProfileId);
        const srcMacro = activeProfile?.macros.find((m) => m.id === moveMenu.macroId);
        const linkId = srcMacro?.linkId;
        const hasSibling = (p: Profile) => !!linkId && p.macros.some((m) => m.linkId === linkId);
        const targets = appData.profiles.filter((p) => p.id !== appData.activeProfileId);
        return (
        <div
          ref={moveMenuRef}
          style={{
            position: 'fixed', left: moveMenu.x, top: moveMenu.y, zIndex: 9999,
            backgroundColor: 'var(--panel-bg-elev)', border: '1px solid var(--panel-border)',
            borderRadius: 'var(--radius-md)', padding: '4px', minWidth: '180px', maxWidth: '240px',
            boxShadow: '0 6px 18px rgba(0,0,0,0.45)', display: 'flex', flexDirection: 'column', gap: '2px',
          }}
        >
          <div style={{ fontSize: '10px', color: 'var(--panel-fg-muted)', padding: '4px 8px 6px', borderBottom: '1px solid var(--panel-border)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Move to profile…</div>
          {targets.map((p) => {
            // A linked button can't move into a profile that already holds a
            // sibling — that'd put two linked instances in one profile.
            const blocked = hasSibling(p);
            return (
              <button
                key={p.id}
                disabled={blocked}
                onClick={() => handleMoveMacroToProfile(moveMenu.macroId, p.id)}
                title={blocked ? 'Already has a linked copy of this button' : undefined}
                style={{
                  background: 'none', border: 'none', color: blocked ? 'var(--panel-fg-muted)' : 'var(--panel-fg)',
                  textAlign: 'left', padding: '6px 8px', fontSize: '12px', cursor: blocked ? 'not-allowed' : 'pointer',
                  opacity: blocked ? 0.5 : 1,
                  borderRadius: 'var(--radius-sm)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                }}
              >
                {p.name}
              </button>
            );
          })}

          <div style={{ fontSize: '10px', color: 'var(--panel-fg-muted)', padding: '8px 8px 6px', marginTop: '2px', borderTop: '1px solid var(--panel-border)', borderBottom: '1px solid var(--panel-border)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Copy to profile…</div>
          {targets.map((p) => {
            const blocked = hasSibling(p); // can't link a second instance into the same profile
            return (
              <div key={p.id} style={{ display: 'flex', alignItems: 'center', gap: '4px', padding: '2px 4px' }}>
                <span style={{ flex: 1, fontSize: '12px', color: 'var(--panel-fg)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name}</span>
                <button
                  disabled={blocked}
                  onClick={() => handleCopyMacroToProfile(moveMenu.macroId, p.id, true)}
                  title={blocked ? 'Already linked in this profile' : 'Linked — edits to this button sync across profiles'}
                  style={{ background: 'var(--panel-bg-sunken)', border: '1px solid var(--panel-border)', color: 'var(--panel-fg)', padding: '3px 8px', fontSize: '11px', cursor: blocked ? 'not-allowed' : 'pointer', opacity: blocked ? 0.4 : 1, borderRadius: 'var(--radius-sm)' }}
                >🔗 Link</button>
                <button
                  onClick={() => handleCopyMacroToProfile(moveMenu.macroId, p.id, false)}
                  title="Independent — a standalone copy that edits separately"
                  style={{ background: 'var(--panel-bg-sunken)', border: '1px solid var(--panel-border)', color: 'var(--panel-fg)', padding: '3px 8px', fontSize: '11px', cursor: 'pointer', borderRadius: 'var(--radius-sm)' }}
                >Copy</button>
              </div>
            );
          })}
        </div>
        );
      })()}

      {contextMenu && (() => {
        // Route the "Open settings…" item to whichever dedicated settings
        // panel matches the current view.
        const settingsScope: 'toolbar' | 'easing' = view === 'easing' ? 'easing' : 'toolbar';
        const items: ContextMenuItem[] = [
          { id: 'settings', label: 'Open settings…', icon: '⚙', onSelect: () => openSettings(settingsScope) },
        ];
        if (view === 'macros') {
          items.push(
            { id: 'edit', label: isEditMode ? 'Exit edit mode' : 'Edit macros', icon: '✎', disabled: !!appData?.settings.lockMacros, onSelect: handleToggleEdit },
            { id: 'palette', label: 'Open command palette', icon: '⌘', divider: true, disabled: !appData?.settings.enableCommandPalette, onSelect: () => setShowCommandPalette(true) },
          );
        } else if (view === 'easing') {
          items.push({
            id: 'easing-profiles', label: 'Manage easing profiles…', icon: '⌒',
            onSelect: () => openSettings('easing'),
          });
        }
        return <ContextMenu x={contextMenu.x} y={contextMenu.y} items={items} onClose={() => setContextMenu(null)} />;
      })()}

      <Toaster />

      {/* Command Palette */}
      {showCommandPalette && appData && (
        <CommandPalette
          profiles={appData.profiles}
          onExecute={handleMacroClick}
          onClose={() => setShowCommandPalette(false)}
        />
      )}
    </div>
  );
}

export default App;