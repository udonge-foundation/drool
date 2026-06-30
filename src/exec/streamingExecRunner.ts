import * as readline from 'readline';

import Anthropic from '@anthropic-ai/sdk';

import { logException, logInfo } from '@industry/logging';
import { MetaError } from '@industry/logging/errors';

import { getSessionController } from '@/controllers/SessionController';
import { runRenderlessExec } from '@/exec/renderlessExecRunner';
import { ExecOptions } from '@/exec/types';
import type { SystemInitEvent } from '@/exec/types';
import { EXEC_SYSTEM_PROMPT } from '@/hooks/constants';
import { getDefaultModelId } from '@/models/availability';
import { getModelDefaultReasoningEffort } from '@/models/config';
import { changeSessionWorkingDirectory } from '@/utils/sessionCwd';
import { getRegisteredTools } from '@/utils/toolCatalog';

// Graceful shutdown timeout when stdin closes
const SHUTDOWN_TIMEOUT_MS = 30000; // 30 seconds

/**
 * Run exec in streaming input mode - reads Anthropic.MessageParam messages from stdin
 * and processes each one through the standard exec flow.
 *
 * Messages are expected to be line-delimited JSON (JSONL format).
 * Output is streamed as JSONL events via the existing debug output format.
 */
export async function runStreamingExec(params: {
  sessionId?: string;
  cwd?: string;
  options: ExecOptions;
}): Promise<void> {
  const { sessionId: initialSessionId, cwd, options } = params;

  logInfo('[StreamingExec] Starting streaming input mode', {
    sessionId: initialSessionId,
  });

  return new Promise<void>((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: false,
    });

    // Track session across messages
    let sessionId = initialSessionId;
    let sessionLoaded = false;
    let messageCount = 0;
    let isProcessing = false;
    const messageQueue: string[] = [];
    let systemInitEmitted = false;

    async function processMessages(): Promise<void> {
      isProcessing = true;

      // Process all queued messages sequentially
      while (messageQueue.length > 0) {
        const line = messageQueue.shift()!;
        const trimmedLine = line.trim();

        if (!trimmedLine) {
          // Ignore empty lines, continue to next
          continue;
        }

        try {
          // Parse Anthropic.MessageParam directly
          const message: Anthropic.MessageParam = JSON.parse(trimmedLine);

          logInfo('[StreamingExec] Processing message', {
            role: message.role,
            count: messageCount + 1,
          });

          // Validate message structure
          if (message.role !== 'user') {
            throw new MetaError(
              "Only 'user' messages are accepted via stdin.",
              {
                role: message.role,
              }
            );
          }

          // Extract text content from message
          const text =
            typeof message.content === 'string'
              ? message.content
              : Array.isArray(message.content)
                ? message.content.find((b) => b.type === 'text')?.text || ''
                : '';

          if (!text) {
            throw new MetaError('Message must contain text content');
          }

          // Create or load session on first message
          if (!sessionLoaded) {
            const sessionController = getSessionController();
            if (sessionId) {
              // Load existing session via SessionController
              await sessionController.ensureSessionLoaded(sessionId, cwd);
              if (cwd) {
                await changeSessionWorkingDirectory(process.cwd());
              }
              logInfo('[StreamingExec] Session loaded', { sessionId });
            } else {
              // Create new session via SessionController
              sessionId = await sessionController.createSession({ cwd });
              logInfo('[StreamingExec] Session created', { sessionId });
            }
            sessionLoaded = true;
          }

          // Emit system init event immediately after session creation so
          // background task launchers can capture the session ID early
          if (!systemInitEmitted && sessionId) {
            const tools = getRegisteredTools();
            const toolNames = tools.map((t) => t.llmId || t.id);
            const resolvedModel = options.modelId || getDefaultModelId();
            const resolvedReasoningEffort =
              options.reasoningEffort ||
              getModelDefaultReasoningEffort(resolvedModel);
            const systemInitEvent: SystemInitEvent = {
              type: 'system',
              subtype: 'init',
              cwd: process.cwd(),
              session_id: sessionId,
              tools: toolNames,
              model: resolvedModel,
              reasoning_effort: resolvedReasoningEffort,
            };
            process.stdout.write(`${JSON.stringify(systemInitEvent)}\n`);
            systemInitEmitted = true;
          }

          // At this point sessionId is guaranteed to be defined (either provided or created above)
          const currentSessionId = sessionId!;

          // Run the agent via existing renderless exec runner
          // This automatically handles conversation history, session persistence,
          // tool execution, and writes to session JSONL file
          const result = await runRenderlessExec({
            sessionId: currentSessionId,
            prompt: text,
            opts: {
              modelId: options.modelId,
              reasoningEffort: options.reasoningEffort,
              specModelId: options.specModelId,
              specReasoningEffort: options.specReasoningEffort,
              useSpec: options.useSpec,
              autoLevel: options.autoLevel,
            },
            systemPromptOverride: EXEC_SYSTEM_PROMPT,
          });

          messageCount++;

          // Output already streamed via debug mode, continue to next message
          logInfo('[StreamingExec] Message processed', {
            count: messageCount,
            error: result.isError,
          });
        } catch (error) {
          // Emit error event but don't crash - allow more messages
          const errorEvent = {
            type: 'error',
            source: 'cli' as const,
            message: error instanceof Error ? error.message : String(error),
            timestamp: Date.now(),
            session_id: sessionId || '',
          };
          process.stdout.write(`${JSON.stringify(errorEvent)}\n`);

          logException(
            error instanceof Error ? error : new Error(String(error)),
            '[StreamingExec] Error processing message'
          );
        }
      }

      isProcessing = false;
    }

    // Handle interruption (Ctrl+C)
    const handleSigint = () => {
      logInfo('[StreamingExec] SIGINT received, shutting down');

      const interruptEvent = {
        type: 'error',
        source: 'cli' as const,
        message: 'Streaming session interrupted by user',
        timestamp: Date.now(),
        session_id: sessionId || '',
      };
      process.stdout.write(`${JSON.stringify(interruptEvent)}\n`);

      process.removeListener('SIGINT', handleSigint);
      rl.close();
      resolve();
    };

    // Queue messages as they arrive
    rl.on('line', (line) => {
      logInfo('[StreamingExec] Received line', {
        count: messageQueue.length,
      });
      messageQueue.push(line);

      // Start processing if not already processing
      if (!isProcessing) {
        processMessages().catch((err) => {
          logException(
            err instanceof Error ? err : new Error(String(err)),
            '[StreamingExec] Fatal error in message processing'
          );
          rl.close();
        });
      }
    });

    // Graceful shutdown on stdin close
    rl.on('close', async () => {
      logInfo('[StreamingExec] Stdin closed, waiting for pending messages', {
        count: messageQueue.length,
      });

      // Wait for any in-flight message processing to complete
      const startTime = Date.now();
      while (
        (isProcessing || messageQueue.length > 0) &&
        Date.now() - startTime < SHUTDOWN_TIMEOUT_MS
      ) {
        await new Promise<void>((r) => {
          setTimeout(r, 100);
        });
      }
      if (isProcessing || messageQueue.length > 0) {
        logInfo('[StreamingExec] Timeout waiting for messages to complete', {
          count: messageQueue.length,
        });
      }

      logInfo('[StreamingExec] All messages processed, shutting down', {
        count: messageCount,
        sessionId,
      });

      // Clean up event listeners
      process.removeListener('SIGINT', handleSigint);

      resolve();
    });

    // Register SIGINT handler
    process.on('SIGINT', handleSigint);

    // Keep process alive until stdin closes
    logInfo('[StreamingExec] Waiting for messages on stdin...');
  });
}
