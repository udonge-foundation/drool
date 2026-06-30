import { Box, Text } from 'ink';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { logException } from '@industry/logging';

import { COLORS } from '@/components/chat/themedColors';
import { useKeypressHandler } from '@/hooks/useKeypressHandler';
import {
  findAvailableClaudeCodeSkills,
  importClaudeCodeSkills,
} from '@/utils/skills/claudeCodeImport';

interface ImportItem {
  name: string;
  location: 'project' | 'personal';
  selected: boolean;
  exists: boolean;
  source: string;
  description?: string;
}

interface ImportSkillsTabProps {
  onComplete: () => void;
}

export function ImportSkillsTab({ onComplete }: ImportSkillsTabProps) {
  const { t } = useTranslation();
  const [items, setItems] = useState<ImportItem[]>([]);
  const [selected, setSelected] = useState(0);
  const [loading, setLoading] = useState(true);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const discoverSkills = async () => {
    setLoading(true);
    try {
      const available = await findAvailableClaudeCodeSkills();
      const importItems: ImportItem[] = [];

      available.project.forEach((skill) => {
        importItems.push({
          name: skill.name,
          location: 'project',
          selected: !skill.exists,
          exists: skill.exists,
          source: skill.source,
          description: skill.description,
        });
      });

      available.personal.forEach((skill) => {
        importItems.push({
          name: skill.name,
          location: 'personal',
          selected: !skill.exists,
          exists: skill.exists,
          source: skill.source,
          description: skill.description,
        });
      });

      setItems(importItems);
      setSelected(0);
    } catch (err) {
      logException(err, 'Failed to discover skills');
      setError(t('common:importSkills.failedDiscover'));
    } finally {
      setLoading(false);
    }
  };

  const handleImport = async () => {
    const selectedItems = items.filter((item) => item.selected);

    if (selectedItems.length === 0) {
      setError(t('common:importSkills.noSkillsSelected'));
      return;
    }

    setImporting(true);
    setError(null);

    try {
      const skillsToImport = selectedItems.map((item) => ({
        name: item.name,
        location: item.location,
      }));

      const results = await importClaudeCodeSkills(skillsToImport);
      const successCount = results.imported.length;

      if (successCount > 0) {
        onComplete();
      } else {
        setError(t('common:importSkills.noSkillsImported'));
      }
    } catch (err) {
      logException(err, 'Failed to import skills');
      setError(t('common:importSkills.failedImport'));
    } finally {
      setImporting(false);
    }
  };

  useEffect(() => {
    void discoverSkills();
  }, []);

  useKeypressHandler((input, key) => {
    if (importing) return;

    if (key.upArrow) {
      setSelected((s) => (s <= 0 ? Math.max(items.length - 1, 0) : s - 1));
      return;
    }

    if (key.downArrow) {
      setSelected((s) => (s >= items.length - 1 ? 0 : s + 1));
      return;
    }

    if (input === ' ' && items[selected] && !items[selected].exists) {
      const newItems = [...items];
      newItems[selected].selected = !newItems[selected].selected;
      setItems(newItems);
      return;
    }

    if (key.return) {
      void handleImport();
      return;
    }

    if (input.toLowerCase() === 'a') {
      const newItems = items.map((item) => ({
        ...item,
        selected: !item.exists,
      }));
      setItems(newItems);
    }
  });

  if (loading) {
    return (
      <Text color={COLORS.text.muted}>
        {t('common:importSkills.discovering')}
      </Text>
    );
  }

  if (importing) {
    return (
      <Text color={COLORS.primary}>{t('common:importSkills.importing')}</Text>
    );
  }

  const selectedCount = items.filter((i) => i.selected).length;

  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Text color={COLORS.text.muted}>
          {t('common:importSkills.foundSelected', {
            found: items.length,
            selected: selectedCount,
          })}
        </Text>
      </Box>

      {items.length === 0 ? (
        <Text color={COLORS.text.muted}>
          {t('common:importSkills.noSkillsFound')}
        </Text>
      ) : (
        items.map((item, index) => {
          const isSelected = selected === index;
          return (
            <Box key={`${item.location}:${item.name}`} flexDirection="row">
              <Text
                color={
                  isSelected
                    ? COLORS.text.primary
                    : item.exists
                      ? COLORS.text.muted
                      : COLORS.text.primary
                }
                bold={isSelected}
              >
                [{item.selected ? 'x' : ' '}] {item.name}
              </Text>
              {item.description && (
                <Text color={COLORS.text.muted}> - {item.description}</Text>
              )}
              <Text color={COLORS.text.muted}> ({item.location})</Text>
              {item.exists && (
                <Text color={COLORS.warning}>
                  {' '}
                  {t('common:importSkills.existsLabel')}
                </Text>
              )}
            </Box>
          );
        })
      )}

      {error && (
        <Box marginTop={1}>
          <Text color={COLORS.error}>
            {t('common:importSkills.errorPrefix', { error })}
          </Text>
        </Box>
      )}
    </Box>
  );
}
