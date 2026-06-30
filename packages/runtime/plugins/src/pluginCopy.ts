import * as fs from 'fs';
import * as path from 'path';

import { logWarn } from '@industry/logging';

const CLAUDE_PLUGIN_DIR = '.claude-plugin';
const INDUSTRY_PLUGIN_DIR = '.industry-plugin';
const CLAUDE_AGENTS_DIR = 'agents';
const INDUSTRY_DROOLS_DIR = 'drools';
const CLAUDE_MCP_FILE = '.mcp.json';
const INDUSTRY_MCP_FILE = 'mcp.json';

type PluginFormat = 'industry' | 'claude' | 'unknown';

async function directoryExists(dirPath: string): Promise<boolean> {
  try {
    const stats = await fs.promises.stat(dirPath);
    return stats.isDirectory();
  } catch (err) {
    logWarn('Failed to stat plugin directory while copying', { cause: err });
    return false;
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    const stats = await fs.promises.stat(filePath);
    return stats.isFile();
  } catch (err) {
    logWarn('Failed to check plugin file existence', { cause: err });
    return false;
  }
}

async function detectPluginFormat(pluginPath: string): Promise<PluginFormat> {
  const industryPluginDir = path.join(pluginPath, INDUSTRY_PLUGIN_DIR);
  if (await directoryExists(industryPluginDir)) {
    return 'industry';
  }

  const claudePluginDir = path.join(pluginPath, CLAUDE_PLUGIN_DIR);
  if (await directoryExists(claudePluginDir)) {
    return 'claude';
  }

  const agentsDir = path.join(pluginPath, CLAUDE_AGENTS_DIR);
  if (await directoryExists(agentsDir)) {
    return 'claude';
  }

  const claudeMcpFile = path.join(pluginPath, CLAUDE_MCP_FILE);
  if (await fileExists(claudeMcpFile)) {
    return 'claude';
  }

  return 'unknown';
}

async function copyDirectory(
  sourcePath: string,
  destPath: string
): Promise<void> {
  const entries = await fs.promises.readdir(sourcePath, {
    withFileTypes: true,
  });

  const validEntries = entries.filter((entry) => {
    if (entry.isSymbolicLink()) {
      logWarn('Skipping symlink in plugin (copy directory)', {
        path: path.join(sourcePath, entry.name),
      });
      return false;
    }
    return true;
  });

  await Promise.all(
    validEntries.map(async (entry) => {
      const srcPath = path.join(sourcePath, entry.name);
      const dstPath = path.join(destPath, entry.name);

      if (entry.isDirectory()) {
        await fs.promises.mkdir(dstPath, { recursive: true });
        await copyDirectory(srcPath, dstPath);
      } else {
        await fs.promises.copyFile(srcPath, dstPath);
        const srcStats = await fs.promises.stat(srcPath);
        await fs.promises.chmod(dstPath, srcStats.mode);
      }
    })
  );
}

async function copyWithTranslation(
  sourcePath: string,
  destPath: string
): Promise<void> {
  const entries = await fs.promises.readdir(sourcePath, {
    withFileTypes: true,
  });

  const validEntries = entries.filter((entry) => {
    if (entry.isSymbolicLink()) {
      logWarn('Skipping symlink in plugin (copy with translation)', {
        path: path.join(sourcePath, entry.name),
      });
      return false;
    }
    return true;
  });

  await Promise.all(
    validEntries.map(async (entry) => {
      const srcPath = path.join(sourcePath, entry.name);
      let destName = entry.name;

      if (entry.name === CLAUDE_PLUGIN_DIR) {
        destName = INDUSTRY_PLUGIN_DIR;
      } else if (entry.name === CLAUDE_AGENTS_DIR) {
        destName = INDUSTRY_DROOLS_DIR;
      } else if (entry.name === CLAUDE_MCP_FILE) {
        destName = INDUSTRY_MCP_FILE;
      }

      const dstPath = path.join(destPath, destName);

      if (entry.isDirectory()) {
        await fs.promises.mkdir(dstPath, { recursive: true });
        await copyWithTranslation(srcPath, dstPath);
      } else if (entry.name === CLAUDE_MCP_FILE) {
        // Claude Code .mcp.json -> Industry mcp.json: wrap server map under
        // `mcpServers` if it isn't already.
        const content = await fs.promises.readFile(srcPath, 'utf-8');
        const parsed = JSON.parse(content);
        const transformed = parsed.mcpServers ? parsed : { mcpServers: parsed };
        await fs.promises.writeFile(
          dstPath,
          JSON.stringify(transformed, null, 2)
        );
      } else {
        await fs.promises.copyFile(srcPath, dstPath);
        const srcStats = await fs.promises.stat(srcPath);
        await fs.promises.chmod(dstPath, srcStats.mode);
      }
    })
  );
}

export async function copyToCache(
  sourcePath: string,
  destPath: string
): Promise<void> {
  await fs.promises.mkdir(destPath, { recursive: true });

  const format = await detectPluginFormat(sourcePath);

  if (format === 'claude') {
    await copyWithTranslation(sourcePath, destPath);
  } else {
    await copyDirectory(sourcePath, destPath);
  }
}
