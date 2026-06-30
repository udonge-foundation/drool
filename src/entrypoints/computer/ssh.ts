import * as fs from 'fs';
import path from 'path';

import {
  ComputerProviderType,
  DEFAULT_REMOTE_USER,
} from '@industry/common/api/v0/computers';
import { MachineType } from '@industry/common/daemon';
import { ClientType } from '@industry/common/shared';
import {
  connectWithRetry,
  TunnelConnection,
  createWebSocketDaemonClient,
} from '@industry/daemon-client';
import { IndustryEnv } from '@industry/environment';
import { logException } from '@industry/logging';
import {
  HttpStatusCode,
  isFetchError,
  MetaError,
} from '@industry/logging/errors';
import { ClientUiSurface } from '@industry/logging/tracing';
import { getAuthTokenOrThrow } from '@industry/runtime/auth';
import { getIndustryHome, resolveDroolBinary } from '@industry/utils/cli';
import { getIndustryDirName } from '@industry/utils/environment';

import '@/api/init';
import { getComputerByName } from '@/api/computer';
import { getAuthErrorMessage } from '@/commands/authHelpers';
import { getRuntimeAuthConfig, getEnv } from '@/environment';
import { getI18n } from '@/i18n';
import { ensureComputerRunning } from '@/services/computer/ensureComputerRunning';
import { exitWithCode } from '@/utils/exitWithCode';

const DEFAULT_SSH_PORT = 22;

const INDUSTRY_SSH_DIR = path.join(
  getIndustryHome(),
  getIndustryDirName(),
  '.ssh'
);
const INDUSTRY_SSH_KEY = path.join(INDUSTRY_SSH_DIR, 'id_ed25519');
const INDUSTRY_SSH_KEY_PUB = `${INDUSTRY_SSH_KEY}.pub`;

interface SSHOptions {
  debug?: boolean;
  proxy?: boolean;
  port?: string;
}

/**
 * Get or generate a Industry-specific SSH key pair.
 * This key is separate from the user's ~/.ssh keys to avoid conflicts
 * with other services (e.g., GitHub).
 */
function getOrCreateIndustrySshKey(): string {
  // Create directory if needed
  if (!fs.existsSync(INDUSTRY_SSH_DIR)) {
    fs.mkdirSync(INDUSTRY_SSH_DIR, { recursive: true, mode: 0o700 });
  }

  // Generate key if it doesn't exist
  if (!fs.existsSync(INDUSTRY_SSH_KEY)) {
    const result = Bun.spawnSync(
      [
        'ssh-keygen',
        '-t',
        'ed25519',
        '-f',
        INDUSTRY_SSH_KEY,
        '-N',
        '',
        '-C',
        'industry-computer-access',
      ],
      { stdio: ['pipe', 'pipe', 'pipe'] }
    );

    if (result.exitCode !== 0) {
      const stderr = result.stderr?.toString() ?? '';
      throw new MetaError('Failed to generate SSH key', { stderr });
    }
  }

  return fs.readFileSync(INDUSTRY_SSH_KEY_PUB, 'utf-8').trim();
}

/**
 * Proxy mode: Forward stdin/stdout through a relay tunnel via DaemonClient.
 * Used for VS Code Remote-SSH ProxyCommand.
 */
async function runProxyMode(
  computerName: string,
  port: number,
  debug: boolean
): Promise<void> {
  const log = debug
    ? (msg: string) => process.stderr.write(`[ssh-proxy] ${msg}\n`)
    : () => {};
  const status = (msg: string) => process.stderr.write(`${msg}\n`);

  const match = computerName.match(/^industry(?:-dev)?-(.+)$/);
  const actualComputerName = match ? match[1] : computerName;

  const t = getI18n().t;
  status(t('commands:ssh.fetchingComputerInfo'));
  const computer = await getComputerByName(actualComputerName);
  if (!computer) {
    status(t('commands:ssh.computerNotFound', { name: actualComputerName }));
    await exitWithCode(1);
    return;
  }
  if (!computer.relayClientUrl) {
    status(t('commands:ssh.computerNotReady', { name: actualComputerName }));
    await exitWithCode(1);
    return;
  }

  log(`Computer: ${computer.name} (${computer.relayClientUrl})`);
  status(t('commands:ssh.connectingTo', { name: computer.name }));

  const publicKey = getOrCreateIndustrySshKey();

  const isManaged = computer.providerType !== ComputerProviderType.Byom;
  const client = createWebSocketDaemonClient({
    clientSurface: ClientUiSurface.CliExec,
    machineType: MachineType.Computer,
    providerType: computer.providerType,
    getAccessToken: () => getAuthTokenOrThrow(getRuntimeAuthConfig()),
  });

  // connectWithRetry wakes the sandbox (ensureRunning) and retries
  // connect+authenticate until the daemon is ready after cold start.
  const token = await getAuthTokenOrThrow(getRuntimeAuthConfig());
  await connectWithRetry({
    client,
    url: computer.relayClientUrl,
    authParams: { token, caller: ClientType.CLI },
    ensureRunning: isManaged
      ? () => ensureComputerRunning(computer.id)
      : undefined,
  });
  try {
    const installResult = await client.installSshKey(publicKey);
    if (!installResult.installed) {
      throw new MetaError('Remote daemon rejected SSH key installation');
    }
  } finally {
    client.disconnect();
  }

  const relayUrl = computer.relayClientUrl.replace(/\/v0\/computer\/.*$/, '');
  const tunnel = new TunnelConnection({
    relayUrl,
    computerId: computer.id,
    port,
    getAccessToken: () => getAuthTokenOrThrow(getRuntimeAuthConfig()),
  });

  await tunnel.connect();
  status(t('commands:ssh.connected'));
  log('Starting proxy mode (stdin/stdout <-> tunnel)');

  tunnel.on('data', (data: ArrayBuffer) => {
    process.stdout.write(Buffer.from(data));
  });

  tunnel.on('close', () => {
    log('Tunnel closed');
    void exitWithCode(0);
  });

  tunnel.on('error', (err) => {
    process.stderr.write(
      `${t('commands:ssh.webSocketError', { message: err.message })}\n`
    );
    void exitWithCode(1);
  });

  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
  }
  process.stdin.on('data', (chunk: Buffer<ArrayBuffer>) => {
    tunnel.send(chunk);
  });

  process.stdin.on('end', () => {
    log('stdin closed');
    tunnel.close();
  });

  return new Promise(() => {});
}

/**
 * Shell mode: Spawn ssh with ProxyCommand pointing back to drool computer ssh --proxy.
 */
function shellQuote(arg: string): string {
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

function normalizeProxyExecutablePath(filePath: string): string {
  // On Windows, OpenSSH invokes ProxyCommand through a POSIX-like shell
  // in our CI environment. Backslashes are treated as escapes there, so
  // `C:\path\to\drool.exe` becomes `C:pathtodrool.exe`. Forward slashes
  // keep the drive-qualified path executable by that shell.
  return process.platform === 'win32' ? filePath.replace(/\\/g, '/') : filePath;
}

function runShellMode(
  computerName: string,
  port: number,
  debug: boolean,
  remoteUser: string
): Promise<number> {
  // Ensure SSH key exists before spawning ssh
  getOrCreateIndustrySshKey();

  const droolBin = resolveDroolBinary(getEnv().env === IndustryEnv.Development);
  const proxyArgs = [
    normalizeProxyExecutablePath(droolBin),
    'computer',
    'ssh',
    computerName,
    '--proxy',
    '--port',
    String(port),
    ...(debug ? ['--debug'] : []),
  ];
  const proxyCmd = proxyArgs.map(shellQuote).join(' ');

  // Use Industry-specific key (-i) and disable other identity files to avoid conflicts
  // Set StrictHostKeyChecking=no to suppress interactive prompt that shows because we don't know the host on the client
  const sshArgs = [
    '-i',
    INDUSTRY_SSH_KEY,
    '-o',
    'IdentitiesOnly=yes',
    '-o',
    `ProxyCommand=${proxyCmd}`,
    '-o',
    'StrictHostKeyChecking=no',
    '-o',
    'UserKnownHostsFile=/dev/null',
    '-o',
    'LogLevel=ERROR',
    `${remoteUser}@localhost`,
  ];

  if (debug) {
    process.stderr.write(
      `[ssh] Running: ssh ${sshArgs.map(shellQuote).join(' ')}\n`
    );
  }

  const result = Bun.spawnSync(['ssh', ...sshArgs], {
    stdio: ['inherit', 'inherit', 'inherit'],
    env: process.env,
  });

  if (debug) {
    process.stderr.write(`[ssh] Exit code: ${result.exitCode}\n`);
  }

  return Promise.resolve(result.exitCode ?? 0);
}

export async function runSshAction(
  computerName: string,
  options: SSHOptions
): Promise<void> {
  try {
    const debug = options.debug ?? false;
    const port = parseInt(options.port ?? String(DEFAULT_SSH_PORT), 10);

    if (options.proxy) {
      await runProxyMode(computerName, port, debug);
      // runProxyMode only returns when it failed before establishing a tunnel;
      // a successful proxy keeps the promise pending until tunnel close handlers exit.
      await exitWithCode(1);
      return;
    }

    // Fetch computer to determine remote user for shell mode
    const nameMatch = computerName.match(/^industry(?:-dev)?-(.+)$/);
    const actualName = nameMatch ? nameMatch[1] : computerName;
    const computer = await getComputerByName(actualName);
    if (!computer) {
      const t = getI18n().t;
      throw new MetaError(
        t('commands:ssh.computerNotFound', { name: actualName })
      );
    }
    if (
      !computer.remoteUser &&
      computer.providerType === ComputerProviderType.Byom
    ) {
      throw new MetaError(
        'This computer is missing remote user configuration. Please update and restart the daemon on the remote machine to fix this automatically.'
      );
    }
    const remoteUser = computer.remoteUser ?? DEFAULT_REMOTE_USER;

    const exitCode = await runShellMode(computerName, port, debug, remoteUser);
    await exitWithCode(exitCode);
  } catch (error) {
    logException(error, 'SSH command failed');
    const t = getI18n().t;
    let errorMessage: string;
    if (
      isFetchError(error) &&
      error.response.status === HttpStatusCode.Unauthorized
    ) {
      errorMessage = getAuthErrorMessage();
    } else if (error instanceof MetaError) {
      errorMessage = error.message;
    } else {
      errorMessage = t('commands:ssh.connectionFailed', {
        message: String(error),
      });
    }
    process.stderr.write(`${errorMessage}\n`);
    await exitWithCode(1);
  }
}
