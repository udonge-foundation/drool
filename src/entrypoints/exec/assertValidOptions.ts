import chalk from 'chalk';
import { z } from 'zod';

import { ReasoningEffort } from '@industry/drool-sdk-ext/protocol/llm';
import { AutonomyLevel } from '@industry/drool-sdk-ext/protocol/shared';
import { MetaError } from '@industry/logging/errors';
import { getProcessEnvironment } from '@industry/utils/environment';
import { findCustomModel } from '@industry/utils/models';

import { InputFormat, OutputFormat } from '@/commands/enums';
import { ExecCommandOptions } from '@/commands/types';
import { getI18n } from '@/i18n';
import { getSettingsService } from '@/services/SettingsService';
import {
  resolveModelId,
  getInvalidModelErrorMessage,
} from '@/utils/modelResolution';
import { validateModelAccess } from '@/utils/modelValidation';

function writeStderr(message: string): void {
  process.stderr.write(`${message}\n`);
}

const execModeSchema = z.object({
  outputFormat: z
    .enum([
      'text',
      'json',
      'stream-json',
      'stream-jsonrpc',
      'acp',
      'acp-daemon',
      'debug',
    ]) // 'debug' is deprecated alias for 'stream-json'
    .optional()
    .default('text'),
  auto: z.nativeEnum(AutonomyLevel).optional(),
  skipPermissionsUnsafe: z.boolean().optional(),
  model: z.string().trim().optional(),
  reasoningEffort: z.nativeEnum(ReasoningEffort).optional(),
  workerModel: z.string().trim().optional(),
  workerReasoningEffort: z.nativeEnum(ReasoningEffort).optional(),
  validatorModel: z.string().trim().optional(),
  validatorReasoningEffort: z.nativeEnum(ReasoningEffort).optional(),
  cwd: z.string().optional(),
  sessionId: z.string().optional(),
  fork: z.string().optional(),
  file: z.string().optional(),
  enabledTools: z.array(z.string()).optional().default([]),
  disabledTools: z.array(z.string()).optional().default([]),
  listTools: z.boolean().optional().default(false),
  // Request ID temporarily used by web app, will be managed by industryd in the future
  requestId: z.string().optional(),
});

export async function assertValidOptions(
  options: ExecCommandOptions
): Promise<void> {
  // Custom mutual-exclusivity and friendly validations first
  const allowedOutputFormats = new Set<OutputFormat>([
    OutputFormat.Text,
    OutputFormat.Json,
    OutputFormat.StreamJson,
    OutputFormat.StreamJsonrpc,
    OutputFormat.Acp,
    OutputFormat.AcpDaemon,
    OutputFormat.Debug, // deprecated alias for 'stream-json'
  ]);
  const allowedAuto = new Set(['low', 'medium', 'high']);
  if (typeof options.model === 'string') {
    options.model = options.model.trim();
    if (!options.model) {
      options.model = undefined;
    }
  }

  if (options.model) {
    const resolved = await resolveModelId(options.model);

    if (!resolved.exists) {
      const errorMessage = await getInvalidModelErrorMessage(options.model);
      writeStderr(chalk.red(errorMessage));
      throw new MetaError(errorMessage);
    }

    options.model = resolved.modelId;

    // Validate model against organization policy
    const settingsService = getSettingsService();
    const validation = validateModelAccess(
      options.model,
      settingsService.getModelPolicy(),
      options.model.startsWith('custom:')
        ? findCustomModel(options.model, settingsService.getCustomModels())
        : null,
      getProcessEnvironment()
    );

    if (!validation.allowed) {
      throw new MetaError(
        getI18n().t('commands:assertValidOptions.modelBlockedByPolicy')
      );
    }
  }

  if (typeof options.fork === 'string') {
    options.fork = options.fork.trim();
    if (!options.fork) {
      options.fork = undefined;
    }
  }

  // Validate and resolve spec model if provided
  if (typeof options.specModel === 'string') {
    options.specModel = options.specModel.trim();
    if (!options.specModel) {
      options.specModel = undefined;
    }
  }

  if (options.specModel) {
    const resolved = await resolveModelId(options.specModel);

    if (!resolved.exists) {
      const errorMessage = await getInvalidModelErrorMessage(options.specModel);
      writeStderr(chalk.red(errorMessage));
      throw new MetaError(errorMessage);
    }

    options.specModel = resolved.modelId;

    // Validate spec model against organization policy
    const settingsService = getSettingsService();
    const validation = validateModelAccess(
      options.specModel,
      settingsService.getModelPolicy(),
      options.specModel.startsWith('custom:')
        ? findCustomModel(options.specModel, settingsService.getCustomModels())
        : null,
      getProcessEnvironment()
    );

    if (!validation.allowed) {
      throw new MetaError(
        getI18n().t('commands:assertValidOptions.specModelBlockedByPolicy')
      );
    }
  }

  const t = getI18n().t;

  // Streaming input mode validation
  if (options.inputFormat === 'stream-json') {
    const outputFormat = options.outputFormat;
    if (
      outputFormat !== OutputFormat.StreamJson &&
      outputFormat !== OutputFormat.Debug
    ) {
      throw new MetaError(
        t('commands:assertValidOptions.streamJsonRequiresStreamJson')
      );
    }
    // Emit deprecation warning
    writeStderr(
      chalk.yellow(t('commands:assertValidOptions.streamJsonDeprecated'))
    );
  }

  if (options.inputFormat === 'stream-jsonrpc') {
    const outputFormat = options.outputFormat;
    if (outputFormat !== OutputFormat.StreamJsonrpc) {
      throw new MetaError(
        t('commands:assertValidOptions.streamJsonRpcRequiresStreamJsonRpc')
      );
    }
  }

  if (options.auto && options.skipPermissionsUnsafe) {
    throw new MetaError(t('commands:assertValidOptions.autoAndSkipConflict'));
  }

  if (options.sessionId && options.fork) {
    throw new MetaError(
      t('commands:assertValidOptions.sessionIdAndForkConflict')
    );
  }

  // Mission mode validation
  if (options.mission) {
    if (!options.skipPermissionsUnsafe && options.auto !== AutonomyLevel.High) {
      throw new MetaError(
        'Invalid flags: --mission requires --auto high or --skip-permissions-unsafe. The orchestrator needs high autonomy to manage workers.'
      );
    }
    if (options.useSpec || options.specModel) {
      throw new MetaError(
        'Invalid flags: --mission cannot be used with --use-spec or --spec-model.'
      );
    }
    if (options.sessionId) {
      throw new MetaError(
        'Invalid flags: --mission cannot be used with --session-id. Mission mode starts a fresh orchestrator session.'
      );
    }
    if (options.fork) {
      throw new MetaError(t('commands:assertValidOptions.forkWithMission'));
    }
    if (
      options.inputFormat === InputFormat.StreamJson ||
      options.inputFormat === InputFormat.StreamJsonrpc
    ) {
      throw new MetaError(
        'Invalid flags: --mission cannot be used with streaming input formats.'
      );
    }

    // Validate & resolve mission worker/validator model overrides
    for (const field of ['workerModel', 'validatorModel'] as const) {
      const raw = options[field];
      if (typeof raw !== 'string') continue;
      const trimmed = raw.trim();
      if (!trimmed) {
        options[field] = undefined;
        continue;
      }
      const resolved = await resolveModelId(trimmed);
      if (!resolved.exists) {
        const errorMessage = await getInvalidModelErrorMessage(trimmed);
        writeStderr(chalk.red(errorMessage));
        throw new MetaError(errorMessage);
      }
      const settingsService = getSettingsService();
      const validation = validateModelAccess(
        resolved.modelId,
        settingsService.getModelPolicy(),
        resolved.modelId.startsWith('custom:')
          ? findCustomModel(resolved.modelId, settingsService.getCustomModels())
          : null,
        getProcessEnvironment()
      );
      if (!validation.allowed) {
        throw new MetaError(
          getI18n().t('commands:assertValidOptions.modelBlockedByPolicy')
        );
      }
      options[field] = resolved.modelId;
    }
  } else {
    if (options.workerModel !== undefined) {
      throw new MetaError(
        'Invalid flags: --worker-model can only be used with --mission.'
      );
    }
    if (options.workerReasoningEffort !== undefined) {
      throw new MetaError(
        'Invalid flags: --worker-reasoning-effort can only be used with --mission.'
      );
    }
    if (options.validatorModel !== undefined) {
      throw new MetaError(
        'Invalid flags: --validator-model can only be used with --mission.'
      );
    }
    if (options.validatorReasoningEffort !== undefined) {
      throw new MetaError(
        'Invalid flags: --validator-reasoning-effort can only be used with --mission.'
      );
    }
  }

  if (options.sessionId && (options.useSpec || options.specModel)) {
    throw new MetaError(t('commands:assertValidOptions.sessionIdWithSpec'));
  }

  if (options.fork && (options.useSpec || options.specModel)) {
    throw new MetaError(t('commands:assertValidOptions.forkWithSpec'));
  }

  if (options.fork && options.worktree !== undefined) {
    throw new MetaError(t('commands:assertValidOptions.forkWithWorktree'));
  }

  if (
    options.fork &&
    (options.inputFormat === InputFormat.StreamJsonrpc ||
      options.outputFormat === OutputFormat.Acp ||
      options.outputFormat === OutputFormat.AcpDaemon)
  ) {
    throw new MetaError(
      t('commands:assertValidOptions.forkUnsupportedProtocolMode')
    );
  }

  if (
    (options.enabledTools?.length ?? 0) > 0 &&
    (options.disabledTools?.length ?? 0) > 0
  ) {
    throw new MetaError(
      t('commands:assertValidOptions.enabledAndDisabledConflict')
    );
  }

  if (options.outputFormat && !allowedOutputFormats.has(options.outputFormat)) {
    throw new MetaError(t('commands:assertValidOptions.invalidOutputFormat'), {
      value: {
        allowed: [...allowedOutputFormats],
        provided: options.outputFormat,
      },
    });
  }

  if (
    typeof options.auto === 'string' &&
    options.auto.length > 0 &&
    !allowedAuto.has(options.auto)
  ) {
    throw new MetaError(t('commands:assertValidOptions.invalidAutoValue'));
  }

  const parsed = execModeSchema.safeParse(options);
  if (!parsed.success) {
    // Provide clearer, user-friendly errors for common enum mismatches
    if (
      options.reasoningEffort &&
      !Object.values(ReasoningEffort).includes(
        options.reasoningEffort as ReasoningEffort
      )
    ) {
      writeStderr(
        chalk.red(t('commands:assertValidOptions.unsupportedReasoningEffort'))
      );
      writeStderr(
        t('commands:assertValidOptions.allowedValues', {
          values: Object.values(ReasoningEffort).join(', '),
        })
      );
    }

    const first = parsed.error.issues[0];
    const message =
      first?.message ?? t('commands:assertValidOptions.invalidOptions');
    throw new MetaError(message);
  }
}
