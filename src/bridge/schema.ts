// MTAG Switch — wire schema. Bumped in unison with breaking changes.
export const SCHEMA_VERSION = 1 as const;

export type PeerKind = 'ai' | 'ae' | 'ps' | 'color';

export type MessageType =
  | 'hello'
  | 'ack'
  | 'ping'
  | 'pong'
  | 'artwork.send'
  | 'artwork.update'
  | 'color.push'
  | 'error';

export interface Envelope<T = unknown> {
  v: typeof SCHEMA_VERSION;
  id: string;
  ts: number;
  from: PeerKind;
  type: MessageType;
  payload: T;
}

export interface HelloPayload {
  kind: PeerKind;
  clientVersion: string;
  capabilities: string[];
}

export interface AckPayload {
  refId: string;
  ok: boolean;
  error?: string;
}

// Minimal artwork stub for the POC. Full shape lives in schema/payload.ts
// once the AI/AE adapters land in Stage 2.
export interface ArtworkStubPayload {
  note: string;
  itemCount: number;
}

// Stage 2+3 payload: path geometry + appearance (fills, strokes, gradients,
// opacity, blend mode).
export interface SubPath {
  closed: boolean;
  vertices: [number, number][];
  inTangents: [number, number][];
  outTangents: [number, number][];
}

export type BlendMode =
  | 'normal' | 'multiply' | 'screen' | 'overlay' | 'darken' | 'lighten'
  | 'colorDodge' | 'colorBurn' | 'hardLight' | 'softLight'
  | 'difference' | 'exclusion' | 'hue' | 'saturation' | 'color' | 'luminosity';

export interface SolidFill {
  kind: 'solid';
  rgba: [number, number, number, number];
}

export interface GradientStop {
  offset: number;                               // 0..1 along the ramp
  rgba: [number, number, number, number];
  midpoint?: number;                            // 0..1, position of the color
                                                // midpoint toward the next stop
                                                // (AE scripting can't set this —
                                                // carried for round-trip only)
}
export interface GradientPaint {
  kind: 'gradient';
  type: 'linear' | 'radial';
  stops: GradientStop[];
  // Endpoints already resolved into layer/pixel space by the exporter, so the
  // importer just applies them — no angle/length math duplicated host-side.
  start: [number, number];
  end: [number, number];
}

export type Paint = SolidFill | GradientPaint;

export interface Stroke {
  paint: Paint;
  width: number;                                // px
  cap: 'butt' | 'round' | 'square';
  join: 'miter' | 'round' | 'bevel';
  miterLimit: number;
  dashes?: number[];                            // [dash, gap, dash, gap, …] px
  dashOffset?: number;
}

export interface PathItem {
  kind: 'path';
  name: string;
  bbox: { x: number; y: number; w: number; h: number };
  opacity: number;                              // 0..1 (object-level)
  blendMode: BlendMode;
  geometry: { subpaths: SubPath[]; fillRule: 'nonzero' | 'even-odd' };
  appearance: { fills: Paint[]; strokes: Stroke[] };
}

// One run of same-styled characters within a text item. `font`/`fontSize` are
// the top-level dominant run; `runs` carries the full breakdown for multi-style
// text (applied per-character on import when AE supports CharacterRange).
export interface TextRun {
  text: string;
  font: string;
  fontSize: number;
  fillRgba?: [number, number, number, number] | null;
}

export interface TextItem {
  kind: 'text';
  name: string;
  text: string;
  font: string;                                 // dominant run
  fontSize: number;                             // dominant run
  justification: 'left' | 'center' | 'right';
  textKind?: 'point' | 'area' | 'path';
  boxSize?: [number, number] | null;            // area-text box dimensions (px)
  runs?: TextRun[] | null;                      // present only for multi-style
  bbox: { x: number; y: number; w: number; h: number };
  aiAnchor?: [number, number];
  opacity: number;                              // 0..1 (object-level)
  blendMode: BlendMode;
  appearance: { fills: Paint[]; strokes: Stroke[] };
}

// Placed (linked) or rasterized/embedded Illustrator image. The exporter
// resolves it to a file on disk — `sourcePath` — that the AE side imports as
// footage. `linked` distinguishes a referenced source file (PlacedItem) from a
// temp PNG extracted from an embedded raster.
export interface ImageItem {
  kind: 'image';
  name: string;
  bbox: { x: number; y: number; w: number; h: number };
  sourcePath: string;
  linked: boolean;
  opacity: number;                              // 0..1 (object-level)
  blendMode: BlendMode;
}

// A group node preserves AI group nesting. `clip` (when present) is the
// clipping path of a clipping group — on import it masks the group's contents.
// children may themselves be groups (arbitrary nesting).
export interface GroupItem {
  kind: 'group';
  name: string;
  opacity: number;                              // 0..1 (object-level)
  blendMode: BlendMode;
  clip?: SubPath[] | null;
  children: AnyItem[];
}

export type AnyItem = PathItem | TextItem | ImageItem | GroupItem;

export interface ArtworkPayload {
  origin: {
    ref: 'artboard' | 'selection-bbox' | 'ruler' | 'comp-center';
    sourceX: number;
    sourceY: number;
    sourceUnit: 'px' | 'pt';
    artboardWidth?: number;
    artboardHeight?: number;
  };
  options?: {
    grouped: boolean;
    centerAnchor: boolean;
  };
  // Names/types of selected objects the exporter couldn't handle (e.g. mesh,
  // symbol, graph). Surfaced in the panel log so drops aren't silent.
  skipped?: string[];
  items: AnyItem[];
}

export type AnyEnvelope =
  | Envelope<HelloPayload>
  | Envelope<AckPayload>
  | Envelope<ArtworkStubPayload>
  | Envelope<Record<string, unknown>>;
