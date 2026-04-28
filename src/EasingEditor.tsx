// src/EasingEditor.tsx
import React, { useState, useRef, useEffect } from 'react';
import { evalScript } from './utils/adobe';
import { loadConfig, saveConfig, getActiveEasingProfile, setActiveEases, setActiveEasingProfileId, setDialogPayload } from './utils/storage';
import { subscribeConfigChanges } from './utils/configWatcher';
import { toast } from './utils/toast';
import { Download, Save, FileUp, ChevronsRightLeft, ChevronRight, ChevronLeft } from 'lucide-react';
import type { AppData, BezierPoint, CustomEase, EaseSource } from './types';
import { parseEasingFile, mergeEasesUnique } from './utils/easingImport';

const SVG_SIZE = 250;
const PADDING = 20;
const INNER_SIZE = SVG_SIZE - PADDING * 2;

type ApplyMode = 'both' | 'in' | 'out';

const APPLY_MODES: { value: ApplyMode; icon: React.ReactNode; tooltip: string }[] = [
  { value: 'in', icon: <ChevronRight size={16} />, tooltip: 'Apply to Ease In' },
  { value: 'both', icon: <ChevronsRightLeft size={16} />, tooltip: 'Apply to Both' },
  { value: 'out', icon: <ChevronLeft size={16} />, tooltip: 'Apply to Ease Out' },
];

const DEFAULT_PRESETS: CustomEase[] = [
  { name: 'Linear', p1: { x: 0, y: 0 }, p2: { x: 1, y: 1 } },
  { name: 'Ease', p1: { x: 0.25, y: 0.1 }, p2: { x: 0.25, y: 1 } },
  { name: 'Ease In', p1: { x: 0.42, y: 0 }, p2: { x: 1, y: 1 } },
  { name: 'Ease Out', p1: { x: 0, y: 0 }, p2: { x: 0.58, y: 1 } },
  { name: 'Bounce', p1: { x: 0.68, y: -0.55 }, p2: { x: 0.265, y: 1.55 } },
];

let __miniCurveSeq = 0;
const MiniCurve = ({ p1, p2, isActive, size = 36 }: { p1: BezierPoint, p2: BezierPoint, isActive?: boolean, size?: number }) => {
  const [hovered, setHovered] = useState(false);
  // Stable per-instance id so the animateMotion's <mpath> reliably refers to
  // *this* curve and not a sibling — the previous inline `path=` attribute can
  // get cached/shared across instances in some renderers.
  const pathId = useRef(`mt-mini-${++__miniCurveSeq}`).current;
  const cp1X = p1.x * size; const cp1Y = size - (p1.y * size);
  const cp2X = p2.x * size; const cp2Y = size - (p2.y * size);
  const pathD = `M 0,${size} C ${cp1X},${cp1Y} ${cp2X},${cp2Y} ${size},0`;
  return (
    <svg
      width={size} height={size} viewBox={`0 0 ${size} ${size}`}
      style={{ overflow: 'visible', display: 'block' }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <rect x="0" y="0" width={size} height={size} fill={isActive ? 'var(--accent)' : 'none'} fillOpacity={isActive ? 0.25 : 1} stroke={isActive ? 'var(--accent)' : 'var(--panel-border)'} strokeWidth={isActive ? "2" : "1"} rx="4" />
      <path id={pathId} d={pathD} fill="none" stroke={isActive ? "var(--panel-fg)" : "var(--panel-fg-muted)"} strokeWidth="2" />
      {hovered && (
        <circle r="3" fill="var(--accent)">
          <animateMotion dur="1.2s" repeatCount="indefinite">
            <mpath xlinkHref={`#${pathId}`} href={`#${pathId}`} />
          </animateMotion>
        </circle>
      )}
    </svg>
  );
};

export default function EasingEditor() {
  const [appData, setAppData] = useState<AppData | null>(null);
  const [p1, setP1] = useState<BezierPoint>(DEFAULT_PRESETS[1].p1);
  const [p2, setP2] = useState<BezierPoint>(DEFAULT_PRESETS[1].p2);

  const [applyMode, setApplyMode] = useState<ApplyMode>('both');

  const [activeHandle, setActiveHandle] = useState<1 | 2 | null>(null);
  const [focusedHandle, setFocusedHandle] = useState<1 | 2 | null>(null);
  const [customMenu, setCustomMenu] = useState<{ name: string; x: number; y: number } | null>(null);
  const customMenuRef = useRef<HTMLDivElement>(null);

  // Collapsed numeric strip ↔ four-input row. Most users edit by dragging
  // the handles; this keeps the chrome compact and reveals inputs only on
  // demand. Auto-collapses on blur (with a small tail timer so tabbing
  // between the four inputs doesn't collapse mid-edit).
  const [numericOpen, setNumericOpen] = useState(false);
  const numericBlurTimerRef = useRef<number | null>(null);

  // Utility overflow (Read / Save / Import) — anchored popover.
  const [utilOpen, setUtilOpen] = useState(false);
  const utilMenuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!utilOpen) return;
    const onMouseDown = (e: MouseEvent) => {
      if (utilMenuRef.current && utilMenuRef.current.contains(e.target as Node)) return;
      setUtilOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setUtilOpen(false); };
    window.addEventListener('mousedown', onMouseDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onMouseDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [utilOpen]);

  // Inline name dialog (replacing the blocking native prompt). One state for
  // both save-to-library and rename flows.
  type NameDialog = { kind: 'save'; value: string } | { kind: 'rename'; oldName: string; value: string };
  const [nameDialog, setNameDialog] = useState<NameDialog | null>(null);
  const nameDialogInputRef = useRef<HTMLInputElement>(null);
  const nameDialogWasOpen = useRef(false);
  useEffect(() => {
    if (nameDialog && !nameDialogWasOpen.current) {
      // autoFocus on the input + select-all so the user can type-replace.
      // Only on the initial open — not on every keystroke.
      nameDialogWasOpen.current = true;
      requestAnimationFrame(() => {
        nameDialogInputRef.current?.focus();
        nameDialogInputRef.current?.select();
      });
    } else if (!nameDialog) {
      nameDialogWasOpen.current = false;
    }
  }, [nameDialog]);

  // Close the custom-ease menu on outside-click / Escape. Uses ref+contains so
  // we don't depend on React's synthetic stopPropagation halting native bubbles.
  useEffect(() => {
    if (!customMenu) return;
    const onMouseDown = (e: MouseEvent) => {
      if (customMenuRef.current && customMenuRef.current.contains(e.target as Node)) return;
      setCustomMenu(null);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setCustomMenu(null); };
    window.addEventListener('mousedown', onMouseDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onMouseDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [customMenu]);
  const svgRef = useRef<SVGSVGElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(300);
  const [containerHeight, setContainerHeight] = useState(400);
  const [topHeight, setTopHeight] = useState(240);
  const topHeightRef = useRef(240);
  const draggingRef = useRef(false);
  const hydratedTopHeightRef = useRef(false);
  const dragStartY = useRef(0);
  const dragStartHeight = useRef(0);
  useEffect(() => { topHeightRef.current = topHeight; }, [topHeight]);

  useEffect(() => {
    // Initial load
    setAppData(loadConfig());

    return subscribeConfigChanges(() => setAppData(loadConfig()));
  }, []);

  useEffect(() => {
    if (!containerRef.current) return;
    const observer = new ResizeObserver((entries) => {
      if (entries[0]) {
        setContainerWidth(entries[0].contentRect.width);
        setContainerHeight(entries[0].contentRect.height);
      }
    });
    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, []);

  // Hydrate topHeight from saved settings the first time appData arrives. Skip
  // updates while the user is mid-drag so a concurrent file-watcher reload
  // doesn't snap the resizer back.
  useEffect(() => {
    if (draggingRef.current) return;
    if (hydratedTopHeightRef.current) return;
    if (appData?.settings?.easingTopHeight !== undefined) {
      setTopHeight(appData.settings.easingTopHeight);
      hydratedTopHeightRef.current = true;
    }
  }, [appData?.settings?.easingTopHeight]);

  const isCompact = containerWidth < 180;

  const toSVG = (val: number, isY = false) => {
    if (isY) return PADDING + INNER_SIZE - (val * INNER_SIZE);
    return PADDING + (val * INNER_SIZE);
  };

  const fromSVG = (pixelX: number, pixelY: number) => {
    let x = Math.max(0, Math.min(1, (pixelX - PADDING) / INNER_SIZE));
    let y = (INNER_SIZE - (pixelY - PADDING)) / INNER_SIZE;
    return { x, y };
  };

  const handlePointerDown = (handleNum: 1 | 2) => {
    pushUndo();
    setActiveHandle(handleNum);
    setFocusedHandle(handleNum);
    svgRef.current?.focus();
  };
  const handlePointerMove = (e: React.PointerEvent) => {
    if (!activeHandle || !svgRef.current) return;
    const rect = svgRef.current.getBoundingClientRect();
    const pixelX = (e.clientX - rect.left) * (SVG_SIZE / rect.width);
    const pixelY = (e.clientY - rect.top) * (SVG_SIZE / rect.height);
    let newVal = fromSVG(pixelX, pixelY);
    // Shift-snap to 0.05 grid
    if (e.shiftKey) {
      newVal.x = Math.round(newVal.x * 20) / 20;
      newVal.y = Math.round(newVal.y * 20) / 20;
    }
    if (activeHandle === 1) setP1(newVal);
    if (activeHandle === 2) setP2(newVal);
  };
  const handlePointerUp = () => setActiveHandle(null);

  const handleSvgKeyDown = (e: React.KeyboardEvent) => {
    if (!focusedHandle) return;
    if (e.key === 'Tab') {
      e.preventDefault();
      setFocusedHandle(focusedHandle === 1 ? 2 : 1);
      return;
    }
    const step = e.shiftKey ? 0.05 : 0.01;
    let dx = 0, dy = 0;
    if (e.key === 'ArrowLeft') dx = -step;
    if (e.key === 'ArrowRight') dx = step;
    if (e.key === 'ArrowUp') dy = step;
    if (e.key === 'ArrowDown') dy = -step;
    if (!dx && !dy) return;
    e.preventDefault();
    const target = focusedHandle === 1 ? p1 : p2;
    const next: BezierPoint = { x: Math.max(0, Math.min(1, target.x + dx)), y: target.y + dy };
    (focusedHandle === 1 ? setP1 : setP2)(next);
  };


  // --- NEW: Precise Number Input Handlers ---
  const handleInputChange = (point: 1 | 2, axis: 'x' | 'y', value: string) => {
    let num = parseFloat(value);
    if (isNaN(num)) num = 0;
    if (axis === 'x') num = Math.max(0, Math.min(1, num)); // Constrain X
    if (point === 1) setP1({ ...p1, [axis]: num });
    if (point === 2) setP2({ ...p2, [axis]: num });
  };

  // --- NEW: Execution & Read Handlers ---
  const handleApplyEase = async () => {
    const bezierArray = [p1.x, p1.y, p2.x, p2.y];
    const response = await evalScript(`applyBezierToSelection('[${bezierArray}]', '${applyMode}')`);
    if (response.includes("Error")) toast.error(response);
    else toast.success("Easing applied.");
  };

  const handleReadEase = async () => {
    const result = await evalScript('readEaseFromSelection()');
    if (result && result !== "null") {
      const coords = JSON.parse(result);
      setP1({ x: parseFloat(coords[0]), y: parseFloat(coords[1]) });
      setP2({ x: parseFloat(coords[2]), y: parseFloat(coords[3]) });
      toast.info("Easing read from selection.");
    } else {
      toast.error("Select one or more keyframes to read.");
    }
  };

  // In-memory undo ring. Captures (p1, p2, customEases) before each mutation.
  type EasingSnap = { p1: BezierPoint; p2: BezierPoint; customEases: CustomEase[] };
  const undoStackRef = useRef<EasingSnap[]>([]);
  const snapshot = (): EasingSnap => ({
    p1: { ...p1 }, p2: { ...p2 },
    customEases: JSON.parse(JSON.stringify(appData?.settings?.customEases ?? [])),
  });
  const pushUndo = () => {
    if (!appData) return;
    const limit = Math.max(1, appData.settings.undoHistorySize ?? 10);
    undoStackRef.current.push(snapshot());
    while (undoStackRef.current.length > limit) undoStackRef.current.shift();
  };
  const handleUndo = () => {
    const prev = undoStackRef.current.pop();
    if (!prev || !appData) {
      toast.info("Nothing to undo.");
      return;
    }
    setP1(prev.p1);
    setP2(prev.p2);
    const next: AppData = { ...appData, settings: { ...appData.settings, customEases: prev.customEases } };
    setAppData(next);
    saveConfig(next);
    toast.info("Undone.");
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tgt = e.target as HTMLElement | null;
      const tag = tgt?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || (tgt && (tgt as HTMLElement).isContentEditable)) return;
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && (e.key === 'z' || e.key === 'Z')) {
        e.preventDefault();
        handleUndo();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const writeCustomEases = (next: CustomEase[]) => {
    if (!appData) return;
    pushUndo();
    // Route through the active easing profile so the change is visible to
    // the profile manager and survives a profile switch.
    const newAppData = setActiveEases(appData, next);
    setAppData(newAppData);
    saveConfig(newAppData);
  };

  const handleSelectEasingProfile = (id: string) => {
    if (!appData) return;
    const next = setActiveEasingProfileId(appData, id);
    setAppData(next);
    saveConfig(next);
  };

  // Open the dialog panel scrolled to the easing-profiles section. Mirrors
  // the macros panel's openDialog flow.
  const openEasingProfilesManager = () => {
    if (typeof window.__adobe_cep__ !== 'undefined') {
      setDialogPayload({ mode: 'settings', focus: 'easingProfiles' });
      window.__adobe_cep__.requestOpenExtension('com.motiontoolbar.panel.dialog', '');
    } else {
      toast.error("Profile manager opens in CEP only.");
    }
  };

  const handleSaveEase = () => {
    if (!appData) return;
    setNameDialog({ kind: 'save', value: 'My Custom Curve' });
  };

  const handleRenameCustom = (oldName: string) => {
    if (!appData) return;
    setNameDialog({ kind: 'rename', oldName, value: oldName });
  };

  const submitNameDialog = () => {
    if (!nameDialog || !appData) return;
    const name = nameDialog.value.trim();
    if (!name) {
      toast.error("Name can't be empty.");
      return;
    }
    if (nameDialog.kind === 'save') {
      // Reject duplicates of existing default + custom names.
      const existing = [...DEFAULT_PRESETS, ...(appData.settings.customEases ?? [])];
      if (existing.some((e) => e.name === name)) {
        toast.error("That name is already taken.");
        return;
      }
      const next = [...(appData.settings.customEases ?? []), { name, p1: { ...p1 }, p2: { ...p2 }, source: 'user' as const }];
      writeCustomEases(next);
      toast.success(`Saved "${name}".`);
    } else {
      if (name !== nameDialog.oldName) {
        const taken = (appData.settings.customEases ?? []).some((e) => e.name !== nameDialog.oldName && e.name === name);
        if (taken) {
          toast.error("That name is already taken.");
          return;
        }
        const next = (appData.settings.customEases ?? []).map((e) =>
          e.name === nameDialog.oldName ? { ...e, name } : e
        );
        writeCustomEases(next);
      }
    }
    setNameDialog(null);
  };

  const handleDeleteCustom = (name: string) => {
    if (!appData) return;
    const next = (appData.settings.customEases ?? []).filter((e) => e.name !== name);
    writeCustomEases(next);
    toast.info(`Deleted “${name}”.`);
  };

  // Unified easing-library import. Accepts both Flow libraries (raw JSON
  // array) and Motion Toolbar easing packs ({kind:'motion-toolbar/easing'}).
  // Each imported ease is stamped with its `source` so the library can
  // badge/filter it.
  const handleImportEasing = () => {
    if (!appData) return;
    if (typeof window.cep === 'undefined') {
      toast.error("File dialog only available in After Effects.");
      return;
    }
    const result = window.cep.fs.showOpenDialog(false, false, "Import Easing Library (Flow or MT)", "", ["flow", "json"]);
    if (result.err !== 0 || !result.data || result.data.length === 0) return;

    const filePath = result.data[0];
    let content: string;
    try {
      const fs = window.require('fs');
      content = fs.readFileSync(filePath, 'utf8');
    } catch (err) {
      console.error("Failed to read easing file", err);
      toast.error("Couldn't read file.");
      return;
    }

    const parsed = parseEasingFile(content);
    if (!parsed.ok) { toast.error((parsed as import('./utils/easingImport').EasingImportFailure).error); return; }

    const existingEases = appData.settings.customEases || [];
    const merged = mergeEasesUnique(parsed.eases, existingEases, DEFAULT_PRESETS.map((p) => p.name));
    if (merged.length === 0) { toast.info("Nothing new to import."); return; }
    writeCustomEases([...existingEases, ...merged]);
    const label = parsed.format === 'flow' ? 'Flow' : 'Motion Toolbar';
    toast.success(`Imported ${merged.length} ease${merged.length === 1 ? '' : 's'} from ${label}.`);
  };

  const startX = toSVG(0); const startY = toSVG(0, true);
  const endX = toSVG(1); const endY = toSVG(1, true);
  const h1X = toSVG(p1.x); const h1Y = toSVG(p1.y, true);
  const h2X = toSVG(p2.x); const h2Y = toSVG(p2.y, true);

  const curvePath = `M ${startX},${startY} C ${h1X},${h1Y} ${h2X},${h2Y} ${endX},${endY}`;
  const transitionStyle = activeHandle === null ? 'all 0.4s cubic-bezier(0.25, 1, 0.5, 1)' : 'none';

  // Estimate the SVG's actual rendered width in CSS pixels (canvas has padding 10
  // + maxWidth 350). Used so handle radii stay readable as the panel shrinks —
  // strokes use vector-effect="non-scaling-stroke" so they don't need scaling.
  const canvasOuter = Math.max(60, Math.min(containerWidth, 350));
  const svgPx = Math.max(40, canvasOuter - 20);
  const svgScale = SVG_SIZE / svgPx; // viewBox-units per device px
  const handleR = 9 * svgScale;       // visible handle: 9 device px
  const handleHitR = 18 * svgScale;   // hit target: 18 device px
  const isPresetActive = (presetP1: BezierPoint, presetP2: BezierPoint) => p1.x === presetP1.x && p1.y === presetP1.y && p2.x === presetP2.x && p2.y === presetP2.y;
  const isCustom = (preset: CustomEase) => !DEFAULT_PRESETS.some((d) => d.name === preset.name);
  const onPresetContextMenu = (e: React.MouseEvent, preset: CustomEase) => {
    if (!isCustom(preset)) return;
    e.preventDefault();
    e.stopPropagation();
    // Clamp inside the viewport so the menu never opens off-screen.
    const MENU_W = 140, MENU_H = 96, PAD = 4;
    const x = Math.max(PAD, Math.min(e.clientX, window.innerWidth - MENU_W - PAD));
    const y = Math.max(PAD, Math.min(e.clientY, window.innerHeight - MENU_H - PAD));
    setCustomMenu({ name: preset.name, x, y });
  };

  // Combine Default and Custom presets. Defaults are tagged synthetically as
  // 'builtin' for the source-filter UI (they aren't persisted with a source
  // — we only need the tag to render the filter pills).
  type PresetWithKind = CustomEase & { _kind: 'builtin' | EaseSource };
  const decoratedDefaults: PresetWithKind[] = DEFAULT_PRESETS.map((p) => ({ ...p, _kind: 'builtin' as const }));
  const decoratedCustoms: PresetWithKind[] = (appData?.settings?.customEases ?? []).map((p) => ({
    ...p,
    _kind: (p.source ?? 'user') as EaseSource,
  }));
  const allPresets: PresetWithKind[] = [...decoratedDefaults, ...decoratedCustoms];

  // Source filter: 'all' | one of the kinds. Counts power the chip labels.
  type Filter = 'all' | 'builtin' | 'user' | 'flow' | 'mt';
  const [sourceFilter, setSourceFilterRaw] = useState<Filter>('all');
  // Hydrate from settings once.
  const sourceFilterHydrated = useRef(false);
  useEffect(() => {
    if (sourceFilterHydrated.current) return;
    const persisted = appData?.settings.easingSourceFilter;
    if (persisted) setSourceFilterRaw(persisted);
    if (appData) sourceFilterHydrated.current = true;
  }, [appData]);
  // Persist on change. Skips the hydration tick.
  const setSourceFilter = (next: Filter) => {
    setSourceFilterRaw(next);
    if (!appData) return;
    if (appData.settings.easingSourceFilter === next) return;
    const updated: AppData = { ...appData, settings: { ...appData.settings, easingSourceFilter: next } };
    setAppData(updated);
    saveConfig(updated);
  };
  const counts = {
    all: allPresets.length,
    builtin: decoratedDefaults.length,
    user: decoratedCustoms.filter((p) => p._kind === 'user').length,
    flow: decoratedCustoms.filter((p) => p._kind === 'flow').length,
    mt: decoratedCustoms.filter((p) => p._kind === 'mt').length,
  };
  const visiblePresets = sourceFilter === 'all'
    ? allPresets
    : allPresets.filter((p) => p._kind === sourceFilter);

  // Tiny coloured chip rendered on top of a custom preset's mini curve so the
  // user can see at a glance where it came from.
  const SourceBadge = ({ kind }: { kind: PresetWithKind['_kind'] }) => {
    if (kind === 'builtin' || kind === 'user') return null;
    const palette: Record<'flow' | 'mt', { bg: string; label: string; title: string }> = {
      flow: { bg: '#3b82f6', label: 'F', title: 'Imported from Flow' },
      mt: { bg: 'var(--accent)', label: 'MT', title: 'Imported from a Motion Toolbar pack' },
    };
    const k = kind as 'flow' | 'mt';
    return (
      <span title={palette[k].title} style={{
        position: 'absolute', top: -3, right: -3, zIndex: 2,
        fontSize: 8, lineHeight: 1, padding: '2px 3px',
        borderRadius: 4, color: '#fff', fontWeight: 700,
        backgroundColor: palette[k].bg,
        boxShadow: '0 0 0 1px var(--panel-bg)',
        letterSpacing: 0,
      }}>{palette[k].label}</span>
    );
  };

  const targetSize = appData?.settings?.bezierButtonSize ?? 40;
  const presetCellMin = targetSize + 8;
  const presetSize = targetSize;
  const presetLabelSize = Math.max(9, Math.min(12, targetSize * 0.35));
  //const presetGap = appData?.settings?.spacing ?? 6;

  const handleResizerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const target = e.currentTarget;
    try { target.setPointerCapture(e.pointerId); } catch { }
    draggingRef.current = true;
    dragStartY.current = e.clientY;
    dragStartHeight.current = topHeight;

    // Leave at least ~110px below the resizer for the preset row + Apply.
    const MIN_TOP = 120;
    const MIN_BOTTOM = 110;
    const RESIZER_PLUS_GAPS = 24;
    const maxTop = Math.max(MIN_TOP + 60, containerHeight - MIN_BOTTOM - RESIZER_PLUS_GAPS);

    const handleMove = (ev: PointerEvent) => {
      const delta = ev.clientY - dragStartY.current;
      const next = Math.max(MIN_TOP, Math.min(maxTop, dragStartHeight.current + delta));
      setTopHeight(next);
    };
    const handleUp = (ev: PointerEvent) => {
      try { target.releasePointerCapture(ev.pointerId); } catch { }
      target.removeEventListener('pointermove', handleMove);
      target.removeEventListener('pointerup', handleUp);
      target.removeEventListener('pointercancel', handleUp);
      draggingRef.current = false;

      // Persist the final height into settings.
      setAppData((cur) => {
        if (!cur) return cur;
        if (cur.settings.easingTopHeight === topHeightRef.current) return cur;
        const next: AppData = {
          ...cur,
          settings: { ...cur.settings, easingTopHeight: topHeightRef.current },
        };
        saveConfig(next);
        return next;
      });
    };

    target.addEventListener('pointermove', handleMove);
    target.addEventListener('pointerup', handleUp);
    target.addEventListener('pointercancel', handleUp);
  };

  const InputStyle = { width: '40px', background: 'transparent', color: 'var(--accent)', border: 'none', borderBottom: '1px solid var(--panel-border)', textAlign: 'center' as const, fontSize: '11px', fontFamily: 'monospace' };

  const ApplyModeToggle = (
    <div style={{ display: 'flex', backgroundColor: 'var(--panel-bg-sunken)', borderRadius: 'var(--radius-md)', overflow: 'hidden', flexShrink: 0 }}>
      {APPLY_MODES.map((mode) => (
        <button
          key={mode.value}
          onClick={() => setApplyMode(mode.value)}
          title={mode.tooltip}
          style={{
            flex: 1,
            padding: '6px',
            display: 'flex',
            justifyContent: 'center',
            alignItems: 'center',
            cursor: 'pointer',
            border: 'none',
            backgroundColor: applyMode === mode.value ? 'var(--accent)' : 'transparent',
            color: applyMode === mode.value ? '#fff' : 'var(--panel-fg-muted)',
            transition: 'all 0.15s ease'
          }}
        >
          {mode.icon}
        </button>
      ))}
    </div>
  );

  return (
    <div ref={containerRef} style={{ display: 'flex', flexDirection: 'column', height: '100%', width: '100%', overflow: 'hidden', gap: '5px' }}>

      {!isCompact ? (
        <>
          <div style={{ display: 'flex', flexDirection: 'column', height: `${topHeight}px`, flexShrink: 0, gap: '8px', overflow: 'hidden', justifyContent: 'center', alignItems: 'center' }}>
            {/* TOP: precise input — collapsed strip by default, expands to
                four inputs on click. Most users never edit numerically. */}
            <div
              style={{
                flexShrink: 0, display: 'flex', justifyContent: 'center', alignItems: 'center',
                backgroundColor: 'var(--panel-bg-sunken)',
                padding: numericOpen ? '2px 2px' : '3px 8px',
                borderRadius: 'var(--radius-md)',
                cursor: numericOpen ? 'default' : 'pointer',
                transition: 'padding 120ms ease-out',
                minHeight: 22,
              }}
              onClick={() => { if (!numericOpen) setNumericOpen(true); }}
              onBlur={() => {
                if (numericBlurTimerRef.current !== null) clearTimeout(numericBlurTimerRef.current);
                // Tail timer so tabbing between the four inputs doesn't
                // collapse mid-edit. The next focus event clears it.
                numericBlurTimerRef.current = window.setTimeout(() => setNumericOpen(false), 120);
              }}
              onFocus={() => {
                if (numericBlurTimerRef.current !== null) {
                  clearTimeout(numericBlurTimerRef.current);
                  numericBlurTimerRef.current = null;
                }
              }}
              title={numericOpen ? 'Click outside to collapse' : 'Click to edit numerically'}
            >
              {numericOpen ? (
                <div style={{ display: 'flex', gap: 0, alignItems: 'center', color: 'var(--panel-fg-dim)', fontSize: 14 }}>
                  <input autoFocus type="number" step="0.01" className="minimal-input" value={p1.x.toFixed(2)} onChange={(e) => handleInputChange(1, 'x', e.target.value)} style={InputStyle} /> ,
                  <input type="number" step="0.01" className="minimal-input" value={p1.y.toFixed(2)} onChange={(e) => handleInputChange(1, 'y', e.target.value)} style={InputStyle} /> ,
                  <input type="number" step="0.01" className="minimal-input" value={p2.x.toFixed(2)} onChange={(e) => handleInputChange(2, 'x', e.target.value)} style={InputStyle} /> ,
                  <input type="number" step="0.01" className="minimal-input" value={p2.y.toFixed(2)} onChange={(e) => handleInputChange(2, 'y', e.target.value)} style={InputStyle} />
                </div>
              ) : (
                <span style={{
                  fontFamily: 'monospace', fontSize: 11,
                  color: 'var(--panel-fg-muted)', letterSpacing: 0.3,
                  userSelect: 'none',
                }}>
                  {p1.x.toFixed(2)}, {p1.y.toFixed(2)}, {p2.x.toFixed(2)}, {p2.y.toFixed(2)}
                </span>
              )}
            </div>

            {/* CANVAS */}
            <div style={{ flex: '0 1 auto', minHeight: 0, display: 'flex', justifyContent: 'center', alignItems: 'center', overflow: 'hidden' }}>
              <div style={{ backgroundColor: 'var(--panel-bg-elev)', border: '1px solid var(--panel-border)', borderRadius: '8px', padding: '0px', width: '100%', maxWidth: '180px', maxHeight: '100%', aspectRatio: '1 / 1', display: 'flex' }}>
                <svg ref={svgRef}
                  viewBox={`0 0 ${SVG_SIZE} ${SVG_SIZE}`}
                  tabIndex={0}
                  style={{ width: '100%', height: '100%', touchAction: 'none', display: 'block', overflow: 'visible', outline: 'none' }}
                  onPointerMove={handlePointerMove}
                  onPointerUp={handlePointerUp}
                  onPointerLeave={handlePointerUp}
                  onKeyDown={handleSvgKeyDown}
                >
                  <rect x={PADDING} y={PADDING} width={INNER_SIZE} height={INNER_SIZE} fill="none" stroke="var(--panel-border)" strokeWidth="1" vectorEffect="non-scaling-stroke" />
                  {[0.25, 0.5, 0.75].map((val) => (
                    <React.Fragment key={val}>
                      <line x1={PADDING} y1={toSVG(val, true)} x2={PADDING + INNER_SIZE} y2={toSVG(val, true)} stroke="var(--panel-border)" strokeDasharray="3" opacity="0.8" vectorEffect="non-scaling-stroke" />
                      <line x1={toSVG(val)} y1={PADDING} x2={toSVG(val)} y2={PADDING + INNER_SIZE} stroke="var(--panel-border)" strokeDasharray="3" opacity="0.8" vectorEffect="non-scaling-stroke" />
                    </React.Fragment>
                  ))}
                  <line x1={startX} y1={startY} x2={h1X} y2={h1Y} stroke="var(--panel-fg-muted)" strokeWidth="1.5" vectorEffect="non-scaling-stroke" style={{ transition: transitionStyle }} />
                  <line x1={endX} y1={endY} x2={h2X} y2={h2Y} stroke="var(--panel-fg-muted)" strokeWidth="1.5" vectorEffect="non-scaling-stroke" style={{ transition: transitionStyle }} />
                  <path id="mt-main-curve" d={curvePath} fill="none" stroke="var(--accent)" strokeWidth="3" vectorEffect="non-scaling-stroke" style={{ transition: transitionStyle }} />

                  {/* Handle 1 (out) */}
                  {activeHandle === 1 && (
                    <circle cx={h1X} cy={h1Y} r={handleR * 1.9} fill="#e74c3c" style={{ pointerEvents: 'none', animation: 'mt-handle-pulse 1.1s ease-in-out infinite' }} />
                  )}
                  <circle cx={h1X} cy={h1Y} r={handleR} fill="#e74c3c" stroke={focusedHandle === 1 ? '#fff' : 'none'} strokeWidth={2} vectorEffect="non-scaling-stroke" style={{ pointerEvents: 'none', transition: transitionStyle }} />
                  <circle cx={h1X} cy={h1Y} r={handleHitR} fill="transparent" style={{ cursor: 'grab' }} onPointerDown={() => handlePointerDown(1)} />

                  {/* Handle 2 (in) */}
                  {activeHandle === 2 && (
                    <circle cx={h2X} cy={h2Y} r={handleR * 1.9} fill="#2ecc71" style={{ pointerEvents: 'none', animation: 'mt-handle-pulse 1.1s ease-in-out infinite' }} />
                  )}
                  <circle cx={h2X} cy={h2Y} r={handleR} fill="#2ecc71" stroke={focusedHandle === 2 ? '#fff' : 'none'} strokeWidth={2} vectorEffect="non-scaling-stroke" style={{ pointerEvents: 'none', transition: transitionStyle }} />
                  <circle cx={h2X} cy={h2Y} r={handleHitR} fill="transparent" style={{ cursor: 'grab' }} onPointerDown={() => handlePointerDown(2)} />

                  {/* Live preview dot */}
                  {appData?.settings?.showCurvePreview && (
                    <circle r="5" fill="var(--accent)" opacity="0.8">
                      <animateMotion dur="1.5s" repeatCount="indefinite" key={curvePath}>
                        <mpath xlinkHref="#mt-main-curve" href="#mt-main-curve" />
                      </animateMotion>
                    </circle>
                  )}
                </svg>
              </div>
            </div>

            {/* (Keyboard-nudge hint removed — the info still lives in the
                canvas tooltip, and the row was eating vertical space.) */}

            {/* COMBINED ROW */}
            <div style={{ flexShrink: 0, display: 'flex', alignItems: 'center', gap: '4px', justifyContent: 'center' }}>
              <div style={{ flex: '0 0 auto' }}>{ApplyModeToggle}</div>
              <button
                onClick={handleApplyEase}
                style={{ flex: '0 0 auto', padding: '6px 8px', backgroundColor: 'var(--accent)', color: 'white', border: 'none', borderRadius: 'var(--radius-md)', fontWeight: 'bold', cursor: 'pointer', fontSize: '10px', letterSpacing: '0.5px' }}
              >
                APPLY
              </button>
              {/* Utility overflow — one button opens a small menu with
                  Read / Save / Import. Keeps APPLY visually dominant. */}
              <div style={{ position: 'relative' }} ref={utilMenuRef}>
                <button
                  onClick={() => setUtilOpen((o) => !o)}
                  title="More actions"
                  aria-haspopup="menu"
                  aria-expanded={utilOpen}
                  style={{
                    background: utilOpen ? 'var(--panel-bg-sunken)' : 'none',
                    border: '1px solid transparent',
                    color: 'var(--panel-fg-muted)',
                    cursor: 'pointer',
                    padding: '2px 6px',
                    borderRadius: 'var(--radius-sm)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontSize: 14, lineHeight: 1,
                  }}
                >⋯</button>
                {utilOpen && (
                  <div
                    role="menu"
                    // Anchored ABOVE the button — the parent column section
                    // has overflow:hidden and the button sits near its bottom
                    // edge, so opening downward gets clipped.
                    style={{
                      position: 'absolute', bottom: 'calc(100% + 6px)', right: 0, zIndex: 100,
                      minWidth: 180,
                      backgroundColor: 'var(--panel-bg-elev)',
                      border: '1px solid var(--panel-border)',
                      borderRadius: 'var(--radius-md)',
                      boxShadow: '0 -8px 24px rgba(0,0,0,0.45)',
                      padding: 4,
                      display: 'flex', flexDirection: 'column', gap: 1,
                      animation: 'mt-fade-in 100ms ease-out both',
                    }}
                  >
                    {[
                      { icon: <Download size={13} />, label: 'Read from selection',    onClick: handleReadEase },
                      { icon: <Save size={13} />,     label: 'Save to library…',       onClick: handleSaveEase },
                      { icon: <FileUp size={13} />,   label: 'Import library (Flow / MT)…', onClick: handleImportEasing },
                    ].map((it) => (
                      <button
                        key={it.label}
                        onClick={() => { setUtilOpen(false); it.onClick(); }}
                        role="menuitem"
                        style={{
                          background: 'none', border: 'none',
                          color: 'var(--panel-fg)',
                          textAlign: 'left',
                          padding: '6px 8px', fontSize: 11,
                          borderRadius: 'var(--radius-sm)',
                          cursor: 'pointer',
                          display: 'flex', alignItems: 'center', gap: 8,
                        }}
                        onMouseEnter={(e) => e.currentTarget.style.backgroundColor = 'var(--panel-bg-sunken)'}
                        onMouseLeave={(e) => e.currentTarget.style.backgroundColor = 'transparent'}
                      >
                        <span style={{ display: 'flex', width: 14, color: 'var(--panel-fg-muted)' }}>{it.icon}</span>
                        {it.label}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* DRAG RESIZER */}
          <div
            onPointerDown={handleResizerDown}
            onDoubleClick={() => {
              setTopHeight(240);
              setAppData((cur) => {
                if (!cur) return cur;
                const next: AppData = { ...cur, settings: { ...cur.settings, easingTopHeight: 240 } };
                saveConfig(next);
                return next;
              });
            }}
            title="Drag to resize (Double-click to reset)"
            // 6px hit area, 1px visible hairline. The transparent padding
            // sandwiches the hairline so the cursor still shows row-resize
            // a few px above and below the line.
            style={{
              flexShrink: 0, height: 6, cursor: 'row-resize',
              backgroundColor: 'transparent',
              display: 'flex', justifyContent: 'center', alignItems: 'center',
              position: 'relative',
            }}
          >
            <div style={{ width: '100%', height: 1, backgroundColor: 'var(--panel-border)' }} />
          </div>

          {/* PROFILE + FILTER ROW — one row, wraps when narrow. The chip
              counts replace the explicit "(11)" suffix in the dropdown. */}
          {appData && (appData.settings.easingProfiles?.length ?? 0) > 0 && (
            <div style={{ flexShrink: 0, display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '4px' }}>
              <select
                value={getActiveEasingProfile(appData).id}
                onChange={(e) => handleSelectEasingProfile(e.target.value)}
                title="Active easing profile"
                style={{
                  flex: '1 1 110px', minWidth: 0,
                  padding: '3px 6px',
                  backgroundColor: 'var(--panel-bg-sunken)',
                  color: 'var(--panel-fg)',
                  border: '1px solid var(--panel-border)',
                  borderRadius: 'var(--radius-sm)',
                  fontSize: 11,
                }}
              >
                {appData.settings.easingProfiles!.map((p) => (
                  <option key={p.id} value={p.id} style={{ backgroundColor: 'var(--panel-bg-elev)' }}>
                    {p.name}
                  </option>
                ))}
              </select>
              <button
                onClick={openEasingProfilesManager}
                title="Manage easing profiles…"
                style={{
                  padding: '2px 6px', fontSize: 10, lineHeight: 1.2,
                  backgroundColor: 'var(--panel-bg-elev)',
                  color: 'var(--panel-fg-muted)',
                  border: '1px solid var(--panel-border)',
                  borderRadius: 'var(--radius-sm)',
                  cursor: 'pointer',
                }}
              >⚙</button>

              {(counts.user + counts.flow + counts.mt) > 0 &&
                ([
                  ['all', 'All'],
                  ['builtin', 'Built-in'],
                  ['user', 'User'],
                  ['flow', 'Flow'],
                  ['mt', 'MT'],
                ] as Array<[Filter, string]>).map(([k, label]) => {
                  const c = counts[k];
                  if (c === 0 && k !== 'all') return null;
                  const active = sourceFilter === k;
                  return (
                    <button
                      key={k}
                      onClick={() => setSourceFilter(k)}
                      title={`Show ${label.toLowerCase()} (${c})`}
                      style={{
                        padding: '1px 6px', fontSize: 9, lineHeight: 1.4, borderRadius: 999,
                        backgroundColor: active ? 'var(--accent)' : 'transparent',
                        color: active ? '#fff' : 'var(--panel-fg-muted)',
                        border: `1px solid ${active ? 'var(--accent)' : 'var(--panel-border)'}`,
                        cursor: 'pointer',
                      }}
                    >{label}<span style={{ opacity: 0.6, marginLeft: 3 }}>{c}</span></button>
                  );
                })}
            </div>
          )}

          {/* PRESETS — `flex: 1 1 0` + `minHeight: 0` lets the grid claim the
              remaining vertical space and scroll inside it (parent is a column
              flex). gap:0 makes the curves touch; the active tile's filled
              rectangle inside <MiniCurve> serves as the only visual divider.
              maskImage gives a soft fade at the bottom so the lack of a
              scrollbar still hints "there's more below". */}
          <div
            className="no-scrollbar"
            style={{
              flex: '1 1 0', minHeight: 0,
              display: 'grid',
              gridTemplateColumns: `repeat(auto-fill, minmax(${presetCellMin}px, 1fr))`,
              gap: 0,
              width: '100%',
              overflowY: 'auto',
              alignContent: 'start',
              WebkitMaskImage: 'linear-gradient(to bottom, black calc(100% - 14px), transparent)',
              maskImage: 'linear-gradient(to bottom, black calc(100% - 14px), transparent)',
            }}
          >
            {visiblePresets.map((preset) => {
              const active = isPresetActive(preset.p1, preset.p2);
              return (
                <div
                  key={preset.name}
                  onClick={() => { pushUndo(); setP1(preset.p1); setP2(preset.p2); if (appData?.settings?.easingClickToApply) handleApplyEase(); }}
                  onDoubleClick={handleApplyEase}
                  onContextMenu={(e) => onPresetContextMenu(e, preset)}
                  title={isCustom(preset) ? `${preset.name} — right-click to manage` : preset.name}
                  style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', cursor: 'pointer', opacity: active ? 1 : 0.55, transition: 'opacity 0.15s', minWidth: 0, position: 'relative' }}
                  onMouseOver={(e) => e.currentTarget.style.opacity = '1'} onMouseOut={(e) => e.currentTarget.style.opacity = active ? '1' : '0.55'}
                >
                  <div key={active ? 'on' : 'off'} style={{ animation: active ? 'mt-pop 280ms cubic-bezier(0.2, 0.8, 0.2, 1)' : 'none', position: 'relative' }}>
                    <MiniCurve p1={preset.p1} p2={preset.p2} isActive={active} size={presetSize} />
                    <SourceBadge kind={preset._kind} />
                  </div>
                  <span style={{ fontSize: `${presetLabelSize}px`, color: active ? 'var(--panel-fg)' : 'var(--panel-fg-muted)', marginTop: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', width: '100%', textAlign: 'center', lineHeight: 1.2 }}>{preset.name}</span>
                </div>
              )
            })}
          </div>
        </>
      ) : (
        <>
          {ApplyModeToggle}
          <div className="no-scrollbar" style={{ flex: '1 1 0', minHeight: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 0, WebkitMaskImage: 'linear-gradient(to bottom, black calc(100% - 14px), transparent)', maskImage: 'linear-gradient(to bottom, black calc(100% - 14px), transparent)' }}>
            {visiblePresets.map((preset) => {
              const active = isPresetActive(preset.p1, preset.p2);
              return (
                <div
                  key={preset.name}
                  onClick={() => { pushUndo(); setP1(preset.p1); setP2(preset.p2); }}
                  onDoubleClick={handleApplyEase}
                  onContextMenu={(e) => onPresetContextMenu(e, preset)}
                  title={isCustom(preset) ? `${preset.name} — right-click to manage` : preset.name}
                  style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', cursor: 'pointer', opacity: active ? 1 : 0.6, transition: 'opacity 0.2s', position: 'relative' }}
                >
                  <div key={active ? 'on' : 'off'} style={{ animation: active ? 'mt-pop 280ms cubic-bezier(0.2, 0.8, 0.2, 1)' : 'none', position: 'relative' }}>
                    <MiniCurve p1={preset.p1} p2={preset.p2} isActive={active} size={presetSize} />
                    <SourceBadge kind={preset._kind} />
                  </div>
                  <span style={{ fontSize: `${presetLabelSize}px`, color: active ? 'var(--panel-fg)' : 'var(--panel-fg-muted)', marginTop: '2px', textAlign: 'center' }}>{preset.name}</span>
                </div>
              )
            })}
          </div>
          <button onClick={handleApplyEase} style={{ flexShrink: 0, width: '100%', padding: '12px 0', backgroundColor: 'var(--accent)', color: 'white', border: 'none', borderRadius: 'var(--radius-lg)', fontWeight: 'bold', cursor: 'pointer' }}>
            APPLY
          </button>
        </>
      )}

      {nameDialog && (
        <div
          onMouseDown={(e) => { if (e.target === e.currentTarget) setNameDialog(null); }}
          style={{
            position: 'fixed', inset: 0, zIndex: 9998,
            backgroundColor: 'rgba(0,0,0,0.55)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '12px',
            animation: 'mt-modal-in 180ms cubic-bezier(0.2, 0.8, 0.2, 1)',
          }}
        >
          <div
            onMouseDown={(e) => e.stopPropagation()}
            style={{
              backgroundColor: 'var(--panel-bg-elev)', border: '1px solid var(--panel-border)',
              borderRadius: '8px', padding: '14px', minWidth: '200px', maxWidth: '280px',
              display: 'flex', flexDirection: 'column', gap: '10px',
              boxShadow: '0 8px 24px rgba(0,0,0,0.45)',
            }}
          >
            <h4 style={{ margin: 0, fontSize: '12px', color: 'var(--panel-fg)', fontWeight: 600, letterSpacing: '0.3px', textTransform: 'uppercase' }}>
              {nameDialog.kind === 'save' ? 'Save easing' : 'Rename easing'}
            </h4>
            <input
              ref={nameDialogInputRef}
              type="text"
              value={nameDialog.value}
              onChange={(e) => setNameDialog({ ...nameDialog, value: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === 'Enter') { e.preventDefault(); submitNameDialog(); }
                else if (e.key === 'Escape') { e.preventDefault(); setNameDialog(null); }
              }}
              placeholder="Name"
              style={{
                padding: '6px 8px', backgroundColor: 'var(--panel-bg-sunken)',
                color: 'var(--panel-fg)', border: '1px solid var(--panel-border)',
                borderRadius: 'var(--radius-md)', fontSize: '12px', outline: 'none',
              }}
            />
            <div style={{ display: 'flex', gap: '6px', justifyContent: 'flex-end' }}>
              <button
                onClick={() => setNameDialog(null)}
                style={{ padding: '6px 12px', backgroundColor: 'var(--panel-border)', color: 'var(--panel-fg)', border: 'none', borderRadius: 'var(--radius-sm)', cursor: 'pointer', fontSize: '11px' }}
              >Cancel</button>
              <button
                onClick={submitNameDialog}
                style={{ padding: '6px 12px', backgroundColor: 'var(--accent)', color: '#fff', border: 'none', borderRadius: 'var(--radius-sm)', cursor: 'pointer', fontSize: '11px', fontWeight: 'bold' }}
              >{nameDialog.kind === 'save' ? 'Save' : 'Rename'}</button>
            </div>
          </div>
        </div>
      )}

      {customMenu && (
        <div
          ref={customMenuRef}
          style={{
            position: 'fixed', left: customMenu.x, top: customMenu.y, zIndex: 9999,
            backgroundColor: 'var(--panel-bg-elev)', border: '1px solid var(--panel-border)',
            borderRadius: 'var(--radius-md)', padding: '4px', minWidth: '120px',
            boxShadow: '0 6px 18px rgba(0,0,0,0.45)', display: 'flex', flexDirection: 'column', gap: '2px',
          }}
        >
          <div style={{ fontSize: '10px', color: 'var(--panel-fg-muted)', padding: '4px 8px 6px', borderBottom: '1px solid var(--panel-border)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{customMenu.name}</div>
          <button onClick={() => { handleRenameCustom(customMenu.name); setCustomMenu(null); }} style={{ background: 'none', border: 'none', color: 'var(--panel-fg)', textAlign: 'left', padding: '6px 8px', fontSize: '12px', cursor: 'pointer', borderRadius: 'var(--radius-sm)' }}>Rename…</button>
          <button onClick={() => { handleDeleteCustom(customMenu.name); setCustomMenu(null); }} style={{ background: 'none', border: 'none', color: 'var(--danger)', textAlign: 'left', padding: '6px 8px', fontSize: '12px', cursor: 'pointer', borderRadius: 'var(--radius-sm)' }}>Delete</button>
        </div>
      )}

    </div>
  );
}