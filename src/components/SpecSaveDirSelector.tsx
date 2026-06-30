import * as fs from 'fs/promises';

import { Box, Text } from 'ink';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { COLORS } from '@/components/chat/themedColors';
import { MenuContainer } from '@/components/common/MenuContainer';
import { useKeypressHandler } from '@/hooks/useKeypressHandler';
import { useMenuNavigation } from '@/hooks/useMenuNavigation';
import { resolveSpecSaveDirectory } from '@/utils/industryPaths';

interface SpecSaveDirSelectorProps {
  projectIndustryDetected: boolean;
  gitRootDir: string | null;
  initialValue: string;
  onCancel: () => void;
  onSave: (value: string) => void;
}

interface DirOption {
  value: string;
  label: string;
  disabled: boolean;
}

export function SpecSaveDirSelector({
  projectIndustryDetected,
  gitRootDir,
  initialValue,
  onCancel,
  onSave,
}: SpecSaveDirSelectorProps) {
  const { t } = useTranslation();
  const [showCustomInput, setShowCustomInput] = useState(false);
  const [customInput, setCustomInput] = useState(initialValue);
  const [error, setError] = useState<string | null>(null);

  const projectLabel = projectIndustryDetected
    ? t('common:specSaveDir.projectRoot')
    : gitRootDir
      ? t('common:specSaveDir.noIndustryInGit')
      : t('common:specSaveDir.noIndustry');

  const options: DirOption[] = [
    {
      value: '.industry/docs',
      label: projectLabel,
      disabled: !projectIndustryDetected,
    },
    {
      value: '~/.industry/docs',
      label: t('common:specSaveDir.userHome'),
      disabled: false,
    },
    { value: 'custom', label: t('common:specSaveDir.custom'), disabled: false },
  ];

  const getInitialIndex = () => {
    if (initialValue === '.industry/docs' && projectIndustryDetected) {
      return 0;
    }
    if (initialValue === '~/.industry/docs') {
      return 1;
    }
    // For custom paths, default to User Home
    return 1;
  };

  const { selectedIndex } = useMenuNavigation({
    items: options,
    initialIndex: getInitialIndex(),
    isSelectable: (option) => !option.disabled,
    onSelect: (option) => {
      if (option.value === 'custom') {
        setShowCustomInput(true);
      } else {
        onSave(option.value);
      }
    },
    onCancel: showCustomInput
      ? () => {
          setShowCustomInput(false);
          setError(null);
        }
      : onCancel,
    isActive: !showCustomInput,
  });

  // Custom input handling
  useKeypressHandler(
    (input, key) => {
      if (!showCustomInput) return;

      if (key.escape) {
        setShowCustomInput(false);
        setError(null);
        return;
      }

      if (key.return) {
        void (async () => {
          const entered = customInput.trim();
          if (!entered) {
            setError(t('common:specSaveDir.errorEmpty'));
            return;
          }
          const resolved = resolveSpecSaveDirectory(entered);
          try {
            await fs.mkdir(resolved, { recursive: true });
            onSave(entered);
          } catch {
            setError(t('common:specSaveDir.errorInvalid'));
          }
        })();
        return;
      }

      if (key.backspace || key.delete || input === '\x08' || input === '\x7f') {
        setCustomInput((prev) => (prev.length > 0 ? prev.slice(0, -1) : prev));
        return;
      }

      if (input) {
        setCustomInput((prev) => prev + input);
      }
    },
    { isActive: showCustomInput }
  );

  return (
    <MenuContainer title={t('common:specSaveDir.title')}>
      {options.map((option, idx) => {
        const isSelected = idx === selectedIndex;
        const isDisabled = option.disabled;

        return (
          <Text
            key={option.value}
            color={
              isDisabled
                ? COLORS.text.muted
                : isSelected
                  ? COLORS.primary
                  : undefined
            }
          >
            {isSelected ? '> ' : '  '}
            {option.label}
          </Text>
        );
      })}
      {showCustomInput && (
        <>
          <Box marginTop={1} />
          <Text>
            {t('common:specSaveDir.enterCustomPath')}
            {customInput || ''}
          </Text>
          {error && (
            <Text color={COLORS.error}>
              {t('common:specSaveDir.errorPrefix', { error })}
            </Text>
          )}
        </>
      )}
    </MenuContainer>
  );
}

// no default export to satisfy import/no-default-export
