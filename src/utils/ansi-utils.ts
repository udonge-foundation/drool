import chalk from 'chalk';

import { ansiDisplayWidth } from '@/utils/displayWidth';

/**
 * Pad an ANSI-styled string with spaces to reach a target visible width,
 * then apply a background color to the padding.
 */
export function padToWidth(
  ansiStr: string,
  targetWidth: number,
  bgColor: string | undefined
): string {
  if (!bgColor || targetWidth <= 0) return ansiStr;
  const visibleLen = ansiDisplayWidth(ansiStr);
  if (visibleLen >= targetWidth) return ansiStr;
  const padding = ' '.repeat(targetWidth - visibleLen);
  return ansiStr + chalk.bgHex(bgColor)(padding);
}
