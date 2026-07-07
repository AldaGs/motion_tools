// Builds the "Copy as…" context-menu items shared by the Wheel and Palette
// swatches: HEX, rgb(), hsl(), and the 0–1 normalized RGB triple AE
// expressions want. Kept in one place so both menus stay in sync.

import type { ContextMenuItem } from '../components/ContextMenu';
import { formatRgb, formatHsl, formatAeRgb } from './color';
import { copyText } from './clipboard';
import { toast } from './toast';

const doCopy = async (label: string, value: string) => {
  if (await copyText(value)) toast.success(`Copied ${label}`);
  else toast.error('Clipboard unavailable.');
};

// `firstDivider` puts a separator above the first item (to group it under a
// preceding action).
export const copyFormatItems = (hex: string, firstDivider = false): ContextMenuItem[] => [
  { id: 'copy-hex', icon: '⧉', label: `Copy ${hex}`, divider: firstDivider, onSelect: () => doCopy(hex, hex) },
  { id: 'copy-rgb', icon: '⧉', label: `Copy ${formatRgb(hex)}`, onSelect: () => doCopy('RGB', formatRgb(hex)) },
  { id: 'copy-hsl', icon: '⧉', label: `Copy ${formatHsl(hex)}`, onSelect: () => doCopy('HSL', formatHsl(hex)) },
  { id: 'copy-ae', icon: '⧉', label: `Copy AE ${formatAeRgb(hex)}`, onSelect: () => doCopy('AE 0–1 RGB', formatAeRgb(hex)) },
];
