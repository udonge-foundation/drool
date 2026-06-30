import { MetaError } from '@industry/logging/errors';

import type {
  ITerminalService,
  TerminalCreateParams,
  TerminalOutputOptions,
} from '@/services/TerminalService/types';
import { summarizeCLIOutput } from '@/tools/executors/client/shell/cli-summarizer';

import type {
  AgentSideConnection,
  TerminalHandle,
  TerminalOutputResponse,
  WaitForTerminalExitResponse,
} from '@agentclientprotocol/sdk';

const DEFAULT_OUTPUT_BYTE_LIMIT = 1048576; // 1MB

interface HostTerminalState {
  handle: TerminalHandle;
  toolId?: string;
}

export class HostTerminalService implements ITerminalService {
  private terminals = new Map<string, HostTerminalState>();

  private toolTerminals = new Map<string, Set<string>>();

  private connection: AgentSideConnection;

  private sessionId: string;

  constructor(connection: AgentSideConnection, sessionId: string) {
    this.connection = connection;
    this.sessionId = sessionId;
  }

  async create(params: TerminalCreateParams): Promise<{ terminalId: string }> {
    const handle = await this.connection.createTerminal({
      sessionId: this.sessionId,
      command: params.command,
      args: params.args,
      cwd: params.cwd,
      env: params.env,
      outputByteLimit: params.outputByteLimit ?? DEFAULT_OUTPUT_BYTE_LIMIT,
    });

    this.terminals.set(handle.id, { handle, toolId: params.toolId });

    if (params.toolId) {
      if (!this.toolTerminals.has(params.toolId)) {
        this.toolTerminals.set(params.toolId, new Set());
      }
      this.toolTerminals.get(params.toolId)!.add(handle.id);
    }

    return { terminalId: handle.id };
  }

  async getOutput(
    terminalId: string,
    options?: TerminalOutputOptions
  ): Promise<TerminalOutputResponse> {
    const state = this.terminals.get(terminalId);
    if (!state) {
      throw new MetaError(`Unknown terminal: ${terminalId}`, { terminalId });
    }

    const result =
      (await state.handle.currentOutput()) as TerminalOutputResponse;
    const mode = options?.mode;
    const maxBytes = options?.maxBytes;
    if (!mode && maxBytes === undefined) {
      return result;
    }

    let output = result.output ?? '';
    let truncated = !!result.truncated;

    const tailByBytes = (text: string, limit: number): string => {
      if (limit <= 0) return '';
      if (Buffer.byteLength(text, 'utf-8') <= limit) return text;
      const buf = Buffer.from(text, 'utf-8');
      return buf.slice(Math.max(0, buf.length - limit)).toString('utf-8');
    };

    if (mode === 'summary') {
      const summarized = summarizeCLIOutput(output);
      if (summarized !== output) {
        truncated = true;
      }
      output = summarized;
    }

    if (mode === 'tail') {
      const limit = maxBytes ?? DEFAULT_OUTPUT_BYTE_LIMIT;
      if (Buffer.byteLength(output, 'utf-8') > limit) {
        truncated = true;
        output = tailByBytes(output, limit);
      }
    } else if (maxBytes !== undefined) {
      if (Buffer.byteLength(output, 'utf-8') > maxBytes) {
        truncated = true;
        output = tailByBytes(output, maxBytes);
      }
    }

    return { ...result, output, truncated };
  }

  async getOutputFile(): Promise<{ path: string; sizeBytes: number } | null> {
    return null;
  }

  async waitForExit(terminalId: string): Promise<WaitForTerminalExitResponse> {
    const state = this.terminals.get(terminalId);
    if (!state) {
      throw new MetaError(`Unknown terminal: ${terminalId}`, { terminalId });
    }
    return state.handle.waitForExit();
  }

  async kill(terminalId: string): Promise<void> {
    const state = this.terminals.get(terminalId);
    if (state) {
      await state.handle.kill();
    }
  }

  async release(terminalId: string): Promise<void> {
    const state = this.terminals.get(terminalId);
    if (state) {
      await state.handle.kill().catch(() => {});
      await state.handle.release();
      if (state.toolId) {
        const toolTerminalIds = this.toolTerminals.get(state.toolId);
        if (toolTerminalIds) {
          toolTerminalIds.delete(terminalId);
          if (toolTerminalIds.size === 0) {
            this.toolTerminals.delete(state.toolId);
          }
        }
      }
      this.terminals.delete(terminalId);
    }
  }

  async releaseAll(): Promise<void> {
    const terminalIds = Array.from(this.terminals.keys());
    await Promise.all(terminalIds.map((id) => this.release(id)));
  }

  async killByToolId(toolId: string): Promise<void> {
    const terminalIds = this.toolTerminals.get(toolId);
    if (!terminalIds || terminalIds.size === 0) {
      return;
    }
    const idsToKill = Array.from(terminalIds);
    await Promise.all(
      idsToKill.map(async (terminalId) => {
        await this.kill(terminalId);
        await this.release(terminalId);
      })
    );
  }
}
