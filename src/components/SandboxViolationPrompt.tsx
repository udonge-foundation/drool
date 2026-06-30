/**
 * SandboxViolationPrompt — renders a sandbox violation confirmation prompt
 * with dynamic options based on violation type.
 *
 * Shows: path/domain, operation type, reason, and org-deny status.
 */

import { Box, Text } from 'ink';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import {
  ToolConfirmationOutcome,
  type SandboxViolationConfirmationDetails,
  type ToolConfirmationListItem,
} from '@industry/drool-sdk-ext/protocol/drool';

import { COLORS } from '@/components/chat/themedColors';
import { SelectableList } from '@/components/SelectableList';
import { useKeypressProvider } from '@/contexts/KeypressProvider';
import { useKeypressHandler } from '@/hooks/useKeypressHandler';
import { setLastSandboxPromptOutcome } from '@/sandbox/SandboxPermissionPrompt';

interface SandboxViolationPromptProps {
  details: SandboxViolationConfirmationDetails;
  options: (ToolConfirmationListItem & {
    selectedColor: string;
    selectedPrefix?: string;
  })[];
  toolUseId: string;
  onConfirm: (
    outcome: ToolConfirmationOutcome,
    approvedToolIds?: string[]
  ) => void | Promise<void>;
  isFocused?: boolean;
  width?: number;
}

export function SandboxViolationPrompt({
  details,
  options,
  toolUseId,
  onConfirm,
  isFocused = true,
  width = 60,
}: SandboxViolationPromptProps) {
  const { t } = useTranslation();
  const [selectedIndex, setSelectedIndex] = useState(0);
  const keypressProvider = useKeypressProvider();

  const promptOptions = useMemo(() => options, [options]);

  const handleConfirm = async (outcome: ToolConfirmationOutcome) => {
    setLastSandboxPromptOutcome(outcome);
    if (outcome === ToolConfirmationOutcome.Cancel) {
      await onConfirm(outcome, []);
    } else {
      await onConfirm(outcome, [toolUseId]);
    }
  };

  useKeypressHandler(
    async (_input, key) => {
      if (key.escape) {
        await handleConfirm(ToolConfirmationOutcome.Cancel);
      } else if (key.upArrow) {
        setSelectedIndex((prev) =>
          prev <= 0 ? promptOptions.length - 1 : prev - 1
        );
      } else if (key.downArrow) {
        setSelectedIndex((prev) =>
          prev >= promptOptions.length - 1 ? 0 : prev + 1
        );
      } else if (key.return) {
        await handleConfirm(
          promptOptions[selectedIndex].value as ToolConfirmationOutcome
        );
      }
    },
    { isActive: isFocused && keypressProvider.isEnabled }
  );

  const operationLabel =
    details.violationType === 'network'
      ? 'network access'
      : `${details.operationType} access`;

  const indent = 3;

  return (
    <Box flexDirection="column" width={width} marginLeft={indent} marginTop={1}>
      <Text color={COLORS.highlightDanger} bold>
        {t('common:sandbox.violationHeader')}: {operationLabel}{' '}
        {t('common:sandbox.blocked')}
      </Text>
      <Box flexDirection="column" paddingLeft={2}>
        <Text wrap="wrap">{details.target}</Text>
        <Text wrap="wrap" color={COLORS.text.muted}>
          {details.reason}
        </Text>
        {details.isOrgDeny && (
          <Text color={COLORS.highlight} wrap="wrap">
            {t('common:sandbox.orgDenyWarning')}
          </Text>
        )}
      </Box>
      <SelectableList
        items={promptOptions}
        selectedIndex={selectedIndex}
        helpText="↑↓ to select, Enter to confirm, Esc to deny"
        marginTop={0}
      />
    </Box>
  );
}
