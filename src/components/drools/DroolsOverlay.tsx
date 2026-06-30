import { Box } from 'ink';

import { CreateDroolFlow } from '@/components/drools/CreateDroolFlow';
import { DeleteDroolFlow } from '@/components/drools/DeleteDroolFlow';
import { DroolsMenu } from '@/components/drools/DroolsMenu';
import { EditDroolFlow } from '@/components/drools/EditDroolFlow';
import { ImportClaudeCodeFlow } from '@/components/drools/ImportClaudeCodeFlow';
import { DroolsFlow } from '@/hooks/enums';
import type { UseDroolsMenu } from '@/hooks/types';

type Props = {
  width: number;
  controller: UseDroolsMenu;
};

export function DroolsOverlay({ width, controller }: Props) {
  const { flow, setFlow, selected, setSelected, close } = controller;

  return (
    <Box width={width}>
      {flow === DroolsFlow.Menu && (
        <DroolsMenu
          onClose={() => {
            close();
          }}
          onCreateDrool={() => {
            setFlow(DroolsFlow.Create);
          }}
          onEditDrool={(drool) => {
            setSelected(drool);
            setFlow(DroolsFlow.Edit);
          }}
          onDeleteDrool={(drool) => {
            setSelected(drool);
            setFlow(DroolsFlow.Delete);
          }}
          onImportDrools={() => {
            setFlow(DroolsFlow.Import);
          }}
        />
      )}
      {flow === DroolsFlow.Create && (
        <CreateDroolFlow
          onComplete={() => {
            setFlow(DroolsFlow.Menu);
          }}
          onCancel={() => {
            setFlow(DroolsFlow.Menu);
          }}
        />
      )}
      {flow === DroolsFlow.Edit && (
        <EditDroolFlow
          drool={selected ?? undefined}
          onComplete={() => {
            setFlow(DroolsFlow.Menu);
            setSelected(null);
          }}
          onCancel={() => {
            setFlow(DroolsFlow.Menu);
            setSelected(null);
          }}
        />
      )}
      {flow === DroolsFlow.Delete && (
        <DeleteDroolFlow
          drool={selected ?? undefined}
          onComplete={() => {
            setFlow(DroolsFlow.Menu);
            setSelected(null);
          }}
          onCancel={() => {
            setFlow(DroolsFlow.Menu);
            setSelected(null);
          }}
        />
      )}
      {flow === DroolsFlow.Import && (
        <ImportClaudeCodeFlow
          onComplete={() => {
            setFlow(DroolsFlow.Menu);
          }}
          onCancel={() => {
            setFlow(DroolsFlow.Menu);
          }}
        />
      )}
    </Box>
  );
}
