// src/types.ts

export type MacroType = 'menuCommand' | 'expression' | 'script' | 'sequence' | 'ffx';

export interface Macro {
  id: string;
  /** Shared across linked duplicates (buttons copied into other profiles with
   * "Link"). Edits to shared fields propagate to every macro with the same
   * `linkId`. `undefined` = standalone / independent copy. */
  linkId?: string;
  label: string;
  type: MacroType;
  payload: string;
  color: string;
  icon?: string;
  /** Keyboard shortcut (e.g. "Alt+S"). Only fires when the panel has focus. */
  hotkey?: string;
  /** Searchable tags for the Command Palette. */
  tags?: string[];
  /** Human-readable menu command name for stable cross-version lookup. */
  menuCommandName?: string;
}

/** A sequence macro's payload is JSON-stringified SequencePayload. */
export interface SequencePayload {
  steps: { macroId: string }[];
  delayMs?: number;
}

export type ProfileContext =
  | 'none'
  | 'textLayer'
  | 'shapeLayer'
  | 'cameraLayer'
  | 'lightLayer'
  | 'nullLayer'
  | 'solidLayer'
  | 'precomp'
  | 'footageLayer'
  | 'mixed';

export interface Profile {
  id: string;
  name: string;
  autoTriggerContext: ProfileContext;
  macros: Macro[];
}

export interface BezierPoint {
  x: number;
  y: number;
}

/** Origin of an imported/saved easing preset. Used purely for UI badges and
 * filtering — execution is identical for all sources. `undefined` is treated
 * as 'user' (legacy entries saved before this field existed). */
export type EaseSource = 'flow' | 'mt' | 'user';

export interface CustomEase {
  name: string;
  p1: BezierPoint;
  p2: BezierPoint;
  source?: EaseSource;
}

export interface EasingProfile {
  id: string;
  name: string;
  eases: CustomEase[];
}

export interface Settings {
  buttonSize: number;
  bezierButtonSize?: number;
  spacing: number;
  enableContext: boolean;
  /** @deprecated Reads still work for one release; writes go through
   * `easingProfiles`. Migrated into a default profile on first load. */
  customEases: CustomEase[];
  /** Named groups of custom easings. The active group is shown in the easing
   * panel; users can add / rename / delete / duplicate them. */
  easingProfiles?: EasingProfile[];
  activeEasingProfileId?: string;
  /** Persisted source-filter selection in the easing library
   * (`'all' | 'builtin' | 'user' | 'flow' | 'mt'`). */
  easingSourceFilter?: 'all' | 'builtin' | 'user' | 'flow' | 'mt';
  /** Persisted height (px) of the easing canvas region above the resizer. */
  easingTopHeight?: number;
  lastOverrideProfileId?: string | null;
  /** If true, clicking a preset in the easing editor also applies it. */
  easingClickToApply?: boolean;
  /** If true, show a live preview dot animating along the bezier curve. */
  showCurvePreview?: boolean;
  /** Enable the Command Palette (Ctrl+Space). Off by default. */
  enableCommandPalette?: boolean;
  /** Custom hotkey for the Command Palette. Defaults to "Ctrl+Space". */
  commandPaletteHotkey?: string;
  /** When true, the macros panel ignores Edit-mode toggling. */
  lockMacros?: boolean;
  /** Size of the per-panel undo ring buffer. Defaults to 10. */
  undoHistorySize?: number;
}

export interface AppData {
  activeProfileId: string;
  settings: Settings;
  profiles: Profile[];
}
