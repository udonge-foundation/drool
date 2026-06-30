import { Box, Text } from 'ink';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { logException } from '@industry/logging';

import { COLORS } from '@/components/chat/themedColors';
import { wrapText } from '@/components/chat/wrapText';
import { MenuContainer } from '@/components/common/MenuContainer';
import { ScrollableDetailView } from '@/components/common/ScrollableDetailView';
import type { DetailLine } from '@/components/common/types';
import { DroolModelFallbackPicker } from '@/components/drools/DroolModelFallbackPicker';
import { useKeypressHandler } from '@/hooks/useKeypressHandler';
import { useMenuNavigation } from '@/hooks/useMenuNavigation';
import { useTerminalDimensions } from '@/hooks/useTerminalDimensions';
import { getAllowedModelIds } from '@/models/availability';
import { getDroolLoaderSingleton } from '@/services/drools/CustomDroolRegistry';
import { DroolValidator } from '@/services/drools/DroolValidator';
import { DroolConfig } from '@/services/drools/types';

import type { CustomDrool } from '@industry/common/settings';

const DROOL_DETAIL_WIDTH_PADDING = 4;
const DROOL_DETAIL_MIN_HEIGHT = 8;
const DROOL_DETAIL_MAX_HEIGHT = 24;
const DROOL_DETAIL_CHROME_ROWS = 8;

function buildDroolDetailLines(
  drool: DroolConfig,
  wrapWidth: number,
  labels: {
    descriptionLabel: string;
    noDescription: string;
    modelLabel: string;
    defaultModel: string;
    toolsLabel: string;
    allTools: string;
    mcpServersLabel: string;
    systemPromptLabel: string;
    fileLabel: string;
  }
): DetailLine[] {
  const lines: DetailLine[] = [];
  const safeWidth = Math.max(10, wrapWidth);

  const pushWrapped = (
    value: string,
    options?: { color?: string; bold?: boolean }
  ) => {
    // Normalize CRLF/CR to LF so a stray carriage return in the source
    // (e.g. a drool markdown checked out with CRLF endings on Windows)
    // does not get written to stdout as a literal \r and overwrite the
    // previous column with the next line of content.
    const normalized = value.replace(/\r\n?/g, '\n');
    const segments = normalized.length === 0 ? [''] : normalized.split('\n');
    for (const segment of segments) {
      const wrapped = wrapText(segment, safeWidth);
      const rendered = wrapped.length === 0 ? [''] : wrapped;
      for (const piece of rendered) {
        lines.push({ text: piece, color: options?.color, bold: options?.bold });
      }
    }
  };

  lines.push({ text: drool.metadata.name, color: COLORS.primary, bold: true });
  lines.push({ text: '' });

  lines.push({ text: labels.descriptionLabel });
  pushWrapped(drool.metadata.description || labels.noDescription, {
    color: COLORS.text.muted,
  });
  lines.push({ text: '' });

  lines.push({ text: labels.modelLabel });
  lines.push({
    text: drool.metadata.model || labels.defaultModel,
    color: COLORS.text.muted,
  });
  lines.push({ text: '' });

  lines.push({ text: labels.toolsLabel });
  if (drool.metadata.tools === 'all' || !drool.metadata.tools) {
    lines.push({ text: labels.allTools, color: COLORS.text.muted });
  } else if (Array.isArray(drool.metadata.tools)) {
    for (const toolName of drool.metadata.tools) {
      lines.push({ text: `• ${toolName}`, color: COLORS.text.muted });
    }
  } else {
    lines.push({
      text: String(drool.metadata.tools),
      color: COLORS.text.muted,
    });
  }
  lines.push({ text: '' });

  if (drool.metadata.mcpServers?.length) {
    lines.push({ text: labels.mcpServersLabel });
    for (const serverName of drool.metadata.mcpServers) {
      lines.push({ text: `• ${serverName}`, color: COLORS.text.muted });
    }
    lines.push({ text: '' });
  }

  lines.push({ text: labels.systemPromptLabel });
  pushWrapped(drool.systemPrompt, { color: COLORS.text.muted });
  lines.push({ text: '' });

  pushWrapped(labels.fileLabel, { color: COLORS.text.muted });

  return lines;
}

interface DroolsMenuProps {
  onClose: () => void;
  onCreateDrool?: () => void;
  onEditDrool?: (drool: DroolConfig) => void;
  onDeleteDrool?: (drool: DroolConfig) => void;
  onImportDrools?: () => void;
}

type MenuOption =
  | { type: 'drool'; drool: CustomDrool }
  | { type: 'action'; action: 'create' | 'import' }
  | { type: 'header'; label: string };

type DroolAction = 'view' | 'edit' | 'delete' | 'fixModel' | 'back';

interface DroolActionOption {
  action: DroolAction;
  label: string;
}

export function DroolsMenu({
  onClose,
  onCreateDrool,
  onEditDrool,
  onDeleteDrool,
  onImportDrools,
}: DroolsMenuProps) {
  const { t } = useTranslation();
  const { width: terminalWidth, height: terminalHeight } =
    useTerminalDimensions();
  const [drools, setDrools] = useState<CustomDrool[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedDrool, setSelectedDrool] = useState<CustomDrool | null>(null);
  const [showDroolDetails, setShowDroolDetails] = useState(false);
  const [modelPickerDrool, setModelPickerDrool] = useState<CustomDrool | null>(
    null
  );

  const loadDrools = async () => {
    try {
      setLoading(true);
      setError(null);
      const loader = getDroolLoaderSingleton();
      const loadedDrools = await loader.loadAllDrools();
      setDrools(loadedDrools);
    } catch (err) {
      logException(err, 'Failed to load drools in menu');
      setError(t('common:drools.failedToLoadDrools'));
    } finally {
      setLoading(false);
    }
  };

  // Load drools on mount
  useEffect(() => {
    void loadDrools();
  }, []);

  // Calculate menu options based on drools
  const menuOptions = useMemo(() => {
    const options: MenuOption[] = [];

    // First option: create new drool
    options.push({ type: 'action', action: 'create' });

    // Separate drools by location
    const projectDrools = drools.filter((d) => d.location === 'project');
    const personalDrools = drools.filter((d) => d.location === 'personal');

    // Add project drools with header
    if (projectDrools.length > 0) {
      options.push({ type: 'header', label: t('common:drools.projectHeader') });
      projectDrools.forEach((drool) => {
        options.push({ type: 'drool', drool });
      });
    }

    // Add personal drools with header
    if (personalDrools.length > 0) {
      options.push({
        type: 'header',
        label: t('common:drools.personalHeader'),
      });
      personalDrools.forEach((drool) => {
        options.push({ type: 'drool', drool });
      });
    }

    // Import option for Claude Code subagents
    if (drools.length > 0) {
      options.push({ type: 'header', label: '' }); // Spacer
    }
    options.push({ type: 'action', action: 'import' });

    return options;
  }, [drools, t]);

  // Main menu navigation
  const { selectedIndex: mainSelectedIndex } = useMenuNavigation({
    items: menuOptions,
    initialIndex: 0,
    isSelectable: (option) => option.type !== 'header',
    onSelect: (selected) => {
      if (selected.type === 'drool') {
        setSelectedDrool(selected.drool);
        setShowDroolDetails(false);
      } else if (selected.type === 'action') {
        switch (selected.action) {
          case 'create':
            onCreateDrool?.();
            break;
          case 'import':
            onImportDrools?.();
            break;
          default:
            break;
        }
      }
    },
    onCancel: onClose,
    isActive: !selectedDrool,
  });

  // Drool submenu options
  const droolActionOptions: DroolActionOption[] = useMemo(() => {
    const options: DroolActionOption[] = [
      { action: 'view', label: t('common:drools.viewDrool') },
    ];
    if (selectedDrool?.pluginId) {
      // Drools from plug-ins cannot be edited, except to fix invalid pinned model.
      if (
        !DroolValidator.validateModel(selectedDrool.metadata.model, [
          ...getAllowedModelIds(),
        ]).valid
      ) {
        options.push({
          action: 'fixModel',
          label: t('common:drools.fixModel'),
        });
      }
    } else {
      options.push({ action: 'edit', label: t('common:drools.editDrool') });
      options.push({ action: 'delete', label: t('common:drools.deleteDrool') });
    }
    options.push({ action: 'back', label: t('common:drools.back') });
    return options;
  }, [selectedDrool, t]);

  // Drool submenu navigation. Disabled while a detail pane is open so that
  // ↑/↓ keys can scroll the preview instead of mutating the hidden submenu
  // selection.
  const { selectedIndex: droolActionIndex } = useMenuNavigation({
    items: droolActionOptions,
    initialIndex: 0,
    onSelect: (option) => {
      if (!selectedDrool) return;

      switch (option.action) {
        case 'view':
          setShowDroolDetails(true);
          break;
        case 'edit':
          onEditDrool?.(selectedDrool);
          break;
        case 'delete':
          onDeleteDrool?.(selectedDrool);
          break;
        case 'fixModel':
          setModelPickerDrool(selectedDrool);
          break;
        case 'back':
          setSelectedDrool(null);
          break;
        default:
          break;
      }
    },
    onCancel: () => {
      setSelectedDrool(null);
    },
    isActive: !!selectedDrool && !showDroolDetails && !modelPickerDrool,
  });

  // Esc/q handler dedicated to the detail pane: returns to the action submenu
  // without unmounting the selected drool. `q` is the standard cancel shortcut
  // throughout the CLI (used by `useMenuNavigation`), so we honor it here too
  // since that hook is intentionally inactive while the detail pane is open.
  useKeypressHandler(
    (input, key) => {
      if (key.escape || input === 'q') {
        setShowDroolDetails(false);
      }
    },
    { isActive: !!selectedDrool && showDroolDetails }
  );

  const summarize = (s?: string): string => {
    if (!s) return t('common:drools.noDescription');
    const oneLine = s.replace(/\s+/g, ' ').trim();
    const max = 80;
    return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
  };

  if (loading) {
    return (
      <MenuContainer title={t('common:drools.title')}>
        <Text color={COLORS.text.muted}>{t('common:drools.loading')}</Text>
      </MenuContainer>
    );
  }

  if (error) {
    return (
      <MenuContainer title={t('common:drools.title')}>
        <Text color={COLORS.error}>
          {t('common:drools.errorPrefix', { error })}
        </Text>
      </MenuContainer>
    );
  }

  if (modelPickerDrool) {
    return (
      <DroolModelFallbackPicker
        droolNames={[modelPickerDrool.metadata.name]}
        originalModelId={modelPickerDrool.metadata.model ?? ''}
        droolLocation={modelPickerDrool.location}
        onComplete={() => {
          setModelPickerDrool(null);
          setSelectedDrool(null);
          void loadDrools();
        }}
        onCancel={() => setModelPickerDrool(null)}
      />
    );
  }

  return (
    <MenuContainer title={t('common:drools.title')}>
      {!selectedDrool ? (
        <>
          {drools.length === 0 && (
            <Box flexDirection="column" marginBottom={1}>
              <Text color={COLORS.text.muted}>
                {t('common:drools.noDroolsFound')}
              </Text>
              <Text color={COLORS.text.muted}>
                {t('common:drools.noDroolsDescription')}
              </Text>
              <Text color={COLORS.text.muted}>
                {t('common:drools.noDroolsSuggestion')}
              </Text>
            </Box>
          )}
          {menuOptions.map((option, index) => {
            const isSelected = index === mainSelectedIndex;
            const color = isSelected ? COLORS.primary : COLORS.text.primary;

            if (option.type === 'header') {
              if (option.label === '') {
                return <Box key={`header-${index}`} marginTop={1} />;
              }
              return (
                <Box key={`header-${index}`} marginTop={index === 0 ? 0 : 1}>
                  <Text color={COLORS.text.secondary}>{option.label}</Text>
                </Box>
              );
            }

            if (option.type === 'action') {
              const labelMap = {
                create: t('common:drools.createNewDrool'),
                import: t('common:drools.importFromClaude'),
              } as const;

              return (
                <Text key={`action-${option.action}`} color={color}>
                  {isSelected ? '> ' : '  '}
                  {labelMap[option.action]}
                </Text>
              );
            }

            return (
              <Box key={`drool-${option.drool.metadata.name}`}>
                <Text color={color}>
                  {isSelected ? '> ' : '  '}
                  {option.drool.metadata.name}
                  {' · '}
                  <Text color={COLORS.text.muted}>
                    {summarize(option.drool.metadata.description)}
                  </Text>
                </Text>
              </Box>
            );
          })}
        </>
      ) : (
        <Box flexDirection="column">
          {!showDroolDetails ? (
            <Box flexDirection="column">
              <Text>
                <Text color={COLORS.text.muted}>
                  {t('common:drools.selectedLabel')}
                </Text>
                {selectedDrool.metadata.name}{' '}
                <Text color={COLORS.text.muted}>
                  (
                  {selectedDrool.location === 'project'
                    ? t('common:drools.projectLabel')
                    : t('common:drools.personalLabel')}
                  )
                </Text>
              </Text>
              <Box marginTop={1} />
              {droolActionOptions.map((option, idx) => {
                const isSelected = idx === droolActionIndex;
                const color = isSelected ? COLORS.primary : COLORS.text.primary;
                return (
                  <Text key={option.label} color={color}>
                    {isSelected ? '> ' : '  '}
                    {option.label}
                  </Text>
                );
              })}
            </Box>
          ) : (
            (() => {
              const detailLines = buildDroolDetailLines(
                selectedDrool,
                terminalWidth - DROOL_DETAIL_WIDTH_PADDING,
                {
                  descriptionLabel: t('common:drools.descriptionLabel'),
                  noDescription: '—',
                  modelLabel: t('common:drools.modelLabel'),
                  defaultModel: 'inherit',
                  toolsLabel: t('common:drools.toolsLabel'),
                  allTools: t('common:drools.allTools'),
                  mcpServersLabel: t('common:drools.mcpServersLabel'),
                  systemPromptLabel: t('common:drools.systemPromptLabel'),
                  fileLabel: t('common:drools.fileLabel', {
                    path: selectedDrool.filePath,
                  }),
                }
              );
              const viewportHeight = Math.max(
                DROOL_DETAIL_MIN_HEIGHT,
                Math.min(
                  DROOL_DETAIL_MAX_HEIGHT,
                  terminalHeight - DROOL_DETAIL_CHROME_ROWS
                )
              );
              return (
                <ScrollableDetailView
                  key={`${selectedDrool.location}:${selectedDrool.metadata.name}`}
                  lines={detailLines}
                  viewportHeight={viewportHeight}
                />
              );
            })()
          )}
        </Box>
      )}
    </MenuContainer>
  );
}
