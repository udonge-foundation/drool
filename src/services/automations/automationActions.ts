import { MetaError } from '@industry/logging/errors';

import type { LocalAutomationRunRecord } from '@/services/automations/types';
import { getTuiDaemonAdapter } from '@/services/daemon/TuiDaemonAdapter';

import type { AutomationEntry } from '@industry/common/daemon';

interface CreateLocalAutomationParams {
  id: string;
  name: string;
  instructions?: string;
  schedule: string;
  visualDescription?: string;
  memoryStrategy?: string;
}

export async function listLocalAutomations(): Promise<AutomationEntry[]> {
  const controller =
    await getTuiDaemonAdapter().ensureConnectedAndGetController();
  const { automations } = await controller.listAutomations();
  return automations.filter((automation) => automation.path !== '');
}

export async function createLocalAutomation(
  params: CreateLocalAutomationParams
): Promise<void> {
  const controller =
    await getTuiDaemonAdapter().ensureConnectedAndGetController();
  const result = await controller.createAutomation({
    id: params.id,
    name: params.name,
    schedule: params.schedule,
    instructions: params.instructions,
    visualDescription: params.visualDescription,
    memoryStrategy: params.memoryStrategy,
  });
  if (!result.success) {
    throw new MetaError(result.error ?? 'Failed to create automation', {
      reason: 'create_local_automation_failed',
    });
  }
}

export async function getLocalAutomationHistory(
  id: string,
  limit = 5
): Promise<LocalAutomationRunRecord[]> {
  const controller =
    await getTuiDaemonAdapter().ensureConnectedAndGetController();
  const result = await controller.getAutomationHistory(id, limit);
  return result.runs;
}

export async function pauseLocalAutomation(id: string): Promise<void> {
  const controller =
    await getTuiDaemonAdapter().ensureConnectedAndGetController();
  const result = await controller.pauseAutomation(id);
  if (!result.success) {
    throw new MetaError(result.error ?? 'Failed to pause automation', {
      reason: 'pause_local_automation_failed',
    });
  }
}

export async function resumeLocalAutomation(id: string): Promise<void> {
  const controller =
    await getTuiDaemonAdapter().ensureConnectedAndGetController();
  const result = await controller.resumeAutomation(id);
  if (!result.success) {
    throw new MetaError(result.error ?? 'Failed to resume automation', {
      reason: 'resume_local_automation_failed',
    });
  }
}

export async function getLocalAutomation(
  id: string
): Promise<AutomationEntry | null> {
  const automations = await listLocalAutomations();
  return automations.find((automation) => automation.id === id) ?? null;
}

export async function deleteLocalAutomation(id: string): Promise<void> {
  const controller =
    await getTuiDaemonAdapter().ensureConnectedAndGetController();
  const result = await controller.deleteAutomation({
    automationId: id,
    automationDirName: id,
  });
  if (!result.success) {
    throw new MetaError(result.error ?? 'Failed to delete automation', {
      reason: 'delete_local_automation_failed',
    });
  }
}

interface EditLocalAutomationParams {
  id: string;
  name?: string;
  prompt?: string;
  status?: 'active' | 'paused';
}

export async function editLocalAutomation(
  params: EditLocalAutomationParams
): Promise<void> {
  const controller =
    await getTuiDaemonAdapter().ensureConnectedAndGetController();
  if (params.name !== undefined) {
    const result = await controller.renameAutomation({
      automationId: params.id,
      automationDirName: params.id,
      newName: params.name,
    });
    if (!result.success) {
      throw new MetaError(result.error ?? 'Failed to rename automation', {
        reason: 'rename_local_automation_failed',
      });
    }
  }
  if (params.prompt !== undefined) {
    const result = await controller.updateAutomationPrompt({
      automationId: params.id,
      automationDirName: params.id,
      prompt: params.prompt,
    });
    if (!result.success) {
      throw new MetaError(
        result.error ?? 'Failed to update automation prompt',
        { reason: 'update_local_automation_prompt_failed' }
      );
    }
  }
  if (params.status === 'paused') {
    await pauseLocalAutomation(params.id);
  } else if (params.status === 'active') {
    await resumeLocalAutomation(params.id);
  }
}
