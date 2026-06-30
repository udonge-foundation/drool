import fs from 'fs';
import path from 'path';

import { SandboxSideEffect } from '@industry/drool-core/tools/enums';
import {
  type IndustryTool,
  type SandboxSideEffects,
} from '@industry/drool-core/tools/types';
import {
  SandboxOperationType,
  SandboxViolationType,
} from '@industry/drool-sdk-ext/protocol/drool';

import { normalizeMacScreenshotPath } from '@/agent/file-edit/utils';
import type { SandboxViolation } from '@/sandbox/types';
import { getSandboxService } from '@/services/SandboxService';

type SandboxPreCheckContext = {
  cwd?: string;
};

const MEDIATED_WEB_SEARCH_SCOPE_URL =
  'industry-mediated-search://mediated-web-search';

function makeToolPolicyViolation({
  toolName,
  sideEffect,
  message,
}: {
  toolName: string;
  sideEffect?: SandboxSideEffect;
  message: string;
}): SandboxViolation {
  return {
    type: SandboxViolationType.Tool,
    toolName,
    sideEffect,
    operation: SandboxOperationType.Tool,
    message,
    timestamp: Date.now(),
    promptable: false,
  };
}

function makeMalformedFilesystemToolViolation(
  toolName: string,
  message: string,
  sideEffect: SandboxSideEffect = SandboxSideEffect.FilesystemWrite
): SandboxViolation {
  return makeToolPolicyViolation({
    toolName,
    sideEffect,
    message,
  });
}

function getPreCheckCwd(context?: SandboxPreCheckContext): string {
  return path.resolve(context?.cwd ?? process.cwd());
}

function fileExistsForReadCheck(targetPath: string): boolean {
  try {
    return fs.existsSync(targetPath);
  } catch {
    return false;
  }
}

function resolveFilesystemTarget(
  targetPath: string,
  context?: SandboxPreCheckContext
): string {
  return path.isAbsolute(targetPath)
    ? targetPath
    : path.resolve(getPreCheckCwd(context), targetPath);
}

function failClosedForRejectedRelativePath(
  toolName: string,
  inputName: string,
  inputValue: string,
  sideEffect: SandboxSideEffect
): SandboxViolation {
  return makeMalformedFilesystemToolViolation(
    toolName,
    `Sandbox: tool policy denied for ${toolName}; relative ${inputName} "${inputValue}" is invalid for this executor and cannot be dispatched unchecked`,
    sideEffect
  );
}

function parseApplyPatchTargets(
  toolName: string,
  patchInput: string,
  context?: SandboxPreCheckContext
):
  | { ok: true; targetPath: string }
  | { ok: false; violation: SandboxViolation } {
  const targets: string[] = [];

  for (const line of patchInput.split(/\r?\n/)) {
    const match = line.match(/^\*\*\* (?:Add|Update) File:\s*(.*)$/);
    if (!match) continue;

    const rawTarget = match[1]?.trim();
    if (!rawTarget) {
      return {
        ok: false,
        violation: makeMalformedFilesystemToolViolation(
          toolName,
          `Sandbox: tool policy denied for ${toolName}; malformed patch file target cannot be dispatched unchecked`
        ),
      };
    }
    targets.push(rawTarget);
  }

  if (targets.length === 0) {
    return {
      ok: false,
      violation: makeMalformedFilesystemToolViolation(
        toolName,
        `Sandbox: tool policy denied for ${toolName}; malformed patch input has no file target to check`
      ),
    };
  }

  const resolvedTargets = targets.map((target) =>
    resolveFilesystemTarget(target, context)
  );
  const uniqueTargets = new Set(resolvedTargets);

  if (uniqueTargets.size !== resolvedTargets.length) {
    return {
      ok: false,
      violation: makeMalformedFilesystemToolViolation(
        toolName,
        `Sandbox: tool policy denied for ${toolName}; duplicate file target cannot be unambiguously checked before dispatch`
      ),
    };
  }

  if (resolvedTargets.length > 1) {
    return {
      ok: false,
      violation: makeMalformedFilesystemToolViolation(
        toolName,
        `Sandbox: tool policy denied for ${toolName}; multiple file targets cannot be dispatched by the single-target executor unchecked`
      ),
    };
  }

  return { ok: true, targetPath: resolvedTargets[0]! };
}

function validateToolSideEffectMetadata(
  toolName: string,
  tool?: Pick<IndustryTool, 'id' | 'sideEffects'>
): SandboxViolation | null {
  if (!tool) {
    return makeToolPolicyViolation({
      toolName,
      message: `Sandbox: tool policy denied for ${toolName}; tool is unknown or unregistered`,
    });
  }

  if (!Object.prototype.hasOwnProperty.call(tool, 'sideEffects')) {
    return makeToolPolicyViolation({
      toolName,
      message: `Sandbox: tool policy denied for ${toolName}; missing sandbox side-effect metadata`,
    });
  }

  if (!Array.isArray(tool.sideEffects)) {
    return makeToolPolicyViolation({
      toolName,
      message: `Sandbox: tool policy denied for ${toolName}; invalid sandbox side-effect metadata`,
    });
  }

  return null;
}

function validateDeclaredSideEffectsAreHandled(
  toolName: string,
  tool: Pick<IndustryTool, 'id' | 'sideEffects'> | undefined,
  handledSideEffects: SandboxSideEffects
): SandboxViolation | null {
  // Unit tests and lower-level callers may exercise canonical built-in
  // handlers without a registry definition. The default branch remains
  // fail-closed for unknown tools; registered callers pass the tool definition
  // so side-effect metadata is still enforced on runtime tool surfaces.
  if (!tool) return null;

  const metadataViolation = validateToolSideEffectMetadata(toolName, tool);
  if (metadataViolation) return metadataViolation;

  const unhandled = tool!.sideEffects.find(
    (sideEffect) => !handledSideEffects.includes(sideEffect)
  );
  if (!unhandled) return null;

  return makeToolPolicyViolation({
    toolName,
    sideEffect: unhandled,
    message: `Sandbox: tool policy denied for ${toolName}; declared side effect ${unhandled} has no sandbox policy handler`,
  });
}

function validateDefaultToolPolicy(
  toolName: string,
  tool?: Pick<IndustryTool, 'id' | 'sideEffects'>
): SandboxViolation[] {
  const metadataViolation = validateToolSideEffectMetadata(toolName, tool);
  if (metadataViolation) return [metadataViolation];

  if (!tool?.sideEffects || tool.sideEffects.length === 0) return [];
  const unhandledSideEffect = tool.sideEffects[0];

  return [
    makeToolPolicyViolation({
      toolName,
      sideEffect: unhandledSideEffect,
      message: `Sandbox: tool policy denied for ${toolName}; declared side effect ${unhandledSideEffect} has no sandbox policy handler`,
    }),
  ];
}

/**
 * Pre-check sandbox violations for a tool BEFORE execution.
 *
 * Returns all violations found for the tool's file/network access,
 * allowing the confirmation flow to prompt the user before the tool
 * runs. This eliminates the need for executor-level sandbox guards
 * on file/network tools (Execute domain prompts remain at runtime).
 */
export function checkSandboxViolationsForTool(
  toolName: string,
  toolInput: Record<string, unknown>,
  tool?: Pick<IndustryTool, 'id' | 'sideEffects'>,
  context?: SandboxPreCheckContext
): SandboxViolation[] {
  const sandbox = getSandboxService();
  if (!sandbox.isEnabled()) return [];

  const toolKey = tool?.id ?? toolName;

  switch (toolKey) {
    case 'Read':
    case 'read-cli': {
      const policyViolation = validateDeclaredSideEffectsAreHandled(
        toolName,
        tool,
        [SandboxSideEffect.FilesystemRead]
      );
      if (policyViolation) return [policyViolation];
      const filePath = toolInput.file_path as string;
      if (!filePath || typeof filePath !== 'string') {
        return [
          makeMalformedFilesystemToolViolation(
            toolName,
            `Sandbox: tool policy denied for ${toolName}; malformed file_path cannot be dispatched unchecked`,
            SandboxSideEffect.FilesystemRead
          ),
        ];
      }
      if (!path.isAbsolute(filePath)) {
        return [
          failClosedForRejectedRelativePath(
            toolName,
            'file_path',
            filePath,
            SandboxSideEffect.FilesystemRead
          ),
        ];
      }
      const v = sandbox.checkFileAccess(filePath, SandboxOperationType.Read);
      if (v) return [v];

      const normalizedPath = normalizeMacScreenshotPath(filePath);
      if (normalizedPath !== filePath) {
        const nv = sandbox.checkFileAccess(
          normalizedPath,
          SandboxOperationType.Read
        );
        if (nv) return [nv];
      }
      return [];
    }

    case 'LS':
    case 'ls-cli': {
      const policyViolation = validateDeclaredSideEffectsAreHandled(
        toolName,
        tool,
        [SandboxSideEffect.FilesystemRead]
      );
      if (policyViolation) return [policyViolation];
      const rawDirPath = toolInput.directory_path;
      if (rawDirPath !== undefined && typeof rawDirPath !== 'string') {
        return [
          makeMalformedFilesystemToolViolation(
            toolName,
            `Sandbox: tool policy denied for ${toolName}; malformed directory_path cannot be dispatched unchecked`,
            SandboxSideEffect.FilesystemRead
          ),
        ];
      }
      const dirPath = rawDirPath;
      const isDot = typeof dirPath === 'string' && dirPath.trim() === '.';
      const cwd = getPreCheckCwd(context);
      if (
        !isDot &&
        dirPath &&
        typeof dirPath === 'string' &&
        !path.isAbsolute(dirPath)
      ) {
        return [
          failClosedForRejectedRelativePath(
            toolName,
            'directory_path',
            dirPath,
            SandboxSideEffect.FilesystemRead
          ),
        ];
      }
      const targetPath = isDot || !dirPath ? cwd : dirPath;
      const v = sandbox.checkFileAccess(
        path.resolve(targetPath),
        SandboxOperationType.Read
      );
      return v ? [v] : [];
    }

    case 'Create':
    case 'create-cli': {
      const policyViolation = validateDeclaredSideEffectsAreHandled(
        toolName,
        tool,
        [SandboxSideEffect.FilesystemWrite]
      );
      if (policyViolation) return [policyViolation];
      const filePath = toolInput.file_path as string;
      if (!filePath || typeof filePath !== 'string') {
        return [
          makeMalformedFilesystemToolViolation(
            toolName,
            `Sandbox: tool policy denied for ${toolName}; malformed file_path cannot be dispatched unchecked`
          ),
        ];
      }
      const createTarget = resolveFilesystemTarget(filePath, context);
      const createViolations: SandboxViolation[] = [];
      const createWriteV = sandbox.checkFileAccess(
        createTarget,
        SandboxOperationType.Write
      );
      if (createWriteV) createViolations.push(createWriteV);
      // Overwriting an existing file reads its old content (diff/snapshot) in
      // the executor, so an existing target must also pass the read policy.
      if (fileExistsForReadCheck(createTarget)) {
        const createReadV = sandbox.checkFileAccess(
          createTarget,
          SandboxOperationType.Read
        );
        if (createReadV) createViolations.push(createReadV);
      }
      return createViolations;
    }

    case 'Edit':
    case 'edit-cli': {
      const policyViolation = validateDeclaredSideEffectsAreHandled(
        toolName,
        tool,
        [SandboxSideEffect.FilesystemRead, SandboxSideEffect.FilesystemWrite]
      );
      if (policyViolation) return [policyViolation];
      const filePath = toolInput.file_path as string;
      if (!filePath || typeof filePath !== 'string') {
        return [
          makeMalformedFilesystemToolViolation(
            toolName,
            `Sandbox: tool policy denied for ${toolName}; malformed file_path cannot be dispatched unchecked`
          ),
        ];
      }
      const targetPath = resolveFilesystemTarget(filePath, context);
      const violations: SandboxViolation[] = [];
      const writeV = sandbox.checkFileAccess(
        targetPath,
        SandboxOperationType.Write
      );
      if (writeV) violations.push(writeV);
      const readV = sandbox.checkFileAccess(
        targetPath,
        SandboxOperationType.Read
      );
      if (readV) violations.push(readV);
      return violations;
    }

    case 'Grep':
    case 'grep-search-cli':
    case 'grep_tool_cli': {
      const policyViolation = validateDeclaredSideEffectsAreHandled(
        toolName,
        tool,
        [SandboxSideEffect.FilesystemRead]
      );
      if (policyViolation) return [policyViolation];
      const rawSearchPath = toolInput.path;
      if (rawSearchPath !== undefined && typeof rawSearchPath !== 'string') {
        return [
          makeMalformedFilesystemToolViolation(
            toolName,
            `Sandbox: tool policy denied for ${toolName}; malformed path cannot be dispatched unchecked`,
            SandboxSideEffect.FilesystemRead
          ),
        ];
      }
      const searchPath = rawSearchPath
        ? resolveFilesystemTarget(rawSearchPath, context)
        : getPreCheckCwd(context);
      const v = sandbox.checkFileAccess(searchPath, SandboxOperationType.Read);
      return v ? [v] : [];
    }

    case 'Glob':
    case 'glob-search-cli':
    case 'glob_tool_cli': {
      const policyViolation = validateDeclaredSideEffectsAreHandled(
        toolName,
        tool,
        [SandboxSideEffect.FilesystemRead]
      );
      if (policyViolation) return [policyViolation];
      const rawFolder = toolInput.folder;
      if (rawFolder !== undefined && typeof rawFolder !== 'string') {
        return [
          makeMalformedFilesystemToolViolation(
            toolName,
            `Sandbox: tool policy denied for ${toolName}; malformed folder cannot be dispatched unchecked`,
            SandboxSideEffect.FilesystemRead
          ),
        ];
      }
      const folder = rawFolder
        ? resolveFilesystemTarget(rawFolder, context)
        : getPreCheckCwd(context);
      const v = sandbox.checkFileAccess(folder, SandboxOperationType.Read);
      return v ? [v] : [];
    }

    case 'FetchUrl':
    case 'fetch_url': {
      const policyViolation = validateDeclaredSideEffectsAreHandled(
        toolName,
        tool,
        [SandboxSideEffect.Network]
      );
      if (policyViolation) return [policyViolation];
      const url = toolInput.url as string;
      if (!url) return [];
      if (!URL.canParse(url)) return [];
      const parsed = new URL(url);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return [];
      }
      const v = sandbox.checkNetworkAccess(url);
      return v ? [v] : [];
    }

    case 'WebSearch':
    case 'web_search':
    case 'web-search': {
      const policyViolation = validateDeclaredSideEffectsAreHandled(
        toolName,
        tool,
        [SandboxSideEffect.Network]
      );
      if (policyViolation) return [policyViolation];
      const query = toolInput.query;
      if (!query || typeof query !== 'string') return [];
      const v = sandbox.checkNetworkAccess(MEDIATED_WEB_SEARCH_SCOPE_URL);
      return v ? [v] : [];
    }

    case 'ApplyPatch':
    case 'apply-patch-cli': {
      const policyViolation = validateDeclaredSideEffectsAreHandled(
        toolName,
        tool,
        [SandboxSideEffect.FilesystemRead, SandboxSideEffect.FilesystemWrite]
      );
      if (policyViolation) return [policyViolation];
      const patchInput = toolInput.input as string;
      if (!patchInput || typeof patchInput !== 'string') {
        return [
          makeMalformedFilesystemToolViolation(
            toolName,
            `Sandbox: tool policy denied for ${toolName}; malformed patch input cannot be dispatched unchecked`
          ),
        ];
      }
      const parsedTarget = parseApplyPatchTargets(
        toolName,
        patchInput,
        context
      );
      if (!parsedTarget.ok) return [parsedTarget.violation];
      const filePath = parsedTarget.targetPath;
      const violations: SandboxViolation[] = [];
      const writeV = sandbox.checkFileAccess(
        filePath,
        SandboxOperationType.Write
      );
      if (writeV) violations.push(writeV);
      const readV = sandbox.checkFileAccess(
        filePath,
        SandboxOperationType.Read
      );
      if (readV) violations.push(readV);
      return violations;
    }

    case 'ExitSpecMode':
    case 'exit-spec-mode': {
      // Metadata-only: the spec write target is computed from the plan/title
      // inside the executor, which owns the single sandbox prompt via
      // enforceSandboxFileAccess. Prompting here too would double-prompt and,
      // for "Allow once", ask the user twice before the spec is saved.
      const policyViolation = validateDeclaredSideEffectsAreHandled(
        toolName,
        tool,
        [SandboxSideEffect.FilesystemWrite]
      );
      return policyViolation ? [policyViolation] : [];
    }

    case 'Execute':
    case 'execute-cli': {
      const metadataViolation = validateToolSideEffectMetadata(toolName, tool);
      if (metadataViolation) return [metadataViolation];
      const policyViolation = validateDeclaredSideEffectsAreHandled(
        toolName,
        tool,
        [SandboxSideEffect.Process]
      );
      return policyViolation ? [policyViolation] : [];
    }

    default:
      return validateDefaultToolPolicy(toolName, tool);
  }
}
