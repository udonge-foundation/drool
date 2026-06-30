import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { join } from 'node:path';

import { renderMermaidSVG } from 'beautiful-mermaid';

import { getIndustryHome } from '@industry/utils/cli';
import { getIndustryDirName } from '@industry/utils/environment';

import { getThemedColors } from '@/components/chat/themedColors';

function getSvgTheme() {
  const colors = getThemedColors();
  return {
    bg: colors.text.userBg,
    fg: colors.text.primary,
    accent: colors.primary,
    muted: colors.text.muted,
    surface: colors.text.userBg,
    border: colors.border,
    line: colors.text.muted,
    font: '-apple-system, BlinkMacSystemFont, Segoe UI, Roboto, sans-serif',
  };
}

function getMermaidDir(): string {
  return join(getIndustryHome(), getIndustryDirName(), 'mermaid');
}

function getHashPrefix(source: string): string {
  return createHash('sha256').update(source).digest('hex').slice(0, 12);
}

export function sanitizeMermaidSource(source: string): string {
  return source.replace(/\/\//g, '%%');
}

export function writeMermaidImage(source: string): string | null {
  const hash = getHashPrefix(source);
  const mermaidDir = getMermaidDir();
  const svgPath = join(mermaidDir, `${hash}.svg`);

  if (fs.existsSync(svgPath) && fs.statSync(svgPath).size > 0) {
    return svgPath;
  }

  try {
    const svg = renderMermaidSVG(sanitizeMermaidSource(source), getSvgTheme());
    fs.mkdirSync(mermaidDir, { recursive: true });
    fs.writeFileSync(svgPath, svg, 'utf-8');
    return svgPath;
  } catch {
    return null;
  }
}

export function buildMermaidViewerUrl(source: string): string | null {
  const localPath = writeMermaidImage(source);
  if (localPath) return `file://${localPath}`;
  return null;
}
