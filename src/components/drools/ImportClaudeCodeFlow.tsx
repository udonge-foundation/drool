import { Box, Text } from 'ink';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { logException } from '@industry/logging';

import { COLORS } from '@/components/chat/themedColors';
import { useKeypressHandler } from '@/hooks/useKeypressHandler';
import {
  detectClaudeCodeSubagents,
  importClaudeCodeSubagents,
} from '@/utils/drools/claudeCodeImport';
import type { ClaudeCodeSubagent, ImportResult } from '@/utils/drools/types';

interface ImportClaudeCodeFlowProps {
  onComplete: () => void;
  onCancel: () => void;
}

type ImportState = 'detecting' | 'selecting' | 'importing' | 'complete';

export function ImportClaudeCodeFlow({
  onComplete,
  onCancel,
}: ImportClaudeCodeFlowProps) {
  const { t } = useTranslation('common');
  const [state, setState] = useState<ImportState>('detecting');
  const [projectSubagents, setProjectSubagents] = useState<
    ClaudeCodeSubagent[]
  >([]);
  const [personalSubagents, setPersonalSubagents] = useState<
    ClaudeCodeSubagent[]
  >([]);
  const [selectedSubagents, setSelectedSubagents] = useState<Set<string>>(
    new Set()
  );
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [importResults, setImportResults] = useState<ImportResult[]>([]);
  const [error, setError] = useState<string | null>(null);

  // Combine all subagents for display
  const allSubagents = [...projectSubagents, ...personalSubagents];

  useEffect(() => {
    const detectSubagents = async () => {
      try {
        const detected = await detectClaudeCodeSubagents();
        setProjectSubagents(detected.project);
        setPersonalSubagents(detected.personal);

        if (detected.totalCount === 0) {
          setError(t('importClaudeCode.noSubagentsFound'));
          setState('complete');
        } else {
          // Pre-select all non-existing subagents
          const toSelect = new Set<string>();
          [...detected.project, ...detected.personal].forEach((s) => {
            if (!s.exists) {
              toSelect.add(`${s.location}:${s.name}`);
            }
          });
          setSelectedSubagents(toSelect);
          setState('selecting');
        }
      } catch (err) {
        logException(
          err,
          'Failed to detect Claude Code subagents in import flow'
        );
        setError(t('importClaudeCode.failedDetect'));
        setState('complete');
      }
    };

    void detectSubagents();
  }, []);

  const handleImport = async () => {
    setState('importing');
    setError(null);

    try {
      const toImport = allSubagents.filter((s) =>
        selectedSubagents.has(`${s.location}:${s.name}`)
      );

      if (toImport.length === 0) {
        setError(t('importClaudeCode.noSelected'));
        setState('complete');
        return;
      }

      const results = await importClaudeCodeSubagents(toImport, {
        overwrite: true,
        skipExisting: false,
      });

      setImportResults(results);
      setState('complete');
    } catch (err) {
      logException(err, 'Failed to import subagents in import flow');
      setError(t('importClaudeCode.failedImportError'));
      setState('complete');
    }
  };

  const toggleSelection = (key: string) => {
    const newSelection = new Set(selectedSubagents);
    if (newSelection.has(key)) {
      newSelection.delete(key);
    } else {
      newSelection.add(key);
    }
    setSelectedSubagents(newSelection);
  };

  const toggleAll = () => {
    if (selectedSubagents.size === allSubagents.length) {
      setSelectedSubagents(new Set());
    } else {
      const all = new Set<string>();
      allSubagents.forEach((s) => {
        all.add(`${s.location}:${s.name}`);
      });
      setSelectedSubagents(all);
    }
  };

  useKeypressHandler(
    (_input, key) => {
      if (key.escape) {
        onCancel();
        return;
      }

      if (state === 'selecting') {
        if (key.upArrow) {
          setSelectedIndex((prev) => Math.max(0, prev - 1));
          return;
        }
        if (key.downArrow) {
          setSelectedIndex((prev) =>
            Math.min(allSubagents.length - 1, prev + 1)
          );
          return;
        }

        // Space to toggle selection
        if (_input === ' ' && allSubagents[selectedIndex]) {
          const subagent = allSubagents[selectedIndex];
          toggleSelection(`${subagent.location}:${subagent.name}`);
          setError(null); // Clear any previous error
          return;
        }

        // 'a' to toggle all
        if (_input === 'a' || _input === 'A') {
          toggleAll();
          setError(null); // Clear any previous error
          return;
        }

        // Enter to import
        if (key.return) {
          // Only import if at least one subagent is selected
          if (selectedSubagents.size === 0) {
            setError(t('importClaudeCode.selectAtLeast'));
            return;
          }
          void handleImport();
          return;
        }
      }

      if (state === 'complete' && key.return) {
        onComplete();
      }
    },
    { isActive: true }
  );

  // Render detecting state
  if (state === 'detecting') {
    return (
      <Box
        borderStyle="round"
        borderColor={COLORS.border}
        paddingX={2}
        paddingY={1}
      >
        <Box flexDirection="column">
          <Text bold>{t('importClaudeCode.title')}</Text>
          <Box marginTop={1} />
          <Text color={COLORS.primary}>{t('importClaudeCode.detecting')}</Text>
        </Box>
      </Box>
    );
  }

  // Render importing state
  if (state === 'importing') {
    return (
      <Box
        borderStyle="round"
        borderColor={COLORS.border}
        paddingX={2}
        paddingY={1}
      >
        <Box flexDirection="column">
          <Text bold>{t('importClaudeCode.title')}</Text>
          <Box marginTop={1} />
          <Text color={COLORS.primary}>
            {t('importClaudeCode.importingCount', {
              count: selectedSubagents.size,
            })}
          </Text>
        </Box>
      </Box>
    );
  }

  // Render complete state
  if (state === 'complete') {
    const successCount = importResults.filter((r) => r.success).length;
    const failCount = importResults.filter((r) => !r.success).length;

    return (
      <Box
        borderStyle="round"
        borderColor={COLORS.border}
        paddingX={2}
        paddingY={1}
      >
        <Box flexDirection="column">
          <Text bold>{t('importClaudeCode.title')}</Text>
          <Box marginTop={1} />

          {error ? (
            <Text color={COLORS.error}>{error}</Text>
          ) : importResults.length > 0 ? (
            <>
              <Text color={COLORS.success}>
                {t('importClaudeCode.successImported', {
                  count: successCount,
                  suffix: successCount !== 1 ? 's' : '',
                })}
              </Text>
              {failCount > 0 && (
                <Text color={COLORS.error}>
                  {t('importClaudeCode.failedImport', {
                    count: failCount,
                    suffix: failCount !== 1 ? 's' : '',
                  })}
                </Text>
              )}
              <Box marginTop={1} />
              {importResults.map((result) => (
                <Text
                  key={`${result.location}:${result.name}`}
                  color={result.success ? COLORS.text.muted : COLORS.error}
                >
                  {result.success ? '✓' : '✗'} {result.name} ({result.location}
                  ): {result.message}
                </Text>
              ))}
            </>
          ) : null}

          <Box marginTop={1} />
          <Text color={COLORS.text.muted}>
            {t('importClaudeCode.continueHint')}
          </Text>
        </Box>
      </Box>
    );
  }

  // Render selecting state
  return (
    <Box
      borderStyle="round"
      borderColor={COLORS.border}
      paddingX={2}
      paddingY={1}
    >
      <Box flexDirection="column">
        <Text bold>{t('importClaudeCode.title')}</Text>
        <Text color={COLORS.text.muted}>
          {t('importClaudeCode.foundCount', {
            count: allSubagents.length,
            suffix: allSubagents.length !== 1 ? 's' : '',
          })}
        </Text>
        <Box marginTop={1} />

        {projectSubagents.length > 0 && (
          <>
            <Text color={COLORS.text.secondary}>
              {t('importClaudeCode.projectHeader')}
            </Text>
            {projectSubagents.map((s, idx) => {
              const key = `${s.location}:${s.name}`;
              const globalIdx = idx;
              const isSelected = globalIdx === selectedIndex;
              const isChecked = selectedSubagents.has(key);

              return (
                <Text
                  key={key}
                  color={
                    isSelected
                      ? COLORS.primary
                      : s.exists
                        ? COLORS.text.muted
                        : COLORS.text.primary
                  }
                >
                  {isSelected ? '> ' : '  '}[{isChecked ? 'x' : ' '}] {s.name}
                  {s.exists && (
                    <Text color={COLORS.warning}>
                      {' '}
                      {t('importClaudeCode.alreadyExists')}
                    </Text>
                  )}
                </Text>
              );
            })}
          </>
        )}

        {personalSubagents.length > 0 && (
          <>
            {projectSubagents.length > 0 && <Box marginTop={1} />}
            <Text color={COLORS.text.secondary}>
              {t('importClaudeCode.personalHeader')}
            </Text>
            {personalSubagents.map((s, idx) => {
              const key = `${s.location}:${s.name}`;
              const globalIdx = projectSubagents.length + idx;
              const isSelected = globalIdx === selectedIndex;
              const isChecked = selectedSubagents.has(key);

              return (
                <Text
                  key={key}
                  color={
                    isSelected
                      ? COLORS.primary
                      : s.exists
                        ? COLORS.text.muted
                        : COLORS.text.primary
                  }
                >
                  {isSelected ? '> ' : '  '}[{isChecked ? 'x' : ' '}] {s.name}
                  {s.exists && (
                    <Text color={COLORS.warning}>
                      {' '}
                      {t('importClaudeCode.alreadyExists')}
                    </Text>
                  )}
                </Text>
              );
            })}
          </>
        )}

        <Box marginTop={1} />
        <Text color={COLORS.text.muted}>
          {t('importClaudeCode.selectHint')}
        </Text>
        <Text color={COLORS.text.muted}>
          {t('importClaudeCode.selectedCount', {
            selected: selectedSubagents.size,
            total: allSubagents.length,
          })}
        </Text>

        {error && (
          <Box marginTop={1}>
            <Text color={COLORS.error}>{error}</Text>
          </Box>
        )}
      </Box>
    </Box>
  );
}
