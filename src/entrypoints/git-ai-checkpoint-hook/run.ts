import { spawn } from 'child_process';

import { CommanderError } from 'commander';

import { Metric, Metrics, type MetricLabels } from '@industry/logging';

const GIT_AI_DAEMON_RECOVERY_PATTERN =
  /captured_connect_failed|request_rejected|failed reading daemon response|timed out waiting for trace ingest|Resource temporarily unavailable|control\.sock/i;

type GitAiCheckpointFailureReason =
  | 'stdin_read_failed'
  | 'spawn_error'
  | 'git_ai_nonzero'
  | 'retry_failed_after_restart';

interface GitAiCheckpointWriteOutcome {
  success: boolean;
  durationMs: number;
  failureReason?: GitAiCheckpointFailureReason;
  reason?: 'daemon_congestion_retry';
  statusCode?: number;
}

function writeStderr(message: string): void {
  process.stderr.write(message.endsWith('\n') ? message : `${message}\n`);
}

function recordGitAiCheckpointWriteOutcome({
  success,
  durationMs,
  failureReason,
  reason,
  statusCode,
}: GitAiCheckpointWriteOutcome): void {
  const labels: MetricLabels = {
    status: success ? 'success' : 'failure',
    ...(failureReason ? { failureReason } : {}),
    ...(reason ? { reason } : {}),
    ...(statusCode !== undefined ? { statusCode } : {}),
  };

  try {
    Metrics.addToCounter(Metric.GIT_AI_CHECKPOINT_WRITE_COUNT, 1, labels);
    Metrics.addToCounter(
      success
        ? Metric.GIT_AI_CHECKPOINT_WRITE_SUCCESS_COUNT
        : Metric.GIT_AI_CHECKPOINT_WRITE_FAILURE_COUNT,
      1,
      labels
    );
    Metrics.recordHistogram(
      Metric.GIT_AI_CHECKPOINT_WRITE_LATENCY,
      durationMs,
      labels
    );
  } catch (error) {
    // Telemetry must never affect git-ai hook behavior. The checkpoint hook's
    // stdout is a passthrough protocol, so route to stderr instead of the
    // logging framework (which defaults to stdout when its sink is unset).
    const message = error instanceof Error ? error.message : String(error);
    writeStderr(`[git-ai] failed to record checkpoint telemetry: ${message}`);
  }
}

async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];

    process.stdin.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
    });

    process.stdin.on('end', () => {
      resolve(Buffer.concat(chunks).toString('utf-8'));
    });

    process.stdin.on('error', (err: Error) => {
      reject(err);
    });
  });
}

async function runGitAi(
  gitAiBin: string,
  args: string[],
  input?: string
): Promise<{
  status: number;
  stdout: string;
  stderr: string;
  spawnError?: boolean;
}> {
  return new Promise((resolve) => {
    const child = spawn(gitAiBin, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data) => {
      stdout += data.toString();
    });
    child.stderr.on('data', (data) => {
      stderr += data.toString();
    });
    child.stdin.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code !== 'EPIPE') {
        stderr += error.message;
      }
    });
    child.on('error', (error) => {
      resolve({ status: 1, stdout, stderr: error.message, spawnError: true });
    });
    child.on('close', (code, signal) => {
      resolve({
        status: typeof code === 'number' ? code : signal ? 1 : 0,
        stdout,
        stderr,
      });
    });

    if (input !== undefined) {
      child.stdin.end(input);
    } else {
      child.stdin.end();
    }
  });
}

async function restartGitAi(gitAiBin: string): Promise<void> {
  let result = await runGitAi(gitAiBin, ['bg', 'restart', '--hard']);
  if (result.status === 0) return;

  result = await runGitAi(gitAiBin, ['bg', 'restart']);
  if (result.status === 0) return;

  await runGitAi(gitAiBin, ['bg', 'start']);
}

export async function runGitAiCheckpointHook(
  gitAiBin: string
): Promise<number> {
  const startedAt = Date.now();
  let input: string;
  try {
    input = await readStdin();
  } catch {
    recordGitAiCheckpointWriteOutcome({
      success: false,
      failureReason: 'stdin_read_failed',
      durationMs: Date.now() - startedAt,
    });
    writeStderr('[git-ai] checkpoint hook failed to read stdin');
    return 0;
  }

  const args = ['checkpoint', 'drool', '--hook-input', 'stdin'];
  let result = await runGitAi(gitAiBin, args, input);

  if (
    result.status !== 0 &&
    GIT_AI_DAEMON_RECOVERY_PATTERN.test(result.stderr)
  ) {
    process.stderr.write(result.stderr);
    writeStderr(
      '[git-ai] checkpoint hook detected daemon congestion; restarting git-ai background service and retrying once'
    );
    await restartGitAi(gitAiBin);
    result = await runGitAi(gitAiBin, args, input);

    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
    if (result.status !== 0) {
      recordGitAiCheckpointWriteOutcome({
        success: false,
        failureReason: result.spawnError
          ? 'spawn_error'
          : 'retry_failed_after_restart',
        statusCode: result.status,
        durationMs: Date.now() - startedAt,
      });
      writeStderr(
        '[git-ai] checkpoint retry failed after daemon restart; allowing Drool edit to continue'
      );
      return 0;
    }
    recordGitAiCheckpointWriteOutcome({
      success: true,
      reason: 'daemon_congestion_retry',
      statusCode: result.status,
      durationMs: Date.now() - startedAt,
    });
    return result.status;
  }

  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  recordGitAiCheckpointWriteOutcome({
    success: result.status === 0,
    failureReason:
      result.status === 0
        ? undefined
        : result.spawnError
          ? 'spawn_error'
          : 'git_ai_nonzero',
    statusCode: result.status,
    durationMs: Date.now() - startedAt,
  });
  return result.status;
}

export async function run(options: { gitAiBin: string }): Promise<void> {
  const status = await runGitAiCheckpointHook(options.gitAiBin);
  if (status !== 0) {
    throw new CommanderError(
      status,
      'git-ai-checkpoint-hook',
      `git-ai checkpoint hook exited with status ${status}`
    );
  }
}
