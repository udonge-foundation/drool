import fs from 'fs';
import path from 'path';

import { Box, Text } from 'ink';
import { parse as parseJsonc, type ParseError } from 'jsonc-parser';
import { type ReactNode, useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { getIndustryHome } from '@industry/utils/cli';
import { getIndustryDirName } from '@industry/utils/environment';
import { findGitRoot } from '@industry/utils/shell/node';

import {
  DROOL_HEADER_LOGO,
  DROOL_HEADER_LOGO_MINI,
  HEADER_TOOLTIPS,
  HEADER_TOOLTIP_WEIGHTS,
  DEFAULTS,
} from '@/components/chat/constants';
import { COLORS } from '@/components/chat/themedColors';
import { getRuntimeAuthConfig } from '@/environment';
import { useMountEffect } from '@/hooks/useMountEffect';
import { CHANGELOG_PAGE_URL } from '@/services/changelog/constants';
import type { ChangelogEntry } from '@/services/changelog/types';
import {
  getChangelog,
  hasChangelogCache,
  isChangelogDismissed,
} from '@/services/ChangelogService';
import {
  findMcpConfigParseErrorSync,
  getUserAndProjectMcpConfigPaths,
} from '@/services/mcp/mcpConfigDiagnostics';
import {
  displayWidth as getDisplayWidth,
  sliceByDisplayWidth,
} from '@/utils/displayWidth';
import { hasAgentsMdGuidelines } from '@/utils/industryPaths';
import {
  getReadinessHintSync,
  markReadinessHintAsShown,
} from '@/utils/getReadinessHint';
import {
  L1_HINT_COPY,
  NO_REPORT_HINT_COPY,
} from '@/utils/getReadinessHint/constants';
import { makeHyperlink } from '@/utils/hyperlinks';

// ===========================================================================
// Header
// ===========================================================================

type CellStyle =
  | 'empty'
  | 'logo'
  | 'dim'
  | 'dim-bold'
  | 'italic'
  | 'box-label'
  | 'dev-tag'
  | 'status-ok'
  | 'status-fail';

interface StyledCell {
  char: string;
  style: CellStyle;
}

const LEFT_MARGIN = 2;

/** Minimum terminal width to show the changelog column. */
const CHANGELOG_MIN_WIDTH = 100;

/** Minimum available width to use the full block-letter logo instead of mini. */
const FULL_LOGO_MIN_WIDTH = 58;

/** Probability the readiness hint replaces the random tooltip when one is available; keeps the regular rotation visible too. */
const READINESS_HINT_REPLACEMENT_PROBABILITY = 0.5;

function getAirgapVersionSuffix(): string {
  try {
    return getRuntimeAuthConfig().airgapEnabled ? ' - Airgap' : '';
  } catch {
    // Runtime auth config may not be initialized in some test contexts.
    return '';
  }
}

function getRandomTooltip(): string {
  const totalWeight = HEADER_TOOLTIPS.reduce(
    (sum, tip) => sum + (HEADER_TOOLTIP_WEIGHTS[tip] ?? 1),
    0
  );
  let r = Math.random() * totalWeight;
  for (const tip of HEADER_TOOLTIPS) {
    r -= HEADER_TOOLTIP_WEIGHTS[tip] ?? 1;
    if (r < 0) return tip;
  }
  return HEADER_TOOLTIPS[HEADER_TOOLTIPS.length - 1];
}

function countSkillsInDir(dir: string, depth = 0): number {
  if (depth > 3) return 0;
  let count = 0;
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const skillMd = path.join(dir, entry.name, 'SKILL.md');
      try {
        if (fs.existsSync(skillMd)) {
          count++;
        } else {
          count += countSkillsInDir(path.join(dir, entry.name), depth + 1);
        }
      } catch {
        // ignore
      }
    }
  } catch {
    // directory doesn't exist
  }
  return count;
}

function getSkillsCount(gitRoot: string | null): number {
  const dirs = new Set<string>();
  const home = getIndustryHome();
  const projectRoot = gitRoot ?? process.cwd();
  // User-level skills (respects INDUSTRY_HOME_OVERRIDE)
  dirs.add(path.join(home, getIndustryDirName(), 'skills'));
  // Project-level skills always use .industry (never .industry-dev)
  dirs.add(path.join(projectRoot, '.industry', 'skills'));
  // Personal/global skills from .agent and .agents directories
  dirs.add(path.join(home, '.agent', 'skills'));
  dirs.add(path.join(home, '.agents', 'skills'));
  dirs.add(path.join(projectRoot, '.agent', 'skills'));
  dirs.add(path.join(projectRoot, '.agents', 'skills'));
  let count = 0;
  for (const dir of dirs) {
    count += countSkillsInDir(dir);
  }
  return count;
}

function getMcpInfo(gitRoot: string | null): {
  count: number;
  hasError: boolean;
} {
  const mcpFiles = new Set(getUserAndProjectMcpConfigPaths(gitRoot));
  const names = new Set<string>();
  let hasError = false;
  for (const file of mcpFiles) {
    if (findMcpConfigParseErrorSync(file)) {
      hasError = true;
      continue;
    }
    if (!fs.existsSync(file)) continue;

    const raw = fs.readFileSync(file, 'utf-8');
    const errors: ParseError[] = [];
    const content = parseJsonc(raw, errors) as Record<string, unknown>;
    if (errors.length > 0) {
      hasError = true;
      continue;
    }
    const servers = content.mcpServers;
    if (servers && typeof servers === 'object' && !Array.isArray(servers)) {
      for (const name of Object.keys(servers as Record<string, unknown>)) {
        names.add(name);
      }
    }
  }
  return { count: names.size, hasError };
}

function createGrid(width: number, height: number): StyledCell[][] {
  return Array.from({ length: height }, () =>
    Array.from(
      { length: width },
      (): StyledCell => ({ char: ' ', style: 'empty' })
    )
  );
}

function drawText(
  grid: StyledCell[][],
  row: number,
  col: number,
  text: string,
  style: CellStyle
): void {
  if (row < 0 || row >= grid.length) return;
  let c = col;
  for (const char of text) {
    if (c >= grid[row].length) break;
    const w = getDisplayWidth(char);
    if (c >= 0) {
      grid[row][c] = { char, style };
      for (let j = 1; j < w && c + j < grid[row].length; j++) {
        grid[row][c + j] = { char: '', style };
      }
    }
    c += w;
  }
}

interface TextProps {
  color?: string;
  bold: boolean;
  italic: boolean;
}

function getTextProps(style: CellStyle): TextProps {
  const CELL_STYLE_PROPS: Record<CellStyle, TextProps> = {
    empty: { color: undefined, bold: false, italic: false },
    logo: { color: COLORS.headerLogo, bold: true, italic: false },
    dim: { color: COLORS.text.secondary, bold: false, italic: false },
    'dim-bold': { color: COLORS.text.secondary, bold: true, italic: false },
    italic: { color: COLORS.text.secondary, bold: false, italic: true },
    'box-label': { color: COLORS.text.primary, bold: true, italic: false },
    'dev-tag': { color: COLORS.asciiArt, bold: true, italic: false },
    'status-ok': { color: COLORS.statusActive, bold: false, italic: false },
    'status-fail': { color: COLORS.error, bold: false, italic: false },
  };
  return CELL_STYLE_PROPS[style];
}

function renderGrid(grid: StyledCell[][]): ReactNode[] {
  return grid.map((row, rowIdx) => {
    const segments: ReactNode[] = [];
    let currentStyle: CellStyle = 'empty';
    let currentText = '';
    let segIdx = 0;

    const flush = () => {
      if (!currentText) return;
      const props = getTextProps(currentStyle);
      segments.push(
        <Text key={segIdx++} {...props}>
          {currentText}
        </Text>
      );
      currentText = '';
    };

    for (const cell of row) {
      if (cell.style !== currentStyle) {
        flush();
        currentStyle = cell.style;
      }
      currentText += cell.char;
    }
    flush();

    return <Text key={rowIdx}>{segments}</Text>;
  });
}

/** Max number of feature bullets shown in the changelog column. */
const CHANGELOG_MAX_FEATURES = 5;

/** Max lines the "New features" section (header + bullets) may occupy. */
const CHANGELOG_MAX_FEATURE_LINES = 10;

function estimateWrappedLines(text: string, width: number): number {
  if (width <= 0) return 1;
  return Math.ceil((text.length + 2) / width); // +2 for "• " prefix
}

function shouldTruncateLastFeature(
  features: string[],
  columnWidth: number
): boolean {
  // 1 line for "New features" header + lines for each bullet
  let totalLines = 1;
  for (const feature of features) {
    totalLines += estimateWrappedLines(feature, columnWidth);
  }
  return totalLines > CHANGELOG_MAX_FEATURE_LINES;
}

function ChangelogColumn({
  changelog,
  columnWidth,
  t,
}: {
  changelog: ChangelogEntry;
  columnWidth: number;
  t: (key: string) => string;
}) {
  const changelogLink = makeHyperlink('Changelog', CHANGELOG_PAGE_URL);
  const seeMoreLink = makeHyperlink('See more →', CHANGELOG_PAGE_URL);
  const features = changelog.features.slice(0, CHANGELOG_MAX_FEATURES);
  const truncateLast = shouldTruncateLastFeature(features, columnWidth);

  return (
    <Box flexDirection="column" width={columnWidth} paddingTop={1}>
      <Box justifyContent="space-between" width={columnWidth}>
        <Text>
          <Text bold color={COLORS.asciiArt}>
            {changelogLink}
          </Text>
          <Text bold color={COLORS.text.primary}>
            {' '}
            {process.env.CLI_VERSION
              ? `v${process.env.CLI_VERSION}`
              : changelog.version}
            {getAirgapVersionSuffix()}
          </Text>
        </Text>
        <Text dimColor>{t('header.dismissChangelog')}</Text>
      </Box>
      <Text> </Text>
      <Text bold color={COLORS.asciiArt}>
        {t('header.newFeatures')}
      </Text>
      {features.map((feature, i) => {
        const isLast = i === features.length - 1;
        const wrapMode = isLast && truncateLast ? 'truncate' : 'wrap';
        const dashIdx = feature.indexOf(' - ');
        if (dashIdx >= 0) {
          const title = feature.slice(0, dashIdx);
          const desc = feature.slice(dashIdx);
          return (
            <Text key={i} wrap={wrapMode} color={COLORS.text.secondary}>
              <Text bold color={COLORS.text.primary}>
                {'• '}
                {title}
              </Text>
              {desc}
            </Text>
          );
        }
        return (
          <Text key={i} wrap={wrapMode} bold color={COLORS.text.primary}>
            {'• '}
            {feature}
          </Text>
        );
      })}
      <Text> </Text>
      <Box justifyContent="center" width={columnWidth}>
        <Text>
          <Text bold color={COLORS.asciiArt}>
            {seeMoreLink}
          </Text>
          <Text dimColor> {t('header.cmdClickHint')}</Text>
        </Text>
      </Box>
    </Box>
  );
}

function HeaderContent({ width }: { width: number }) {
  const { t } = useTranslation('common');

  const headerData = useMemo(() => {
    const gitRoot = findGitRoot(process.cwd());
    const skillsCount = getSkillsCount(gitRoot);
    const mcpInfo = getMcpInfo(gitRoot);
    const agentsMd = hasAgentsMdGuidelines();
    return { skillsCount, mcpInfo, agentsMd };
  }, []);

  // Header mounts inside Ink's `<Static>` which paints once and discards subsequent updates, so we MUST resolve the tooltip synchronously on first render.
  const { tooltip, surfacedHint } = useMemo(() => {
    const hint = getReadinessHintSync();
    const replaceWithReadinessHint =
      hint !== null && Math.random() < READINESS_HINT_REPLACEMENT_PROBABILITY;
    if (!replaceWithReadinessHint) {
      return { tooltip: getRandomTooltip(), surfacedHint: null };
    }
    if (hint.kind === 'gap') {
      const copy =
        L1_HINT_COPY[hint.criterionId as keyof typeof L1_HINT_COPY] ?? null;
      // Defensive fallback when copy is missing for a newly-added criterion.
      if (copy === null) {
        return { tooltip: getRandomTooltip(), surfacedHint: null };
      }
      return { tooltip: copy, surfacedHint: hint };
    }
    return { tooltip: NO_REPORT_HINT_COPY, surfacedHint: hint };
  }, []);

  // Mark only the hint committed during first render so a skipped (gate-rolled-out) hint stays eligible for a future launch.
  useMountEffect(() => {
    if (surfacedHint !== null) {
      markReadinessHintAsShown(surfacedHint);
    }
  });

  const changelog = getChangelog();
  const showChangelog = width >= CHANGELOG_MIN_WIDTH && changelog !== null;

  const leftColWidth = showChangelog ? Math.floor(width * 0.55) : width;
  const rightColWidth = showChangelog ? width - leftColWidth : 0;

  // Logo
  const logoLines =
    leftColWidth >= FULL_LOGO_MIN_WIDTH
      ? DROOL_HEADER_LOGO
      : DROOL_HEADER_LOGO_MINI;
  const isDev = process.env.INDUSTRY_ENV !== 'production';
  // logo + gap + [DEV] + TIP + gap + 2 shortcut lines + gap + status
  const showVersion = !showChangelog && !!process.env.CLI_VERSION;
  const contentRows =
    logoLines.length + 2 + (isDev ? 1 : 0) + (showVersion ? 2 : 0) + 5;
  const gridHeight = contentRows;

  const grid = createGrid(leftColWidth, gridHeight);

  // Center logo in left column
  const centerIn = (text: string): number =>
    Math.max(0, Math.floor((leftColWidth - getDisplayWidth(text)) / 2));

  const logoRow = 0;
  const logoWidth = Math.max(...logoLines.map((line) => getDisplayWidth(line)));
  const logoCol = Math.max(0, Math.floor((leftColWidth - logoWidth) / 2));

  for (let r = 0; r < logoLines.length; r++) {
    drawText(grid, logoRow + r, logoCol, logoLines[r], 'logo');
  }

  const centerUnderLogo = (text: string): number =>
    logoCol + Math.max(0, Math.floor((logoWidth - getDisplayWidth(text)) / 2));

  let nextRow = logoRow + logoLines.length + 1;

  if (isDev) {
    const devText = t('header.devIndicator');
    drawText(grid, nextRow, centerUnderLogo(devText), devText, 'dev-tag');
    nextRow++;
  }

  if (!showChangelog && process.env.CLI_VERSION) {
    const versionText = `v${process.env.CLI_VERSION}${getAirgapVersionSuffix()}`;

    // Show changelog hint next to the version number when changelog is hidden
    if (
      width >= CHANGELOG_MIN_WIDTH &&
      isChangelogDismissed() &&
      hasChangelogCache()
    ) {
      const hintText = ` (${t('header.viewChangelog')})`;
      const fullText = `${versionText}${hintText}`;
      const fullCol = centerUnderLogo(fullText);
      drawText(grid, nextRow, fullCol, versionText, 'dim-bold');
      drawText(
        grid,
        nextRow,
        fullCol + getDisplayWidth(versionText),
        hintText,
        'dim'
      );
    } else {
      const versionCol = centerUnderLogo(versionText);
      drawText(grid, nextRow, versionCol, versionText, 'dim-bold');
    }

    nextRow += 2;
  }

  const tipText = `${t('header.tip')} ${tooltip}`;
  const maxTipLen = leftColWidth - LEFT_MARGIN * 2;
  const tipDisplay =
    getDisplayWidth(tipText) > maxTipLen
      ? `${sliceByDisplayWidth(tipText, maxTipLen - 1).slice}…`
      : tipText;
  drawText(grid, nextRow, centerIn(tipDisplay), tipDisplay, 'box-label');
  nextRow += 2;

  const shortcutsLine1 = t('header.shortcutsLine1');
  drawText(grid, nextRow, centerIn(shortcutsLine1), shortcutsLine1, 'dim');
  nextRow++;
  const shortcutsLine2 = t('header.shortcutsLine2');
  drawText(grid, nextRow, centerIn(shortcutsLine2), shortcutsLine2, 'dim');
  nextRow += 2;

  // Status line: Skills (N) ✓  MCPs (N) ✓  AGENTS.md ✓
  const skillsLabel = `${t('header.skillsLabel')} (${headerData.skillsCount})`;
  const mcpLabel = headerData.mcpInfo.hasError
    ? `${t('header.mcpsLabel')} (!)`
    : `${t('header.mcpsLabel')} (${headerData.mcpInfo.count})`;
  const agentsLabel = t('header.agentsMdLabel');
  const checkMark = ' ✓';
  const crossMark = ' ✗';
  const mcpIndicator =
    headerData.mcpInfo.hasError || headerData.mcpInfo.count === 0
      ? crossMark
      : checkMark;
  const statusText = `${skillsLabel}${checkMark}  ${mcpLabel}${mcpIndicator}  ${agentsLabel}${checkMark}`;
  const statusCol = centerIn(statusText);

  // Draw each segment with its color
  let col = statusCol;
  drawText(grid, nextRow, col, skillsLabel, 'dim-bold');
  col += getDisplayWidth(skillsLabel);
  const skillsIndicator = headerData.skillsCount > 0 ? checkMark : crossMark;
  drawText(
    grid,
    nextRow,
    col,
    skillsIndicator,
    headerData.skillsCount > 0 ? 'status-ok' : 'status-fail'
  );
  col += getDisplayWidth(skillsIndicator) + 2;
  drawText(
    grid,
    nextRow,
    col,
    mcpLabel,
    headerData.mcpInfo.hasError ? 'status-fail' : 'dim-bold'
  );
  col += getDisplayWidth(mcpLabel);
  drawText(
    grid,
    nextRow,
    col,
    mcpIndicator,
    headerData.mcpInfo.hasError || headerData.mcpInfo.count === 0
      ? 'status-fail'
      : 'status-ok'
  );
  col += getDisplayWidth(mcpIndicator) + 2;
  drawText(grid, nextRow, col, agentsLabel, 'dim-bold');
  col += getDisplayWidth(agentsLabel);
  const agentsIndicator = headerData.agentsMd ? checkMark : crossMark;
  drawText(
    grid,
    nextRow,
    col,
    agentsIndicator,
    headerData.agentsMd ? 'status-ok' : 'status-fail'
  );

  const gridLines = renderGrid(grid);

  return (
    <Box width={width} flexDirection="row" marginTop={2} marginBottom={1}>
      <Box flexDirection="column" width={leftColWidth} justifyContent="center">
        {gridLines}
      </Box>
      {showChangelog && changelog && (
        <>
          <Box
            flexDirection="column"
            paddingTop={1}
            marginRight={1}
            borderStyle="single"
            borderLeft
            borderRight={false}
            borderTop={false}
            borderBottom={false}
            borderColor={COLORS.asciiArt}
          />
          <ChangelogColumn
            changelog={changelog}
            columnWidth={rightColWidth - 3}
            t={t}
          />
        </>
      )}
    </Box>
  );
}

// ===========================================================================
// Exported Header
// ===========================================================================

export function Header({
  width = DEFAULTS.VIEWPORT_WIDTH,
}: {
  width?: number;
}) {
  return <HeaderContent width={width} />;
}
