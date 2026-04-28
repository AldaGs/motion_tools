// src/utils/easingImport.ts
//
// Unified easing-library import. Sniffs the file shape and stamps each
// imported ease with its `source` so the UI can badge/filter it later.
//
// Supported shapes:
//   - Flow                 (Inductions): top-level JSON array of
//                          `{ name, value: [x1,y1,x2,y2] }`.
//   - Motion Toolbar pack: `{ kind: 'motion-toolbar/easing', version: 1,
//                            customEases: [{ name, p1, p2, source? }, ...] }`
//
// Returns the parsed eases (with `source` set), the detected format, or an
// error string suitable for surfacing as a toast.

import type { CustomEase, EaseSource } from '../types';

export type ImportFormat = 'flow' | 'mt';

export interface EasingImportSuccess {
  ok: true;
  format: ImportFormat;
  eases: CustomEase[];
}
export interface EasingImportFailure {
  ok: false;
  error: string;
}
export type EasingImportResult = EasingImportSuccess | EasingImportFailure;

const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && isFinite(v);

const stampSource = (eases: Omit<CustomEase, 'source'>[], source: EaseSource): CustomEase[] =>
  eases.map((e) => ({ ...e, source }));

const parseFlow = (raw: unknown[]): CustomEase[] => {
  const out: CustomEase[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const it = item as any;
    if (typeof it.name !== 'string') continue;
    if (!Array.isArray(it.value) || it.value.length !== 4) continue;
    const [x1, y1, x2, y2] = it.value.map(Number);
    if (![x1, y1, x2, y2].every(isFiniteNumber)) continue;
    out.push({
      name: it.name,
      p1: { x: x1, y: y1 },
      p2: { x: x2, y: y2 },
      source: 'flow',
    });
  }
  return out;
};

const parseMt = (raw: any): CustomEase[] => {
  // Multi-profile MT pack: { profiles: [{ id, name, eases: [...] }, ...] }.
  // Flatten into a single list — the importer drops everything into the
  // currently active easing profile. Users can split after if they want.
  if (Array.isArray(raw?.profiles)) {
    const out: CustomEase[] = [];
    for (const prof of raw.profiles) {
      if (!Array.isArray(prof?.eases)) continue;
      out.push(...parseMt({ customEases: prof.eases }));
    }
    return out;
  }
  const list = Array.isArray(raw?.customEases) ? raw.customEases : [];
  const out: CustomEase[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    if (typeof item.name !== 'string') continue;
    const p1 = item.p1, p2 = item.p2;
    if (!p1 || !p2) continue;
    if (![p1.x, p1.y, p2.x, p2.y].every(isFiniteNumber)) continue;
    out.push({
      name: item.name,
      p1: { x: p1.x, y: p1.y },
      p2: { x: p2.x, y: p2.y },
      // Preserve the original source if the pack tagged it (e.g. an MT
      // export that originally came from Flow), otherwise default to 'mt'.
      source: (item.source === 'flow' || item.source === 'user') ? item.source : 'mt',
    });
  }
  return out;
};

export function parseEasingFile(text: string): EasingImportResult {
  let parsed: any;
  try { parsed = JSON.parse(text); }
  catch { return { ok: false, error: "File is not valid JSON." }; }

  // Sniff shape.
  if (Array.isArray(parsed)) {
    const eases = parseFlow(parsed);
    if (eases.length === 0) return { ok: false, error: "Flow file contained no recognisable easing entries." };
    return { ok: true, format: 'flow', eases };
  }
  if (parsed && typeof parsed === 'object') {
    if (parsed.kind === 'motion-toolbar/easing') {
      const eases = parseMt(parsed);
      if (eases.length === 0) return { ok: false, error: "Motion Toolbar easing pack contained no valid entries." };
      return { ok: true, format: 'mt', eases };
    }
    // Tolerant fallback: object with a customEases array but no kind tag.
    if (Array.isArray(parsed.customEases)) {
      const eases = parseMt(parsed);
      if (eases.length > 0) return { ok: true, format: 'mt', eases };
    }
  }
  return { ok: false, error: "Unrecognised easing file format. Expected a Flow library or a Motion Toolbar easing pack." };
}

/** Merges incoming eases into an existing list, deduplicating by name with
 * an auto " (n)" suffix. Reserved names (default presets) are also avoided. */
export function mergeEasesUnique(
  incoming: CustomEase[],
  existing: CustomEase[],
  reservedNames: ReadonlyArray<string> = [],
): CustomEase[] {
  const taken = new Set<string>([...reservedNames, ...existing.map((e) => e.name)]);
  const out: CustomEase[] = [];
  for (const e of incoming) {
    let name = e.name;
    let n = 1;
    while (taken.has(name)) name = `${e.name} (${n++})`;
    taken.add(name);
    out.push({ ...e, name });
  }
  return out;
}

// Re-export so callers don't have to import the same value twice.
export { stampSource };
