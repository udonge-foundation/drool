import { SoftwareIndustryTriageInputReportSchema } from '@industry/common/api/software-industry';

import { getAuthHeaders } from '@/api/config';
import { fetchBackend } from '@/api/fetchBackend';

interface RecordTriageInputOptions {
  automationId: string;
  runId: string;
  messagesConsumed: string;
  occurredAt?: string;
}

const ENDPOINT = '/api/v1/software-industry/triage-inputs';

function writeStderr(message: string): void {
  process.stderr.write(`${message}\n`);
}

export async function run(options: RecordTriageInputOptions): Promise<void> {
  const occurredAt =
    options.occurredAt !== undefined
      ? Number.parseInt(options.occurredAt, 10)
      : Date.now();

  const parsed = SoftwareIndustryTriageInputReportSchema.safeParse({
    automationId: options.automationId,
    runId: options.runId,
    messagesConsumed: Number.parseInt(options.messagesConsumed, 10),
    occurredAt,
  });
  if (!parsed.success) {
    writeStderr('Error: invalid triage input report arguments');
    process.exitCode = 1;
    return;
  }

  // Built-in CLI auth. The backend restricts this route to service principals,
  // so an interactive (human) session is rejected with a 403 — this command is
  // only usable by the scheduled triage automation, not invokable by humans.
  const headers = await getAuthHeaders();
  if (!headers.Authorization) {
    writeStderr('Error: not authenticated');
    process.exitCode = 1;
    return;
  }

  try {
    const response = await fetchBackend(ENDPOINT, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify(parsed.data),
    });
    if (!response.ok) {
      const body = await response.text().catch(() => 'unknown');
      writeStderr(
        `Error: triage input report failed (${response.status}): ${body}`
      );
      process.exitCode = 1;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    writeStderr(`Error: triage input report request failed: ${message}`);
    process.exitCode = 1;
  }
}
