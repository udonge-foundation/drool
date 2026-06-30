import { spawn } from 'child_process';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'crypto';
import { constants as fsConstants, promises as fsPromises } from 'fs';
import { syncBuiltinESMExports } from 'module';
import { createServer } from 'net';
import { dirname, join } from 'path';

import shellquote from 'shell-quote';

import { SandboxMode } from '@industry/drool-sdk-ext/protocol/settings';
import { logWarn } from '@industry/logging';
import { MetaError } from '@industry/logging/errors';
import { domainMatchesPattern } from '@industry/utils/settings';

import { buildSandboxConfig } from '@/sandbox/buildSandboxConfig';
import {
  DROOL_SANDBOXED_ENV,
  DROOL_WHOLE_PROCESS_SANDBOX_ATTESTATION_REQUEST_FIFO_ENV,
  DROOL_WHOLE_PROCESS_SANDBOX_ATTESTATION_RESPONSE_FIFO_ENV,
  DROOL_WHOLE_PROCESS_SANDBOX_GUARD_PATH_ENV,
  DROOL_WHOLE_PROCESS_SANDBOX_GUARD_TOKEN_ENV,
  DROOL_WHOLE_PROCESS_SANDBOX_PERMISSION_REQUEST_FIFO_ENV,
  DROOL_WHOLE_PROCESS_SANDBOX_PERMISSION_RESPONSE_FIFO_ENV,
} from '@/sandbox/constants';
import { DroolSandboxManager } from '@/sandbox/DroolSandboxManager';
import type { SandboxConfig } from '@/sandbox/types';
import { loadWholeProcessSandboxBootstrapSettings } from '@/sandbox/wholeProcessSandboxSettings';

import type { SandboxSettings } from '@industry/common/settings';

type ProcessEnv = Record<string, string | undefined>;

interface GuardFileContents {
  version: 1;
  launchId: string;
  token: string;
  configHash: string;
  supervisorPid: number;
  bridgeDirectoryPath: string;
  requestFifoPath: string;
  responseFifoPath: string;
  attestationRequestFifoPath: string;
  attestationResponseFifoPath: string;
  denyReadCanaryPath: string;
  denyReadCanarySecret: string;
  denyWriteCanaryPath: string;
  expectedProxyEnv: Partial<
    Record<'HTTP_PROXY' | 'HTTPS_PROXY' | 'ALL_PROXY', string>
  >;
}

interface GuardFileStat {
  uid?: number;
  mode?: number;
}

interface PermissionBridgePaths {
  directoryPath: string;
  requestFifoPath: string;
  responseFifoPath: string;
  attestationRequestFifoPath: string;
  attestationResponseFifoPath: string;
}

interface LaunchCanaries {
  rootPath: string;
  denyReadDirectoryPath: string;
  denyReadCanaryPath: string;
  denyReadCanarySecret: string;
  denyWriteCanaryPath: string;
}

interface NetworkPolicyProbeTarget {
  host: string;
  port: number;
  policyDerived: true;
  challengeId: string;
}

interface FilesystemPolicyChallenge {
  allowedScratchPath: string;
  deniedWritePaths: string[];
}

interface ChildPolicyChallenge {
  challengeId: string;
  filesystem: FilesystemPolicyChallenge;
  networkProbeTargets: NetworkPolicyProbeTarget[];
}

type PermissionBridgeDecision =
  | { decision: 'deny'; errorCode?: string }
  | { decision: 'allow_once' }
  | { decision: 'allow_always'; allowPattern?: string };

type WholeProcessChildValidationResult =
  | { ok: true; launchId: string; configHash: string }
  | { ok: false; reason: string };

interface ChildRuntimeProbeDeps {
  probeFilesystemCanaries: (guard: GuardFileContents) => Promise<boolean>;
  probeConfiguredFilesystemPolicy: (
    config: SandboxConfig,
    guard: GuardFileContents,
    challenge: FilesystemPolicyChallenge
  ) => Promise<boolean>;
  probeRawNetworkBlocked: (
    target: NetworkPolicyProbeTarget
  ) => Promise<boolean>;
  probeDescendantNetworkBlocked: (
    target: NetworkPolicyProbeTarget
  ) => Promise<boolean>;
  performSupervisorAttestation: (
    guard: GuardFileContents,
    env: ProcessEnv,
    policyProbeDigest: string
  ) => Promise<boolean>;
  createPolicyChallengeId: () => string;
}

interface WholeProcessSandboxManager {
  checkPlatformSupport(): Promise<{ supported: boolean; reason?: string }>;
  checkDependencies(): Promise<{
    satisfied: boolean;
    errors: string[];
    warnings: string[];
  }>;
  initialize(
    config: SandboxConfig,
    cwd?: string,
    sandboxAskCallback?: (params: {
      host: string;
      port: number | undefined;
    }) => Promise<boolean>
  ): Promise<void>;
  isActive(): boolean;
  wrapCommand(command: string): Promise<string>;
  allowDomain(domain: string): Promise<void>;
  getProxyEnv?(): Record<string, string>;
  shutdown(): Promise<void>;
}

interface RunSandboxedCommandResult {
  code: number | null;
  signal: NodeJS.Signals | null;
}

interface EnsureWholeProcessSandboxDeps {
  env: ProcessEnv;
  argv: string[];
  execPath: string;
  pid: number;
  uid?: number;
  makeManager: () => WholeProcessSandboxManager;
  createGuardToken: () => string;
  createLaunchId: () => string;
  createGuardPath: (token: string) => string;
  writeGuardFile: (path: string, contents: GuardFileContents) => Promise<void>;
  readGuardFile: (path: string) => Promise<string>;
  statGuardFile: (path: string) => Promise<GuardFileStat>;
  removeGuardFile: (path: string) => Promise<void>;
  readCurrentNetworkNamespace: () => Promise<string | undefined>;
  probeUnixSocketCreationBlocked: (socketPath: string) => Promise<boolean>;
  probeFilesystemCanaries: (guard: GuardFileContents) => Promise<boolean>;
  probeConfiguredFilesystemPolicy: (
    config: SandboxConfig,
    guard: GuardFileContents,
    challenge: FilesystemPolicyChallenge
  ) => Promise<boolean>;
  probeRawNetworkBlocked: (
    target: NetworkPolicyProbeTarget
  ) => Promise<boolean>;
  probeDescendantNetworkBlocked: (
    target: NetworkPolicyProbeTarget
  ) => Promise<boolean>;
  performSupervisorAttestation: (
    guard: GuardFileContents,
    env: ProcessEnv,
    policyProbeDigest: string
  ) => Promise<boolean>;
  createPolicyChallengeId: () => string;
  createLaunchCanaries: (token: string) => Promise<LaunchCanaries>;
  removeLaunchCanaries: (canaries: LaunchCanaries) => Promise<void>;
  loadCurrentSandboxSettings: () => Promise<SandboxSettings | undefined>;
  createPermissionBridgePaths: (token: string) => PermissionBridgePaths;
  createPermissionBridge: (paths: PermissionBridgePaths) => Promise<void>;
  removePermissionBridge: (paths: PermissionBridgePaths) => Promise<void>;
  startAttestationResponder: (
    paths: PermissionBridgePaths,
    launch: Pick<GuardFileContents, 'launchId' | 'token' | 'configHash'>
  ) => Promise<() => Promise<void>>;
  requestPermissionBridge: (
    paths: PermissionBridgePaths,
    token: string,
    params: { host: string; port: number | undefined }
  ) => Promise<PermissionBridgeDecision | undefined>;
  runSandboxedCommand: (command: string) => Promise<RunSandboxedCommandResult>;
  exitProcess: (code: number) => void;
}

type EnsureWholeProcessSandboxResult =
  | { status: 'not_requested' }
  | { status: 'already_sandboxed' }
  | { status: 'supervisor_exited'; code: number };

type ValidationDeps = Pick<
  EnsureWholeProcessSandboxDeps,
  | 'pid'
  | 'uid'
  | 'readGuardFile'
  | 'statGuardFile'
  | 'readCurrentNetworkNamespace'
  | 'probeUnixSocketCreationBlocked'
> &
  ChildRuntimeProbeDeps;

interface MutableNetModule {
  connect: (...args: unknown[]) => unknown;
  createConnection: (...args: unknown[]) => unknown;
}

const patchedNetModules = new WeakSet<object>();
const FIFO_OPEN_FLAGS = fsConstants.O_RDWR + fsConstants.O_NONBLOCK;
const WHOLE_PROCESS_RUNTIME_ROOT = '/tmp/claude/drool-whole-process';
const PIPE_BUF_LIMIT = 4096;
const DENIED_NETWORK_PROBE_CANDIDATES = [
  { host: '1.1.1.1', port: 80 },
  { host: '1.0.0.1', port: 80 },
  { host: '8.8.8.8', port: 80 },
  { host: '8.8.4.4', port: 80 },
  { host: '9.9.9.9', port: 80 },
  { host: '149.112.112.112', port: 80 },
  { host: '208.67.222.222', port: 80 },
  { host: '208.67.220.220', port: 80 },
  { host: '64.6.64.6', port: 80 },
  { host: '64.6.65.6', port: 80 },
  { host: '76.76.2.0', port: 80 },
  { host: '76.76.10.0', port: 80 },
] as const;
const DENIED_NETWORK_PROBE_COUNT = 2;

function defaultCreateGuardPath(token: string): string {
  return join(
    WHOLE_PROCESS_RUNTIME_ROOT,
    `${process.pid}-${token}`,
    'guard.json'
  );
}

function defaultCreatePermissionBridgePaths(
  token: string
): PermissionBridgePaths {
  const directoryPath = join(
    WHOLE_PROCESS_RUNTIME_ROOT,
    `${process.pid}-${token}`
  );

  return {
    directoryPath,
    requestFifoPath: join(directoryPath, 'permission-request.fifo'),
    responseFifoPath: join(directoryPath, 'permission-response.fifo'),
    attestationRequestFifoPath: join(directoryPath, 'attestation-request.fifo'),
    attestationResponseFifoPath: join(
      directoryPath,
      'attestation-response.fifo'
    ),
  };
}

async function defaultWriteGuardFile(
  filePath: string,
  contents: GuardFileContents
): Promise<void> {
  await fsPromises.writeFile(filePath, JSON.stringify(contents), {
    mode: 0o600,
  });
}

async function runLocalProcess(
  executable: string,
  args: string[]
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(executable, args, {
      stdio: 'ignore',
    });

    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(
        new MetaError(`${executable} exited while creating sandbox IPC`, {
          cause: `${args.join(' ')}: ${code ?? signal ?? 'unknown status'}`,
        })
      );
    });
  });
}

async function defaultCreatePermissionBridge(
  paths: PermissionBridgePaths
): Promise<void> {
  await fsPromises.mkdir(paths.directoryPath, { recursive: true, mode: 0o700 });
  await Promise.all([
    fsPromises.rm(paths.requestFifoPath, { force: true }),
    fsPromises.rm(paths.responseFifoPath, { force: true }),
    fsPromises.rm(paths.attestationRequestFifoPath, { force: true }),
    fsPromises.rm(paths.attestationResponseFifoPath, { force: true }),
  ]);
  await Promise.all([
    runLocalProcess('mkfifo', [paths.requestFifoPath]),
    runLocalProcess('mkfifo', [paths.responseFifoPath]),
    runLocalProcess('mkfifo', [paths.attestationRequestFifoPath]),
    runLocalProcess('mkfifo', [paths.attestationResponseFifoPath]),
  ]);
  await Promise.all([
    fsPromises.chmod(paths.requestFifoPath, 0o600),
    fsPromises.chmod(paths.responseFifoPath, 0o600),
    fsPromises.chmod(paths.attestationRequestFifoPath, 0o600),
    fsPromises.chmod(paths.attestationResponseFifoPath, 0o600),
  ]);
}

async function defaultRemovePermissionBridge(
  paths: PermissionBridgePaths
): Promise<void> {
  await fsPromises.rm(paths.directoryPath, { recursive: true, force: true });
}

async function defaultRunSandboxedCommand(
  command: string
): Promise<RunSandboxedCommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, {
      shell: true,
      stdio: 'inherit',
      env: process.env,
    });

    const forwardSignal = (signal: NodeJS.Signals): void => {
      if (!child.killed) {
        child.kill(signal);
      }
    };
    const forwardSigint = (): void => forwardSignal('SIGINT');
    const forwardSigterm = (): void => forwardSignal('SIGTERM');
    const forwardSighup = (): void => forwardSignal('SIGHUP');

    process.once('SIGINT', forwardSigint);
    process.once('SIGTERM', forwardSigterm);
    process.once('SIGHUP', forwardSighup);

    child.once('error', reject);
    child.once('exit', (code, signal) => {
      process.removeListener('SIGINT', forwardSigint);
      process.removeListener('SIGTERM', forwardSigterm);
      process.removeListener('SIGHUP', forwardSighup);
      resolve({ code, signal });
    });
  });
}

async function defaultReadCurrentNetworkNamespace(): Promise<
  string | undefined
> {
  try {
    return await fsPromises.readlink('/proc/self/ns/net');
  } catch (error) {
    logWarn('[Sandbox] Failed to read network namespace proof', {
      cause: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}

async function defaultProbeUnixSocketCreationBlocked(
  socketPath: string
): Promise<boolean> {
  await fsPromises.rm(socketPath, { force: true });

  return new Promise((resolve) => {
    const server = createServer();
    let settled = false;

    const settle = (blocked: boolean): void => {
      if (settled) {
        return;
      }
      settled = true;
      const finish = (): void => {
        void fsPromises.rm(socketPath, { force: true }).finally(() => {
          resolve(blocked);
        });
      };
      try {
        server.close(finish);
      } catch {
        finish();
      }
    };

    server.once('error', (error: NodeJS.ErrnoException) => {
      settle(error.code === 'EPERM');
    });
    server.once('listening', () => {
      settle(false);
    });
    server.listen(socketPath);
  });
}

function isWouldBlock(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === 'EAGAIN' || code === 'EWOULDBLOCK';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function hashStable(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}

function isPathUnder(filePath: string, dirPath: string): boolean {
  const normalizedDir = dirPath.endsWith('/') ? dirPath.slice(0, -1) : dirPath;
  return filePath === normalizedDir || filePath.startsWith(`${normalizedDir}/`);
}

function isPathUnderAny(filePath: string, paths: string[]): boolean {
  return paths.some((path) => isPathUnder(filePath, path));
}

function buildWholeProcessSandboxConfig(
  baseConfig: SandboxConfig,
  launchPaths: {
    bridgeDirectoryPath: string;
    canaryRootPath: string;
    denyReadCanaryDirectoryPath: string;
    denyWriteCanaryPath: string;
  }
): SandboxConfig {
  return {
    ...baseConfig,
    filesystem: {
      allowRead: baseConfig.filesystem.allowRead,
      allowWrite: [
        ...baseConfig.filesystem.allowWrite,
        launchPaths.bridgeDirectoryPath,
        launchPaths.canaryRootPath,
      ],
      denyRead: [
        ...baseConfig.filesystem.denyRead,
        launchPaths.denyReadCanaryDirectoryPath,
      ],
      denyWrite: [
        ...baseConfig.filesystem.denyWrite,
        launchPaths.denyWriteCanaryPath,
      ],
    },
    network: {
      ...baseConfig.network,
      allowAllUnixSockets: false,
    },
  };
}

function getGuardCanaryRootPath(guard: GuardFileContents): string {
  return dirname(dirname(guard.denyReadCanaryPath));
}

function sortByChallengeDigest<T>(
  values: readonly T[],
  challengeId: string
): T[] {
  return [...values].sort((left, right) =>
    hashStable({ challengeId, value: left }).localeCompare(
      hashStable({ challengeId, value: right })
    )
  );
}

function deriveDeniedNetworkProbeTargets(
  config: SandboxConfig,
  challengeId: string
): NetworkPolicyProbeTarget[] {
  return sortByChallengeDigest(DENIED_NETWORK_PROBE_CANDIDATES, challengeId)
    .map((candidate, index) => ({
      host: `drool-${hashStable({ challengeId, candidate, index }).slice(0, 16)}.${candidate.host}.sslip.io`,
      port: candidate.port,
      originalHost: candidate.host,
    }))
    .filter((candidate) =>
      config.network.allowedDomains.every(
        (pattern) =>
          !domainMatchesPattern(candidate.originalHost, pattern) &&
          !domainMatchesPattern(candidate.host, pattern)
      )
    )
    .slice(0, DENIED_NETWORK_PROBE_COUNT)
    .map(({ host, port }) => ({
      host,
      port,
      policyDerived: true,
      challengeId,
    }));
}

function makePolicyProbeDigest(
  config: SandboxConfig,
  configHash: string,
  challenge: ChildPolicyChallenge
) {
  return hashStable({
    configHash,
    filesystem: config.filesystem,
    network: config.network,
    challenge,
  });
}

function makeBridgeMac(
  token: string,
  payload: Record<string, unknown>
): string {
  return createHmac('sha256', token)
    .update(stableStringify(payload))
    .digest('hex');
}

function macEquals(left: unknown, right: string): boolean {
  if (typeof left !== 'string') {
    return false;
  }
  const leftBuffer = Buffer.from(left, 'hex');
  const rightBuffer = Buffer.from(right, 'hex');
  return (
    leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer)
  );
}

function permissionResponseMacPayload(params: {
  id: string;
  host: string;
  port: number | undefined;
  deadlineMs: number;
  responseFifoPath: string;
  decision: PermissionBridgeDecision['decision'];
  allowPattern?: string;
}): Record<string, unknown> {
  return {
    id: params.id,
    host: params.host,
    port: params.port,
    deadlineMs: params.deadlineMs,
    responseFifoPath: params.responseFifoPath,
    decision: params.decision,
    allowPattern: params.allowPattern,
  };
}

function attestationMacPayload(params: {
  id: string;
  launchId: string;
  configHash: string;
  probeDigest: string;
}): Record<string, unknown> {
  return {
    id: params.id,
    launchId: params.launchId,
    configHash: params.configHash,
    probeDigest: params.probeDigest,
  };
}

async function openFifoWithDeadline(
  fifoPath: string,
  deadlineMs: number
): Promise<Awaited<ReturnType<typeof fsPromises.open>>> {
  let lastError: unknown;
  while (Date.now() < deadlineMs) {
    try {
      return await fsPromises.open(fifoPath, FIFO_OPEN_FLAGS);
    } catch (error) {
      if (!isWouldBlock(error)) {
        lastError = error;
      }
      await sleep(25);
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new MetaError('Timed out opening whole-process sandbox FIFO', {
        cause: fifoPath,
      });
}

async function readNdjsonFrame(
  handle: Awaited<ReturnType<typeof fsPromises.open>>,
  deadlineMs: number
): Promise<unknown | undefined> {
  let buffered = '';
  while (Date.now() < deadlineMs) {
    const buffer = Buffer.alloc(PIPE_BUF_LIMIT);
    try {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead > 0) {
        buffered += buffer.subarray(0, bytesRead).toString('utf8');
        const line = buffered.split('\n').find((value) => value.trim());
        if (line) {
          return JSON.parse(line);
        }
      }
    } catch (error) {
      if (!isWouldBlock(error)) {
        return undefined;
      }
    }
    await sleep(25);
  }
  return undefined;
}

async function defaultRequestPermissionBridge(
  paths: PermissionBridgePaths,
  token: string,
  params: { host: string; port: number | undefined }
): Promise<PermissionBridgeDecision | undefined> {
  const requestId = randomBytes(8).toString('hex');
  const responseFifoPath = join(
    paths.directoryPath,
    `permission-response-${requestId}.fifo`
  );
  let requestHandle: Awaited<ReturnType<typeof fsPromises.open>> | undefined;
  let responseHandle: Awaited<ReturnType<typeof fsPromises.open>> | undefined;

  try {
    await fsPromises.rm(responseFifoPath, { force: true });
    await runLocalProcess('mkfifo', [responseFifoPath]);
    await fsPromises.chmod(responseFifoPath, 0o600);

    const deadlineMs = Date.now() + 60_000;
    requestHandle = await openFifoWithDeadline(
      paths.requestFifoPath,
      Date.now() + 2_000
    );
    responseHandle = await fsPromises.open(responseFifoPath, FIFO_OPEN_FLAGS);
    const requestFrame = JSON.stringify({
      version: 1,
      kind: 'network_permission_request',
      id: requestId,
      token,
      responseFifoPath,
      deadlineMs,
      ...params,
    });
    if (Buffer.byteLength(requestFrame) >= PIPE_BUF_LIMIT) {
      return undefined;
    }
    await requestHandle.write(`${requestFrame}\n`);

    let responseBuffer = '';

    while (Date.now() < deadlineMs) {
      const buffer = Buffer.alloc(4096);
      try {
        const { bytesRead } = await responseHandle.read(
          buffer,
          0,
          buffer.length,
          null
        );
        if (bytesRead > 0) {
          responseBuffer += buffer.subarray(0, bytesRead).toString('utf8');
          const lines = responseBuffer.split('\n');
          responseBuffer = lines.pop() ?? '';

          for (const line of lines) {
            if (!line.trim()) {
              continue;
            }
            const parsed = JSON.parse(line) as {
              version?: unknown;
              kind?: unknown;
              id?: unknown;
              decision?: unknown;
              allowPattern?: unknown;
              mac?: unknown;
            };
            if (
              parsed.version !== 1 ||
              parsed.kind !== 'network_permission_response' ||
              parsed.id !== requestId ||
              (parsed.decision !== 'deny' &&
                parsed.decision !== 'allow_once' &&
                parsed.decision !== 'allow_always')
            ) {
              continue;
            }
            const allowPattern =
              typeof parsed.allowPattern === 'string'
                ? parsed.allowPattern
                : undefined;
            const expectedMac = makeBridgeMac(
              token,
              permissionResponseMacPayload({
                id: requestId,
                host: params.host,
                port: params.port,
                deadlineMs,
                responseFifoPath,
                decision: parsed.decision,
                allowPattern,
              })
            );
            if (!macEquals(parsed.mac, expectedMac)) {
              return undefined;
            }
            if (parsed.decision === 'allow_once') {
              return { decision: 'allow_once' };
            }
            if (parsed.decision === 'allow_always') {
              return { decision: 'allow_always', allowPattern };
            }
            return { decision: 'deny' };
          }
        }
      } catch (error) {
        if (!isWouldBlock(error)) {
          return undefined;
        }
      }

      await sleep(25);
    }

    return undefined;
  } catch {
    return undefined;
  } finally {
    await Promise.allSettled([requestHandle?.close(), responseHandle?.close()]);
    await fsPromises.rm(responseFifoPath, { force: true }).catch(() => {});
  }
}

async function defaultCreateLaunchCanaries(
  token: string
): Promise<LaunchCanaries> {
  const rootPath = join(
    WHOLE_PROCESS_RUNTIME_ROOT,
    `${process.pid}-${token}`,
    'canaries'
  );
  const denyReadDirectoryPath = join(rootPath, 'deny-read');
  const denyReadCanaryPath = join(denyReadDirectoryPath, 'secret.txt');
  const denyWriteCanaryPath = join(rootPath, 'deny-write.txt');
  const denyReadCanarySecret = randomBytes(16).toString('hex');

  await fsPromises.mkdir(denyReadDirectoryPath, {
    recursive: true,
    mode: 0o700,
  });
  await fsPromises.writeFile(denyReadCanaryPath, denyReadCanarySecret, {
    mode: 0o600,
  });
  await fsPromises.writeFile(denyWriteCanaryPath, 'deny-write-canary', {
    mode: 0o600,
  });

  return {
    rootPath,
    denyReadDirectoryPath,
    denyReadCanaryPath,
    denyReadCanarySecret,
    denyWriteCanaryPath,
  };
}

async function defaultRemoveLaunchCanaries(
  canaries: LaunchCanaries
): Promise<void> {
  await fsPromises.rm(canaries.rootPath, { recursive: true, force: true });
}

async function defaultProbeFilesystemCanaries(
  guard: GuardFileContents
): Promise<boolean> {
  try {
    const content = await fsPromises.readFile(guard.denyReadCanaryPath, 'utf8');
    if (content.includes(guard.denyReadCanarySecret)) {
      return false;
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code !== 'EACCES' && code !== 'EPERM' && code !== 'ENOENT') {
      return false;
    }
  }

  try {
    await fsPromises.writeFile(guard.denyWriteCanaryPath, 'mutated');
    return false;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    return code === 'EACCES' || code === 'EPERM' || code === 'EROFS';
  }
}

async function probeReadPathDenied(path: string): Promise<boolean> {
  try {
    const stat = await fsPromises.stat(path);
    if (stat.isDirectory()) {
      await fsPromises.readdir(path);
      return false;
    }

    const content = await fsPromises.readFile(path);
    return content.length === 0;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    return (
      code === 'EACCES' ||
      code === 'EPERM' ||
      code === 'ENOENT' ||
      code === 'ENOTDIR'
    );
  }
}

async function probeWritePathDenied(path: string): Promise<boolean> {
  try {
    await fsPromises.access(path, fsConstants.W_OK);
    return false;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') {
      return true;
    }
    if (code !== 'ENOENT' && code !== 'ENOTDIR') {
      return false;
    }
  }

  try {
    await fsPromises.writeFile(path, 'whole-process-denied-write-probe', {
      flag: 'wx',
    });
    await fsPromises.rm(path, { force: true });
    return false;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    return code === 'EACCES' || code === 'EPERM' || code === 'EROFS';
  }
}

async function probeWritePathAllowed(path: string): Promise<boolean> {
  try {
    await fsPromises.writeFile(path, 'whole-process-allowed-write-probe');
    await fsPromises.rm(path, { force: true });
    return true;
  } catch {
    return false;
  }
}

async function probeNewWritePathDenied(path: string): Promise<boolean> {
  try {
    await fsPromises.writeFile(path, 'whole-process-denied-write-probe');
    await fsPromises.rm(path, { force: true });
    return false;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    return code === 'EACCES' || code === 'EPERM' || code === 'EROFS';
  }
}

function deriveDefaultDeniedWriteProbePaths(
  config: SandboxConfig,
  guard: GuardFileContents,
  challengeId: string
): string[] {
  const effectiveAllowWriteRoots = [
    process.cwd(),
    ...config.filesystem.allowWrite,
  ];
  const candidates: string[] = [];

  for (const [index, allowedRoot] of effectiveAllowWriteRoots.entries()) {
    if (!allowedRoot || allowedRoot === '/') {
      continue;
    }
    const suffix = hashStable({
      challengeId,
      index,
      allowedRoot,
    }).slice(0, 16);
    const candidate = `${allowedRoot}-sandbox-denied-${suffix}`;
    if (
      !isPathUnderAny(candidate, effectiveAllowWriteRoots) &&
      !isPathUnderAny(candidate, config.filesystem.denyWrite)
    ) {
      candidates.push(candidate);
    }
  }

  const suffix = hashStable({
    challengeId,
    bridgeDirectoryPath: guard.bridgeDirectoryPath,
  }).slice(0, 16);
  const fallback = join(
    dirname(guard.bridgeDirectoryPath),
    `default-deny-write-${suffix}`
  );
  if (
    !isPathUnderAny(fallback, effectiveAllowWriteRoots) &&
    !isPathUnderAny(fallback, config.filesystem.denyWrite)
  ) {
    candidates.push(fallback);
  }

  return [...new Set(candidates)].slice(0, 2);
}

function createChildPolicyChallenge(
  config: SandboxConfig,
  guard: GuardFileContents,
  createPolicyChallengeId: () => string
): ChildPolicyChallenge {
  const challengeId = createPolicyChallengeId();
  return {
    challengeId,
    filesystem: {
      allowedScratchPath: join(
        guard.bridgeDirectoryPath,
        `allowed-write-${challengeId}.tmp`
      ),
      deniedWritePaths: deriveDefaultDeniedWriteProbePaths(
        config,
        guard,
        challengeId
      ),
    },
    networkProbeTargets: deriveDeniedNetworkProbeTargets(config, challengeId),
  };
}

async function defaultProbeConfiguredFilesystemPolicy(
  config: SandboxConfig,
  guard: GuardFileContents,
  challenge: FilesystemPolicyChallenge
): Promise<boolean> {
  const canaryDenyReadDirectoryPath = dirname(guard.denyReadCanaryPath);
  const canaryDenyWritePath = guard.denyWriteCanaryPath;

  for (const deniedReadPath of config.filesystem.denyRead) {
    if (deniedReadPath === canaryDenyReadDirectoryPath) {
      continue;
    }
    if (!(await probeReadPathDenied(deniedReadPath))) {
      return false;
    }
  }

  for (const deniedWritePath of config.filesystem.denyWrite) {
    if (deniedWritePath === canaryDenyWritePath) {
      continue;
    }
    if (!(await probeWritePathDenied(deniedWritePath))) {
      return false;
    }
  }

  if (!(await probeWritePathAllowed(challenge.allowedScratchPath))) {
    return false;
  }

  if (challenge.deniedWritePaths.length === 0) {
    return false;
  }
  for (const deniedBoundaryPath of challenge.deniedWritePaths) {
    if (!(await probeNewWritePathDenied(deniedBoundaryPath))) {
      return false;
    }
  }

  return true;
}

async function defaultProbeRawNetworkBlocked(
  target: NetworkPolicyProbeTarget
): Promise<boolean> {
  const net = await import('node:net');
  return new Promise((resolve) => {
    const socket = net.createConnection({
      host: target.host,
      port: target.port,
    });
    const timeout = setTimeout(() => {
      socket.destroy();
      resolve(true);
    }, 1_000);

    socket.once('connect', () => {
      clearTimeout(timeout);
      socket.destroy();
      resolve(false);
    });
    socket.once('error', () => {
      clearTimeout(timeout);
      resolve(true);
    });
  });
}

export async function defaultProbeDescendantNetworkBlocked(
  target: NetworkPolicyProbeTarget,
  spawnFn: typeof spawn = spawn
): Promise<boolean> {
  const grandchildScript = [
    "const net=require('net');",
    `const s=net.createConnection({host:${JSON.stringify(target.host)},port:${target.port}});`,
    'const t=setTimeout(()=>{s.destroy();process.exit(0)},1000);',
    "s.once('connect',()=>{clearTimeout(t);s.destroy();process.exit(42)});",
    "s.once('error',()=>{clearTimeout(t);process.exit(0)});",
  ].join('');
  const script = [
    "const {spawn}=require('child_process');",
    "const net=require('net');",
    `const target=${JSON.stringify({ host: target.host, port: target.port })};`,
    `const grandchildScript=${JSON.stringify(grandchildScript)};`,
    'function probeChild(){',
    'return new Promise((resolve)=>{',
    'const s=net.createConnection(target);',
    'const t=setTimeout(()=>{s.destroy();resolve(0)},1000);',
    "s.once('connect',()=>{clearTimeout(t);s.destroy();resolve(42)});",
    "s.once('error',()=>{clearTimeout(t);resolve(0)});",
    '});',
    '}',
    'function probeGrandchild(){',
    'return new Promise((resolve)=>{',
    "const child=spawn(process.execPath,['-e',grandchildScript],{stdio:'ignore',env:Object.fromEntries(Object.entries(process.env).filter(([key])=>key!=='HTTP_PROXY'&&key!=='HTTPS_PROXY'&&key!=='ALL_PROXY'))});",
    'const t=setTimeout(()=>{child.kill("SIGKILL");resolve(0)},2000);',
    "child.once('exit',(code)=>{clearTimeout(t);resolve(code===0?0:42)});",
    "child.once('error',()=>{clearTimeout(t);resolve(42)});",
    '});',
    '}',
    '(async()=>{',
    'if ((await probeChild()) === 42) process.exit(42);',
    'process.exit(await probeGrandchild());',
    '})().catch(()=>process.exit(42));',
  ].join('');

  return new Promise((resolve) => {
    const child = spawnFn('node', ['-e', script], {
      stdio: 'ignore',
      env: Object.fromEntries(
        Object.entries(process.env).filter(
          ([key]) =>
            key !== 'HTTP_PROXY' && key !== 'HTTPS_PROXY' && key !== 'ALL_PROXY'
        )
      ),
    });

    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      resolve(false);
    }, 5_000);
    child.once('exit', (code) => {
      clearTimeout(timeout);
      // The probe script's contract is exit 0 (denied) or exit 42 (a denied
      // connection succeeded). Any other exit (crash codes, null on signal
      // kill) means the probes never ran to completion, which must not count
      // as proof of denial.
      resolve(code === 0);
    });
    child.once('error', () => {
      clearTimeout(timeout);
      resolve(false);
    });
  });
}

async function defaultPerformSupervisorAttestation(
  guard: GuardFileContents,
  _env: ProcessEnv,
  policyProbeDigest: string
): Promise<boolean> {
  let requestHandle: Awaited<ReturnType<typeof fsPromises.open>> | undefined;
  let responseHandle: Awaited<ReturnType<typeof fsPromises.open>> | undefined;
  const id = randomBytes(8).toString('hex');
  const deadlineMs = Date.now() + 5_000;
  const probeDigest = policyProbeDigest;

  try {
    requestHandle = await openFifoWithDeadline(
      guard.attestationRequestFifoPath,
      Date.now() + 2_000
    );
    responseHandle = await openFifoWithDeadline(
      guard.attestationResponseFifoPath,
      Date.now() + 2_000
    );
    const requestFrame = JSON.stringify({
      version: 1,
      kind: 'attest',
      id,
      launchId: guard.launchId,
      token: guard.token,
      configHash: guard.configHash,
      probeDigest,
    });
    if (Buffer.byteLength(requestFrame) >= PIPE_BUF_LIMIT) {
      return false;
    }
    await requestHandle.write(`${requestFrame}\n`);

    const response = (await readNdjsonFrame(responseHandle, deadlineMs)) as {
      version?: unknown;
      kind?: unknown;
      id?: unknown;
      ok?: unknown;
      mac?: unknown;
    };
    if (
      response?.version !== 1 ||
      response.kind !== 'attest-result' ||
      response.id !== id ||
      response.ok !== true
    ) {
      return false;
    }
    const expectedMac = makeBridgeMac(
      guard.token,
      attestationMacPayload({
        id,
        launchId: guard.launchId,
        configHash: guard.configHash,
        probeDigest,
      })
    );
    return macEquals(response.mac, expectedMac);
  } catch {
    return false;
  } finally {
    await Promise.allSettled([requestHandle?.close(), responseHandle?.close()]);
  }
}

async function defaultStartAttestationResponder(
  paths: PermissionBridgePaths,
  launch: Pick<GuardFileContents, 'launchId' | 'token' | 'configHash'>
): Promise<() => Promise<void>> {
  let stopped = false;
  const requestHandle = await fsPromises.open(
    paths.attestationRequestFifoPath,
    FIFO_OPEN_FLAGS
  );
  const responseHandle = await fsPromises.open(
    paths.attestationResponseFifoPath,
    FIFO_OPEN_FLAGS
  );

  const task = (async () => {
    while (!stopped) {
      const request = (await readNdjsonFrame(
        requestHandle,
        Date.now() + 250
      )) as {
        version?: unknown;
        kind?: unknown;
        id?: unknown;
        launchId?: unknown;
        token?: unknown;
        configHash?: unknown;
        probeDigest?: unknown;
      };
      if (!request) {
        continue;
      }
      if (
        request.version !== 1 ||
        request.kind !== 'attest' ||
        typeof request.id !== 'string' ||
        request.launchId !== launch.launchId ||
        request.token !== launch.token ||
        request.configHash !== launch.configHash ||
        typeof request.probeDigest !== 'string'
      ) {
        continue;
      }

      const mac = makeBridgeMac(
        launch.token,
        attestationMacPayload({
          id: request.id,
          launchId: launch.launchId,
          configHash: launch.configHash,
          probeDigest: request.probeDigest,
        })
      );
      await responseHandle.write(
        `${JSON.stringify({
          version: 1,
          kind: 'attest-result',
          id: request.id,
          ok: true,
          mac,
        })}\n`
      );
    }
  })();

  return async () => {
    stopped = true;
    await Promise.allSettled([
      task,
      requestHandle.close(),
      responseHandle.close(),
    ]);
  };
}

function getDefaultDeps(): EnsureWholeProcessSandboxDeps {
  return {
    env: process.env,
    argv: process.argv,
    execPath: process.execPath,
    pid: process.pid,
    uid: typeof process.getuid === 'function' ? process.getuid() : undefined,
    makeManager: () => new DroolSandboxManager(),
    createGuardToken: () => randomBytes(16).toString('hex'),
    createLaunchId: () => randomBytes(16).toString('hex'),
    createGuardPath: defaultCreateGuardPath,
    writeGuardFile: defaultWriteGuardFile,
    readGuardFile: fsPromises.readFile as unknown as (
      path: string
    ) => Promise<string>,
    statGuardFile: fsPromises.stat as unknown as (
      path: string
    ) => Promise<GuardFileStat>,
    removeGuardFile: async (path: string) => {
      await fsPromises.rm(path, { force: true });
    },
    readCurrentNetworkNamespace: defaultReadCurrentNetworkNamespace,
    probeUnixSocketCreationBlocked: defaultProbeUnixSocketCreationBlocked,
    probeFilesystemCanaries: defaultProbeFilesystemCanaries,
    probeConfiguredFilesystemPolicy: defaultProbeConfiguredFilesystemPolicy,
    probeRawNetworkBlocked: defaultProbeRawNetworkBlocked,
    probeDescendantNetworkBlocked: defaultProbeDescendantNetworkBlocked,
    performSupervisorAttestation: defaultPerformSupervisorAttestation,
    createPolicyChallengeId: () => randomBytes(16).toString('hex'),
    createLaunchCanaries: defaultCreateLaunchCanaries,
    removeLaunchCanaries: defaultRemoveLaunchCanaries,
    loadCurrentSandboxSettings: loadWholeProcessSandboxBootstrapSettings,
    createPermissionBridgePaths: defaultCreatePermissionBridgePaths,
    createPermissionBridge: defaultCreatePermissionBridge,
    removePermissionBridge: defaultRemovePermissionBridge,
    startAttestationResponder: defaultStartAttestationResponder,
    requestPermissionBridge: defaultRequestPermissionBridge,
    runSandboxedCommand: defaultRunSandboxedCommand,
    exitProcess: (code: number) => {
      process.exit(code);
    },
  };
}

function signalToExitCode(signal: NodeJS.Signals | null): number {
  if (!signal) return 1;
  const signalNumbers: Partial<Record<NodeJS.Signals, number>> = {
    SIGHUP: 1,
    SIGINT: 2,
    SIGTERM: 15,
  };
  return 128 + (signalNumbers[signal] ?? 1);
}

function extractNetConnectHost(args: unknown[]): string | null {
  const first = args[0];
  const second = args[1];

  if (typeof first === 'object' && first !== null) {
    const options = first as {
      host?: unknown;
      hostname?: unknown;
      path?: unknown;
    };
    if (typeof options.path === 'string') {
      return null;
    }
    const host = options.host ?? options.hostname;
    return typeof host === 'string' ? host : 'localhost';
  }

  if (typeof first === 'string') {
    return null;
  }

  if (typeof second === 'string') {
    return second;
  }

  return 'localhost';
}

function isLoopbackHost(host: string): boolean {
  const normalized = host.toLowerCase();
  return (
    normalized === 'localhost' ||
    normalized === '::1' ||
    normalized === '[::1]' ||
    normalized === '0.0.0.0' ||
    normalized.startsWith('127.')
  );
}

/**
 * Node's raw net/http/https clients do not honor HTTP_PROXY/HTTPS_PROXY by
 * default. In whole-process mode the supported direct in-process network path
 * is fetch/undici via the SRT proxy; raw socket-based APIs fail closed unless
 * they target loopback/proxy or a Unix socket.
 */
export function installWholeProcessNetworkGuards(deps?: {
  net?: MutableNetModule;
}): void {
  const netModule = deps?.net;
  if (!netModule || patchedNetModules.has(netModule)) {
    return;
  }
  patchedNetModules.add(netModule);

  const originalConnect = netModule.connect.bind(netModule);
  const originalCreateConnection = netModule.createConnection.bind(netModule);

  const guardConnect = (
    original: (...args: unknown[]) => unknown,
    args: unknown[]
  ): unknown => {
    const host = extractNetConnectHost(args);
    if (host && !isLoopbackHost(host)) {
      throw new MetaError(
        'Sandbox: unsupported direct network API blocked. Use fetch so whole-process network policy can mediate via the sandbox proxy.',
        { host }
      );
    }
    return original(...args);
  };

  netModule.connect = (...args: unknown[]): unknown =>
    guardConnect(originalConnect, args);
  netModule.createConnection = (...args: unknown[]): unknown =>
    guardConnect(originalCreateConnection, args);
  syncBuiltinESMExports();
}

async function installWholeProcessNetworkRuntime(
  env: ProcessEnv
): Promise<void> {
  try {
    const netModule = (await import('node:net')) as unknown as {
      default?: MutableNetModule;
    } & MutableNetModule;
    installWholeProcessNetworkGuards({
      net: netModule.default ?? netModule,
    });
  } catch (error) {
    logWarn(
      '[Sandbox] Failed to install whole-process raw network fail-closed guards',
      {
        cause: error instanceof Error ? error.message : String(error),
      }
    );
  }

  const proxyUrl = env.HTTPS_PROXY ?? env.HTTP_PROXY;
  if (!proxyUrl) {
    return;
  }

  try {
    // Node's fetch implementation is backed by undici but does not honor proxy
    // environment variables unless a dispatcher is installed.
    const { ProxyAgent, setGlobalDispatcher } = (await import(
      'undici'
    )) as unknown as {
      ProxyAgent: new (url: string) => unknown;
      setGlobalDispatcher: (dispatcher: unknown) => void;
    };
    setGlobalDispatcher(new ProxyAgent(proxyUrl));
  } catch (error) {
    // Bun fetch already honors proxy environment variables. If undici is not
    // available in another runtime, OS-level network isolation still fails
    // closed for denied hosts rather than falling back to raw networking.
    logWarn(
      '[Sandbox] Failed to install whole-process fetch proxy dispatcher',
      {
        cause: error instanceof Error ? error.message : String(error),
      }
    );
  }
}

function buildCurrentProcessCommand(
  deps: Pick<EnsureWholeProcessSandboxDeps, 'argv' | 'execPath'>,
  guardPath: string,
  guardToken: string,
  permissionBridgePaths: PermissionBridgePaths
): string {
  const scriptAndArgs = deps.argv.slice(1);
  return shellquote.quote([
    'env',
    `${DROOL_SANDBOXED_ENV}=1`,
    `${DROOL_WHOLE_PROCESS_SANDBOX_GUARD_PATH_ENV}=${guardPath}`,
    `${DROOL_WHOLE_PROCESS_SANDBOX_GUARD_TOKEN_ENV}=${guardToken}`,
    `${DROOL_WHOLE_PROCESS_SANDBOX_PERMISSION_REQUEST_FIFO_ENV}=${permissionBridgePaths.requestFifoPath}`,
    `${DROOL_WHOLE_PROCESS_SANDBOX_PERMISSION_RESPONSE_FIFO_ENV}=${permissionBridgePaths.responseFifoPath}`,
    `${DROOL_WHOLE_PROCESS_SANDBOX_ATTESTATION_REQUEST_FIFO_ENV}=${permissionBridgePaths.attestationRequestFifoPath}`,
    `${DROOL_WHOLE_PROCESS_SANDBOX_ATTESTATION_RESPONSE_FIFO_ENV}=${permissionBridgePaths.attestationResponseFifoPath}`,
    deps.execPath,
    ...scriptAndArgs,
  ]);
}

function findAllowedDomainPattern(
  config: SandboxConfig,
  host: string
): string | null {
  for (const pattern of config.network.allowedDomains) {
    if (domainMatchesPattern(host, pattern)) {
      return pattern;
    }
  }
  return null;
}

function createHostDirectNetworkAskCallback(
  manager: WholeProcessSandboxManager,
  deps: Pick<
    EnsureWholeProcessSandboxDeps,
    'loadCurrentSandboxSettings' | 'requestPermissionBridge'
  >,
  permissionBridgePaths: PermissionBridgePaths,
  permissionBridgeToken: string
): (params: { host: string; port: number | undefined }) => Promise<boolean> {
  const syncPersistedAllowance = async (host: string): Promise<boolean> => {
    try {
      const settings = await deps.loadCurrentSandboxSettings();
      if (!settings?.enabled || settings.mode !== SandboxMode.WholeProcess) {
        return false;
      }

      const config = buildSandboxConfig(settings);
      const matchingPattern = findAllowedDomainPattern(config, host);
      if (!matchingPattern) {
        return false;
      }

      await manager.allowDomain(matchingPattern);
      return true;
    } catch {
      return false;
    }
  };

  return async (params): Promise<boolean> => {
    const bridgeDecision = await deps.requestPermissionBridge(
      permissionBridgePaths,
      permissionBridgeToken,
      params
    );

    if (bridgeDecision?.decision === 'deny') {
      return false;
    }

    if (bridgeDecision?.decision === 'allow_once') {
      return true;
    }

    if (bridgeDecision?.decision === 'allow_always') {
      return syncPersistedAllowance(params.host);
    }

    // No bridge decision (timeout, malformed frame, missing reader): this is
    // not an allow-by-default. syncPersistedAllowance grants only when the
    // host already matches the settings-derived allowedDomains (healing a
    // stale SRT runtime, e.g. allow-always persisted by another session) and
    // denies everything else.
    return syncPersistedAllowance(params.host);
  };
}

async function validateWholeProcessSandboxChildRuntime(
  env: ProcessEnv = process.env,
  deps: Partial<ValidationDeps> = {},
  settings: SandboxSettings | undefined = undefined
): Promise<WholeProcessChildValidationResult> {
  if (env[DROOL_SANDBOXED_ENV] !== '1') {
    return { ok: false, reason: 'not_sandboxed_env' };
  }

  const guardPath = env[DROOL_WHOLE_PROCESS_SANDBOX_GUARD_PATH_ENV];
  const guardToken = env[DROOL_WHOLE_PROCESS_SANDBOX_GUARD_TOKEN_ENV];
  const permissionRequestFifoPath =
    env[DROOL_WHOLE_PROCESS_SANDBOX_PERMISSION_REQUEST_FIFO_ENV];
  const permissionResponseFifoPath =
    env[DROOL_WHOLE_PROCESS_SANDBOX_PERMISSION_RESPONSE_FIFO_ENV];
  const attestationRequestFifoPath =
    env[DROOL_WHOLE_PROCESS_SANDBOX_ATTESTATION_REQUEST_FIFO_ENV];
  const attestationResponseFifoPath =
    env[DROOL_WHOLE_PROCESS_SANDBOX_ATTESTATION_RESPONSE_FIFO_ENV];
  if (
    !guardPath ||
    !guardToken ||
    !permissionRequestFifoPath ||
    !permissionResponseFifoPath ||
    !attestationRequestFifoPath ||
    !attestationResponseFifoPath
  ) {
    return { ok: false, reason: 'missing_launch_material' };
  }

  const defaults = getDefaultDeps();
  const readGuardFile = deps.readGuardFile ?? defaults.readGuardFile;
  const statGuardFile = deps.statGuardFile ?? defaults.statGuardFile;
  const uid = deps.uid ?? defaults.uid;
  const pid = deps.pid ?? defaults.pid;
  const probeUnixSocketCreationBlocked =
    deps.probeUnixSocketCreationBlocked ??
    defaults.probeUnixSocketCreationBlocked;
  const probeFilesystemCanaries =
    deps.probeFilesystemCanaries ?? defaults.probeFilesystemCanaries;
  const probeConfiguredFilesystemPolicy =
    deps.probeConfiguredFilesystemPolicy ??
    defaults.probeConfiguredFilesystemPolicy;
  const probeRawNetworkBlocked =
    deps.probeRawNetworkBlocked ?? defaults.probeRawNetworkBlocked;
  const probeDescendantNetworkBlocked =
    deps.probeDescendantNetworkBlocked ??
    defaults.probeDescendantNetworkBlocked;
  const performSupervisorAttestation =
    deps.performSupervisorAttestation ?? defaults.performSupervisorAttestation;
  const createPolicyChallengeId =
    deps.createPolicyChallengeId ?? defaults.createPolicyChallengeId;

  try {
    const [raw, stat] = await Promise.all([
      readGuardFile(guardPath),
      statGuardFile(guardPath),
    ]);
    const parsed = JSON.parse(raw) as Partial<GuardFileContents>;

    if (
      parsed.version !== 1 ||
      typeof parsed.launchId !== 'string' ||
      parsed.token !== guardToken ||
      typeof parsed.configHash !== 'string' ||
      typeof parsed.supervisorPid !== 'number' ||
      parsed.supervisorPid <= 0 ||
      parsed.bridgeDirectoryPath !== dirname(permissionRequestFifoPath) ||
      parsed.requestFifoPath !== permissionRequestFifoPath ||
      parsed.responseFifoPath !== permissionResponseFifoPath ||
      parsed.attestationRequestFifoPath !== attestationRequestFifoPath ||
      parsed.attestationResponseFifoPath !== attestationResponseFifoPath ||
      typeof parsed.denyReadCanaryPath !== 'string' ||
      typeof parsed.denyReadCanarySecret !== 'string' ||
      typeof parsed.denyWriteCanaryPath !== 'string' ||
      !parsed.expectedProxyEnv ||
      typeof parsed.expectedProxyEnv !== 'object'
    ) {
      return { ok: false, reason: 'invalid_guard_shape' };
    }
    if (uid !== undefined && stat.uid !== undefined && stat.uid !== uid) {
      return { ok: false, reason: 'guard_owner_mismatch' };
    }
    if (stat.mode !== undefined && stat.mode % 0o100 !== 0) {
      return { ok: false, reason: 'guard_mode_too_permissive' };
    }

    const guard = parsed as GuardFileContents;
    let expectedConfig: SandboxConfig = {
      enabled: true,
      mode: SandboxMode.WholeProcess,
      filesystem: {
        allowRead: [],
        allowWrite: [],
        denyRead: [],
        denyWrite: [],
      },
      network: { allowedDomains: [] },
    };
    if (settings) {
      const baseConfig = buildSandboxConfig(settings);
      expectedConfig = buildWholeProcessSandboxConfig(baseConfig, {
        bridgeDirectoryPath: guard.bridgeDirectoryPath,
        canaryRootPath: getGuardCanaryRootPath(guard),
        denyReadCanaryDirectoryPath: dirname(guard.denyReadCanaryPath),
        denyWriteCanaryPath: guard.denyWriteCanaryPath,
      });
      const expectedConfigHash = hashStable(expectedConfig);
      if (guard.configHash !== expectedConfigHash) {
        return { ok: false, reason: 'config_hash_mismatch' };
      }
    }
    const childPolicyChallenge = createChildPolicyChallenge(
      expectedConfig,
      guard,
      createPolicyChallengeId
    );
    const policyProbeDigest = makePolicyProbeDigest(
      expectedConfig,
      guard.configHash,
      childPolicyChallenge
    );
    const deniedNetworkProbeTargets = childPolicyChallenge.networkProbeTargets;
    if (settings) {
      if (
        !(await probeConfiguredFilesystemPolicy(
          expectedConfig,
          guard,
          childPolicyChallenge.filesystem
        ))
      ) {
        return {
          ok: false,
          reason: 'configured_filesystem_policy_probe_failed',
        };
      }
    }
    if (deniedNetworkProbeTargets.length === 0) {
      return {
        ok: false,
        reason: 'network_policy_probe_targets_unavailable',
      };
    }

    for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY'] as const) {
      const expected = guard.expectedProxyEnv[key];
      if (expected && env[key] !== expected) {
        return { ok: false, reason: `proxy_env_mismatch_${key}` };
      }
    }

    // Linux SRT children run in an unshared PID namespace with a fresh /proc,
    // so host supervisor PIDs are not visible from the child. Treat the guard
    // file as supervisor-owned metadata and validate the child-side SRT
    // capability directly instead of walking host /proc ancestry.
    if (
      !(await probeUnixSocketCreationBlocked(
        join(dirname(permissionRequestFifoPath), `runtime-proof-${pid}.sock`)
      ))
    ) {
      return { ok: false, reason: 'unix_socket_not_blocked' };
    }
    if (!(await probeFilesystemCanaries(guard))) {
      return { ok: false, reason: 'filesystem_canary_probe_failed' };
    }
    for (const target of deniedNetworkProbeTargets) {
      if (!(await probeRawNetworkBlocked(target))) {
        return { ok: false, reason: 'raw_network_probe_succeeded' };
      }
    }
    for (const target of deniedNetworkProbeTargets) {
      if (!(await probeDescendantNetworkBlocked(target))) {
        return { ok: false, reason: 'descendant_network_probe_succeeded' };
      }
    }
    if (!(await performSupervisorAttestation(guard, env, policyProbeDigest))) {
      return { ok: false, reason: 'supervisor_attestation_failed' };
    }

    return { ok: true, launchId: guard.launchId, configHash: guard.configHash };
  } catch {
    return { ok: false, reason: 'guard_validation_error' };
  }
}

export async function isValidatedWholeProcessSandboxChild(
  env: ProcessEnv = process.env,
  deps: Partial<ValidationDeps> = {},
  settings: SandboxSettings | undefined = undefined
): Promise<boolean> {
  const result = await validateWholeProcessSandboxChildRuntime(
    env,
    deps,
    settings
  );
  return result.ok;
}

export async function ensureWholeProcessSandbox(
  settings: SandboxSettings | undefined | null,
  depsOverrides: Partial<EnsureWholeProcessSandboxDeps> = {}
): Promise<EnsureWholeProcessSandboxResult> {
  if (!settings?.enabled || settings.mode !== SandboxMode.WholeProcess) {
    return { status: 'not_requested' };
  }

  const deps = { ...getDefaultDeps(), ...depsOverrides };

  if (await isValidatedWholeProcessSandboxChild(deps.env, deps, settings)) {
    await installWholeProcessNetworkRuntime(deps.env);
    return { status: 'already_sandboxed' };
  }

  if (deps.env[DROOL_SANDBOXED_ENV] === '1') {
    throw new Error(
      'Invalid whole-process sandbox recursion guard. Refusing to continue with spoofed sandbox state.'
    );
  }

  const manager = deps.makeManager();
  const platform = await manager.checkPlatformSupport();
  if (!platform.supported) {
    throw new MetaError(
      'Whole-process sandbox is unsupported on this platform',
      {
        reason: platform.reason ?? 'unknown reason',
      }
    );
  }

  const dependencyCheck = await manager.checkDependencies();
  if (!dependencyCheck.satisfied) {
    throw new MetaError('Whole-process sandbox dependencies are unavailable', {
      failureReason: dependencyCheck.errors.join(', '),
    });
  }
  const seccompWarning = dependencyCheck.warnings.find((warning) =>
    /seccomp|unix/i.test(warning)
  );
  if (seccompWarning) {
    throw new MetaError(
      'Whole-process sandbox secure seccomp dependencies are unavailable',
      { failureReason: seccompWarning }
    );
  }

  const baseConfig = buildSandboxConfig(settings);
  if (baseConfig.network.allowAllUnixSockets === true) {
    throw new MetaError(
      'Whole-process sandbox refuses broad Unix socket permissions in secure mode'
    );
  }
  const guardToken = deps.createGuardToken();
  const launchId = deps.createLaunchId();
  const guardPath = deps.createGuardPath(guardToken);
  const permissionBridgePaths = deps.createPermissionBridgePaths(guardToken);
  const canaries = await deps.createLaunchCanaries(guardToken);
  const config = buildWholeProcessSandboxConfig(baseConfig, {
    bridgeDirectoryPath: permissionBridgePaths.directoryPath,
    canaryRootPath: canaries.rootPath,
    denyReadCanaryDirectoryPath: canaries.denyReadDirectoryPath,
    denyWriteCanaryPath: canaries.denyWriteCanaryPath,
  });
  const configHash = hashStable(config);
  let guardFileWritten = false;
  let bridgeCreated = false;
  let stopAttestationResponder: (() => Promise<void>) | undefined;
  let exitCode = 1;

  try {
    await deps.createPermissionBridge(permissionBridgePaths);
    bridgeCreated = true;

    await manager.initialize(
      config,
      undefined,
      createHostDirectNetworkAskCallback(
        manager,
        deps,
        permissionBridgePaths,
        guardToken
      )
    );
    if (!manager.isActive()) {
      throw new Error(
        'Whole-process sandbox initialization did not produce an active runtime'
      );
    }

    if (!(await deps.readCurrentNetworkNamespace())) {
      throw new MetaError(
        'Whole-process sandbox runtime state cannot be validated',
        {
          reason:
            'network namespace proof is unavailable, so the recursion guard cannot be trusted',
        }
      );
    }
    stopAttestationResponder = await deps.startAttestationResponder(
      permissionBridgePaths,
      { launchId, token: guardToken, configHash }
    );

    await deps.writeGuardFile(guardPath, {
      version: 1,
      launchId,
      token: guardToken,
      configHash,
      supervisorPid: deps.pid,
      bridgeDirectoryPath: permissionBridgePaths.directoryPath,
      requestFifoPath: permissionBridgePaths.requestFifoPath,
      responseFifoPath: permissionBridgePaths.responseFifoPath,
      attestationRequestFifoPath:
        permissionBridgePaths.attestationRequestFifoPath,
      attestationResponseFifoPath:
        permissionBridgePaths.attestationResponseFifoPath,
      denyReadCanaryPath: canaries.denyReadCanaryPath,
      denyReadCanarySecret: canaries.denyReadCanarySecret,
      denyWriteCanaryPath: canaries.denyWriteCanaryPath,
      expectedProxyEnv: manager.getProxyEnv?.() ?? {},
    });
    guardFileWritten = true;

    const childCommand = buildCurrentProcessCommand(
      deps,
      guardPath,
      guardToken,
      permissionBridgePaths
    );
    const wrappedCommand = await manager.wrapCommand(childCommand);
    const result = await deps.runSandboxedCommand(wrappedCommand);
    exitCode =
      result.code ?? (result.signal ? signalToExitCode(result.signal) : 1);
  } finally {
    await stopAttestationResponder?.();
    await manager.shutdown();
    if (guardFileWritten) {
      await deps.removeGuardFile(guardPath);
    }
    if (bridgeCreated) {
      await deps.removePermissionBridge(permissionBridgePaths);
    }
    await deps.removeLaunchCanaries(canaries);
  }

  deps.exitProcess(exitCode);
  return { status: 'supervisor_exited', code: exitCode };
}
