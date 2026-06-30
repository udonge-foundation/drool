/**
 * ACPDaemonAdapter
 *
 * Daemon-mode adapter that orchestrates multiple ACP child processes.
 * Extends ACPAdapter to inherit common functionality (authentication, session listing)
 * while overriding session methods to spawn and route to child processes.
 */
import { RequestError } from '@agentclientprotocol/sdk';
import { v4 as uuidv4 } from 'uuid';

import { DroolProcessManager, DroolProcessMode } from '@industry/drool-sdk';
import { logInfo } from '@industry/logging';
import { getAuthToken, loginWithDeviceCode } from '@industry/runtime/auth';

import packageJson from '../../package.json';
import { ACPAdapter } from '@/acp/ACPAdapter';
import { ChildProcessHandler } from '@/acp/ChildProcessHandler';
import type { ConfigOptionsState } from '@/acp/session/types';
import { getRuntimeAuthConfig } from '@/environment';

import type {
  AuthenticateRequest,
  CancelNotification,
  InitializeRequest,
  InitializeResponse,
  LoadSessionRequest,
  LoadSessionResponse,
  McpServer,
  NewSessionRequest,
  NewSessionResponse,
  PromptRequest,
  PromptResponse,
  ReadTextFileRequest,
  ReadTextFileResponse,
  SetSessionModelRequest,
  SetSessionModelResponse,
  SetSessionModeRequest,
  SetSessionModeResponse,
  WriteTextFileRequest,
  WriteTextFileResponse,
  SessionModeState,
  SessionModelState,
} from '@agentclientprotocol/sdk';

// UNSTABLE: session/resume types not yet in SDK
interface ResumeSessionRequest {
  sessionId: string;
  cwd: string;
  mcpServers?: McpServer[];
  _meta?: Record<string, unknown> | null;
}

interface ResumeSessionResponse {
  models?: SessionModelState | null;
  modes?: SessionModeState | null;
  configOptions?: ConfigOptionsState | null;
  _meta?: Record<string, unknown> | null;
}

// UNSTABLE: session/set_config_option types not yet in SDK
interface SetSessionConfigOptionRequest {
  sessionId: string;
  configId: string;
  value: string;
}

interface SetSessionConfigOptionResponse {
  _meta?: Record<string, unknown> | null;
}

/**
 * ACPDaemonAdapter - orchestrates multiple ACP child processes
 *
 * Inherits from ACPAdapter:
 * - listSessions (reads from SessionService)
 * - authenticate (device pairing flow)
 * - ensureAuthenticated (auth checking)
 * - extMethod (routes to listSessions/resumeSession)
 *
 * Overrides session methods to spawn/forward to children:
 * - initialize, newSession, loadSession, resumeSession
 * - prompt, cancel, setSessionModel, setSessionMode
 * - readTextFile, writeTextFile
 */
export class ACPDaemonAdapter extends ACPAdapter {
  private processManager = new DroolProcessManager();

  private children = new Map<string, ChildProcessHandler>();

  override async initialize(
    request: InitializeRequest
  ): Promise<InitializeResponse> {
    this.protocolVersion = request.protocolVersion ?? 1;
    this.clientCapabilities = request.clientCapabilities ?? null;

    logInfo('[ACPDaemon] Initialize called', {
      version: this.protocolVersion,
    });

    return {
      protocolVersion: this.protocolVersion,
      agentCapabilities: {
        loadSession: true,
        // @ts-expect-error UNSTABLE: session/resume and sessionCapabilities not yet in SDK types
        sessionCapabilities: {
          list: {},
          resume: {},
        },
        promptCapabilities: {
          image: true,
          embeddedContext: true,
        },
        _meta: {
          terminal_output: true,
          'terminal-auth': true,
        },
      },
      agentInfo: {
        name: packageJson.name,
        title: 'Industry Drool (Daemon)',
        version: packageJson.version,
      },
      authMethods: [
        {
          id: 'device-pairing',
          name: 'Login',
          description:
            'Authenticate with Industry using a device pairing code in your browser.',
        },
        {
          id: 'industry-api-key',
          name: 'Industry API Key',
          description:
            'Authenticate using a Industry API key set in the INDUSTRY_API_KEY environment variable.',
        },
      ],
    };
  }

  override async authenticate(params: AuthenticateRequest): Promise<void> {
    if (params.methodId !== 'device-pairing') {
      return super.authenticate(params);
    }

    // Consume the device code that ensureAuthenticated() cached and showed
    // to the client. Pass it to loginWithDeviceCode so the browser opens
    // with the same code the user already sees. If the cached code expired,
    // fall through to the base class which generates a fresh one.
    const cachedAuth = this.isPendingDeviceAuthValid()
      ? this.pendingDeviceAuth!
      : null;
    this.pendingDeviceAuth = null;
    this.pendingDeviceAuthTimestamp = null;

    if (!cachedAuth) {
      return super.authenticate(params);
    }

    try {
      const { openBrowser } = await import('@/utils/openBrowser');
      const flow = loginWithDeviceCode(getRuntimeAuthConfig(), cachedAuth);
      let browserOpened = false;
      for await (const status of flow) {
        if (status.type === 'pending' && !browserOpened) {
          browserOpened = true;
          await openBrowser(status.verificationUriComplete);
        }
      }

      const token = await getAuthToken(getRuntimeAuthConfig());
      if (token) {
        this.authToken = token;
      }
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Authentication failed';
      throw RequestError.internalError(message, 'Device authentication failed');
    }
  }

  private async spawnChildProcess(
    sessionId: string,
    cwd?: string,
    mcpServers?: McpServer[]
  ): Promise<ChildProcessHandler> {
    const isDev = process.env.INDUSTRY_ENV === 'development';

    const extraArgs = ['--session-id', sessionId];
    if (mcpServers && mcpServers.length > 0) {
      // Pass MCP servers as base64-encoded JSON
      extraArgs.push(
        '--mcp-servers',
        Buffer.from(JSON.stringify(mcpServers)).toString('base64')
      );
    }

    const managedProcess = this.processManager.spawn({
      mode: DroolProcessMode.Acp,
      isDevelopment: isDev,
      cwd,
      env: {
        // Child reads auth from shared stored credentials via getAuthToken()
        // Pass client capabilities to child
        ...(this.clientCapabilities
          ? {
              ACP_CLIENT_CAPABILITIES: JSON.stringify(this.clientCapabilities),
            }
          : {}),
      },
      extraArgs,
    });

    const handler = new ChildProcessHandler(
      sessionId,
      managedProcess,
      this.connection
    );
    this.children.set(sessionId, handler);

    logInfo('[ACPDaemon] Spawned child process', {
      sessionId,
      cwd,
      count: mcpServers?.length ?? 0,
    });

    return handler;
  }

  private getChild(sessionId: string): ChildProcessHandler {
    const child = this.children.get(sessionId);
    if (!child) {
      throw RequestError.invalidParams(
        { sessionId },
        'Unknown session identifier'
      );
    }
    return child;
  }

  override async newSession(
    params: NewSessionRequest
  ): Promise<NewSessionResponse> {
    await this.ensureAuthenticated();

    // Generate session ID for the child (standard UUID format)
    const sessionId = uuidv4();

    // Spawn child process with the session ID
    const child = await this.spawnChildProcess(
      sessionId,
      params.cwd,
      params.mcpServers
    );

    // Forward newSession to child (child will use the pre-assigned session ID)
    // Note: We pass sessionId via _meta extension because the SDK strips unknown top-level fields
    try {
      // First, initialize the child with our protocol version and client capabilities
      // This ensures the child knows about terminal support, etc.
      await child.sendRequest('initialize', {
        protocolVersion: this.protocolVersion,
        clientCapabilities: this.clientCapabilities,
      });

      const childParams = {
        ...params,
        _meta: {
          ...(params._meta || {}),
          sessionId, // Pass the pre-generated session ID via _meta
        },
      };
      logInfo('[ACPDaemon] Sending newSession to child', {
        options: JSON.stringify(childParams),
      });
      const response = await child.sendRequest<NewSessionResponse>(
        'session/new',
        childParams
      );

      logInfo('[ACPDaemon] Created new session via child', {
        sessionId,
      });

      return response;
    } catch (error) {
      // Clean up child process on failure to avoid zombie entries
      await child.close();
      this.children.delete(sessionId);
      throw error;
    }
  }

  override async loadSession(
    params: LoadSessionRequest
  ): Promise<LoadSessionResponse> {
    await this.ensureAuthenticated();

    // Spawn or get existing child for this session
    let child = this.children.get(params.sessionId);
    if (!child) {
      child = await this.spawnChildProcess(
        params.sessionId,
        params.cwd,
        params.mcpServers
      );
    }

    try {
      // Initialize the child with our protocol version and client capabilities
      await child.sendRequest('initialize', {
        protocolVersion: this.protocolVersion,
        clientCapabilities: this.clientCapabilities,
      });

      // Forward to child - it handles cwd validation and session loading
      return await child.sendRequest<LoadSessionResponse>(
        'session/load',
        params
      );
    } catch (error) {
      // Clean up child process on failure
      await child.close();
      this.children.delete(params.sessionId);
      throw error;
    }
  }

  override async resumeSession(
    params: ResumeSessionRequest
  ): Promise<ResumeSessionResponse> {
    await this.ensureAuthenticated();

    let child = this.children.get(params.sessionId);
    if (!child) {
      child = await this.spawnChildProcess(
        params.sessionId,
        params.cwd,
        params.mcpServers
      );

      try {
        // Initialize the child with our protocol version and client capabilities
        await child.sendRequest('initialize', {
          protocolVersion: this.protocolVersion,
          clientCapabilities: this.clientCapabilities,
        });

        return await child.sendRequest<ResumeSessionResponse>(
          'session/resume',
          params
        );
      } catch (error) {
        await child.close();
        this.children.delete(params.sessionId);
        throw error;
      }
    }

    return child.sendRequest<ResumeSessionResponse>('session/resume', params);
  }

  override async prompt(params: PromptRequest): Promise<PromptResponse> {
    const child = this.getChild(params.sessionId);
    return child.sendRequest<PromptResponse>('session/prompt', params);
  }

  override async cancel(params: CancelNotification): Promise<void> {
    const child = this.children.get(params.sessionId);
    if (child) {
      await child.sendNotification('session/cancel', params);
    }
  }

  override async setSessionModel(
    params: SetSessionModelRequest
  ): Promise<SetSessionModelResponse> {
    const child = this.getChild(params.sessionId);
    return child.sendRequest<SetSessionModelResponse>(
      'session/set_model',
      params
    );
  }

  override async setSessionMode(
    params: SetSessionModeRequest
  ): Promise<SetSessionModeResponse> {
    const child = this.getChild(params.sessionId);
    return child.sendRequest<SetSessionModeResponse>(
      'session/set_mode',
      params
    );
  }

  /**
   * Forward `session/set_config_option` to the owning child. The child runs
   * the actual SessionController update and emits the corresponding
   * `config_option_update` notification.
   */
  override async setSessionConfigOption(
    params: SetSessionConfigOptionRequest
  ): Promise<SetSessionConfigOptionResponse> {
    const child = this.getChild(params.sessionId);
    return child.sendRequest<SetSessionConfigOptionResponse>(
      'session/set_config_option',
      params
    );
  }

  override async readTextFile(
    params: ReadTextFileRequest
  ): Promise<ReadTextFileResponse> {
    const child = this.getChild(params.sessionId);
    return child.sendRequest<ReadTextFileResponse>('textFile/read', params);
  }

  override async writeTextFile(
    params: WriteTextFileRequest
  ): Promise<WriteTextFileResponse> {
    const child = this.getChild(params.sessionId);
    return child.sendRequest<WriteTextFileResponse>('textFile/write', params);
  }

  async dispose(): Promise<void> {
    logInfo('[ACPDaemon] Disposing, closing all child processes');
    const closePromises: Promise<void>[] = [];
    for (const [sessionId, child] of this.children) {
      logInfo('[ACPDaemon] Closing child', { sessionId });
      closePromises.push(child.close());
    }
    await Promise.all(closePromises);
    this.children.clear();
  }
}
