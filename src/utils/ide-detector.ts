import { exec, spawn } from 'child_process';
import * as fs from 'fs';
import * as https from 'https';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';

import { logInfo, logError, logException, logWarn } from '@industry/logging';
import { MetaError } from '@industry/logging/errors';
import { getIndustryHome } from '@industry/utils/cli';
import { getIndustryDirName } from '@industry/utils/environment';

import { getIndustryApiConfig } from '@/api/config';
import { fetchBackend } from '@/api/fetchBackend';
import { quoteCommand, parseStdoutLines } from '@/utils/command-utils';
import { IdeType } from '@/utils/enums';

const execAsync = promisify(exec);

/**
 * Interface for IDE detector options
 */
interface IdeDetectorOptions {
  /** Force check even if not in a supported IDE */
  forceCheck?: boolean;
  /** CLI version to use for downloads */
  version?: string;
}

/**
 * Interface for IDE information
 */
interface IdeInfo {
  type: IdeType;
  cliCommand: string;
  platformCommand: string;
  displayName: string;
}

/**
 * IdeDetector class for detecting IDE environment and managing extension installation
 * Supports VSCode, Cursor, and Windsurf IDEs
 */
export class IdeDetector {
  // eslint-disable-next-line no-use-before-define -- singleton pattern requires reference before definition
  private static instance: IdeDetector;

  private isVSCodeTerminal: boolean | null = null;

  private extensionInstalled: boolean | null = null;

  private detectedIde: IdeInfo | null = null;

  private tempDir: string = path.join(
    getIndustryHome(),
    getIndustryDirName(),
    'temp',
    'extensions'
  );

  // Cache for IDE CLI paths - one per IDE type
  private static cliPathCache: Partial<Record<IdeType, string | undefined>> =
    {};

  private readonly EXTENSION_ID =
    process.env.INDUSTRY_ENV === 'production'
      ? 'industry.industry-vscode-extension'
      : 'industry.industry-vscode-extension-dev';

  /**
   * Private constructor to enforce singleton pattern
   */
  // eslint-disable-next-line no-useless-constructor
  private constructor() {
    // Temp directory will be created lazily when needed
  }

  /**
   * Detect which IDE is currently running
   * @returns IDE information including commands and display name
   */
  public detectIde(): IdeInfo {
    if (this.detectedIde !== null) {
      return this.detectedIde;
    }

    // Detect which IDE type is running
    let detectedType: IdeType;

    // Check for Cursor first
    if (
      process.env.CURSOR_TRACE_ID ||
      process.env.VSCODE_GIT_ASKPASS_MAIN?.toLowerCase().includes('cursor')
    ) {
      detectedType = IdeType.CURSOR;
      logInfo('Detected Cursor IDE');
    }
    // Check for Windsurf
    else if (
      process.env.VSCODE_GIT_ASKPASS_MAIN?.toLowerCase().includes('windsurf')
    ) {
      detectedType = IdeType.WINDSURF;
      logInfo('Detected Windsurf IDE');
    }
    // Default to VSCode
    else {
      detectedType = IdeType.VSCODE;
    }

    // Get the info for the detected IDE type
    this.detectedIde = IdeDetector.getIdeInfo(detectedType);
    return this.detectedIde;
  }

  /**
   * Get IDE info for a specific IDE type
   * @param ideType - The IDE type to get info for
   * @returns IDE information including commands and display name
   */
  public static getIdeInfo(ideType: IdeType): IdeInfo {
    const isWindows = process.platform === 'win32';

    switch (ideType) {
      case IdeType.CURSOR: {
        const cliCommand = 'cursor';
        return {
          type: IdeType.CURSOR,
          cliCommand,
          platformCommand: isWindows ? `${cliCommand}.cmd` : cliCommand,
          displayName: 'Cursor',
        };
      }
      case IdeType.WINDSURF: {
        const cliCommand = 'surf';
        return {
          type: IdeType.WINDSURF,
          cliCommand,
          platformCommand: isWindows ? `${cliCommand}.cmd` : cliCommand,
          displayName: 'Windsurf',
        };
      }
      default: {
        // Default to VSCode for any other IDE type
        const cliCommand = 'code';
        return {
          type: IdeType.VSCODE,
          cliCommand,
          platformCommand: isWindows ? `${cliCommand}.cmd` : cliCommand,
          displayName: 'VS Code',
        };
      }
    }
  }

  /**
   * Get the platform-specific IDE command name for the current IDE
   */

  /**
   * Get platform-specific paths where IDE CLIs might be installed
   * Supports VSCode, Cursor, and Windsurf
   */
  private static getIdeCLIPaths(ideType: IdeType): string[] {
    const platform = process.platform;
    const paths: string[] = [];
    const { cliCommand, platformCommand } = IdeDetector.getIdeInfo(ideType);

    if (platform === 'darwin') {
      // macOS: Minimal fallback paths since Spotlight usually finds IDEs
      paths.push(
        `/opt/homebrew/bin/${cliCommand}`,
        `/usr/local/bin/${cliCommand}`,
        path.join(os.homedir(), '.local/bin', cliCommand)
      );
      // VSCode specific: also check for insiders edition
      if (ideType === IdeType.VSCODE) {
        paths.push(
          '/opt/homebrew/bin/code-insiders',
          '/usr/local/bin/code-insiders',
          path.join(os.homedir(), '.local/bin/code-insiders')
        );
      }
    } else if (platform === 'win32') {
      // Windows paths
      const programFiles = process.env.PROGRAMFILES || 'C:\\Program Files';
      const programFilesX86 =
        process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)';
      const localAppData =
        process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');

      if (ideType === IdeType.VSCODE) {
        paths.push(
          path.join(
            localAppData,
            'Programs',
            'Microsoft VS Code',
            'bin',
            platformCommand
          ),
          path.join(programFiles, 'Microsoft VS Code', 'bin', platformCommand),
          path.join(
            programFilesX86,
            'Microsoft VS Code',
            'bin',
            platformCommand
          ),
          // Also check for Insiders edition
          path.join(
            localAppData,
            'Programs',
            'Microsoft VS Code Insiders',
            'bin',
            'code-insiders.cmd'
          ),
          path.join(
            programFiles,
            'Microsoft VS Code Insiders',
            'bin',
            'code-insiders.cmd'
          ),
          path.join(
            programFilesX86,
            'Microsoft VS Code Insiders',
            'bin',
            'code-insiders.cmd'
          )
        );
      } else if (ideType === IdeType.CURSOR) {
        paths.push(
          path.join(localAppData, 'Programs', 'Cursor', platformCommand),
          path.join(programFiles, 'Cursor', platformCommand),
          path.join(programFilesX86, 'Cursor', platformCommand)
        );
      } else if (ideType === IdeType.WINDSURF) {
        paths.push(
          path.join(
            localAppData,
            'Programs',
            'Windsurf',
            'bin',
            platformCommand
          ),
          path.join(programFiles, 'Windsurf', 'bin', platformCommand),
          path.join(programFilesX86, 'Windsurf', 'bin', platformCommand)
        );
      }
    } else {
      // Linux paths
      const appName =
        ideType === IdeType.VSCODE
          ? 'code'
          : ideType === IdeType.CURSOR
            ? 'cursor'
            : 'windsurf';
      paths.push(
        `/snap/bin/${cliCommand}`,
        `/usr/share/${appName}/bin/${cliCommand}`,
        path.join(os.homedir(), '.local/bin', cliCommand),
        `/usr/local/bin/${cliCommand}`,
        `/usr/bin/${cliCommand}`
      );
      // VSCode specific: also check for insiders edition
      if (ideType === IdeType.VSCODE) {
        paths.push(
          '/snap/bin/code-insiders',
          '/usr/share/code-insiders/bin/code-insiders',
          path.join(os.homedir(), '.local/bin/code-insiders')
        );
      }
    }

    return paths;
  }

  /**
   * Verify if a command is actually an IDE CLI
   */
  private static async isIdeCLI(command: string): Promise<boolean> {
    try {
      // Check if the command executes and returns version info
      const { stdout } = await execAsync(`${quoteCommand(command)} --version`);

      // IDE CLIs return version in format: "1.85.1\n<commit-hash>\n<platform>"
      const hasVersionPattern = /^\d+\.\d+\.\d+/m.test(stdout);

      return hasVersionPattern;
    } catch {
      return false;
    }
  }

  /**
   * Search for IDE using system-specific methods
   */
  private static async findIdeUsingSystemSearch(
    ideType: IdeType
  ): Promise<string | null> {
    const platform = process.platform;

    try {
      if (platform === 'darwin') {
        // Use mdfind (Spotlight) on macOS to find IDE apps
        try {
          let bundleIds: string[] = [];
          const cliName = IdeDetector.getIdeInfo(ideType).cliCommand;

          if (ideType === IdeType.VSCODE) {
            bundleIds = [
              'com.microsoft.VSCode',
              'com.microsoft.VSCodeInsiders',
            ];
          } else if (ideType === IdeType.CURSOR) {
            bundleIds = ['com.cursor.CursorApp'];
          } else if (ideType === IdeType.WINDSURF) {
            bundleIds = ['com.windsurf.WindsurfApp'];
          }

          for (const bundleId of bundleIds) {
            try {
              const { stdout } = await execAsync(
                `mdfind "kMDItemCFBundleIdentifier == ${bundleId}"`
              );
              const apps = parseStdoutLines(stdout);
              for (const app of apps) {
                const cliPath = path.join(
                  app,
                  'Contents/Resources/app/bin',
                  cliName
                );
                if (fs.existsSync(cliPath)) {
                  const isValid = await IdeDetector.isIdeCLI(cliPath);
                  if (isValid) {
                    logInfo('Found IDE via Spotlight search', {
                      type: ideType,
                      path: cliPath,
                    });
                    return cliPath;
                  }
                }
              }
            } catch {
              // This bundle ID search failed, try next
            }
          }
        } catch {
          // Spotlight search failed entirely
        }
      } else if (platform === 'win32') {
        // Check Windows Registry for IDE installation
        try {
          let searchName = '';
          const { platformCommand } = IdeDetector.getIdeInfo(ideType);

          if (ideType === IdeType.VSCODE) {
            searchName = 'Microsoft Visual Studio Code';
          } else if (ideType === IdeType.CURSOR) {
            searchName = 'Cursor';
          } else if (ideType === IdeType.WINDSURF) {
            searchName = 'Windsurf';
          }

          const { stdout } = await execAsync(
            `reg query "HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall" /s /f "${searchName}"`
          );

          const lines = parseStdoutLines(stdout);
          for (let i = 0; i < lines.length; i++) {
            if (lines[i] && lines[i].includes('InstallLocation')) {
              const match = lines[i].match(/InstallLocation\s+REG_SZ\s+(.+)/);
              if (match) {
                const installPath = match[1].trim();
                const cliPath = path.join(installPath, 'bin', platformCommand);
                if (fs.existsSync(cliPath)) {
                  const isValid = await IdeDetector.isIdeCLI(cliPath);
                  if (isValid) {
                    logInfo('Found IDE via Windows Registry', {
                      type: ideType,
                      path: cliPath,
                    });
                    return cliPath;
                  }
                }
              }
            }
          }
        } catch {
          // Registry query failed
        }

        // Also check using 'where' command on Windows
        try {
          const baseCommand = IdeDetector.getIdeInfo(ideType).cliCommand;
          const { stdout } = await execAsync(`where ${baseCommand}`);
          const paths = parseStdoutLines(stdout);

          // On Windows, prefer .cmd files over shell scripts
          const sortedPaths = paths.sort((a: string, b: string) => {
            const aIsCmd = a.endsWith('.cmd');
            const bIsCmd = b.endsWith('.cmd');
            if (aIsCmd && !bIsCmd) return -1;
            if (!aIsCmd && bIsCmd) return 1;
            return 0;
          });

          for (const idePath of sortedPaths) {
            const isValid = await IdeDetector.isIdeCLI(idePath);
            if (isValid) {
              logInfo('Found IDE via where command', {
                type: ideType,
                path: idePath,
              });
              return idePath;
            }
          }
        } catch {
          // where command failed
        }
      } else {
        // Linux: Try using which and whereis
        const cliCommand = IdeDetector.getIdeInfo(ideType).cliCommand;

        try {
          const { stdout } = await execAsync(`which ${cliCommand}`);
          const idePath = stdout.trim();
          if (idePath) {
            const isValid = await IdeDetector.isIdeCLI(idePath);
            if (isValid) {
              logInfo('Found IDE via which command', {
                type: ideType,
                path: idePath,
              });
              return idePath;
            }
          }
        } catch {
          // which failed, try whereis
        }

        try {
          const { stdout } = await execAsync(`whereis ${cliCommand}`);
          const match = stdout.match(new RegExp(`^${cliCommand}:\\s+(.+)$`));
          if (match) {
            const paths = match[1].split(' ').filter(Boolean);
            for (const idePath of paths) {
              if (!idePath.includes('/man/') && !idePath.includes('/share/')) {
                const isValid = await IdeDetector.isIdeCLI(idePath);
                if (isValid) {
                  logInfo('Found IDE via whereis command', {
                    type: ideType,
                    path: idePath,
                  });
                  return idePath;
                }
              }
            }
          }
        } catch {
          // whereis failed
        }

        // Check desktop files on Linux
        try {
          const baseCommand = IdeDetector.getIdeInfo(ideType).cliCommand;
          const desktopFileName = `${baseCommand}.desktop`;
          const desktopPaths = [
            `/usr/share/applications/${desktopFileName}`,
            `/usr/local/share/applications/${desktopFileName}`,
            path.join(
              os.homedir(),
              '.local/share/applications',
              desktopFileName
            ),
          ];

          for (const desktopFile of desktopPaths) {
            if (fs.existsSync(desktopFile)) {
              const content = fs.readFileSync(desktopFile, 'utf8');
              const execMatch = content.match(/^Exec=(.+?)(?:\s|$)/m);
              if (execMatch) {
                const execPath = execMatch[1].replace(/%[FfUu]/g, '').trim();
                const isValid = await IdeDetector.isIdeCLI(execPath);
                if (isValid) {
                  logInfo('Found IDE via desktop file', {
                    type: ideType,
                    path: execPath,
                  });
                  return execPath;
                }
              }
            }
          }
        } catch {
          // Desktop file search failed
        }
      }
    } catch (error) {
      logInfo('System search for IDE failed', { type: ideType, error });
    }

    return null;
  }

  /**
   * Check for IDE CLI in macOS .app bundles
   */
  private static async findIdeInMacOSApplications(
    ideType: IdeType
  ): Promise<string | null> {
    if (process.platform !== 'darwin') {
      return null;
    }

    const { cliCommand } = IdeDetector.getIdeInfo(ideType);
    const appPaths: Array<{ appName: string; cliName?: string }> = [];

    // Define app paths and CLI names for each IDE
    if (ideType === IdeType.VSCODE) {
      appPaths.push(
        { appName: 'Visual Studio Code.app', cliName: 'code' },
        {
          appName: 'Visual Studio Code - Insiders.app',
          cliName: 'code-insiders',
        }
      );
    } else if (ideType === IdeType.CURSOR) {
      appPaths.push({ appName: 'Cursor.app', cliName: 'cursor' });
    } else if (ideType === IdeType.WINDSURF) {
      appPaths.push({ appName: 'Windsurf.app', cliName: 'windsurf' });
    }

    // Check both /Applications and ~/Applications
    const searchDirs = [
      '/Applications',
      path.join(os.homedir(), 'Applications'),
    ];

    for (const dir of searchDirs) {
      for (const { appName, cliName } of appPaths) {
        const appPath = path.join(dir, appName);
        const cliPath = path.join(
          appPath,
          'Contents/Resources/app/bin',
          cliName || cliCommand
        );

        if (fs.existsSync(cliPath)) {
          try {
            const isValid = await IdeDetector.isIdeCLI(cliPath);
            if (isValid) {
              logInfo('Found IDE CLI in macOS Application bundle', {
                type: ideType,
                path: cliPath,
              });
              return cliPath;
            }
          } catch {
            // This CLI path doesn't work, continue
          }
        }
      }
    }

    return null;
  }

  /**
   * Find IDE CLI executable path using multiple strategies
   */
  private static async findIdeCLI(
    ideType: IdeType
  ): Promise<string | undefined> {
    // 1. Try the default command in PATH
    const { platformCommand } = IdeDetector.getIdeInfo(ideType);
    try {
      const isValid = await IdeDetector.isIdeCLI(platformCommand);
      if (isValid) {
        logInfo('Found IDE CLI in PATH', {
          type: ideType,
          command: platformCommand,
        });
        return platformCommand;
      }
    } catch (error) {
      logInfo('IDE CLI command in PATH check failed', {
        type: ideType,
        command: platformCommand,
        error: error instanceof Error ? error.message : error,
      });
    }

    // 2. Check macOS Application bundles directly (fast and reliable)
    if (process.platform === 'darwin') {
      const macAppPath = await IdeDetector.findIdeInMacOSApplications(ideType);
      if (macAppPath) return macAppPath;
    }

    // 3. Use system-specific search methods (Spotlight, Registry, etc.)
    const systemPath = await IdeDetector.findIdeUsingSystemSearch(ideType);
    if (systemPath) return systemPath;

    // 4. Fall back to checking known installation paths
    const possiblePaths = IdeDetector.getIdeCLIPaths(ideType);
    for (const cliPath of possiblePaths) {
      try {
        if (fs.existsSync(cliPath)) {
          const isValid = await IdeDetector.isIdeCLI(cliPath);
          if (isValid) {
            logInfo('Found IDE CLI at known path', {
              type: ideType,
              path: cliPath,
            });
            return cliPath;
          }
        }
      } catch {
        // This path doesn't work, continue
      }
    }

    return undefined;
  }

  /**
   * Find and cache the IDE CLI command path
   * This ensures we only search for the CLI once per session per IDE
   */
  private static async findAndCacheIdeCLICommand(
    ideType: IdeType
  ): Promise<string | undefined> {
    // Return cached result if already searched
    const cachedPath = IdeDetector.cliPathCache[ideType];
    if (cachedPath !== undefined) {
      return cachedPath;
    }

    // Search for IDE CLI and cache the result
    const cliPath = await IdeDetector.findIdeCLI(ideType);
    IdeDetector.cliPathCache[ideType] = cliPath;

    if (cliPath) {
      logInfo('IDE CLI cached for session', { type: ideType, path: cliPath });
    } else {
      logInfo('IDE CLI not found in any known locations', { type: ideType });
    }

    return cliPath;
  }

  /**
   * Get the IDE CLI command to use (with path resolution)
   */
  private async getIdeCLICommand(): Promise<string> {
    const ide = this.detectIde();
    const cliPath = await IdeDetector.findAndCacheIdeCLICommand(ide.type);

    if (!cliPath) {
      throw new MetaError('ide.cli-not-available', {
        name: ide.displayName,
        errorMessage: `${ide.displayName} CLI not found. Please ensure ${ide.displayName} is installed and the "${ide.cliCommand}" command is available in your PATH.`,
      });
    }

    return cliPath;
  }

  /**
   * Ensure temp directory exists (async)
   */
  private async ensureTempDir(): Promise<void> {
    try {
      if (!fs.existsSync(this.tempDir)) {
        await fs.promises.mkdir(this.tempDir, { recursive: true });
      }
    } catch (error) {
      // Log error but don't throw - allow IDE detection to continue
      // Extension installation may not work, but CLI won't crash
      logWarn('Failed to create temp directory for extensions', {
        directory: this.tempDir,
        cause: error,
      });
    }
  }

  /**
   * Get the extensions directory path for the current IDE and platform
   */
  private getExtensionsDirectory(): string {
    const ide = this.detectIde();
    const homeDir = os.homedir();

    let extensionsPath: string;

    if (process.platform === 'win32') {
      // Windows: %USERPROFILE%\.{ide}\extensions
      const userProfile = process.env.USERPROFILE || homeDir;
      switch (ide.type) {
        case IdeType.CURSOR:
          extensionsPath = path.join(userProfile, '.cursor', 'extensions');
          break;
        case IdeType.WINDSURF:
          extensionsPath = path.join(userProfile, '.windsurf', 'extensions');
          break;
        default:
          extensionsPath = path.join(userProfile, '.vscode', 'extensions');
      }
    } else {
      // macOS/Linux: ~/.{ide}/extensions
      switch (ide.type) {
        case IdeType.CURSOR:
          extensionsPath = path.join(homeDir, '.cursor', 'extensions');
          break;
        case IdeType.WINDSURF:
          extensionsPath = path.join(homeDir, '.windsurf', 'extensions');
          break;
        default:
          extensionsPath = path.join(homeDir, '.vscode', 'extensions');
      }
    }

    return extensionsPath;
  }

  /**
   * Find the installed Industry extension directory, checking if it's not obsolete
   * Returns null if extension not found or marked as obsolete
   * If multiple versions exist (e.g., after an update), returns the first non-obsolete one
   */
  private async findIndustryExtensionDirectory(): Promise<string | null> {
    try {
      const extensionsDir = this.getExtensionsDirectory();

      // Check if extensions directory exists
      if (!fs.existsSync(extensionsDir)) {
        return null;
      }

      // Read the extensions directory
      const files = await fs.promises.readdir(extensionsDir);

      // Extension folders follow pattern: publisher.extension-id-version
      // Find all matching extension directories (there may be multiple versions)
      const matchingDirs = files.filter((dir) =>
        dir.startsWith(this.EXTENSION_ID)
      );

      if (matchingDirs.length === 0) {
        return null;
      }

      // Load obsolete data once if the file exists
      let obsoleteData: Record<string, boolean> = {};
      const obsoleteFile = path.join(extensionsDir, '.obsolete');
      if (fs.existsSync(obsoleteFile)) {
        try {
          const obsoleteContent = await fs.promises.readFile(
            obsoleteFile,
            'utf8'
          );
          obsoleteData = JSON.parse(obsoleteContent) as Record<string, boolean>;
        } catch {
          // If we can't read/parse .obsolete file, continue with empty obsolete data
        }
      }

      // Iterate through all matching directories and return the first non-obsolete one
      for (const extensionDir of matchingDirs) {
        if (!obsoleteData[extensionDir]) {
          // Found a non-obsolete extension directory
          return path.join(extensionsDir, extensionDir);
        }
      }

      // All matching directories are marked as obsolete
      return null;
    } catch (error) {
      logException(error, 'Error finding installed extension directory');
      return null;
    }
  }

  /**
   * Get singleton instance of IdeDetector
   */
  public static getInstance(): IdeDetector {
    if (!IdeDetector.instance) {
      IdeDetector.instance = new IdeDetector();
    }
    return IdeDetector.instance;
  }

  /**
   * Check if running in a supported IDE terminal
   * Kept as isRunningInVSCode for backward compatibility
   */
  public isRunningInVSCode(): boolean {
    if (this.isVSCodeTerminal !== null) {
      return this.isVSCodeTerminal;
    }

    // Check environment variables that indicate any supported IDE terminal
    const isInIde =
      process.env.TERM_PROGRAM === 'vscode' ||
      !!process.env.VSCODE_PID ||
      !!process.env.VSCODE_CWD ||
      !!process.env.VSCODE_IPC_HOOK_CLI ||
      !!process.env.CURSOR_TRACE_ID ||
      !!process.env.VSCODE_GIT_ASKPASS_MAIN;

    this.isVSCodeTerminal = isInIde;
    return isInIde;
  }

  /**
   * Check if running in a supported IDE (more accurate method name)
   */
  public isRunningInSupportedIde(): boolean {
    return this.isRunningInVSCode();
  }

  /**
   * Check if IDE CLI is available (with path resolution)
   * Kept as isVSCodeCLIAvailable for backward compatibility
   */
  public static async isVSCodeCLIAvailable(): Promise<boolean> {
    const ide = IdeDetector.getInstance().detectIde();
    const cliPath = await IdeDetector.findAndCacheIdeCLICommand(ide.type);
    return cliPath !== null;
  }

  /**
   * Reset the extension installation cache
   * Call this to force a fresh check on the next isExtensionInstalled() call
   */
  public resetExtensionCache(): void {
    this.extensionInstalled = null;
  }

  /**
   * Check if Industry extension is installed
   * @param forceCheck - If true, bypass cache and perform fresh check
   */
  public async isExtensionInstalled(forceCheck = false): Promise<boolean> {
    if (!forceCheck && this.extensionInstalled !== null) {
      return this.extensionInstalled;
    }

    const extensionDir = await this.findIndustryExtensionDirectory();
    this.extensionInstalled = extensionDir !== null;
    return this.extensionInstalled;
  }

  /**
   * Get the version of the installed Industry extension
   */
  public async getInstalledExtensionVersion(): Promise<string | null> {
    const extensionDirPath = await this.findIndustryExtensionDirectory();

    if (!extensionDirPath) {
      return null;
    }

    // Read package.json from the extension directory
    try {
      const packageJsonPath = path.join(extensionDirPath, 'package.json');
      const content = await fs.promises.readFile(packageJsonPath, 'utf8');
      const packageJson = JSON.parse(content) as { version?: string };
      return packageJson.version || null;
    } catch (error) {
      logException(error, 'Error reading extension package.json');
      return null;
    }
  }

  /**
   * Get extension info from Industry API
   */
  private async getLatestExtensionInfo(): Promise<{
    version: string;
    downloadUrl: string;
  }> {
    const apiConfig = getIndustryApiConfig();
    const headers = (await apiConfig.getHeaders?.()) ?? {};

    const response = await fetchBackend('/api/vscode-extension', {
      method: 'GET',
      headers,
    });

    if (!response.ok) {
      throw new MetaError('vscode-extension.api-fetch-failed', {
        statusCode: response.status,
        statusText: response.statusText,
      });
    }

    const data = await response.json();
    return {
      version: data.version,
      downloadUrl: data.downloadUrl,
    };
  }

  /**
   * Download the extension from a given URL
   */
  private async downloadExtensionFromUrl(downloadUrl: string): Promise<string> {
    await this.ensureTempDir();
    const vsixPath = path.join(this.tempDir, 'industry-vscode-extension.vsix');

    try {
      const ide = this.detectIde();
      logInfo('Downloading extension', { displayName: ide.displayName });

      return new Promise<string>((resolve, reject) => {
        const file = fs.createWriteStream(vsixPath);

        https
          .get(downloadUrl, (response) => {
            if (response.statusCode === 200) {
              response.pipe(file);
              file.on('finish', () => {
                file.close();
                logInfo('Extension downloaded successfully', {
                  displayName: ide.displayName,
                });
                resolve(vsixPath);
              });
            } else {
              fs.unlink(vsixPath, () => {});
              reject(
                new MetaError('vscode-extension.download-failed', {
                  statusCode: response.statusCode,
                  statusText: response.statusMessage,
                  url: downloadUrl,
                })
              );
            }
          })
          .on('error', (err) => {
            fs.unlink(vsixPath, () => {});
            reject(
              new MetaError('vscode-extension.download-error', {
                cause: err,
                url: downloadUrl,
              })
            );
          });
      });
    } catch (error) {
      // Clean up the file if it exists
      try {
        await fs.promises.unlink(vsixPath);
      } catch (_unlinkError) {
        // Ignore unlink errors
      }

      throw new MetaError('vscode-extension.download-error', {
        cause: error,
      });
    }
  }

  /**
   * Install the extension
   */
  private async installExtension(vsixPath: string): Promise<boolean> {
    const ide = this.detectIde();
    const command = await this.getIdeCLICommand();
    logInfo('Installing extension', {
      displayName: ide.displayName,
      path: vsixPath,
      command,
    });

    return new Promise<boolean>((resolve, reject) => {
      let stdout = '';
      let stderr = '';

      const childProcess = spawn(
        command,
        ['--install-extension', vsixPath, '--force'],
        {
          shell: false,
        }
      );

      // Capture stdout
      childProcess.stdout?.on('data', (data) => {
        stdout += data.toString();
      });

      // Capture stderr
      childProcess.stderr?.on('data', (data) => {
        stderr += data.toString();
      });

      childProcess.on('close', (code) => {
        if (code === 0) {
          logInfo('Industry extension installed successfully', {
            displayName: ide.displayName,
            stdout: stdout.trim(),
          });
          this.extensionInstalled = true;
          resolve(true);
        } else {
          logError('Failed to install extension', {
            exitCode: code || 0,
            displayName: ide.displayName,
            vsixPath,
            command,
            stdout: stdout.trim(),
            stderr: stderr.trim(),
          });

          resolve(false);
        }
      });

      childProcess.on('error', (err) => {
        logError('Error spawning extension installation process', {
          error: err.message,
          displayName: ide.displayName,
          vsixPath,
          command,
          stdout: stdout.trim(),
          stderr: stderr.trim(),
        });

        reject(err);
      });
    });
  }

  /**
   * Compare two semantic versions
   */
  private compareVersions(version1: string, version2: string): number {
    const v1Parts = version1.split('.').map(Number);
    const v2Parts = version2.split('.').map(Number);

    const maxLength = Math.max(v1Parts.length, v2Parts.length);

    for (let i = 0; i < maxLength; i++) {
      const v1Part = v1Parts[i] || 0;
      const v2Part = v2Parts[i] || 0;

      if (v1Part < v2Part) return -1;
      if (v1Part > v2Part) return 1;
    }

    return 0;
  }

  /**
   * Check if installed extension version meets minimum requirement
   */
  public async isExtensionVersionAtLeast(minVersion: string): Promise<boolean> {
    const installedVersion = await this.getInstalledExtensionVersion();
    if (!installedVersion) return false;
    return this.compareVersions(installedVersion, minVersion) >= 0;
  }

  /**
   * Check and install extension if needed
   */
  public async checkAndInstallExtension(
    options: IdeDetectorOptions = {}
  ): Promise<boolean> {
    const ide = this.detectIde();

    // Skip if not in a supported IDE and not forcing check
    if (!this.isRunningInSupportedIde() && !options.forceCheck) {
      logInfo('Not running in IDE, skipping extension check', {
        displayName: ide.displayName,
      });
      return false;
    }

    // Skip if IDE CLI not available
    if (!(await IdeDetector.isVSCodeCLIAvailable())) {
      logInfo('IDE CLI not available, skipping extension check', {
        displayName: ide.displayName,
      });
      return false;
    }

    try {
      // Always get the latest version info and pre-signed URL from the API first
      const { version: latestVersion, downloadUrl } =
        await this.getLatestExtensionInfo();

      // Get currently installed version (if any)
      const installedVersion = await this.getInstalledExtensionVersion();

      // Only install if the latest version is newer than current (or not installed)
      if (installedVersion) {
        const comparison = this.compareVersions(
          installedVersion,
          latestVersion
        );
        if (comparison >= 0) {
          // Already up to date
          logInfo('Industry extension is already up to date', {
            displayName: ide.displayName,
            version: installedVersion,
          });
          return true;
        }

        // Update available - latest is newer than current
        logInfo('Industry extension update available', {
          displayName: ide.displayName,
          version: `${installedVersion} -> ${latestVersion}`,
        });
      } else {
        // Not installed
        logInfo(
          'Industry extension not installed, will install latest version',
          {
            displayName: ide.displayName,
            version: latestVersion,
          }
        );
      }

      // Download and install the extension using the pre-signed URL
      const vsixPath = await this.downloadExtensionFromUrl(downloadUrl);
      return await this.installExtension(vsixPath);
    } catch (error) {
      logException(error, 'Error installing extension');
      return false;
    }
  }
}

// Export singleton instance
export const ideDetector = IdeDetector.getInstance();
