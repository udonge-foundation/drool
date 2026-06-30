import { Box, Text } from 'ink';
import { useTranslation } from 'react-i18next';

import {
  AutonomyLevel,
  DroolInteractionMode,
} from '@industry/drool-sdk-ext/protocol/shared';

import { COLORS } from '@/components/chat/themedColors';
import { SupportedLocale } from '@/i18n/enums';
import { displayWidth as getDisplayWidth } from '@/utils/displayWidth';
import { isWindowsLike } from '@/utils/isWsl';

import type React from 'react';

interface HelpPopupProps {
  interactionMode?: DroolInteractionMode;
  autonomyLevel?: AutonomyLevel;
  width?: number;
  height?: number;
}

const isWindows = isWindowsLike();

const SHORTCUTS_MIN_WIDTH = 56;
const WIDE_THRESHOLD = 110;

// Wide-mode height thresholds (two-column layout).
// Left column line counts:
//   Basics ~10, Shortcuts ~10, Navigation ~6, Modes ~6, Autonomy ~7
// Right column line counts:
//   Guide full ~23, Guide compact ~14, Recommended Models ~8, Tips ~9
const WIDE_SHOW_TIPS = 50;
const WIDE_SHOW_WORKFLOW = 40;
const WIDE_MOVE_AUTONOMY = 38;
const WIDE_COMPACT_GUIDE = 35;
const WIDE_HIDE_NAV = 28;
const WIDE_MOVE_BOTH = 25;
const WIDE_MINIMAL = 20;

// Narrow-mode height thresholds (single-column layout).
// In narrow mode everything stacks vertically, so the total height is much
// larger than in the two-column wide layout.  ShortcutsPanel alone is ~39
// lines, so guide/tips/workflow need significantly higher thresholds.
const NARROW_HIDE_AUTONOMY = 38;
const NARROW_HIDE_MODES = 30;
const NARROW_HIDE_NAVIGATION = 24;
const NARROW_SHOW_GUIDE = 55;
const NARROW_COMPACT_GUIDE = 60;
const NARROW_SHOW_WORKFLOW = 70;
const NARROW_SHOW_TIPS = 80;

interface KeyBindingRowProps {
  description: string;
  keys: string;
}

function KeyBindingRow({ description, keys }: KeyBindingRowProps) {
  return (
    <Box justifyContent="space-between" width="100%">
      <Box flexShrink={1} marginRight={2}>
        <Text color={COLORS.text.muted} wrap="wrap">
          {description}
        </Text>
      </Box>
      <Box flexShrink={0}>
        <Text color={COLORS.primary}>{keys}</Text>
      </Box>
    </Box>
  );
}

interface ModeRowProps {
  label: string;
  desc: string;
  active: boolean;
  color: string;
  labelColor?: string;
}

function ModeRow({ label, desc, active, color, labelColor }: ModeRowProps) {
  const labelMinWidth = Math.max(18, getDisplayWidth(label) + 2);
  const resolvedLabelColor = labelColor ?? (active ? color : COLORS.text.muted);
  return (
    <Box width="100%">
      <Box width={labelMinWidth} flexShrink={0}>
        <Text color={resolvedLabelColor}>{label}</Text>
      </Box>
      <Text color={COLORS.primary} wrap="wrap">
        {desc}
      </Text>
    </Box>
  );
}

function NoteRow({ text }: { text: string }) {
  return (
    <Box width="100%">
      <Text color={COLORS.text.muted} wrap="wrap">
        {'• '}
        {text}
      </Text>
    </Box>
  );
}

function HelpSection({
  title,
  headerRight,
  children,
}: {
  title: string;
  headerRight?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <Box
      borderStyle="round"
      borderColor={COLORS.border}
      paddingX={1}
      paddingY={0}
      flexDirection="column"
    >
      <Box paddingLeft={1} justifyContent="space-between">
        <Text bold>{title}</Text>
        {headerRight}
      </Box>
      <Box flexDirection="column" paddingLeft={1}>
        {children}
      </Box>
    </Box>
  );
}

function RecommendedWorkflowRow({
  label,
  value,
  labelColor,
}: {
  label: string;
  value: string;
  labelColor?: string;
}) {
  return (
    <Box width="100%">
      <Box flexShrink={0} minWidth={14}>
        <Text color={labelColor ?? COLORS.text.muted} bold>
          {label}
        </Text>
      </Box>
      <Text color={COLORS.text.muted}>{value}</Text>
    </Box>
  );
}

function ModesBox({
  interactionMode,
}: {
  interactionMode: DroolInteractionMode;
}) {
  const { t } = useTranslation('common');
  return (
    <HelpSection
      title={t('helpSections.modes')}
      headerRight={<Text dimColor>{t('common:helpPopup.shiftTabHint')}</Text>}
    >
      <ModeRow
        label={t('modes.auto')}
        desc={t('modeDescriptions.auto')}
        active={interactionMode === DroolInteractionMode.Auto}
        color={COLORS.primary}
      />
      <ModeRow
        label={t('modes.spec')}
        desc={t('modeDescriptions.spec')}
        active={interactionMode === DroolInteractionMode.Spec}
        color={COLORS.spec}
      />
      <ModeRow
        label={t('modes.mission')}
        desc={t('modeDescriptions.mission')}
        active={interactionMode === DroolInteractionMode.Mission}
        color={COLORS.agi}
        labelColor={COLORS.agi}
      />
    </HelpSection>
  );
}

function AutonomyBox({ autonomyLevel }: { autonomyLevel: AutonomyLevel }) {
  const { t } = useTranslation('common');
  return (
    <HelpSection
      title={t('helpSections.autonomyLevels')}
      headerRight={<Text dimColor>{t('common:helpPopup.ctrlLHint')}</Text>}
    >
      <ModeRow
        label={t('autonomyLevels.off')}
        desc={t('autonomyDescriptions.off')}
        active={autonomyLevel === AutonomyLevel.Off}
        color={COLORS.primary}
      />
      <ModeRow
        label={t('autonomyLevels.low')}
        desc={t('autonomyDescriptions.low')}
        active={autonomyLevel === AutonomyLevel.Low}
        color={COLORS.highlight}
      />
      <ModeRow
        label={t('autonomyLevels.medium')}
        desc={t('autonomyDescriptions.medium')}
        active={autonomyLevel === AutonomyLevel.Medium}
        color={COLORS.highlight}
      />
      <ModeRow
        label={t('autonomyLevels.high')}
        desc={t('autonomyDescriptions.high')}
        active={autonomyLevel === AutonomyLevel.High}
        color={COLORS.highlight}
      />
    </HelpSection>
  );
}

function GettingStartedGuide({
  compact,
  autonomyInRight,
  modesInRight,
  interactionMode,
  autonomyLevel,
  showWorkflow,
  showTips,
}: {
  compact: boolean;
  autonomyInRight: boolean;
  modesInRight: boolean;
  interactionMode: DroolInteractionMode;
  autonomyLevel: AutonomyLevel;
  showWorkflow: boolean;
  showTips: boolean;
}) {
  const { t } = useTranslation('common');

  return (
    <Box flexDirection="column">
      <Box
        borderStyle="round"
        borderColor={COLORS.primary}
        paddingX={1}
        paddingY={0}
        flexDirection="column"
      >
        <Box paddingLeft={1} flexDirection="column">
          <Text bold color={COLORS.primary}>
            {t('gettingStarted.title')}
          </Text>
          <Text color={COLORS.primary} dimColor>
            {t('gettingStarted.docsLink')}
          </Text>
        </Box>

        <Box paddingLeft={1} flexDirection="column" marginTop={1}>
          <Text bold color={COLORS.highlight}>
            {t('gettingStarted.step1Title')}
          </Text>
          <Text color={COLORS.text.muted}>{t('gettingStarted.step1Desc')}</Text>
        </Box>

        <Box paddingLeft={1} flexDirection="column">
          <Text bold color={COLORS.highlight}>
            {t('gettingStarted.step2Title')}
          </Text>
          <Text color={COLORS.text.muted}>
            {t('gettingStarted.step2Line1')}
          </Text>
          <Text color={COLORS.text.muted}>
            {t('gettingStarted.step2Line2')}
          </Text>
          {!compact && (
            <Text bold color={COLORS.spec}>
              {t('gettingStarted.step2Hint')}
            </Text>
          )}
        </Box>

        <Box paddingLeft={1} flexDirection="column">
          <Text bold color={COLORS.highlight}>
            {t('gettingStarted.step3Title')}
          </Text>
          <Text color={COLORS.text.muted}>
            {t('gettingStarted.step3Line1')}
          </Text>
          <Text color={COLORS.text.muted}>
            {t('gettingStarted.step3Line2')}
          </Text>
          <Text color={COLORS.text.muted}>
            {t('gettingStarted.step3Line3')}
          </Text>
        </Box>

        {!compact && (
          <>
            <Box paddingLeft={1} flexDirection="column">
              <Text bold color={COLORS.highlight}>
                {t('gettingStarted.step4Title')}
              </Text>
              <Text color={COLORS.text.muted}>
                {t('gettingStarted.step4Desc')}
              </Text>
            </Box>

            <Box paddingLeft={1} flexDirection="column">
              <Text bold color={COLORS.highlight}>
                {t('gettingStarted.step5Title')}
              </Text>
              <Text color={COLORS.text.muted}>
                {t('gettingStarted.step5Line1')}
              </Text>
              <Text color={COLORS.text.muted}>
                {t('gettingStarted.step5Line2')}
              </Text>
            </Box>
          </>
        )}
      </Box>

      {modesInRight && <ModesBox interactionMode={interactionMode} />}
      {autonomyInRight && <AutonomyBox autonomyLevel={autonomyLevel} />}

      {showWorkflow && (
        <Box
          borderStyle="round"
          borderColor={COLORS.border}
          paddingX={1}
          paddingY={0}
          flexDirection="column"
        >
          <Box paddingLeft={1}>
            <Text bold>{t('gettingStarted.workflowTitle')}</Text>
          </Box>
          <Box paddingLeft={1} flexDirection="column">
            <RecommendedWorkflowRow
              label={t('gettingStarted.workflowComplexLabel')}
              value={t('gettingStarted.workflowComplexValue')}
              labelColor={COLORS.highlight}
            />
            <RecommendedWorkflowRow
              label={t('gettingStarted.workflowQuickLabel')}
              value={t('gettingStarted.workflowQuickValue')}
              labelColor={COLORS.highlight}
            />
            <RecommendedWorkflowRow
              label={t('gettingStarted.workflowBudgetLabel')}
              value={t('gettingStarted.workflowBudgetValue')}
              labelColor={COLORS.highlight}
            />
          </Box>
          <Box paddingLeft={1} marginTop={1} flexDirection="column">
            <Text dimColor>{t('gettingStarted.workflowHint')}</Text>
          </Box>
        </Box>
      )}

      {showTips && (
        <HelpSection title={t('gettingStarted.tipsTitle')}>
          <NoteRow text={t('gettingStarted.tip1')} />
          <NoteRow text={t('gettingStarted.tip2')} />
          <NoteRow text={t('gettingStarted.tip3')} />
          <NoteRow text={t('gettingStarted.tip4')} />
          <NoteRow text={t('gettingStarted.tip5')} />
        </HelpSection>
      )}
    </Box>
  );
}

function ShortcutsPanel({
  interactionMode,
  autonomyLevel,
  isJapanese,
  height,
  hideNavigation,
  hideAutonomy,
  hideModes,
}: {
  interactionMode: DroolInteractionMode;
  autonomyLevel: AutonomyLevel;
  isJapanese: boolean;
  height: number;
  hideNavigation: boolean;
  hideAutonomy: boolean;
  hideModes: boolean;
}) {
  const { t } = useTranslation('common');

  const showNavigation =
    !hideNavigation &&
    ((hideAutonomy || hideModes) && !hideModes
      ? true
      : height >= NARROW_HIDE_NAVIGATION);
  const showModes = !hideModes && height >= NARROW_HIDE_MODES;
  const showAutonomy =
    !hideAutonomy && !hideModes && height >= NARROW_HIDE_AUTONOMY;

  return (
    <Box flexDirection="column" width={SHORTCUTS_MIN_WIDTH}>
      <HelpSection title={t('helpSections.basics')}>
        <KeyBindingRow description={t('keybindings.send')} keys="Enter" />
        <KeyBindingRow
          description={t('keybindings.newLine')}
          keys={'\\ + Enter'}
        />
        <KeyBindingRow
          description={t('keybindings.pasteImage')}
          keys={isWindows ? 'Alt + V' : 'Ctrl + V'}
        />
        <KeyBindingRow
          description={t('keybindings.clearInput')}
          keys="Double Esc / Ctrl+C"
        />
        <KeyBindingRow
          description={t('keybindings.rewind')}
          keys="Double Esc (input empty)"
        />
        <KeyBindingRow description={t('keybindings.cancelExit')} keys="Esc" />
        <KeyBindingRow
          description={t('keybindings.historyNavigation')}
          keys="↑/↓"
        />
      </HelpSection>

      <HelpSection title={t('helpSections.shortcuts')}>
        <KeyBindingRow description={t('keybindings.filePaths')} keys="@" />
        <KeyBindingRow description={t('keybindings.commandsMenu')} keys="/" />
        <KeyBindingRow description={t('keybindings.toggleBash')} keys="!" />
        <KeyBindingRow
          description={t('keybindings.changeModes')}
          keys={isWindows ? 'Ctrl + T' : 'Shift + Tab'}
        />
        <KeyBindingRow
          description={t('keybindings.cycleReasoning')}
          keys="Tab"
        />
        <KeyBindingRow
          description={t('keybindings.cycleModel')}
          keys="Ctrl + N"
        />
        <KeyBindingRow
          description={t('keybindings.toggleDetailedView')}
          keys="Ctrl + O"
        />
        <KeyBindingRow
          description={t('keybindings.editInEditor')}
          keys="Ctrl + P"
        />
        <KeyBindingRow
          description={t('keybindings.toggleAutoCompress')}
          keys="Alt/Option + X"
        />
        <KeyBindingRow
          description={t('keybindings.transcriptScrollTurn')}
          keys="Alt + ↑/↓"
        />
        <KeyBindingRow
          description={t('keybindings.transcriptScrollUserTurn')}
          keys="Alt + PgUp/PgDn"
        />
      </HelpSection>

      {showNavigation && (
        <HelpSection title={t('helpSections.navigation')}>
          <KeyBindingRow
            description={t('keybindings.jumpToLineStartEnd')}
            keys={isWindows ? 'Home/End' : 'Cmd + ←/→'}
          />
          <KeyBindingRow
            description={t('keybindings.deleteWord')}
            keys={isWindows ? 'Ctrl / Alt + Backspace' : 'Option + Delete'}
          />
          <KeyBindingRow
            description={t('keybindings.deleteLine')}
            keys={isWindows ? 'Ctrl + U' : 'Cmd + Delete'}
          />
        </HelpSection>
      )}

      {showModes && <ModesBox interactionMode={interactionMode} />}
      {showAutonomy && <AutonomyBox autonomyLevel={autonomyLevel} />}

      {/* JIS Keyboard & IME Notes — shown only for Japanese locale */}
      {isJapanese && showAutonomy && (
        <HelpSection title={t('helpSections.jisKeyboardNotes')}>
          <NoteRow text={t('jisNotes.ctrlShortcutsBypassIme')} />
          <NoteRow text={t('jisNotes.backslashPosition')} />
          <NoteRow text={t('jisNotes.bracketPositions')} />
          <NoteRow text={t('jisNotes.imeCompositionNote')} />
          <NoteRow text={t('jisNotes.escDismissesIme')} />
        </HelpSection>
      )}
    </Box>
  );
}

export function HelpPopup({
  interactionMode = DroolInteractionMode.Auto,
  autonomyLevel = AutonomyLevel.Off,
  width,
  height,
}: HelpPopupProps) {
  const { i18n } = useTranslation('common');
  const isJapanese = i18n.language === SupportedLocale.Japanese;

  const h = height ?? 50;
  const isWide = (width ?? 0) >= WIDE_THRESHOLD;

  if (isWide) {
    const autonomyInRight = h < WIDE_MOVE_AUTONOMY;
    const modesInRight = h < WIDE_MOVE_BOTH;
    const compact = h < WIDE_COMPACT_GUIDE;
    const hideNavigation = autonomyInRight && h < WIDE_HIDE_NAV;
    const showGuide = h >= WIDE_MINIMAL;
    const showWorkflow =
      !autonomyInRight && !modesInRight && h >= WIDE_SHOW_WORKFLOW;
    const showTips = !autonomyInRight && !modesInRight && h >= WIDE_SHOW_TIPS;

    return (
      <Box flexDirection="row" width={width}>
        <Box flexShrink={0}>
          <ShortcutsPanel
            interactionMode={interactionMode}
            autonomyLevel={autonomyLevel}
            isJapanese={isJapanese}
            height={h}
            hideNavigation={hideNavigation}
            hideAutonomy={autonomyInRight}
            hideModes={modesInRight}
          />
        </Box>
        {showGuide && (
          <Box flexGrow={1} marginLeft={1}>
            <GettingStartedGuide
              compact={compact}
              autonomyInRight={autonomyInRight}
              modesInRight={modesInRight}
              interactionMode={interactionMode}
              autonomyLevel={autonomyLevel}
              showWorkflow={showWorkflow}
              showTips={showTips}
            />
          </Box>
        )}
      </Box>
    );
  }

  // Narrow single-column layout
  const showGuide = h >= NARROW_SHOW_GUIDE;

  return (
    <Box flexDirection="column">
      <ShortcutsPanel
        interactionMode={interactionMode}
        autonomyLevel={autonomyLevel}
        isJapanese={isJapanese}
        height={h}
        hideNavigation={false}
        hideAutonomy={false}
        hideModes={false}
      />
      {showGuide && (
        <GettingStartedGuide
          compact={h < NARROW_COMPACT_GUIDE}
          autonomyInRight={false}
          modesInRight={false}
          interactionMode={interactionMode}
          autonomyLevel={autonomyLevel}
          showWorkflow={h >= NARROW_SHOW_WORKFLOW}
          showTips={h >= NARROW_SHOW_TIPS}
        />
      )}
    </Box>
  );
}
