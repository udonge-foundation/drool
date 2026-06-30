import { COLORS } from '@/components/chat/themedColors';
import { getTerminalTheme } from '@/utils/terminalTheme';
import { TerminalTheme } from '@/utils/terminalTheme/enums';

function darkenHex(hex: string, amount: number): string {
  const normalized = hex.startsWith('#') ? hex.slice(1) : hex;
  if (normalized.length !== 6) return hex;

  const clamp01 = (n: number) => Math.min(1, Math.max(0, n));
  const a = clamp01(amount);

  const r = parseInt(normalized.slice(0, 2), 16);
  const g = parseInt(normalized.slice(2, 4), 16);
  const b = parseInt(normalized.slice(4, 6), 16);

  if ([r, g, b].some((v) => Number.isNaN(v))) return hex;

  const darkenChannel = (v: number) => Math.round(v * (1 - a));
  const toHex = (v: number) => v.toString(16).padStart(2, '0');

  return `#${toHex(darkenChannel(r))}${toHex(darkenChannel(g))}${toHex(
    darkenChannel(b)
  )}`;
}

export function getAutonomyIndicatorColor(): string {
  return getTerminalTheme() === TerminalTheme.Light
    ? darkenHex(COLORS.highlight, 0.15)
    : COLORS.highlight;
}
