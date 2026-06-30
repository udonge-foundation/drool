import * as fs from 'fs';
import * as path from 'path';

import {
  parse as parseJsonc,
  printParseErrorCode,
  type ParseError,
} from 'jsonc-parser';

import { getIndustryHome } from '@industry/utils/cli';
import { getIndustryDirName } from '@industry/utils/environment';

export function offsetToLineCol(
  content: string,
  offset: number
): { line: number; col: number } {
  let line = 1;
  let col = 1;
  for (let i = 0; i < offset && i < content.length; i++) {
    if (content[i] === '\n') {
      line++;
      col = 1;
    } else {
      col++;
    }
  }
  return { line, col };
}

export function formatJsoncParseError(
  content: string,
  errors: ParseError[]
): string {
  const first = errors[0];
  if (!first) return 'Invalid JSON/JSONC';
  const { line, col } = offsetToLineCol(content, first.offset);
  return `line ${line}, col ${col}: ${printParseErrorCode(first.error)}`;
}

export function getUserAndProjectMcpConfigPaths(
  gitRoot: string | null
): string[] {
  const projectRoot = gitRoot ?? process.cwd();
  return [
    path.join(getIndustryHome(), getIndustryDirName(), 'mcp.json'),
    path.join(projectRoot, '.industry', 'mcp.json'),
  ];
}

export function findMcpConfigParseErrorSync(
  filePath: string
): { path: string; message: string } | null {
  let content: string;
  try {
    content = fs.readFileSync(filePath, 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    return {
      path: filePath,
      message:
        error instanceof Error ? error.message : 'Failed to read mcp.json',
    };
  }

  const errors: ParseError[] = [];
  parseJsonc(content, errors);
  if (errors.length === 0) return null;

  return {
    path: filePath,
    message: formatJsoncParseError(content, errors),
  };
}

export async function findFirstMcpConfigParseError(
  gitRoot: string | null
): Promise<{ path: string; message: string } | null> {
  for (const filePath of getUserAndProjectMcpConfigPaths(gitRoot)) {
    const error = findMcpConfigParseErrorSync(filePath);
    if (error) return error;
  }
  return null;
}
