import { Box, Text } from 'ink';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { logException } from '@industry/logging';
import { SettingsManager } from '@industry/runtime/settings';

import { COLORS } from '@/components/chat/themedColors';
import { wrapText } from '@/components/chat/wrapText';
import { getWindowedListSlice } from '@/components/common/getWindowedListSlice';
import { ScrollableDetailView } from '@/components/common/ScrollableDetailView';
import { TextInput } from '@/components/common/TextInput';
import type { DetailLine } from '@/components/common/types';
import { SKILLS_CONTENT_HEIGHT } from '@/components/skills/constants';
import { useMenuNavigation } from '@/hooks/useMenuNavigation';
import { useTerminalDimensions } from '@/hooks/useTerminalDimensions';
import {
  displayWidth as getDisplayWidth,
  padEndByDisplayWidth,
} from '@/utils/displayWidth';
import { cleanPastedText } from '@/utils/pasteHandler';

import type { Skill } from '@industry/common/settings';
import type { SkillLocation } from '@industry/drool-sdk-ext/protocol/settings';

const VISIBLE_COUNT = 8;
const DETAIL_WIDTH_PADDING = 4;

function buildSkillDetailLines(
  skill: Skill,
  wrapWidth: number,
  labels: {
    descriptionLabel: string;
    noDescription: string;
    toolsLabel: string;
    allTools: string;
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
    // (e.g. a SKILL.md checked out with CRLF endings on Windows) does not
    // get written to stdout as a literal \r and overwrite the previous
    // column with the next line of content.
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

  lines.push({ text: skill.metadata.name, color: COLORS.primary, bold: true });
  lines.push({ text: '' });

  lines.push({ text: labels.descriptionLabel });
  pushWrapped(skill.metadata.description || labels.noDescription, {
    color: COLORS.text.muted,
  });
  lines.push({ text: '' });

  lines.push({ text: labels.toolsLabel });
  const tools = skill.metadata.tools;
  if (!tools || tools === 'all') {
    lines.push({ text: labels.allTools, color: COLORS.text.muted });
  } else if (Array.isArray(tools)) {
    for (const toolName of tools) {
      lines.push({ text: `• ${toolName}`, color: COLORS.text.muted });
    }
  } else {
    lines.push({ text: String(tools), color: COLORS.text.muted });
  }
  lines.push({ text: '' });

  lines.push({ text: labels.systemPromptLabel });
  pushWrapped(skill.systemPrompt, { color: COLORS.text.muted });
  lines.push({ text: '' });

  pushWrapped(labels.fileLabel, { color: COLORS.text.muted });

  return lines;
}

interface SkillListTabProps {
  location: SkillLocation;
  onShowDetail: (skill: Skill | null) => void;
  onCancel: () => void;
}

export function SkillListTab({
  location,
  onShowDetail,
  onCancel,
}: SkillListTabProps) {
  const { t } = useTranslation();
  const [skills, setSkills] = useState<Skill[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedSkill, setSelectedSkill] = useState<Skill | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const { width: terminalWidth } = useTerminalDimensions();

  useEffect(() => {
    void (async () => {
      setLoading(true);
      try {
        const settings =
          await SettingsManager.getInstance().getResolvedSettings();
        const loadedSkills = (settings.skills ?? []).filter(
          (s) =>
            s.validationResult.valid &&
            s.metadata.enabled !== false &&
            s.location === location
        );
        setSkills(loadedSkills);
      } catch (err) {
        logException(err, 'Failed to load skills');
      } finally {
        setLoading(false);
      }
    })();
  }, [location]);

  const filteredSkills = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) return skills;
    return skills.filter(
      (s) =>
        s.metadata.name.toLowerCase().includes(query) ||
        s.metadata.description?.toLowerCase().includes(query)
    );
  }, [skills, searchQuery]);

  const menuItems = useMemo(
    () => filteredSkills.map((skill) => ({ type: 'skill' as const, skill })),
    [filteredSkills]
  );

  const { selectedIndex } = useMenuNavigation({
    items: menuItems,
    initialIndex: 0,
    onSelect: (selected) => {
      setSelectedSkill(selected.skill);
      onShowDetail(selected.skill);
    },
    onCancel,
    isActive: !selectedSkill,
    enableCharKeys: false,
  });

  // Handle escape from detail view
  useMenuNavigation({
    items: [{ type: 'back' as const }],
    initialIndex: 0,
    onSelect: () => {
      setSelectedSkill(null);
      onShowDetail(null);
    },
    onCancel: () => {
      setSelectedSkill(null);
      onShowDetail(null);
    },
    isActive: !!selectedSkill,
  });

  if (loading) {
    return (
      <Text color={COLORS.text.muted}>{t('common:skills.loadingSkills')}</Text>
    );
  }

  if (skills.length === 0 && !searchQuery.trim()) {
    const locationLabel =
      location === 'project'
        ? '.industry/skills/[name]/SKILL.md'
        : '~/.industry/skills/[name]/SKILL.md';
    return (
      <Box flexDirection="column">
        <Text color={COLORS.text.muted}>
          {t('common:skills.noSkillsFound', { location })}
        </Text>
        <Box marginTop={1}>
          <Text color={COLORS.text.muted}>
            {t('common:skills.createSkillsHint', { path: locationLabel })}
          </Text>
        </Box>
      </Box>
    );
  }

  if (selectedSkill) {
    const detailLines = buildSkillDetailLines(
      selectedSkill,
      terminalWidth - DETAIL_WIDTH_PADDING,
      {
        descriptionLabel: t('common:skills.descriptionLabel'),
        noDescription: t('common:skills.noDescription'),
        toolsLabel: t('common:skills.toolsLabel'),
        allTools: t('common:skills.allTools'),
        systemPromptLabel: t('common:skills.systemPromptLabel'),
        fileLabel: t('common:skills.fileLabel', {
          path: selectedSkill.filePath,
        }),
      }
    );
    return (
      <ScrollableDetailView
        key={`${selectedSkill.location}:${selectedSkill.metadata.name}`}
        lines={detailLines}
        viewportHeight={SKILLS_CONTENT_HEIGHT}
      />
    );
  }

  const normalizeDescription = (s?: string): string =>
    (s || '').replace(/\s+/g, ' ').trim();

  const showNoResults =
    searchQuery.trim().length > 0 && filteredSkills.length === 0;

  const maxSkillNameLength = Math.max(
    0,
    ...filteredSkills.map((skill) => getDisplayWidth(skill.metadata.name))
  );

  const prefixWidth = 2;
  const separatorWidth = 6;
  const minPadding = 1;
  const borderOverhead = 4;
  const availableForDesc = Math.max(
    0,
    terminalWidth -
      prefixWidth -
      maxSkillNameLength -
      separatorWidth -
      minPadding -
      borderOverhead
  );

  const { windowStart, visibleItems: visibleSlice } = getWindowedListSlice({
    items: menuItems,
    selectedIndex,
    visibleCount: VISIBLE_COUNT,
    anchorRow: 3,
  });
  const end = Math.min(
    windowStart + visibleSlice.length,
    filteredSkills.length
  );

  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <TextInput
          value={searchQuery}
          onChange={(value) => {
            setSearchQuery(cleanPastedText(value));
          }}
          placeholder={t('common:skills.filterPlaceholder')}
        />
      </Box>
      {showNoResults && (
        <Text color={COLORS.text.muted}>
          {t('common:skills.noSkillsMatch', { query: searchQuery })}
        </Text>
      )}
      {filteredSkills.length > VISIBLE_COUNT && (
        <Box marginBottom={1}>
          <Text color={COLORS.text.muted}>
            {t('common:skills.skillRange', {
              start: windowStart + 1,
              end,
              total: filteredSkills.length,
            })}
          </Text>
        </Box>
      )}
      {visibleSlice.map((option, index) => {
        const globalIndex = windowStart + index;
        const isSelected = globalIndex === selectedIndex;

        const rawDescription = normalizeDescription(
          option.skill.metadata.description
        );
        let description =
          rawDescription || t('common:skills.noDescriptionDefault');
        if (availableForDesc <= 3) {
          description = '';
        } else if (description.length > availableForDesc) {
          description = `${description.slice(0, availableForDesc - 3)}...`;
        }

        const toolsSuffix =
          option.skill.metadata.tools && option.skill.metadata.tools.length > 0
            ? ` ${t('common:skills.toolsCount', { count: option.skill.metadata.tools.length })}`
            : '';

        const labelColor: string | undefined = isSelected
          ? COLORS.text.primary
          : COLORS.text.muted;
        return (
          <Box key={`skill-${option.skill.metadata.name}`}>
            <Box width={2}>
              <Text> </Text>
            </Box>
            <Text bold={isSelected} color={labelColor}>
              {padEndByDisplayWidth(
                option.skill.metadata.name,
                maxSkillNameLength
              )}
            </Text>
            <Text bold={isSelected} color={COLORS.text.muted}>
              {'      '}
              {description}
              {toolsSuffix}
            </Text>
          </Box>
        );
      })}
    </Box>
  );
}
