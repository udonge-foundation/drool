import * as fsSync from 'fs';
import * as fs from 'fs/promises';

import { parse as parseJsonc, type ParseError } from 'jsonc-parser';

import { logWarn } from '@industry/logging';

import type {
  McpOAuthReconnectionBannerOptions,
  McpOAuthReconnectionBannerStatus,
} from './types';

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasApiKeyField(config: Record<string, unknown>): boolean {
  return Object.prototype.hasOwnProperty.call(config, 'apiKey');
}

function isOAuthStyleHttpMcpConfig(config: unknown): boolean {
  return (
    isObjectRecord(config) && config.type === 'http' && !hasApiKeyField(config)
  );
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

function fileExistsSync(filePath: string): boolean {
  try {
    fsSync.accessSync(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

async function readOAuthStyleHttpServerNames(
  filePath: string
): Promise<string[]> {
  let content: string;
  try {
    content = await fs.readFile(filePath, 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    logWarn(
      '[McpOAuthReconnectionBanner] Failed to read MCP config file async',
      {
        path: filePath,
        cause: error,
      }
    );
    return [];
  }

  const parseErrors: ParseError[] = [];
  const parsed: unknown = parseJsonc(content, parseErrors);
  if (parseErrors.length > 0 || !isObjectRecord(parsed)) {
    logWarn(
      '[McpOAuthReconnectionBanner] Failed to parse MCP config file async',
      {
        path: filePath,
        errorCount: parseErrors.length,
      }
    );
    return [];
  }

  const servers = parsed.mcpServers;
  if (!isObjectRecord(servers)) {
    return [];
  }

  return Object.entries(servers)
    .filter(([, config]) => isOAuthStyleHttpMcpConfig(config))
    .map(([name]) => name);
}

function readOAuthStyleHttpServerNamesSync(filePath: string): string[] {
  let content: string;
  try {
    content = fsSync.readFileSync(filePath, 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    logWarn(
      '[McpOAuthReconnectionBanner] Failed to read MCP config file sync',
      {
        path: filePath,
        cause: error,
      }
    );
    return [];
  }

  const parseErrors: ParseError[] = [];
  const parsed: unknown = parseJsonc(content, parseErrors);
  if (parseErrors.length > 0 || !isObjectRecord(parsed)) {
    logWarn(
      '[McpOAuthReconnectionBanner] Failed to parse MCP config file sync',
      {
        path: filePath,
        errorCount: parseErrors.length,
      }
    );
    return [];
  }

  const servers = parsed.mcpServers;
  if (!isObjectRecord(servers)) {
    return [];
  }

  return Object.entries(servers)
    .filter(([, config]) => isOAuthStyleHttpMcpConfig(config))
    .map(([name]) => name);
}

export async function getMcpOAuthReconnectionBannerStatus({
  oauthDataFilePath,
  mcpConfigFilePaths,
}: McpOAuthReconnectionBannerOptions): Promise<McpOAuthReconnectionBannerStatus> {
  if (await fileExists(oauthDataFilePath)) {
    return { shouldShow: false, serverNames: [] };
  }

  const names = new Set<string>();
  const uniqueConfigPaths = [...new Set(mcpConfigFilePaths)];
  await Promise.all(
    uniqueConfigPaths.map(async (filePath) => {
      const serverNames = await readOAuthStyleHttpServerNames(filePath);
      for (const serverName of serverNames) {
        names.add(serverName);
      }
    })
  );

  const serverNames = [...names].sort((left, right) =>
    left.localeCompare(right)
  );
  return { shouldShow: serverNames.length > 0, serverNames };
}

export function getMcpOAuthReconnectionBannerStatusSync({
  oauthDataFilePath,
  mcpConfigFilePaths,
}: McpOAuthReconnectionBannerOptions): McpOAuthReconnectionBannerStatus {
  if (fileExistsSync(oauthDataFilePath)) {
    return { shouldShow: false, serverNames: [] };
  }

  const names = new Set<string>();
  const uniqueConfigPaths = [...new Set(mcpConfigFilePaths)];
  for (const filePath of uniqueConfigPaths) {
    const serverNames = readOAuthStyleHttpServerNamesSync(filePath);
    for (const serverName of serverNames) {
      names.add(serverName);
    }
  }

  const serverNames = [...names].sort((left, right) =>
    left.localeCompare(right)
  );
  return { shouldShow: serverNames.length > 0, serverNames };
}
