import { Box } from 'ink';

import { HookCommandEditor } from '@/components/hooks/HookCommandEditor';
import { HookMatcherSelector } from '@/components/hooks/HookMatcherSelector';
import { HooksMenu } from '@/components/hooks/HooksMenu';
import { HooksFlow } from '@/hooks/enums';
import type { UseHooksManager } from '@/hooks/types';

type Props = {
  width: number;
  controller: UseHooksManager;
};

export function HooksOverlay({ width, controller }: Props) {
  const {
    flow,
    setFlow,
    selectedHookType,
    setSelectedHookType,
    editingConfig,
    setEditingConfig,
    close,
  } = controller;

  return (
    <Box width={width}>
      {flow === HooksFlow.Menu && (
        <HooksMenu
          onClose={() => {
            close();
          }}
          onSelectHookType={(hookType) => {
            setSelectedHookType(hookType);
            setFlow(HooksFlow.Matcher);
          }}
        />
      )}

      {flow === HooksFlow.Matcher && selectedHookType && (
        <HookMatcherSelector
          hookType={selectedHookType}
          onBack={() => {
            setFlow(HooksFlow.Menu);
            setSelectedHookType(null);
          }}
          onSelectMatcher={(config, _isNew) => {
            setEditingConfig(config);
            setFlow(HooksFlow.Command);
          }}
        />
      )}

      {flow === HooksFlow.Command && selectedHookType !== null && (
        <HookCommandEditor
          hookType={selectedHookType}
          existingConfig={editingConfig}
          isNewMatcher={editingConfig === null}
          onBack={() => {
            setFlow(HooksFlow.Matcher);
            setEditingConfig(null);
          }}
          onSave={() => {
            close();
          }}
        />
      )}
    </Box>
  );
}
