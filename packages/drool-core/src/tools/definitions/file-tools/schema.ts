import { z } from 'zod';

import { AssemblyFragmentType } from '@industry/common/session';

import { RepoLocationType, SaveStatus } from './enums';

// Used for both remote and local indexed repos
const indexedRepoSchema = z.object({
  type: z
    .enum([RepoLocationType.INDEXED_REPO])
    .describe(
      'Use `indexedRepo` type for both remote and local indexed repos that have an repo URL'
    ),
  repoUrl: z
    .string()
    .describe(
      `Unique identifier of the repository for local or remote repositories in the URL format. Example: 'https://github.com/user/repo' for remote repository, 'https://github.com/user/repo?local=true' for local repository.`
    ),
});
// Used for local files accessed through TUI or CDE that are not from indexed local repos
const fileSystemSchema = z.object({
  type: z
    .enum([RepoLocationType.FILE_SYSTEM])
    .describe(
      'Use `fileSystem` type for files on the file system of your connected machine that are not from indexed local repos'
    ),
  repoPath: z
    .string()
    .describe(
      `An absolute path to a repo directory on the file system of your connected machine that is not accessible through an indexed repo. Example: '/home/user/project'`
    ),
});
// Used for files that are not associated with any repository or machine, eg. one-off temporary files created in session
const nonRepoFileSchema = z.object({
  type: z
    .enum([RepoLocationType.NON_REPO_FILE])
    .describe(
      'Use `nonRepoFile` type for files that are not associated with any repository or machine, e.g. one-off temporary files created in the current session'
    ),
  // No additional properties needed as these files aren't associated with any repository
});
// New repo location schema that's sent to LLM

export const repoLocationSchema = z
  .discriminatedUnion('type', [
    indexedRepoSchema,
    fileSystemSchema,
    nonRepoFileSchema,
  ])
  .describe(
    `An object (not a string) that specifies the repository location. Must follow the repoLocationSchema structure which can represent different types of repositories using one of these types: ${Object.values(
      RepoLocationType
    )
      .filter((type) => type !== 'localFileRepo')
      .join(', ')}.`
  );

export type RepoLocation = z.infer<typeof repoLocationSchema>;
// ======= To be deprecated in favor of fileSystem type =======
// Deprecated schema for backward compatibility with existing code
const localFileRepoSchema = z.object({
  type: z
    .enum([RepoLocationType.LOCAL_FILE_REPO])
    .describe(
      'Use `localFileRepo` type for files on the file system of your connected machine that are not from indexed local repos'
    ),
  repoPath: z
    .string()
    .describe(
      `An absolute path to a repo directory on the file system of your connected machine that is not accessible through an indexed repo. Example: '/home/user/project'`
    ),
});

export const deprecatedRepoLocationSchema = z.discriminatedUnion('type', [
  indexedRepoSchema,
  fileSystemSchema,
  nonRepoFileSchema,
  localFileRepoSchema, // to be deprecated
]);

export type DeprecatedRepoLocation = z.infer<
  typeof deprecatedRepoLocationSchema
>;

const saveStatusSchema = z.nativeEnum(SaveStatus);

export const editFileAnthropicSchema = z.object({
  repoLocation: repoLocationSchema,
  filePath: z.string().describe('The path to the file to edit'),
  oldStr: z.string().describe('The exact text to find and replace in the file'),
  newStr: z.string().describe('The text to replace the oldStr with'),
  changeAll: z
    .boolean()
    .optional()
    .default(false)
    .describe(
      'Whether to replace all occurrences (true) or just the first one (false). Defaults to false.'
    ),
});

// ========================================================
// Base schema for file operation results

export const fileOperationResultSchema = z.object({
  success: z.boolean(),
  repoLocation: deprecatedRepoLocationSchema.optional(), // TODO: migrate to repoLocationSchema
  filePath: z.string(),
  type: z.nativeEnum(AssemblyFragmentType),
  title: z.string(),
  language: z.string(),
  repositoryUrl: z.string().optional(), // empty for files from non-indexed repos or temporary files
  content: z.string(),
  // Optional line-range metadata (start & end are 1-based, inclusive)
  start: z.number().optional(),
  end: z.number().optional(),
  isPartialFile: z.boolean().optional(), // Indicates if the file is partial due to start/end parameters or content length
  fullContent: z.string().optional(), // Full content of the file, only used by viewFile tool. Not sent to LLM.

  // Optional properties for file operations
  savedRepoPath: z.string().optional(), // Path where the file was saved
  saveStatus: saveStatusSchema.optional(), // Status of the save operation

  // Only populated by editFile tool
  diff: z.string().optional(),
  // Flag indicating whether the file has been soft-deleted by user
  toolResultDeleted: z.boolean().optional(),
  // Deprecated properties
  workingFolder: z.string().optional(), // to be deprecated in favor of repoLocation
  repositoryUniqueId: z.string().optional(), // deprecated in favor of repositoryUrl
  repo: z.string().optional(), // deprecated in favor of repositoryUrl
});

export type FileOperationResult = z.infer<typeof fileOperationResultSchema>;
