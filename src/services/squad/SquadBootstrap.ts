import { ReasoningEffort } from '@industry/drool-sdk-ext/protocol/llm';
import {
  AutonomyLevel,
  DroolInteractionMode,
} from '@industry/drool-sdk-ext/protocol/shared';
import { logException } from '@industry/logging';
import { MetaError } from '@industry/logging/errors';

import {
  getModelDefaultReasoningEffort,
  getTuiModelConfig,
} from '@/models/config';
import { getTuiDaemonAdapter } from '@/services/daemon/TuiDaemonAdapter';
import { getSessionService } from '@/services/SessionService';
import { SQUAD_AGENT_INACTIVITY_TIMEOUT_MS } from '@/services/squad/constants';
import { SquadRole, SquadStatus } from '@/services/squad/enums';
import {
  buildSquadOrchestratorBootstrapPrompt,
  buildSquadOrchestratorResumePrompt,
  buildSquadWorkerBootstrapPrompt,
  buildSquadWorkerResumePrompt,
} from '@/services/squad/prompts';
import {
  assignAgentSession,
  getSquadState,
  markAgentErrored,
  updateSquadStatus,
} from '@/services/squad/SquadStateService';
import { getSquadWakeupScheduler } from '@/services/squad/SquadWakeupScheduler';
import type { SquadBootstrapResult } from '@/services/squad/types';

function resolveReasoningEffort(modelId: string): ReasoningEffort {
  const modelConfig = getTuiModelConfig(modelId);
  const supportedEfforts = modelConfig.supportedReasoningEfforts ?? [];
  if (supportedEfforts.includes(ReasoningEffort.High)) {
    return ReasoningEffort.High;
  }
  return getModelDefaultReasoningEffort(modelId);
}

export async function startSquad(
  squadId: string,
  options?: { resume?: boolean }
): Promise<SquadBootstrapResult> {
  const squad = await getSquadState(squadId);
  if (!squad) {
    throw new MetaError('Squad was not found', { value: { squadId } });
  }

  const modelId = getSessionService().getModel();
  const reasoningEffort = resolveReasoningEffort(modelId);
  const client = getTuiDaemonAdapter();

  let spawnedAgents = 0;
  const failedAgentIds: string[] = [];
  let orchestratorSessionId: string | null = null;

  const orchestrator = squad.agents.find(
    (agent) => agent.role === SquadRole.Orchestrator
  );
  const workers = squad.agents.filter(
    (agent) => agent.role === SquadRole.Worker
  );
  const orderedAgents = orchestrator ? [orchestrator, ...workers] : workers;

  for (const agent of orderedAgents) {
    try {
      const sessionId = await client.spawnSquadAgent({
        squadId: squad.id,
        agentId: agent.agentId,
        agentName: agent.name,
        role: agent.role,
        cwd: squad.cwd,
        modelId,
        interactionMode: DroolInteractionMode.Auto,
        autonomyLevel: AutonomyLevel.High,
        reasoningEffort,
        inactivityTimeoutMs: SQUAD_AGENT_INACTIVITY_TIMEOUT_MS,
      });
      await assignAgentSession({
        squadId: squad.id,
        agentId: agent.agentId,
        sessionId,
      });

      if (agent.role === SquadRole.Orchestrator) {
        orchestratorSessionId = sessionId;
      }

      await client.addUserMessage({
        sessionId,
        text:
          agent.role === SquadRole.Orchestrator
            ? options?.resume
              ? buildSquadOrchestratorResumePrompt(squad, agent)
              : buildSquadOrchestratorBootstrapPrompt(squad, agent)
            : options?.resume
              ? buildSquadWorkerResumePrompt(squad, agent)
              : buildSquadWorkerBootstrapPrompt(squad, agent),
      });

      spawnedAgents += 1;
    } catch (error) {
      failedAgentIds.push(agent.agentId);
      await markAgentErrored({
        squadId: squad.id,
        agentId: agent.agentId,
      });
      logException(error, '[SquadBootstrap] Failed to start squad agent', {
        teamId: squad.id,
        droolId: agent.agentId,
      });
    }
  }

  await updateSquadStatus(
    squad.id,
    spawnedAgents > 0 ? SquadStatus.Running : SquadStatus.Stopped
  );

  if (orchestratorSessionId && spawnedAgents > 0) {
    getSquadWakeupScheduler().start({
      squadId: squad.id,
      orchestratorSessionId,
    });
  }

  return {
    squadId: squad.id,
    spawnedAgents,
    failedAgentIds,
  };
}
