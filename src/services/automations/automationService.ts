import { v4 as uuidv4 } from 'uuid';

import {
  Automation,
  AutomationStatus,
  AutomationTriggerType,
  CreateAutomationRequest,
  UpdateAutomationRequest,
} from '@industry/common/api/v0/automations';
import { MetaError } from '@industry/logging/errors';
import { buildAutomationSlug } from '@industry/utils/automations';

import {
  createAutomation as createCloudAutomation,
  deleteAutomation as deleteCloudAutomation,
  getAutomation as getCloudAutomation,
  listAutomations as listCloudAutomations,
  runAutomation as runCloudAutomation,
  updateAutomation as updateCloudAutomation,
} from '@/api/automation';
import {
  createLocalAutomation,
  deleteLocalAutomation,
  editLocalAutomation,
  getLocalAutomation,
  listLocalAutomations,
} from '@/services/automations/automationActions';

import type { AutomationEntry } from '@industry/common/daemon';

// Single fork point for automation operations. `executionLocation` selects the
// computer the automation runs on: `local` delegates to the daemon (filesystem
// automations on this machine), `remote` delegates to the v0 cloud API (an
// automation that runs on another drool computer). The local/remote sub-
// functions are owned elsewhere and intentionally left untouched.

type AutomationExecutionLocation = 'local' | 'remote';

interface CreateAutomationInput {
  executionLocation: AutomationExecutionLocation;
  name: string;
  schedule: string;
  prompt?: string;
  description?: string;
  visualizationInstruction?: string;
  memoryInstruction?: string;
  computerId?: string;
}

interface EditAutomationInput {
  executionLocation: AutomationExecutionLocation;
  automationId: string;
  name?: string;
  description?: string;
  schedule?: string;
  prompt?: string;
  status?: 'active' | 'paused';
  computerId?: string;
}

interface CreateAutomationResult {
  automationId: string;
  /** Present for remote when an immediate run was attempted. */
  runNote?: string;
}

function composeRemotePrompt(input: {
  prompt: string;
  visualizationInstruction?: string;
  memoryInstruction?: string;
}): string {
  const sections = [input.prompt];
  if (input.visualizationInstruction) {
    sections.push(`## Visualization\n\n${input.visualizationInstruction}`);
  }
  if (input.memoryInstruction) {
    sections.push(`## Memory & Evolution\n\n${input.memoryInstruction}`);
  }
  return sections.join('\n\n');
}

function toAutomationStatus(status: 'active' | 'paused'): AutomationStatus {
  return status === 'active'
    ? AutomationStatus.Active
    : AutomationStatus.Paused;
}

// These tools only manage schedule-triggered automations. CI/Slack automations
// share the same v0 endpoints, so every fetched/mutated automation is checked to
// avoid the agent listing, reading, editing, or deleting a non-schedule one.
function isScheduleAutomation(automation: Automation): boolean {
  return automation.triggerType === AutomationTriggerType.Schedule;
}

function assertScheduleAutomation(
  automation: Automation | null,
  automationId: string
): asserts automation is Automation {
  if (!automation) {
    throw new MetaError('Automation not found', {
      reason: 'remote_automation_not_found',
      automationId,
    });
  }
  if (!isScheduleAutomation(automation)) {
    throw new MetaError(
      'Automation is not a scheduled automation and cannot be managed here',
      {
        reason: 'remote_automation_not_schedule',
        automationId,
        data: { triggerType: automation.triggerType },
      }
    );
  }
}

async function createRemoteAutomation(
  input: CreateAutomationInput
): Promise<CreateAutomationResult> {
  if (!input.computerId) {
    throw new MetaError('computerId is required for remote automations', {
      reason: 'remote_automation_missing_computer_id',
    });
  }
  if (!input.prompt) {
    throw new MetaError('prompt is required for remote automations', {
      reason: 'remote_automation_missing_prompt',
    });
  }
  const body: CreateAutomationRequest = {
    id: uuidv4(),
    name: input.name,
    description: input.description ?? '',
    prompt: composeRemotePrompt({
      prompt: input.prompt,
      visualizationInstruction: input.visualizationInstruction,
      memoryInstruction: input.memoryInstruction,
    }),
    triggerType: AutomationTriggerType.Schedule,
    schedule: input.schedule,
    model: '',
    tags: [],
    computerId: input.computerId,
  };
  const automation = await createCloudAutomation(body);
  let runNote: string;
  try {
    const run = await runCloudAutomation(automation.id);
    runNote = `First run started (session ${run.sessionId}).`;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    runNote = `Created, but the immediate run could not be started: ${message}`;
  }
  return { automationId: automation.id, runNote };
}

async function createLocalAutomationEntry(
  input: CreateAutomationInput
): Promise<CreateAutomationResult> {
  const id = buildAutomationSlug(input.name);
  await createLocalAutomation({
    id,
    name: input.name,
    schedule: input.schedule,
    ...(input.prompt ? { instructions: input.prompt } : {}),
    ...(input.visualizationInstruction
      ? { visualDescription: input.visualizationInstruction }
      : {}),
    ...(input.memoryInstruction
      ? { memoryStrategy: input.memoryInstruction }
      : {}),
  });
  return { automationId: id };
}

export async function createAutomation(
  input: CreateAutomationInput
): Promise<CreateAutomationResult> {
  return input.executionLocation === 'remote'
    ? createRemoteAutomation(input)
    : createLocalAutomationEntry(input);
}

// list/read return a discriminated result so callers narrow the local
// (AutomationEntry) vs remote (Automation) shape on `location` without casts.
type ListAutomationsResult =
  | { location: 'local'; automations: AutomationEntry[] }
  | { location: 'remote'; automations: Automation[] };

type ReadAutomationResult =
  | { location: 'local'; automation: AutomationEntry | null }
  | { location: 'remote'; automation: Automation | null };

export async function listAutomations(
  executionLocation: AutomationExecutionLocation
): Promise<ListAutomationsResult> {
  if (executionLocation === 'remote') {
    const { automations } = await listCloudAutomations();
    return {
      location: 'remote',
      automations: automations.filter(isScheduleAutomation),
    };
  }
  return { location: 'local', automations: await listLocalAutomations() };
}

export async function readAutomation(
  executionLocation: AutomationExecutionLocation,
  automationId: string
): Promise<ReadAutomationResult> {
  if (executionLocation === 'remote') {
    const automation = await getCloudAutomation(automationId);
    return {
      location: 'remote',
      automation:
        automation && isScheduleAutomation(automation) ? automation : null,
    };
  }
  return {
    location: 'local',
    automation: await getLocalAutomation(automationId),
  };
}

export async function editAutomation(
  input: EditAutomationInput
): Promise<void> {
  if (input.executionLocation === 'remote') {
    const updates: UpdateAutomationRequest = {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.description !== undefined
        ? { description: input.description }
        : {}),
      ...(input.schedule !== undefined ? { schedule: input.schedule } : {}),
      ...(input.prompt !== undefined ? { prompt: input.prompt } : {}),
      ...(input.status !== undefined
        ? { status: toAutomationStatus(input.status) }
        : {}),
      ...(input.computerId !== undefined
        ? { computerId: input.computerId }
        : {}),
    };
    // The "at least one field" rule lives in the tool input schema's
    // superRefine, which is not carried in the tool-call JSON schema, so it is
    // re-enforced here to reject no-op edits the backend would otherwise accept.
    if (Object.keys(updates).length === 0) {
      throw new MetaError('Provide at least one field to update', {
        reason: 'remote_automation_edit_no_fields',
        automationId: input.automationId,
      });
    }
    const existing = await getCloudAutomation(input.automationId);
    assertScheduleAutomation(existing, input.automationId);
    await updateCloudAutomation(input.automationId, updates);
    return;
  }
  await editLocalAutomation({
    id: input.automationId,
    ...(input.name !== undefined ? { name: input.name } : {}),
    ...(input.prompt !== undefined ? { prompt: input.prompt } : {}),
    ...(input.status !== undefined ? { status: input.status } : {}),
  });
}

export async function deleteAutomation(
  executionLocation: AutomationExecutionLocation,
  automationId: string
): Promise<void> {
  if (executionLocation === 'remote') {
    const existing = await getCloudAutomation(automationId);
    assertScheduleAutomation(existing, automationId);
    await deleteCloudAutomation(automationId);
    return;
  }
  await deleteLocalAutomation(automationId);
}
