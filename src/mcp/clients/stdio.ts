import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  Implementation,
  LoggingMessageNotificationSchema,
} from '@modelcontextprotocol/sdk/types.js';

import { MetaError } from '@industry/logging/errors';

import packageJson from '../../../package.json';
import { ILogger } from '@/mcp/types';

export async function initializeStdioClient({
  serverArgs,
  logger,
  clientInfo,
}: {
  serverArgs: {
    name: string;
    command: string;
    args: string[];
    env?: Record<string, string>;
  };
  logger?: ILogger;
  clientInfo?: Implementation;
}): Promise<{
  client: Client;
  transport: StdioClientTransport;
}> {
  const { name: serverName, command, args, env } = serverArgs;
  const transport = new StdioClientTransport({
    command,
    args,
    env,
    stderr: 'ignore', // Direct output from the MCP servers isn't very useful/actionable currently.
  });

  transport.onerror = (error: Error) => {
    logger?.warn(`Error in MCP server`, {
      name: serverName,
      cause: error,
    });
  };

  transport.onmessage = (message) => {
    logger?.debug(`Received message from MCP server`, {
      name: serverName,
      message,
    });
  };

  transport.onclose = () => {
    logger?.info(`MCP server closed`, { name: serverName });
  };

  // Client initialization with optional custom clientInfo
  const client = new Client(
    clientInfo || {
      name: 'industry-cli',
      title: 'Industry CLI',
      version: packageJson.version,
      websiteUrl: 'https://example.com/',
    }
  );
  try {
    await client.connect(transport);
  } catch (error) {
    throw new MetaError('Failed to connect to MCP server', {
      name: serverName,
      cause: error,
    });
  }

  client.setNotificationHandler(
    LoggingMessageNotificationSchema,
    (notification) => {
      const logData = {
        server: serverName,
        level: notification.params.level,
        logger: notification.params.logger,
        data: notification.params.data,
      };

      const uppercaseLevel = logData.level.toUpperCase();
      switch (logData.level) {
        case 'debug':
          logger?.debug(`[MCP ${uppercaseLevel}]`, logData);
          break;
        case 'info':
        case 'notice':
          logger?.info(`[MCP ${uppercaseLevel}]`, logData);
          break;
        case 'warning':
          logger?.warn(`[MCP ${uppercaseLevel}]`, logData);
          break;
        case 'error':
        case 'critical':
        case 'alert':
        case 'emergency':
          logger?.error(`[MCP ${uppercaseLevel}]`, logData);
          break;
        default:
          logger?.error(`[MCP UNKNOWN (${uppercaseLevel})]`, logData);
      }
    }
  );

  return { client, transport };
}
