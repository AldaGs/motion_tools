// src/App.tsx
import React, { useState, useEffect, useRef } from 'react';
import { evalScript } from './utils/adobe';
import { loadConfig, saveConfig, setDialogPayload, resolvePath, getLastLoadDiagnostics } from './utils/storage';
import { subscribeConfigChanges } from './utils/configWatcher';
import type { AppData, Macro, Profile } from './types';
import EasingEditor from './EasingEditor';
import DialogApp from './DialogApp';
import MotionColor from './MotionColor';
import MotionGifs from './MotionGifs';
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
  const view: 'macros' | 'easing' | 'dialog' | 'color' | 'gifs' = (() => {
    if (typeof window.__adobe_cep__ !== 'undefined') {
      const extId = window.__adobe_cep__.getExtensionId();
      if (extId === 'com.motiontoolbar.panel.easing') return 'easing';
      if (extId === 'com.motiontoolbar.panel.dialog') return 'dialog';
      if (extId === 'com.motiontoolbar.panel.color') return 'color';
      if (extId === 'com.motiontoolbar.panel.gifs') return 'gifs';
    }
    return 'macros';
  })();

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

  useEffect(() => {
    // Initial load
    const data = loadConfig();
    setAppData(data);
    if (data.settings.lastOverrideProfileId) {
      setOverrideProfileId(data.settings.lastOverrideProfileId);
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
        if (!cur || cur.settings.lastOverrideProfileId == null) return cur;
        const next = { ...cur, settings: { ...cur.settings, lastOverrideProfileId: null } };
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
      if (view === 'macros' && appData?.settings?.enableCommandPalette && e.ctrlKey && e.code === 'Space') {
        e.preventDefault();
        setShowCommandPalette((prev) => !prev);
        return;
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
  let profileToShow: Profile | undefined;
  if (overrideProfileId) {
    profileToShow = appData.profiles.find((p) => p.id === overrideProfileId);
  } else if (!appData.settings.enableContext) {
    profileToShow = appData.profiles.find((p) => p.id === appData.activeProfileId);
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

    // Update the base active profile (for edit mode and non-context scenarios)
    const newAppData: AppData = { ...appData, activeProfileId: selectedId };
    setAppData(newAppData);
    saveConfig(newAppData);

    // Set the temporary override and persist it
    setOverrideProfileId(selectedId);
    if (appData) {
      const next: AppData = { ...appData, settings: { ...appData.settings, lastOverrideProfileId: selectedId } };
      saveConfig(next);
    }
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

                {!isEditMode && appData.settings.enableContext && (
                  <span style={{ fontSize: '10px', color: overrideProfileId ? 'var(--warning)' : 'var(--panel-fg-muted)', flexShrink: 0 }} title={overrideProfileId ? 'Manual Override Active' : 'Auto-Context Active'}>
                    [{overrideProfileId ? 'Manual' : activeContext}]
                  </span>
                )}
              </div>
              
              <div style={{ display: 'flex', gap: '5px', flexShrink: 0 }}>
                <button onClick={handleToggleEdit} title={appData.settings.lockMacros ? 'Locked — toggle in Settings' : (isEditMode ? 'Exit edit mode' : 'Edit')} style={{ padding: '4px 8px', fontSize: '11px', cursor: appData.settings.lockMacros ? 'not-allowed' : 'pointer', backgroundColor: isEditMode ? 'var(--danger)' : 'var(--panel-bg-elev)', color: appData.settings.lockMacros ? 'var(--panel-fg-dim)' : 'var(--panel-fg)', border: '1px solid var(--panel-border)', borderRadius: 'var(--radius-sm)', opacity: appData.settings.lockMacros ? 0.6 : 1 }}>
                  {appData.settings.lockMacros ? '🔒' : (isEditMode ? 'Done' : 'Edit')}
                </button>
                <button onClick={() => openDialog('settings')} style={{ padding: '4px 8px', fontSize: '11px', cursor: 'pointer', backgroundColor: 'var(--panel-bg-elev)', color: 'var(--panel-fg)', border: '1px solid var(--panel-border)', borderRadius: 'var(--radius-sm)' }}>
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
            {profileToShow.macros.map((macro) => {
              const isDropTarget = isEditMode && dragOverMacroId === macro.id && draggedMacroId !== macro.id;
              const pendingDelete = pendingDeleteMacroId === macro.id;
              const isGhost = !!(macro.icon && macro.color);
              const isDragging = draggedMacroId === macro.id;

              // Static layout lives in .mt-tile; per-tile dynamics travel via
              // class modifiers + a `--mt-color` custom property + the
              // hex+alpha bg (kept inline so we don't rely on color-mix being
              // available in older CEF builds).
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
                  {/* Hide the text label when an icon is assigned — the icon
                      is the visual identity. Label-only tiles still render text. */}
                  {!macro.icon && macro.label && <span className="mt-tile-label">{macro.label}</span>}
                  {macro.hotkey && <span className="mt-hotkey-badge">{macro.hotkey}</span>}
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
            })}

            {isEditMode && (
              <div onClick={openCreateMacro} className="mt-add-tile">
                + Add
              </div>
            )}
          </div>
        )}

        {/* VIEW 2: EASING EDITOR */}
        {view === 'easing' && (
          <div style={{ width: '100%', height: '100%' }}>
            <EasingEditor />
          </div>
        )}

      </div>

      {moveMenu && (
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
          {appData.profiles
            .filter((p) => p.id !== appData.activeProfileId)
            .map((p) => (
              <button
                key={p.id}
                onClick={() => handleMoveMacroToProfile(moveMenu.macroId, p.id)}
                style={{
                  background: 'none', border: 'none', color: 'var(--panel-fg)',
                  textAlign: 'left', padding: '6px 8px', fontSize: '12px', cursor: 'pointer',
                  borderRadius: 'var(--radius-sm)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                }}
              >
                {p.name}
              </button>
            ))}
        </div>
      )}

      {contextMenu && (() => {
        const items: ContextMenuItem[] = [
          { id: 'settings', label: 'Open settings…', icon: '⚙', onSelect: () => openDialog('settings') },
        ];
        if (view === 'macros') {
          items.push(
            { id: 'edit', label: isEditMode ? 'Exit edit mode' : 'Edit macros', icon: '✎', disabled: !!appData?.settings.lockMacros, onSelect: handleToggleEdit },
            { id: 'palette', label: 'Open command palette', icon: '⌘', divider: true, disabled: !appData?.settings.enableCommandPalette, onSelect: () => setShowCommandPalette(true) },
          );
        } else if (view === 'easing') {
          items.push({
            id: 'easing-profiles', label: 'Manage easing profiles…', icon: '⌒',
            onSelect: () => {
              if (typeof window.__adobe_cep__ !== 'undefined') {
                setDialogPayload({ mode: 'settings', focus: 'easingProfiles' });
                window.__adobe_cep__.requestOpenExtension('com.motiontoolbar.panel.dialog', '');
              }
            },
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