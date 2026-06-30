import type { FileSuggestionDisplayParts } from './types';

export type { FileSuggestionDisplayParts } from './types';

function getNormalizedPathWithoutTrailingSlash(filePath: string): {
  isDirectory: boolean;
  pathWithoutTrailingSlash: string;
} {
  const normalizedPath = filePath.replace(/\\/g, '/');
  const isDirectory = normalizedPath.endsWith('/');

  return {
    isDirectory,
    pathWithoutTrailingSlash: isDirectory
      ? normalizedPath.slice(0, -1)
      : normalizedPath,
  };
}

function extractDirectoriesFromFiles(filePaths: string[]): string[] {
  const dirSet = new Set<string>();

  for (const filePath of filePaths) {
    const { pathWithoutTrailingSlash } =
      getNormalizedPathWithoutTrailingSlash(filePath);
    const pathParts = pathWithoutTrailingSlash.split('/');

    for (let index = 1; index < pathParts.length; index++) {
      dirSet.add(pathParts.slice(0, index).join('/'));
    }
  }

  return Array.from(dirSet).sort((a, b) => {
    const aDepth = a.split('/').length;
    const bDepth = b.split('/').length;
    if (aDepth !== bDepth) {
      return aDepth - bDepth;
    }
    return a.localeCompare(b);
  });
}

export function getFileSuggestionCandidates(filePaths: string[]): string[] {
  const directories = extractDirectoriesFromFiles(filePaths).map(
    (directory) => `${directory}/`
  );
  return [...directories, ...filePaths];
}

export function getFileSuggestionDisplayParts(
  filePath: string
): FileSuggestionDisplayParts {
  const { isDirectory, pathWithoutTrailingSlash } =
    getNormalizedPathWithoutTrailingSlash(filePath);
  const lastSlashIndex = pathWithoutTrailingSlash.lastIndexOf('/');
  const basename =
    lastSlashIndex >= 0
      ? pathWithoutTrailingSlash.substring(lastSlashIndex + 1)
      : pathWithoutTrailingSlash;

  return {
    directory:
      lastSlashIndex >= 0
        ? pathWithoutTrailingSlash.substring(0, lastSlashIndex)
        : '',
    filename: isDirectory ? `${basename}/` : basename,
    isDirectory,
  };
}
