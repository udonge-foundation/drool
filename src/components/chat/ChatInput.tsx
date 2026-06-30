/**
 * Multi-line chat input with cursor navigation
 */

import { Box, Text } from 'ink';
import PropTypes from 'prop-types';
import React, {
  useState,
  useCallback,
  useMemo,
  useRef,
  useEffect,
} from 'react';
import { useTranslation } from 'react-i18next';

import { IndustryFeatureFlags } from '@industry/common/feature-flags';
import { DroolInteractionMode } from '@industry/drool-sdk-ext/protocol/shared';
import { Metric } from '@industry/logging/metrics/enums';

import { getAgentEffectivenessReportVisibility } from '@/commands/agentEffectivenessReportVisibility';
import { commandRegistry } from '@/commands/registry';
import { filterVisibleSlashCommands } from '@/commands/visibility';
import { ChatFileSuggestions } from '@/components/chat/chat-file-suggestions';
import { CommandSuggestions } from '@/components/chat/CommandSuggestions';
import { DEFAULTS } from '@/components/chat/constants';
import { ImageAttachment } from '@/components/chat/ImageAttachment';
import { COLORS } from '@/components/chat/themedColors';
import {
  ChatInputProps,
  FileSuggestion,
  ChatInputApi,
} from '@/components/chat/types';
import { SelectableList } from '@/components/SelectableList';
import type { SelectableListItem } from '@/components/types';
// Keyboard-handling hook
import { useKeypressProvider } from '@/contexts/KeypressProvider';
import { useFeatureFlagValue } from '@/feature-flags/hooks';
import { useChatKeyboardInput } from '@/hooks/useChatKeyboardInput';
import { useImageAttachments } from '@/hooks/useImageAttachments';
import { useRandomPlaceholder } from '@/hooks/useRandomPlaceholder';
import { getHistoryService } from '@/services/HistoryService';
import type { ChatSubmitOptions } from '@/types/types';
import {
  extractSlashCommandQuery,
  hasCompletedSlashCommand,
  matchCommands,
} from '@/utils/commandMatching';
import { displayWidth as getDisplayWidth } from '@/utils/displayWidth';
import {
  getQueryLengthBucket,
  getResultCountBucket,
  recordInputLatency,
} from '@/utils/inputLatencyMetrics';
import { isWindowsLike } from '@/utils/isWsl';
import { sanitizeTerminalDisplayText } from '@/utils/sanitizeTerminalDisplayText';
import { canViewTokenUsage } from '@/utils/tokenUsageVisibility';

const EDITOR_INPUT_API_RETRY_COUNT = 20;
const EDITOR_INPUT_API_RETRY_DELAY_MS = 25;

// Pre-calculated static values for performance
const PROMPT_SYMBOLS = {
  normal: '> ',
  bash: ' ! ',
  executing: ' ⏳ ',
  continuation: '  ',
  spec: '> ',
} as const;

const isWindows = isWindowsLike();

const LINE_COLORS = {
  prompt: {
    normal: COLORS.primary,
    bash: COLORS.success,
  },
  text: {
    normal: COLORS.text.primary,
    muted: COLORS.text.muted,
  },
} as const;

function renderableText(text: string): string {
  return sanitizeTerminalDisplayText(text, { stripSgr: true });
}

export async function waitForChatInputApi(
  inputApiRef: React.MutableRefObject<ChatInputApi | null>,
  {
    retryCount = EDITOR_INPUT_API_RETRY_COUNT,
    retryDelayMs = EDITOR_INPUT_API_RETRY_DELAY_MS,
  }: { retryCount?: number; retryDelayMs?: number } = {}
): Promise<ChatInputApi | null> {
  for (let attempt = 0; attempt < retryCount; attempt += 1) {
    if (inputApiRef.current) {
      return inputApiRef.current;
    }

    await new Promise((resolve) => {
      setTimeout(resolve, retryDelayMs);
    });
  }

  return inputApiRef.current;
}

function buildModeBorderText(width: number, label: string): string {
  const boundedWidth = Math.max(1, Math.floor(width));
  if (boundedWidth === 1) return '╭';
  if (boundedWidth === 2) return '╭╮';

  const labelSegment = `── ${label} `;
  const interiorWidth = boundedWidth - 2;
  if (getDisplayWidth(labelSegment) > interiorWidth) {
    return `╭${'─'.repeat(interiorWidth)}╮`;
  }

  return `╭${labelSegment}${'─'.repeat(
    interiorWidth - getDisplayWidth(labelSegment)
  )}╮`;
}

export function resolveChatInputRunningSessionHint({
  enableQueuedMessages,
  runningSessionHint,
  runningSessionSteerOnlyHint,
}: {
  enableQueuedMessages?: boolean;
  runningSessionHint: string;
  runningSessionSteerOnlyHint: string;
}): string {
  return enableQueuedMessages
    ? runningSessionHint
    : runningSessionSteerOnlyHint;
}

export function resolveChatInputDisplayPlaceholder({
  isBashExecuting,
  isSessionRunning,
  isBashMode,
  isFirstMessage,
  isSpecMode,
  isMissionMode,
  executingCommand,
  runningSessionHint,
  specPlaceholder,
  missionPlaceholder,
  placeholder,
  randomPlaceholder,
}: {
  isBashExecuting?: boolean;
  isSessionRunning?: boolean;
  isBashMode?: boolean;
  isFirstMessage?: boolean;
  isSpecMode?: boolean;
  isMissionMode?: boolean;
  executingCommand: string;
  runningSessionHint: string;
  specPlaceholder: string;
  missionPlaceholder: string;
  placeholder?: string;
  randomPlaceholder?: string;
}): string {
  if (isBashExecuting) {
    return executingCommand;
  }
  if (isSessionRunning && !isBashMode) {
    return runningSessionHint;
  }
  if (!isFirstMessage) {
    return placeholder ?? '';
  }
  if (isSpecMode) {
    return specPlaceholder;
  }
  if (isMissionMode) {
    return missionPlaceholder;
  }
  return placeholder || randomPlaceholder || '';
}

// Optimized cursor line component to minimize DOM operations
function CursorLineComponent({
  text,
  cursorCol,
  color,
  dim,
  isTerminalFocused,
  isFocused,
}: {
  text: string;
  cursorCol: number;
  color?: string;
  dim?: boolean;
  isTerminalFocused?: boolean;
  isFocused?: boolean;
}) {
  const beforeCursor = text.substring(0, cursorCol);
  const atCursor = text.charAt(cursorCol) || ' ';
  const afterCursor = text.substring(cursorCol + 1);

  const displayBefore = renderableText(beforeCursor);
  const displayAt = renderableText(atCursor) || ' ';
  const displayAfter = renderableText(afterCursor);

  // When terminal or input is out of focus, just render the full text without cursor
  if (isTerminalFocused === false || isFocused === false) {
    return (
      <Text color={color} dimColor={dim || isFocused === false}>
        {renderableText(text)}
      </Text>
    );
  }

  return (
    <>
      <Text color={color} dimColor={dim}>
        {displayBefore}
      </Text>
      <Text inverse>{displayAt}</Text>
      <Text color={color} dimColor={dim}>
        {displayAfter}
      </Text>
    </>
  );
}

CursorLineComponent.propTypes = {
  text: PropTypes.string.isRequired,
  cursorCol: PropTypes.number.isRequired,
  color: PropTypes.string,
  dim: PropTypes.bool,
  isTerminalFocused: PropTypes.bool,
};

const CursorLine = React.memo(CursorLineComponent);
CursorLine.displayName = 'CursorLine';

interface InputLineProps {
  line: string;
  index: number;
  isCurrentLine: boolean;
  cursorCol: number;
  isEmpty: boolean;
  displayPlaceholder: string;
  isBashMode: boolean;
  isBashExecuting: boolean;
  stableKey: string;
  isTerminalFocused?: boolean;
  isFocused?: boolean;
  isSpecMode?: boolean;
  isMissionMode?: boolean;
  commandHints?: Record<string, string>;
  specLabel?: string;
  missionLabel?: string;
}

// Optimized line component with React.memo to prevent unnecessary re-renders
function InputLineComponent({
  line,
  index,
  isCurrentLine,
  cursorCol,
  isEmpty,
  displayPlaceholder,
  isBashMode,
  isBashExecuting,
  stableKey,
  isTerminalFocused,
  isFocused,
  isSpecMode,
  isMissionMode,
  commandHints,
  specLabel,
  missionLabel,
}: InputLineProps) {
  const isFirstLine = index === 0;
  const commandHintText = isFirstLine
    ? commandHints?.[line.toLowerCase()]
    : undefined;
  const lineText = isEmpty && isFirstLine ? displayPlaceholder : line;

  // Pre-calculate colors and symbols
  const promptColor = isBashMode
    ? LINE_COLORS.prompt.bash
    : isMissionMode
      ? COLORS.success
      : isSpecMode
        ? COLORS.spec
        : LINE_COLORS.prompt.normal;
  const isPlaceholder = isEmpty && isFirstLine;

  const promptSymbol = isFirstLine
    ? isBashMode
      ? isBashExecuting
        ? PROMPT_SYMBOLS.executing
        : PROMPT_SYMBOLS.bash
      : (isSpecMode || isMissionMode) && isWindows
        ? PROMPT_SYMBOLS.spec
        : PROMPT_SYMBOLS.normal
    : PROMPT_SYMBOLS.continuation;

  return (
    <Box key={stableKey} width="100%">
      {(isSpecMode || isMissionMode) && isWindows && isFirstLine ? (
        <>
          <Text color={isSpecMode ? COLORS.spec : COLORS.agi}>
            {isSpecMode ? specLabel || 'Spec' : missionLabel || 'Mission'}{' '}
          </Text>
          <Text color={promptColor}>&gt; </Text>
        </>
      ) : (
        <Text color={promptColor}>{promptSymbol}</Text>
      )}
      {!isCurrentLine ? (
        <Text dimColor={isPlaceholder || !isFocused}>
          {renderableText(lineText)}
        </Text>
      ) : (
        // Optimized cursor line rendering
        <CursorLine
          text={lineText}
          cursorCol={cursorCol}
          dim={isPlaceholder}
          isTerminalFocused={isTerminalFocused}
          isFocused={isFocused}
        />
      )}
      {commandHintText && isCurrentLine && (
        <Text dimColor>{commandHintText}</Text>
      )}
    </Box>
  );
}

InputLineComponent.propTypes = {
  line: PropTypes.string.isRequired,
  index: PropTypes.number.isRequired,
  isCurrentLine: PropTypes.bool.isRequired,
  cursorCol: PropTypes.number.isRequired,
  isEmpty: PropTypes.bool.isRequired,
  displayPlaceholder: PropTypes.string.isRequired,
  isBashMode: PropTypes.bool.isRequired,
  isBashExecuting: PropTypes.bool.isRequired,
  stableKey: PropTypes.string.isRequired,
  isTerminalFocused: PropTypes.bool,
  isSpecMode: PropTypes.bool,
  isMissionMode: PropTypes.bool,
  commandHints: PropTypes.objectOf(PropTypes.string),
  specLabel: PropTypes.string,
  missionLabel: PropTypes.string,
};

const InputLine = React.memo(InputLineComponent, (prevProps, nextProps) => {
  // Custom comparison function for React.memo

  // For non-cursor lines, ignore cursorCol and cursor-specific props
  if (!prevProps.isCurrentLine && !nextProps.isCurrentLine) {
    return (
      prevProps.line === nextProps.line &&
      prevProps.index === nextProps.index &&
      prevProps.isCurrentLine === nextProps.isCurrentLine &&
      prevProps.isEmpty === nextProps.isEmpty &&
      prevProps.displayPlaceholder === nextProps.displayPlaceholder &&
      prevProps.isBashMode === nextProps.isBashMode &&
      prevProps.isBashExecuting === nextProps.isBashExecuting &&
      prevProps.stableKey === nextProps.stableKey &&
      prevProps.isSpecMode === nextProps.isSpecMode &&
      prevProps.isMissionMode === nextProps.isMissionMode
      // Notably NOT comparing cursorCol for non-cursor lines
    );
  }

  // For cursor lines or when cursor status changes, always re-render
  // This ensures cursor line updates properly and handles cursor line transitions
  return false;
});

InputLine.displayName = 'InputLine';

export function ChatInput({
  placeholder = DEFAULTS.INPUT_PLACEHOLDER,
  currentModel,
  onSubmit,
  onEscape,
  onRewindShortcut,
  width = DEFAULTS.INPUT_WIDTH,
  workingDirectory = process.cwd(),
  isFocused = true,
  showHelpHints,
  setShowHelpHints,
  isBashMode = false,
  isBashExecuting = false,
  isSessionRunning = false,
  enableQueuedMessages = false,
  onBashSubmit,
  onModeToggle,
  onAutonomyLevelCycle,
  onModelCycle,
  onReasoningCycle,
  onToggleBashMode,
  isFirstMessage = false,
  disableSlashCommands = false,
  disableFileSuggestions = false,
  inputApiRef,
  initialValue = '',
  initialCursorPosition,
  onInputChange,
  onCursorPositionChange,
  onWarning,
  interactionMode,
  isMissionActive = false,
  onDownArrowAtBottom,
  onQueuedMessagesReviewShortcut,
  onPullQueuedMessageShortcut,
  onCommandMenuVisibilityChange,
}: ChatInputProps) {
  const { t } = useTranslation('common');

  // Get terminal focus state from KeypressProvider
  const { isTerminalFocused } = useKeypressProvider();

  // Get random placeholder text only for the first message
  const randomPlaceholder = useRandomPlaceholder(isFirstMessage && !isBashMode);

  // Check feature flags for command visibility
  const isGitAiEnabled = useFeatureFlagValue(IndustryFeatureFlags.GitAi);
  const isSquadEnabled = useFeatureFlagValue(IndustryFeatureFlags.Squad);
  const isLoopEnabled = useFeatureFlagValue(IndustryFeatureFlags.LoopCommand);
  const isAutomationsEnabled = useFeatureFlagValue(
    IndustryFeatureFlags.SoftwareIndustry
  );
  const isAgentEffectivenessReportFeatureEnabled = useFeatureFlagValue(
    IndustryFeatureFlags.AgentEffectivenessReport
  );
  const [
    isAgentEffectivenessReportVisible,
    setIsAgentEffectivenessReportVisible,
  ] = useState(false);

  useEffect(() => {
    if (!isAgentEffectivenessReportFeatureEnabled) {
      setIsAgentEffectivenessReportVisible(false);
      return;
    }

    let isCurrent = true;
    void getAgentEffectivenessReportVisibility().then((isVisible) => {
      if (isCurrent) {
        setIsAgentEffectivenessReportVisible(isVisible);
      }
    });

    return () => {
      isCurrent = false;
    };
  }, [isAgentEffectivenessReportFeatureEnabled]);

  // Get available commands from registry, filtered by feature flags
  const availableCommands = useMemo(
    () =>
      filterVisibleSlashCommands(commandRegistry.getCommands(), {
        industryEnv: process.env.INDUSTRY_ENV,
        isGitAiEnabled,
        isSquadEnabled,
        isLoopEnabled,
        isAutomationsEnabled,
        isAgentEffectivenessReportVisible,
        isMissionActive,
        isTokenUsageVisible: canViewTokenUsage(),
      }),
    [
      isGitAiEnabled,
      isSquadEnabled,
      isLoopEnabled,
      isAutomationsEnabled,
      isAgentEffectivenessReportVisible,
      isMissionActive,
    ]
  );

  // Suggestions state
  const [suggestions, setSuggestions] = useState<FileSuggestion[]>([]);
  const [selectedSuggestionIndex, setSelectedSuggestionIndex] = useState(0);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [showCommands, setShowCommands] = useState(false);
  const [filteredCommands, setFilteredCommands] = useState(availableCommands);

  useEffect(() => {
    onCommandMenuVisibilityChange?.(showCommands);
  }, [showCommands, onCommandMenuVisibilityChange]);

  // Escape sequence state for keyboard handling
  const [waitingForEscapeChar, setWaitingForEscapeChar] = useState(false);

  // Debounce and stale-result protection for file suggestions
  // - debounceTimerRef: holds the debounce timer to cancel rapid successive calls
  // - fileSuggestionsRequestIdRef: increments on each new request; stale results are discarded
  // - loadingTimerRef: delays showing loading indicator to avoid flicker
  const debounceTimerRef = useRef<NodeJS.Timeout | null>(null);
  const fileSuggestionsRequestIdRef = useRef(0);
  const loadingTimerRef = useRef<NodeJS.Timeout | null>(null);
  const [isLoadingSuggestions, setIsLoadingSuggestions] = useState(false);

  // Image attachments
  const {
    attachedImages,
    isProcessingImage,
    handleImagePaste,
    handleImageFilePathPaste,
    removeImage,
    clearImages,
    clearImagesStateOnly,
    setImages,
    getImagesForSubmission,
  } = useImageAttachments({
    currentModel,
    onWarning,
  });

  // File suggestions handler
  const fileSuggestions = useMemo(
    () =>
      new ChatFileSuggestions({
        workingDirectory,
        maxSuggestions: DEFAULTS.MAX_SUGGESTIONS,
      }),
    [workingDirectory]
  );

  useEffect(() => {
    fileSuggestionsRequestIdRef.current += 1;
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }
    if (loadingTimerRef.current) {
      clearTimeout(loadingTimerRef.current);
      loadingTimerRef.current = null;
    }
    setIsLoadingSuggestions(false);
    setSuggestions([]);
    setShowSuggestions(false);
    setSelectedSuggestionIndex(0);
  }, [fileSuggestions]);

  // Get history service instance
  const historyService = useMemo(() => getHistoryService(), []);
  const runningSessionHint = resolveChatInputRunningSessionHint({
    enableQueuedMessages,
    runningSessionHint: t('chatInput.runningSessionHint'),
    runningSessionSteerOnlyHint: t('chatInput.runningSessionSteerOnlyHint'),
  });

  // Enhanced onSubmit that includes images. Clears local image state
  // immediately so the UI reflects that attachments were sent, while
  // the agent can continue reading from temp files on disk. After the
  // submission completes (successfully or not), clear the on-disk files.
  const handleSubmit = useCallback(
    async (text: string, options?: ChatSubmitOptions) => {
      if (!onSubmit) return;

      const images = getImagesForSubmission();
      const hasImages = images.length > 0;

      if (hasImages) {
        clearImagesStateOnly();
      }

      try {
        if (options) {
          await onSubmit(text, images, options);
        } else {
          await onSubmit(text, images);
        }
      } finally {
        if (hasImages) {
          await clearImages();
        }
      }
    },
    [onSubmit, getImagesForSubmission, clearImagesStateOnly, clearImages]
  );

  // Create stable callback refs to avoid recreating the hook
  const updateSuggestionsRef =
    useRef<(newInput?: string, newCursorPosition?: number) => Promise<void>>(
      undefined
    );
  const selectSuggestionRef =
    useRef<(suggestion: FileSuggestion) => void>(undefined);

  // Create stable callback functions that don't change on every render
  const stableUpdateSuggestions = useCallback(
    async (newInput?: string, newCursorPosition?: number) => {
      await updateSuggestionsRef.current?.(newInput, newCursorPosition);
    },
    []
  );

  const stableSelectSuggestion = useCallback((suggestion: FileSuggestion) => {
    selectSuggestionRef.current?.(suggestion);
  }, []);

  const applyEditorInputToActiveInput = useMemo(() => {
    if (!inputApiRef) {
      return undefined;
    }

    return async (value: string) => {
      const inputApi = await waitForChatInputApi(inputApiRef);
      if (!inputApi) {
        onWarning?.(t('chatInput.editorApplyError'));
        return;
      }

      inputApi.setInput(value);
    };
  }, [inputApiRef, onWarning, t]);

  // Use the keyboard input hook for all keyboard handling and get state from it
  const {
    input,
    cursorPosition,
    layout,
    setInput,
    setCursorPosition,
    editorGuidance,
  } = useChatKeyboardInput({
    showSuggestions,
    showCommands,
    suggestions,
    selectedSuggestionIndex,
    waitingForEscapeChar,
    setSelectedSuggestionIndex,
    setShowSuggestions,
    setShowCommands,
    setWaitingForEscapeChar,
    selectSuggestion: stableSelectSuggestion,
    updateSuggestions: stableUpdateSuggestions,
    onSubmit: handleSubmit,
    onEscape,
    onRewindShortcut,
    isFocused: isFocused && !isBashExecuting,
    showHelpHints,
    setShowHelpHints,
    filteredCommands,
    availableCommands,
    isBashMode,
    enableQueuedMessages,
    onBashSubmit,
    onModeToggle,
    onAutonomyLevelCycle,
    onModelCycle,
    onReasoningCycle,
    historyService,
    onToggleBashMode,
    handleImagePaste,
    handleImageFilePathPaste,
    attachedImages,
    clearImages,
    onWarning,
    initialValue,
    initialCursorPosition,
    onInputChange,
    onCursorPositionChange,
    onEditorInputApplied: applyEditorInputToActiveInput,
    width,
    onDownArrowAtBottom,
    onQueuedMessagesReviewShortcut,
    onPullQueuedMessageShortcut,
  });

  // Expose imperative API to parent when requested
  useEffect(() => {
    if (!inputApiRef) return;
    const api: ChatInputApi = {
      setInput: (value: string) => {
        setInput(value);
        setCursorPosition(value.length);
      },
      setImages,
      appendInput: (text: string) => {
        const next = input ? `${input}\n\n${text}` : text;
        setInput(next);
        setCursorPosition(next.length);
      },
      getInput: () => input,
      closeSuggestions: () => {
        setShowSuggestions(false);
        setShowCommands(false);
      },
    };
    inputApiRef.current = api;
    return () => {
      if (inputApiRef) inputApiRef.current = null;
    };
  }, [inputApiRef, input, setInput, setCursorPosition, setImages]);

  // Handle suggestions state updates in keyboard handler
  // Implements debouncing (120ms) and stale-result protection for file suggestions
  const updateSuggestions = useCallback(
    async (newInput?: string, newCursorPosition?: number) => {
      const textToCheck = newInput ?? input;
      const positionToCheck = newCursorPosition ?? cursorPosition;

      // Check for slash commands (optional) - these are instant (no debounce needed)
      if (!disableSlashCommands) {
        const commandQuery = extractSlashCommandQuery(
          textToCheck,
          positionToCheck
        );
        if (
          commandQuery !== null &&
          !hasCompletedSlashCommand(
            textToCheck.slice(0, positionToCheck),
            availableCommands
          )
        ) {
          const slashMatchStart = performance.now();
          const filtered = matchCommands(availableCommands, commandQuery);
          recordInputLatency(
            Metric.CLI_TUI_SLASH_MATCH_LATENCY,
            performance.now() - slashMatchStart,
            {
              inputKind: 'slash',
              queryLengthBucket: getQueryLengthBucket(commandQuery),
              resultCountBucket: getResultCountBucket(filtered.length),
            }
          );

          if (filtered.length > 0) {
            // Cancel any pending file suggestion debounce/loading when switching to commands
            if (debounceTimerRef.current) {
              clearTimeout(debounceTimerRef.current);
              debounceTimerRef.current = null;
            }
            if (loadingTimerRef.current) {
              clearTimeout(loadingTimerRef.current);
              loadingTimerRef.current = null;
            }
            setIsLoadingSuggestions(false);

            setFilteredCommands(filtered);
            setShowCommands(true);
            setShowSuggestions(false);
            setSuggestions([]);
            setSelectedSuggestionIndex(0);
            return;
          }
        }
      }
      setShowCommands(false);
      setFilteredCommands(availableCommands);

      if (!disableFileSuggestions) {
        if (
          ChatFileSuggestions.isInPathContext({
            text: textToCheck,
            cursorPosition: positionToCheck,
          })
        ) {
          const extraction = ChatFileSuggestions.extractPathQuery({
            text: textToCheck,
            cursorPosition: positionToCheck,
          });
          if (extraction) {
            // Cancel any pending debounce timer before starting a new one
            if (debounceTimerRef.current) {
              clearTimeout(debounceTimerRef.current);
            }

            const doFetch = () => {
              const suggestionsStart = performance.now();
              // Increment request ID for stale-result protection
              const myRequestId = ++fileSuggestionsRequestIdRef.current;

              // Start delayed loading indicator (200ms) to avoid flicker
              if (loadingTimerRef.current) {
                clearTimeout(loadingTimerRef.current);
              }
              loadingTimerRef.current = setTimeout(() => {
                // Only show loading if this request is still current
                if (myRequestId === fileSuggestionsRequestIdRef.current) {
                  setIsLoadingSuggestions(true);
                }
              }, DEFAULTS.FILE_SUGGESTIONS_LOADING_DELAY_MS);

              // Perform the async file suggestions fetch
              void fileSuggestions
                .getSuggestions(extraction.pathQuery)
                .then((fileSuggestionsList) => {
                  recordInputLatency(
                    Metric.CLI_TUI_FILE_SUGGESTION_LATENCY,
                    performance.now() - suggestionsStart,
                    {
                      inputKind: 'at',
                      outcome:
                        fileSuggestionsList === null ? 'cache_miss' : 'ready',
                      queryLengthBucket: getQueryLengthBucket(
                        extraction.pathQuery
                      ),
                      resultCountBucket:
                        fileSuggestionsList === null
                          ? '0'
                          : getResultCountBucket(fileSuggestionsList.length),
                    }
                  );
                  // Stale-result guard: only update state if this is still the latest request
                  if (myRequestId === fileSuggestionsRequestIdRef.current) {
                    // null means the file index cache isn't warm yet — retry
                    if (fileSuggestionsList === null) {
                      debounceTimerRef.current = setTimeout(() => {
                        if (
                          myRequestId === fileSuggestionsRequestIdRef.current
                        ) {
                          doFetch();
                        }
                      }, 200);
                      return;
                    }

                    // Clear loading state
                    if (loadingTimerRef.current) {
                      clearTimeout(loadingTimerRef.current);
                      loadingTimerRef.current = null;
                    }
                    setIsLoadingSuggestions(false);

                    setSuggestions(fileSuggestionsList);
                    setSelectedSuggestionIndex(0);
                    setShowSuggestions(fileSuggestionsList.length > 0);
                  }
                })
                .catch(() => {
                  recordInputLatency(
                    Metric.CLI_TUI_FILE_SUGGESTION_LATENCY,
                    performance.now() - suggestionsStart,
                    {
                      inputKind: 'at',
                      outcome: 'error',
                      queryLengthBucket: getQueryLengthBucket(
                        extraction.pathQuery
                      ),
                    }
                  );
                  // On error, clear loading state if this is still the current request
                  if (myRequestId === fileSuggestionsRequestIdRef.current) {
                    if (loadingTimerRef.current) {
                      clearTimeout(loadingTimerRef.current);
                      loadingTimerRef.current = null;
                    }
                    setIsLoadingSuggestions(false);
                    setSuggestions([]);
                    setShowSuggestions(false);
                  }
                });
            };

            // Skip debounce for bare @ — cached result is instant, nothing to coalesce
            if (!extraction.pathQuery) {
              doFetch();
            } else {
              debounceTimerRef.current = setTimeout(
                doFetch,
                DEFAULTS.FILE_SUGGESTIONS_DEBOUNCE_MS
              );
            }

            return;
          }
        }
      }

      // Not in any suggestion context - clear everything
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = null;
      }
      if (loadingTimerRef.current) {
        clearTimeout(loadingTimerRef.current);
        loadingTimerRef.current = null;
      }
      setIsLoadingSuggestions(false);
      setSuggestions([]);
      setShowSuggestions(false);
    },
    [
      input,
      cursorPosition,
      fileSuggestions,
      availableCommands,
      disableSlashCommands,
      disableFileSuggestions,
    ]
  );

  useEffect(() => {
    if (!showCommands) {
      setFilteredCommands(availableCommands);
      return;
    }

    void updateSuggestions();
  }, [availableCommands, showCommands, updateSuggestions]);

  // Handle suggestion selection
  const selectSuggestion = useCallback(
    (suggestion: FileSuggestion) => {
      // Cancel any pending debounce/loading timers when a suggestion is selected
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = null;
      }
      if (loadingTimerRef.current) {
        clearTimeout(loadingTimerRef.current);
        loadingTimerRef.current = null;
      }
      setIsLoadingSuggestions(false);

      const result = ChatFileSuggestions.completeFilePath({
        text: input,
        cursorPosition,
        selectedSuggestion: suggestion,
      });
      setInput(result.newText);
      setCursorPosition(result.newCursorPosition);
      setShowSuggestions(false);
      setSuggestions([]);
    },
    [input, cursorPosition, setInput, setCursorPosition]
  );

  // Cleanup debounce and loading timers on unmount
  useEffect(
    () => () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }
      if (loadingTimerRef.current) {
        clearTimeout(loadingTimerRef.current);
      }
    },
    []
  );

  // Update the refs with the actual callbacks
  useEffect(() => {
    updateSuggestionsRef.current = updateSuggestions;
    selectSuggestionRef.current = selectSuggestion;
  }, [updateSuggestions, selectSuggestion]);

  const isEmpty = input.length === 0;

  // Override placeholder based on mode
  const isSpecMode = interactionMode === DroolInteractionMode.Spec;
  const isMissionMode = interactionMode === DroolInteractionMode.Mission;
  const displayPlaceholder = resolveChatInputDisplayPlaceholder({
    isBashExecuting,
    isSessionRunning,
    isBashMode,
    isFirstMessage,
    isSpecMode,
    isMissionMode,
    executingCommand: t('chatInput.executingCommand'),
    runningSessionHint,
    specPlaceholder: t('chatInput.specPlaceholder'),
    missionPlaceholder: t('chatInput.missionPlaceholder'),
    placeholder,
    randomPlaceholder,
  });

  const commandHints = useMemo<Record<string, string>>(
    () => ({
      '/btw ': t('chatInput.btwHint'),
      '/bug ': t('chatInput.bugHint'),
      '/rename ': t('chatInput.renameHint'),
      '/compress ': t('chatInput.compressHint'),
      '/create-skill ': t('chatInput.createSkillHint'),
      '/cwd ': t('chatInput.cwdHint'),
      '/language ': t('chatInput.languageHint'),
      '/fast ': t('chatInput.fastHint'),
    }),
    [t]
  );

  const { displayLines, lineMapping, cursorLine, cursorCol } = layout;
  const specLabel = t('modes.spec');
  const missionLabel = t('modes.mission');
  const modeLabel = isSpecMode ? specLabel : missionLabel;
  const modeBorderText = buildModeBorderText(width, modeLabel);
  const belowInputHint =
    isSessionRunning && !isBashMode && !isBashExecuting && !isEmpty
      ? runningSessionHint
      : undefined;

  // Pre-calculate line data with stable keys for performance
  const linesWithKeys = useMemo(
    () =>
      displayLines.map((line, index) => {
        const lineMap = lineMapping[index];
        const stableKey = lineMap
          ? `${lineMap.rawLineIndex}-${lineMap.isWrapped ? index : 0}`
          : `line-${index}`;

        return {
          line,
          index,
          stableKey,
          isCurrentLine: index === cursorLine,
        };
      }),
    [displayLines, lineMapping, cursorLine]
  );

  const inputLines = linesWithKeys.map(
    ({ line, index, stableKey, isCurrentLine }) => (
      <InputLine
        key={stableKey}
        line={line}
        index={index}
        isCurrentLine={isCurrentLine}
        cursorCol={cursorCol}
        isEmpty={isEmpty}
        displayPlaceholder={displayPlaceholder}
        isBashMode={isBashMode}
        isBashExecuting={isBashExecuting}
        stableKey={stableKey}
        isTerminalFocused={isTerminalFocused}
        isFocused={isFocused}
        isSpecMode={isSpecMode}
        isMissionMode={isMissionMode}
        commandHints={commandHints}
        specLabel={specLabel}
        missionLabel={missionLabel}
      />
    )
  );
  const belowInputHintLine = belowInputHint ? (
    <Box paddingLeft={PROMPT_SYMBOLS.continuation.length}>
      <Text dimColor>{belowInputHint}</Text>
    </Box>
  ) : null;
  const editorGuidanceLine = editorGuidance ? (
    <Box paddingLeft={PROMPT_SYMBOLS.continuation.length}>
      <Text dimColor>{editorGuidance}</Text>
    </Box>
  ) : null;

  return (
    <Box flexDirection="column">
      {/* Image attachments display */}
      {(attachedImages.length > 0 || isProcessingImage) && (
        <ImageAttachment
          images={attachedImages}
          onRemove={removeImage}
          isProcessing={isProcessingImage}
          width={width}
        />
      )}

      {/* Input display */}
      {/* When in spec/mission mode on non-Windows, render custom border with mode label */}
      {(isSpecMode || isMissionMode) && !isWindows ? (
        <Box flexDirection="column" width={width}>
          {/* Top border with left-aligned mode label */}
          <Box width={width}>
            <Text color={isSpecMode ? COLORS.spec : COLORS.agi}>
              {modeBorderText}
            </Text>
          </Box>
          {/* Content with side borders */}
          <Box
            borderStyle="round"
            borderColor={isSpecMode ? COLORS.spec : COLORS.agi}
            borderTop={false}
            width={width}
            paddingX={1}
          >
            <Box flexDirection="column" width="100%">
              {inputLines}
              {belowInputHintLine}
              {editorGuidanceLine}
            </Box>
          </Box>
        </Box>
      ) : (
        <Box
          borderStyle={isWindows ? undefined : 'round'}
          borderColor={isWindows ? undefined : COLORS.border}
          width={width}
          paddingX={1}
          paddingY={isWindows ? 1 : 0}
        >
          <Box flexDirection="column" width="100%">
            {inputLines}
            {belowInputHintLine}
            {editorGuidanceLine}
          </Box>
        </Box>
      )}

      {/* File suggestions */}
      {showSuggestions && suggestions.length > 0 && (
        <SelectableList
          items={suggestions.map(
            (suggestion): SelectableListItem => ({
              label: suggestion.label,
              value: suggestion.value,
              fileDisplay: suggestion.fileDisplay,
            })
          )}
          selectedIndex={selectedSuggestionIndex}
          helpText={t('chatInput.navigationHint')}
          width={width}
        />
      )}

      {/* Loading indicator for file suggestions (appears after 200ms delay to avoid flicker) */}
      {isLoadingSuggestions && !showSuggestions && (
        <Box paddingLeft={2}>
          <Text dimColor>{t('chatInput.loadingSuggestions')}</Text>
        </Box>
      )}

      {/* Command suggestions */}
      {showCommands && (
        <CommandSuggestions
          commands={filteredCommands}
          selectedIndex={selectedSuggestionIndex}
          width={width}
        />
      )}
    </Box>
  );
}
