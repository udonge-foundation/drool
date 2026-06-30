import z from 'zod';

import {
  FeatureStatus,
  HandoffSchema,
  MissionState,
} from '@industry/drool-sdk-ext/protocol/drool';
import { CustomModelsSchema } from '@industry/drool-sdk-ext/protocol/settings';

const OptionalNonBlankStringSchema = z.preprocess(
  (value) =>
    typeof value === 'string' && value.trim() === '' ? undefined : value,
  z.string().optional()
);

const OnDiskMissionFeatureSchema = z
  .object({
    id: z.string(),
    description: z.string(),
    status: z.nativeEnum(FeatureStatus),
    skillName: z.string().optional(),
    preconditions: z.array(z.string()).optional(),
    expectedBehavior: z.union([z.array(z.string()), z.string()]).optional(),
    fulfills: z.array(z.string()).optional(),
    milestone: z.string().optional(),
    workerSessionIds: z.array(z.string()).optional(),
    currentWorkerSessionId: z.string().nullable().optional(),
    completedWorkerSessionId: z.string().nullable().optional(),
  })
  .passthrough();

export const HandoffEntrySchema = z.object({
  timestamp: z.string(),
  workerSessionId: z.string(),
  featureId: z.string(),
  milestone: z.string().optional(),
  commitId: OptionalNonBlankStringSchema,
  repoPath: OptionalNonBlankStringSchema,
  handoff: HandoffSchema,
});

export const WorkerHandoffFileSchema = z.object({
  timestamp: z.string(),
  workerSessionId: z.string(),
  featureId: z.string(),
  milestone: z.string().optional(),
  commitId: z.string().optional(),
  successState: z.string().optional(),
  returnToOrchestrator: z.boolean().optional(),
  handoff: HandoffSchema,
});

export const MissionStateFileSchema = z
  .object({
    missionId: z.string().min(1),
    state: z.nativeEnum(MissionState),
    workingDirectory: z.string().min(1),
    createdAt: z.string(),
    updatedAt: z.string(),
    lastReviewedHandoffCount: z.number().nonnegative().optional(),
  })
  .passthrough();

export const FeaturesFileSchema = z
  .object({
    features: z.array(OnDiskMissionFeatureSchema),
  })
  .passthrough();

export const RuntimeCustomModelsFileSchema = z.object({
  customModels: CustomModelsSchema,
});
