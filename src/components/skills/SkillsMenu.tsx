import { Box, Text } from 'ink';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { SkillLocation } from '@industry/drool-sdk-ext/protocol/settings';

import { COLORS } from '@/components/chat/themedColors';
import { MenuContainer } from '@/components/common/MenuContainer';
import { SKILLS_CONTENT_HEIGHT } from '@/components/skills/constants';
import { ImportSkillsTab } from '@/components/skills/ImportSkillsTab';
import { SkillListTab } from '@/components/skills/SkillListTab';
import { SkillTab } from '@/hooks/enums';
import { useKeypressHandler } from '@/hooks/useKeypressHandler';
import { useTerminalDimensions } from '@/hooks/useTerminalDimensions';

const TABS: SkillTab[] = [SkillTab.Project, SkillTab.Personal, SkillTab.Import];
const TAB_TO_LOCATION: Record<string, SkillLocation> = {
  [SkillTab.Project]: SkillLocation.Project,
  [SkillTab.Personal]: SkillLocation.Personal,
};
interface SkillsMenuProps {
  activeTab: SkillTab;
  onTabChange: (tab: SkillTab) => void;
  onClose: () => void;
}

export function SkillsMenu({
  activeTab,
  onTabChange,
  onClose,
}: SkillsMenuProps) {
  const { t } = useTranslation();
  const { width: terminalWidth } = useTerminalDimensions();
  const [showingDetail, setShowingDetail] = useState(false);

  const isImportTab = activeTab === SkillTab.Import;

  const tabLabels = useMemo(
    () => ({
      [SkillTab.Project]: t('common:skills.tabProject'),
      [SkillTab.Personal]: t('common:skills.tabPersonal'),
      [SkillTab.Import]: t('common:skills.tabImport'),
    }),
    [t]
  );

  useKeypressHandler(
    (input, key) => {
      if (key.escape) {
        onClose();
        return true;
      }

      if (key.tab) {
        const currentIndex = TABS.indexOf(activeTab);
        const newIndex = currentIndex < TABS.length - 1 ? currentIndex + 1 : 0;
        onTabChange(TABS[newIndex]);
        return true;
      }

      return false;
    },
    { isActive: !showingDetail }
  );

  return (
    <MenuContainer
      title={t('common:skills.title')}
      titleBold={false}
      width={terminalWidth}
      headerTabs={
        <Box>
          {TABS.map((tab, index) => {
            const isActive = tab === activeTab;
            return (
              <Box key={tab}>
                {index > 0 && <Text color={COLORS.text.muted}> | </Text>}
                <Text color={isActive ? COLORS.primary : COLORS.text.muted}>
                  {isActive ? '◉' : '○'} {tabLabels[tab]}
                </Text>
              </Box>
            );
          })}
        </Box>
      }
      helpText={
        showingDetail
          ? '↑↓ scroll · PgUp/PgDn page · Esc back'
          : '↑↓ navigate · Enter select · Tab switch tab · Esc cancel'
      }
      showDefaultHelp={false}
    >
      <Box flexDirection="column" height={SKILLS_CONTENT_HEIGHT}>
        {activeTab === SkillTab.Project && (
          <SkillListTab
            key={SkillTab.Project}
            location={TAB_TO_LOCATION[SkillTab.Project]}
            onShowDetail={(skill) => setShowingDetail(!!skill)}
            onCancel={onClose}
          />
        )}
        {activeTab === SkillTab.Personal && (
          <SkillListTab
            key={SkillTab.Personal}
            location={TAB_TO_LOCATION[SkillTab.Personal]}
            onShowDetail={(skill) => setShowingDetail(!!skill)}
            onCancel={onClose}
          />
        )}
        {isImportTab && (
          <ImportSkillsTab onComplete={() => onTabChange(SkillTab.Project)} />
        )}
      </Box>
    </MenuContainer>
  );
}
