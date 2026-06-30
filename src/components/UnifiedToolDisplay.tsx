import { Box, Text } from 'ink';

import { TOOL_RESULT_PENDING_MARKER } from '@industry/common/sessionV2';

import { ABORT_NOTICE_DISPLAY_TEXT } from '@/components/chat/constants';
import { COLORS } from '@/components/chat/themedColors';
import { getToolComponent, DefaultTool } from '@/components/tools/registry';
import { ToolHeaderRenderMode } from '@/components/tools/registry/enums';
import { ExitSpecModeDisplay } from '@/components/tools/special/ExitSpecModeDisplay';
import { ProposeMissionDisplay } from '@/components/tools/special/ProposeMissionDisplay';
import { ToolHeader } from '@/components/tools/ToolHeader';
import { ToolCallStatus } from '@/hooks/enums';
import { ProfiledRegion } from '@/profiling/ProfiledRegion';
import { isUserCancellationMessage } from '@/utils/error-messages';
import { sanitizeTerminalDisplayText } from '@/utils/sanitizeTerminalDisplayText';
import { formatJsonResultAsMarkdown } from '@/utils/tool-result-helpers';

import type { ToolStreamingUpdate } from '@industry/drool-sdk-ext/protocol/drool';

interface UnifiedToolDisplayProps {
  toolUseId?: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  status: ToolCallStatus;
  result?: string;
  isError?: boolean;
  _startTime?: number;
  _endTime?: number;
  // Optional width (columns) available for rendering tool content
  contentWidth?: number;
  progressUpdates?: ToolStreamingUpdate[];
  isDetailedView?: boolean;
  isAwaitingPermission?: boolean;
  hideHeader?: boolean;
  renderRegion?: 'static' | 'dynamic';
}

export function shouldAnimateToolHeader(
  toolName: string,
  status: ToolCallStatus,
  toolInput: Record<string, unknown> = {},
  isAwaitingPermission = false
): boolean {
  const isActiveTool =
    status === ToolCallStatus.Pending || status === ToolCallStatus.Executing;
  if (!isActiveTool) {
    return false;
  }

  if (toolName === 'ExitSpecMode') {
    return typeof toolInput.plan !== 'string';
  }

  if (toolName === 'Execute' && isAwaitingPermission) {
    return false;
  }

  return true;
}

export function UnifiedToolDisplay({
  toolUseId,
  toolName,
  toolInput,
  status,
  result,
  isError = false,
  _startTime,
  _endTime,
  contentWidth,
  progressUpdates,
  isDetailedView = false,
  isAwaitingPermission = false,
  hideHeader = false,
  renderRegion,
}: UnifiedToolDisplayProps) {
  const baseToolComponent = getToolComponent(toolName);

  const sanitizeParameterValue = (value: unknown): unknown => {
    if (typeof value === 'string') {
      return sanitizeTerminalDisplayText(value);
    }

    if (Array.isArray(value)) {
      return value.map(sanitizeParameterValue);
    }

    if (value && typeof value === 'object') {
      const sanitizedObject: Record<string, unknown> = {};

      Object.entries(value).forEach(([key, nestedValue]) => {
        sanitizedObject[key] = sanitizeParameterValue(nestedValue);
      });

      return sanitizedObject;
    }

    return value;
  };

  const sanitizeParameters = (
    parameters: Record<string, unknown> | undefined
  ): Record<string, unknown> | undefined => {
    if (!parameters) {
      return parameters;
    }

    const sanitizedParameters: Record<string, unknown> = {};

    Object.entries(parameters).forEach(([key, value]) => {
      sanitizedParameters[key] = sanitizeParameterValue(value);
    });

    return sanitizedParameters;
  };

  const sanitizeOptional = (value: string | undefined): string | undefined =>
    value === undefined ? undefined : sanitizeTerminalDisplayText(value);
  const sanitizeToolResultContent = (value: unknown): unknown => {
    if (typeof value !== 'string') {
      return sanitizeParameterValue(value);
    }

    const sanitizedText = sanitizeTerminalDisplayText(value);
    try {
      const parsed = JSON.parse(sanitizedText);
      if (parsed && typeof parsed === 'object') {
        return JSON.stringify(sanitizeParameterValue(parsed));
      }
    } catch {
      return sanitizedText;
    }

    return sanitizedText;
  };
  const sanitizedToolInput = sanitizeParameterValue(toolInput) as Record<
    string,
    unknown
  >;
  const sanitizedResult = sanitizeOptional(result);
  const sanitizedProgressUpdates = progressUpdates?.map((update) => ({
    ...update,
    text: sanitizeOptional(update.text),
    error: sanitizeOptional(update.error),
    details: sanitizeOptional(update.details),
    valueSnippet: sanitizeOptional(update.valueSnippet),
    fullOutput: sanitizeOptional(update.fullOutput),
    parameters: sanitizeParameters(update.parameters),
  }));

  const effectiveBaseResult =
    sanitizedResult !== undefined &&
    sanitizedResult !== TOOL_RESULT_PENDING_MARKER
      ? sanitizedResult
      : undefined;
  const displayOverride = baseToolComponent.getDisplayOverride?.({
    toolUseId,
    input: sanitizedToolInput,
    result: effectiveBaseResult,
    isError,
    contentWidth,
    progressUpdates: sanitizedProgressUpdates,
    hideHeader,
  });
  const sanitizedDisplayOverride = displayOverride
    ? {
        toolName: displayOverride.toolName,
        input: sanitizeParameterValue(displayOverride.input) as Record<
          string,
          unknown
        >,
        ...(displayOverride.result !== undefined
          ? {
              result: sanitizeToolResultContent(
                displayOverride.result
              ) as typeof displayOverride.result,
            }
          : {}),
      }
    : undefined;

  const isActiveApplyPatch =
    toolName === 'ApplyPatch' &&
    !isError &&
    (status === ToolCallStatus.Pending || status === ToolCallStatus.Executing);
  if (
    isActiveApplyPatch &&
    !sanitizedDisplayOverride &&
    effectiveBaseResult === undefined
  ) {
    return null;
  }

  const displayToolName = sanitizedDisplayOverride?.toolName ?? toolName;
  const toolComponent = sanitizedDisplayOverride
    ? getToolComponent(displayToolName)
    : baseToolComponent;
  const displayToolInput =
    sanitizedDisplayOverride?.input ?? sanitizedToolInput;
  const displayResult = sanitizedDisplayOverride?.result ?? sanitizedResult;
  const renderDisplayResult =
    !isError &&
    displayToolName.includes('___') &&
    typeof displayResult === 'string' &&
    displayResult !== TOOL_RESULT_PENDING_MARKER
      ? (formatJsonResultAsMarkdown(displayResult) ?? displayResult)
      : displayResult;
  const effectiveResult =
    renderDisplayResult !== undefined &&
    renderDisplayResult !== TOOL_RESULT_PENDING_MARKER
      ? renderDisplayResult
      : undefined;

  // Get the header label for this tool
  const headerLabel = toolComponent.getHeaderLabel(displayToolInput);

  // If we have toolInput but no headerLabel from specific tool, try default.
  // Execute streams `summary` before `command`; don't show that transient input.
  const shouldUseDefaultHeaderLabel =
    displayToolName !== 'Execute' && displayToolName !== 'AskUser';
  const finalLabel =
    headerLabel ||
    (shouldUseDefaultHeaderLabel
      ? DefaultTool.getHeaderLabel(displayToolInput)
      : '');
  const sanitizedLabel = sanitizeTerminalDisplayText(finalLabel);

  const isCancelledByUser =
    isError && typeof result === 'string' && isUserCancellationMessage(result);
  const shouldRenderAbortNotice =
    isCancelledByUser && toolName !== 'StartMissionRun';

  const hasProgressUpdates = Boolean(
    sanitizedProgressUpdates && sanitizedProgressUpdates.length > 0
  );

  // Render the result section when there's actual content, progress updates,
  // or the tool is still executing (so the component can show "Pending...").
  // MCP tools (containing "___") and ConnectorSearch render their own empty-
  // result text, so skip the empty result row during pending/executing to
  // avoid flashing "No output returned" before the call finishes.
  const isMcpTool = displayToolName.includes('___');
  const defersEmptyPendingResult =
    isMcpTool || displayToolName === 'ConnectorSearch';
  const shouldRenderResult =
    effectiveResult !== undefined ||
    hasProgressUpdates ||
    (!defersEmptyPendingResult &&
      (status === ToolCallStatus.Pending ||
        status === ToolCallStatus.Executing));

  const headerRenderMode = isDetailedView
    ? ToolHeaderRenderMode.Detailed
    : isAwaitingPermission
      ? ToolHeaderRenderMode.Confirmation
      : ToolHeaderRenderMode.Standard;

  // Get header parts if available (for mixed styling support)
  const headerParts = toolComponent.getHeaderParts?.(
    displayToolInput,
    contentWidth,
    headerRenderMode
  );
  const sanitizedHeaderParts = headerParts?.map((part) => ({
    ...part,
    text: sanitizeTerminalDisplayText(part.text),
  }));

  // Compute overflow text for the header line (e.g. "...47 more, Ctrl+O to view")
  // Compute overflow text for compact view
  const overflowText =
    !isDetailedView && effectiveResult
      ? toolComponent.getHeaderSuffix?.(effectiveResult, isError)
      : undefined;
  const sanitizedOverflowText = sanitizeOptional(overflowText);

  // Get custom badge if available (e.g. Task tool uses subagent type as badge)
  const badge = toolComponent.getHeaderBadge?.(displayToolInput);
  const sanitizedBadge = badge
    ? {
        ...badge,
        text: sanitizeTerminalDisplayText(badge.text),
      }
    : undefined;

  const marginLeft = 3;
  const headerWidth = contentWidth
    ? Math.max(20, contentWidth - marginLeft)
    : undefined;
  const shouldRenderExitSpecModeDisplay =
    displayToolName === 'ExitSpecMode' &&
    !(renderRegion === 'dynamic' && isAwaitingPermission);

  return (
    <ProfiledRegion id={`ToolDisplay:${displayToolName}`}>
      <Box flexDirection="row" marginLeft={marginLeft}>
        <Box flexGrow={1} flexDirection="column">
          {!hideHeader && (
            <ToolHeader
              toolName={displayToolName}
              headerLabel={sanitizedLabel}
              headerParts={sanitizedHeaderParts}
              overflowText={sanitizedOverflowText}
              badge={sanitizedBadge}
              isPending={shouldAnimateToolHeader(
                displayToolName,
                status,
                displayToolInput,
                isAwaitingPermission
              )}
              contentWidth={headerWidth}
            />
          )}

          {/* Special handling for ExitSpecMode - keep approval-ready plan bodies out of dynamic output because they are committed through <Static>. */}
          {!hideHeader && shouldRenderExitSpecModeDisplay && (
            <ExitSpecModeDisplay
              toolInput={displayToolInput}
              contentWidth={contentWidth}
            />
          )}

          {/* ProposeMission display - keep the proposal in transcript output so it can live in static scrollback during review */}
          {!hideHeader && displayToolName === 'ProposeMission' && (
            <ProposeMissionDisplay
              toolInput={displayToolInput}
              contentWidth={contentWidth}
            />
          )}

          {/* Tool-specific parameter preview (shown immediately) - but not for ExitSpecMode */}
          {!hideHeader &&
            (!displayResult || displayResult === TOOL_RESULT_PENDING_MARKER) &&
            toolComponent.renderPreview && (
              <>
                {toolComponent.renderPreview(
                  displayToolInput,
                  headerRenderMode
                )}
              </>
            )}

          {/* Tool result */}
          {shouldRenderResult && (
            <Box flexDirection="column" marginLeft={1} marginTop={0}>
              {shouldRenderAbortNotice ? (
                <Text color={COLORS.text.muted}>
                  {ABORT_NOTICE_DISPLAY_TEXT}
                </Text>
              ) : isDetailedView && toolComponent.renderDetailedView ? (
                toolComponent.renderDetailedView({
                  toolUseId,
                  input: displayToolInput,
                  result:
                    renderDisplayResult === TOOL_RESULT_PENDING_MARKER
                      ? undefined
                      : renderDisplayResult,
                  isError,
                  contentWidth,
                  progressUpdates: sanitizedProgressUpdates,
                  hideHeader,
                })
              ) : (
                toolComponent.renderResult({
                  toolUseId,
                  input: displayToolInput,
                  result:
                    renderDisplayResult === TOOL_RESULT_PENDING_MARKER
                      ? undefined
                      : renderDisplayResult,
                  isError,
                  contentWidth,
                  progressUpdates: sanitizedProgressUpdates,
                  hideHeader,
                })
              )}
            </Box>
          )}
        </Box>
      </Box>
    </ProfiledRegion>
  );
}
