import fs from 'fs';

import { Box, Text } from 'ink';
import { useState, useCallback, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';

import { COLORS } from '@/components/chat/themedColors';
import { BackgroundTaskItemType } from '@/hooks/enums';
import type { BackgroundTaskItem, ToolExecution } from '@/hooks/types';
import { useBackgroundTasks } from '@/hooks/useBackgroundTasks';
import { useKeypressHandler } from '@/hooks/useKeypressHandler';
import { getI18n } from '@/i18n/index';
import { matchKeyboardChord } from '@/keyboard/keyboardChords';
import { backgroundProcessTracker } from '@/services/BackgroundProcessTracker';
import { getTuiDaemonAdapter } from '@/services/daemon/TuiDaemonAdapter';
import { truncateLine } from '@/utils/text-utils';

type PanelView = 'collapsed' | 'expanded' | 'detail';

function capitalize(str: string): string {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

interface ParsedOutputLine {
  prefix: string;
  prefixColor: string;
  text: string;
}

function parseOutputLine(raw: string): ParsedOutputLine {
  try {
    const event = JSON.parse(raw) as Record<string, unknown>;
    const type = event.type as string | undefined;

    if (type === 'tool_call') {
      const toolName = (event.toolName as string) ?? 'unknown';
      const status = event.status as string | undefined;
      const params = event.parameters as Record<string, unknown> | undefined;
      let detail = '';
      if (params) {
        const key =
          ['file_path', 'path', 'command', 'description', 'pattern'].find(
            (k) => typeof params[k] === 'string'
          ) ?? Object.keys(params)[0];
        if (key && params[key] !== undefined) {
          const val = String(params[key]);
          detail = val.length > 80 ? `${val.slice(0, 77)}...` : val;
        }
      }
      const statusStr =
        status === 'completed' || status === 'error' ? ` (${status})` : '';
      return {
        prefix: `[tool] ${toolName}${statusStr}`,
        prefixColor: COLORS.primary,
        text: detail,
      };
    }

    if (type === 'tool_result') {
      const toolName =
        (event.toolName as string) ?? (event.toolId as string) ?? 'Tool: N/A';
      const isError = event.isError === true;
      let details = (event.text as string) ?? (event.message as string) ?? '';
      if (!details && typeof event.value === 'string') {
        details = event.value;
      }
      const snippet =
        details.length > 100 ? `${details.slice(0, 97)}...` : details;
      return {
        prefix: `[result] ${toolName}`,
        prefixColor: isError ? COLORS.error : COLORS.success,
        text: snippet,
      };
    }

    if (type === 'message') {
      const role = (event.role as string) ?? '';
      const text = (event.text as string) ?? '';
      const snippet = text.length > 100 ? `${text.slice(0, 97)}...` : text;
      if (role === 'assistant') {
        return {
          prefix: '[assistant]',
          prefixColor: COLORS.primary,
          text: snippet,
        };
      }
      if (role === 'user') {
        return {
          prefix: '[user]',
          prefixColor: COLORS.text.userText,
          text: snippet,
        };
      }
      return {
        prefix: `[${role || 'message'}]`,
        prefixColor: COLORS.text.muted,
        text: snippet,
      };
    }

    if (type === 'error') {
      const msg = (event.message as string) ?? '';
      return { prefix: '[error]', prefixColor: COLORS.error, text: msg };
    }

    if (type === 'system') {
      return { prefix: '[system]', prefixColor: COLORS.text.muted, text: '' };
    }

    return { prefix: '', prefixColor: COLORS.text.secondary, text: raw };
  } catch {
    return { prefix: '', prefixColor: COLORS.text.secondary, text: raw };
  }
}

interface BackgroundTasksPanelProps {
  getToolExecutions: () => Map<string, ToolExecution>;
  isFocused: boolean;
  onFocusReturn: () => void;
  onCancelTool?: (toolId: string) => void;
  onProcessKilled?: (label: string, pid?: number) => void;
  width: number;
}

const DETAIL_MAX_UPDATES = 10;
function formatAge(startTime?: number): string {
  if (!startTime) return '';
  const seconds = Math.floor((Date.now() - startTime) / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h${minutes % 60}m`;
}

function getItemIcon(item: BackgroundTaskItem): string {
  if (item.type === BackgroundTaskItemType.Agent) return '';
  return 'bash: ';
}

function CollapsedView({
  processCount,
  agentCount,
}: {
  processCount: number;
  agentCount: number;
}) {
  const t = getI18n().t.bind(getI18n());

  const segments: Array<{ text: string; bold?: boolean }> = [];
  if (processCount > 0) {
    segments.push({
      text: t('common:backgroundTasks.processCount', { count: processCount }),
      bold: true,
    });
  }
  if (processCount > 0 && agentCount > 0) {
    segments.push({ text: t('common:backgroundTasks.conjunction') });
  }
  if (agentCount > 0) {
    segments.push({
      text: t('common:backgroundTasks.agentCount', { count: agentCount }),
      bold: true,
    });
  }
  const runningText = t('common:backgroundTasks.runningInBackground', {
    description: '',
  }).trimStart();
  segments.push({ text: ` ${runningText}` });

  return (
    <Box marginLeft={1}>
      <Text color={COLORS.subagent.panelBg}>
        {segments.map((seg, i) => (
          <Text key={i} bold={seg.bold}>
            {seg.text}
          </Text>
        ))}
      </Text>
      <Text color={COLORS.text.muted}>
        {' '}
        {t('common:backgroundTasks.viewHint')}
      </Text>
    </Box>
  );
}

function DetailView({
  item,
  width,
  onBack,
  onKill,
  onForceKill,
  isKilling,
}: {
  item: BackgroundTaskItem;
  width: number;
  onBack: () => void;
  onKill: () => void;
  onForceKill: () => void;
  isKilling: boolean;
}) {
  const { t } = useTranslation('common');
  const [outputLines, setOutputLines] = useState<string[]>([]);

  useKeypressHandler((input, key) => {
    if (matchKeyboardChord({ input, key }, 'escape')) {
      onBack();
      return true;
    }
    if (matchKeyboardChord({ input, key }, 'kill-task')) {
      onKill();
      return true;
    }
    if (matchKeyboardChord({ input, key }, 'force-kill')) {
      onForceKill();
      return true;
    }
    return false;
  });

  // Poll output file for live process output
  useEffect(() => {
    if (!item.outputFile) return undefined;

    const readOutput = () => {
      try {
        if (!fs.existsSync(item.outputFile!)) return;
        const stat = fs.statSync(item.outputFile!);
        const readSize = Math.min(stat.size, 4096);
        const fd = fs.openSync(item.outputFile!, 'r');
        const buffer = Buffer.alloc(readSize);
        fs.readSync(fd, buffer, 0, readSize, stat.size - readSize);
        fs.closeSync(fd);
        const content = buffer.toString('utf-8');
        const lines = content.split('\n').filter((l) => l.length > 0);
        setOutputLines(lines.slice(-DETAIL_MAX_UPDATES));
      } catch {
        // File may not exist yet or be inaccessible
      }
    };

    readOutput();
    const interval = setInterval(readOutput, 2000);
    return () => clearInterval(interval);
  }, [item.outputFile]);

  const age = formatAge(item.startTime);

  return (
    <Box flexDirection="column" marginLeft={1} width={width - 2}>
      <Box>
        <Text color={COLORS.primary} bold>
          {getItemIcon(item)}
          {capitalize(item.label)}
        </Text>
        {item.pid && (
          <Text color={COLORS.text.muted}>
            {' '}
            {t('common:backgroundTasks.pidLabel', { pid: item.pid })}
          </Text>
        )}
      </Box>
      {(age || item.detail) && (
        <Box>
          <Text color={COLORS.text.muted}>
            {age ? t('backgroundTasks.startedAgo', { age }) : ''}
            {age && item.detail ? ' | ' : ''}
            {item.detail || ''}
          </Text>
        </Box>
      )}

      {outputLines.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          <Text color={COLORS.text.muted}>
            {t('backgroundTasks.latestOutput')}
          </Text>
          {outputLines.map((line, i) => {
            const parsed = parseOutputLine(line);
            return (
              <Box key={`out-${i}`}>
                {parsed.prefix ? (
                  <>
                    <Text color={parsed.prefixColor} bold>
                      {parsed.prefix}
                    </Text>
                    {parsed.text ? (
                      <Text color={COLORS.text.secondary}>
                        {' '}
                        {truncateLine(
                          parsed.text,
                          width - 4 - parsed.prefix.length - 1
                        )}
                      </Text>
                    ) : null}
                  </>
                ) : (
                  <Text color={COLORS.text.secondary}>
                    {truncateLine(parsed.text, width - 4)}
                  </Text>
                )}
              </Box>
            );
          })}
        </Box>
      )}

      {!item.outputFile &&
        item.progressUpdates &&
        item.progressUpdates.length > 0 && (
          <Box flexDirection="column" marginTop={1}>
            <Text color={COLORS.text.muted}>
              {t('backgroundTasks.latestOutput')}
            </Text>
            {item.progressUpdates
              .slice(-DETAIL_MAX_UPDATES)
              .map((update, i) => {
                const uType = 'type' in update ? (update.type as string) : '';
                const toolName =
                  'toolName' in update ? (update.toolName as string) : '';
                const details =
                  ('details' in update
                    ? (update.details as string)
                    : undefined) ??
                  ('text' in update ? (update.text as string) : undefined) ??
                  ('error' in update ? (update.error as string) : undefined) ??
                  '';

                let prefix = '';
                let prefixColor = COLORS.text.muted;

                if (uType === 'tool_call' && toolName) {
                  prefix = `[tool] ${toolName}`;
                  prefixColor = COLORS.primary;
                } else if (uType === 'tool_result' && toolName) {
                  const isErr = 'error' in update && update.error;
                  prefix = `[result] ${toolName}`;
                  prefixColor = isErr ? COLORS.error : COLORS.success;
                } else if (uType === 'message') {
                  prefix = '[assistant]';
                  prefixColor = COLORS.primary;
                } else if (uType === 'error') {
                  prefix = '[error]';
                  prefixColor = COLORS.error;
                }

                return (
                  <Box key={`update-${i}`}>
                    {prefix ? (
                      <>
                        <Text color={prefixColor} bold>
                          {prefix}
                        </Text>
                        {details ? (
                          <Text color={COLORS.text.secondary}>
                            {' '}
                            {truncateLine(
                              details,
                              width - 4 - prefix.length - 1
                            )}
                          </Text>
                        ) : null}
                      </>
                    ) : (
                      <Text color={COLORS.text.secondary}>
                        {truncateLine(details, width - 4)}
                      </Text>
                    )}
                  </Box>
                );
              })}
          </Box>
        )}

      <Box marginTop={1}>
        {isKilling ? (
          <Text color={COLORS.warning}>
            {t('backgroundTasks.sendingKillSignal')}
          </Text>
        ) : (
          <Text color={COLORS.text.muted}>
            {t('backgroundTasks.detailControls')}
          </Text>
        )}
      </Box>
    </Box>
  );
}

export function BackgroundTasksPanel({
  getToolExecutions,
  isFocused,
  onFocusReturn,
  onCancelTool,
  onProcessKilled,
  width,
}: BackgroundTasksPanelProps) {
  const { t } = useTranslation('common');
  const { items, processCount, agentCount, refresh } = useBackgroundTasks({
    getToolExecutions,
  });
  const [view, setView] = useState<PanelView>('collapsed');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const prevFocusedRef = useRef(false);

  // Render-time state derivation: auto-expand on focus gain (own state only)
  if (isFocused !== prevFocusedRef.current) {
    if (isFocused && items.length > 0) {
      setView('expanded');
      setSelectedIndex(0);
    }
    prevFocusedRef.current = isFocused;
  }

  // Clamp selectedIndex when items shrink
  if (items.length > 0 && selectedIndex >= items.length) {
    setSelectedIndex(Math.max(0, items.length - 1));
    if (view === 'detail') {
      setView('expanded');
    }
  }

  // Parent callback must go in useEffect to avoid updating parent state during render
  useEffect(() => {
    if (isFocused && items.length === 0) {
      setView('collapsed');
      onFocusReturn();
    }
  }, [isFocused, items.length, onFocusReturn]);

  const [isKilling, setIsKilling] = useState(false);

  const handleGracefulKill = useCallback(
    (item: BackgroundTaskItem) => {
      setIsKilling(true);
      if (item.pid) {
        void backgroundProcessTracker.killProcess(item.pid).finally(() => {
          setIsKilling(false);
          onProcessKilled?.(item.label, item.pid);
          refresh();
          setView('expanded');
        });
      } else if (item.toolId && onCancelTool) {
        onCancelTool(item.toolId);
        setIsKilling(false);
        onProcessKilled?.(item.label);
        refresh();
        setView('expanded');
      } else if (item.sessionId) {
        void getTuiDaemonAdapter()
          .interruptSession(item.sessionId)
          .finally(() => {
            setIsKilling(false);
            onProcessKilled?.(item.label);
            refresh();
            setView('expanded');
          });
      } else {
        setIsKilling(false);
        setView('expanded');
      }
    },
    [onCancelTool, onProcessKilled, refresh]
  );

  const handleForceKill = useCallback(
    (item: BackgroundTaskItem) => {
      setIsKilling(true);
      if (item.pid) {
        void backgroundProcessTracker.forceKillProcess(item.pid).finally(() => {
          setIsKilling(false);
          onProcessKilled?.(item.label, item.pid);
          refresh();
          setView('expanded');
        });
      } else if (item.toolId && onCancelTool) {
        onCancelTool(item.toolId);
        setIsKilling(false);
        onProcessKilled?.(item.label);
        refresh();
        setView('expanded');
      } else if (item.sessionId) {
        void getTuiDaemonAdapter()
          .interruptSession(item.sessionId)
          .finally(() => {
            setIsKilling(false);
            onProcessKilled?.(item.label);
            refresh();
            setView('expanded');
          });
      } else {
        setIsKilling(false);
        setView('expanded');
      }
    },
    [onCancelTool, onProcessKilled, refresh]
  );

  // Keyboard handling for collapsed and expanded views
  useKeypressHandler(
    (input, key) => {
      if (view === 'collapsed') {
        if (
          matchKeyboardChord({ input, key }, 'enter') ||
          matchKeyboardChord({ input, key }, 'down-arrow')
        ) {
          setView('expanded');
          setSelectedIndex(0);
          return true;
        }
        if (
          matchKeyboardChord({ input, key }, 'escape') ||
          matchKeyboardChord({ input, key }, 'up-arrow')
        ) {
          onFocusReturn();
          return true;
        }
        return false;
      }

      if (view === 'expanded') {
        if (matchKeyboardChord({ input, key }, 'escape')) {
          setView('collapsed');
          onFocusReturn();
          return true;
        }
        if (matchKeyboardChord({ input, key }, 'up-arrow')) {
          if (selectedIndex === 0) {
            setView('collapsed');
            onFocusReturn();
          } else {
            setSelectedIndex((prev) => Math.max(0, prev - 1));
          }
          return true;
        }
        if (matchKeyboardChord({ input, key }, 'down-arrow')) {
          setSelectedIndex((prev) => Math.min(items.length - 1, prev + 1));
          return true;
        }
        if (
          matchKeyboardChord({ input, key }, 'enter') &&
          items[selectedIndex]
        ) {
          setView('detail');
          return true;
        }
      }

      return false;
    },
    { isActive: isFocused && view !== 'detail' }
  );

  if (items.length === 0) {
    return null;
  }

  if (view === 'detail' && items[selectedIndex]) {
    return (
      <DetailView
        item={items[selectedIndex]}
        width={width}
        onBack={() => setView('expanded')}
        onKill={() => handleGracefulKill(items[selectedIndex])}
        onForceKill={() => handleForceKill(items[selectedIndex])}
        isKilling={isKilling}
      />
    );
  }

  if (view === 'collapsed' || !isFocused) {
    return (
      <CollapsedView processCount={processCount} agentCount={agentCount} />
    );
  }

  // expanded view
  return (
    <Box flexDirection="column" marginLeft={1}>
      {items.map((item, index) => {
        const isSelected = index === selectedIndex;
        const prefix = isSelected ? '> ' : '  ';
        const icon = getItemIcon(item);
        const pidStr = item.pid ? ` (pid: ${item.pid})` : '';
        const detailStr = item.detail ? `: ${item.detail}` : '';
        const label = truncateLine(
          `${icon}${capitalize(item.label)}${detailStr}${pidStr}`,
          width - 6
        );

        return (
          <Box key={item.id}>
            <Text
              color={isSelected ? COLORS.primary : COLORS.text.secondary}
              bold={isSelected}
            >
              {prefix}
              {label}
            </Text>
          </Box>
        );
      })}
      <Text color={COLORS.text.muted}>{t('backgroundTasks.enterHint')}</Text>
    </Box>
  );
}
