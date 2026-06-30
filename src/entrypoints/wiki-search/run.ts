import chalk from 'chalk';

import { getAuthHeadersOrThrow } from '@/api/config';
import { fetchBackend } from '@/api/fetchBackend';
import { getAuthErrorMessage } from '@/commands/authHelpers';
import { resolveWikiRunId } from '@/entrypoints/wiki-read/run';
import {
  assertWikiFeatureEnabled,
  extract403Message,
  isNetworkErrorMessage,
  writeStderr,
  writeStdout,
} from '@/entrypoints/wiki-shared/wiki-utils';
import { getI18n } from '@/i18n';

import type { WikiSearchResponse } from '@industry/common/api/v0/wiki';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface WikiSearchOptions {
  repoUrl?: string;
  wikiRunId?: string;
  query: string;
  limit?: string;
  json?: boolean;
}

// ---------------------------------------------------------------------------
// Result formatting
// ---------------------------------------------------------------------------

export function formatSearchResults(
  results: WikiSearchResponse['results']
): string {
  const lines: string[] = [];

  for (const result of results) {
    lines.push(chalk.bold(result.title));
    lines.push(chalk.dim(`  ${result.path}`));
    lines.push(`  ${result.snippet}`);
    lines.push('');
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Main logic
// ---------------------------------------------------------------------------

export async function runWikiSearch(options: WikiSearchOptions): Promise<void> {
  const t = getI18n().t;

  if (!options.repoUrl && !options.wikiRunId) {
    writeStderr(
      t('commands:wikiSearch.errorPrefix', {
        message: t('commands:wikiSearch.missingIdentifier'),
      })
    );
    process.exitCode = 1;
    return;
  }

  const limit = options.limit !== undefined ? parseInt(options.limit, 10) : 20;
  if (Number.isNaN(limit) || limit < 1) {
    writeStderr(
      t('commands:wikiSearch.errorPrefix', {
        message: t('commands:wikiSearch.invalidLimit'),
      })
    );
    process.exitCode = 1;
    return;
  }

  let headers: Record<string, string>;
  try {
    headers = await getAuthHeadersOrThrow();
  } catch {
    writeStderr(getAuthErrorMessage());
    process.exitCode = 1;
    return;
  }

  let wikiRunId: string;
  try {
    if (options.wikiRunId) {
      wikiRunId = options.wikiRunId;
    } else {
      wikiRunId = await resolveWikiRunId(options.repoUrl!, headers);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    if (message === 'AUTH_FAILED') {
      writeStderr(
        t('commands:wikiSearch.errorPrefix', {
          message: t('commands:wikiSearch.authFailed'),
        })
      );
    } else if (message.startsWith('CLOUD_SYNC_DISABLED:')) {
      const serverMessage = message.slice('CLOUD_SYNC_DISABLED:'.length);
      writeStderr(
        t('commands:wikiSearch.errorPrefix', {
          message: t('commands:wikiSearch.cloudSyncDisabled', {
            message: serverMessage,
          }),
        })
      );
    } else if (message === 'NO_WIKI_FOUND') {
      writeStderr(
        t('commands:wikiSearch.errorPrefix', {
          message: t('commands:wikiSearch.noWikiFound', {
            repoUrl: options.repoUrl!,
          }),
        })
      );
    } else {
      writeStderr(
        t('commands:wikiSearch.errorPrefix', {
          message,
        })
      );
    }
    process.exitCode = 1;
    return;
  }

  try {
    const encodedQuery = encodeURIComponent(options.query);
    const response = await fetchBackend(
      `/api/v0/wiki/${encodeURIComponent(wikiRunId)}/search?q=${encodedQuery}&limit=${limit}`,
      { headers }
    );

    if (!response.ok) {
      if (response.status === 401) {
        writeStderr(
          t('commands:wikiSearch.errorPrefix', {
            message: t('commands:wikiSearch.authFailed'),
          })
        );
      } else if (response.status === 403) {
        const serverMessage = await extract403Message(response);
        writeStderr(
          t('commands:wikiSearch.errorPrefix', {
            message: t('commands:wikiSearch.cloudSyncDisabled', {
              message: serverMessage,
            }),
          })
        );
      } else if (response.status === 404) {
        writeStderr(
          t('commands:wikiSearch.errorPrefix', {
            message: t('commands:wikiSearch.wikiRunNotFound', {
              wikiRunId,
            }),
          })
        );
      } else {
        const body = await response.text().catch(() => 'Unknown error');
        writeStderr(
          t('commands:wikiSearch.errorPrefix', {
            message: t('commands:wikiSearch.apiFailed', {
              status: response.status,
              body,
            }),
          })
        );
      }
      process.exitCode = 1;
      return;
    }

    const data = (await response.json()) as WikiSearchResponse;

    if (options.json) {
      writeStdout(JSON.stringify(data, null, 2));
    } else if (data.results.length === 0) {
      writeStdout(t('commands:wikiSearch.noResults', { query: options.query }));
    } else {
      writeStdout(formatSearchResults(data.results));
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (isNetworkErrorMessage(message)) {
      writeStderr(
        t('commands:wikiSearch.errorPrefix', {
          message: t('commands:wikiSearch.networkError', { message }),
        })
      );
    } else {
      writeStderr(
        t('commands:wikiSearch.errorPrefix', {
          message: t('commands:wikiSearch.genericError', { message }),
        })
      );
    }
    process.exitCode = 1;
  }
}

// ---------------------------------------------------------------------------
// Exported run function
// ---------------------------------------------------------------------------

export async function run(options: WikiSearchOptions): Promise<void> {
  try {
    await assertWikiFeatureEnabled();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const t = getI18n().t;

    if (message === 'WIKI_FEATURE_DISABLED') {
      writeStderr(
        t('commands:wikiSearch.errorPrefix', {
          message: t('commands:wikiSearch.featureDisabled'),
        })
      );
      process.exitCode = 1;
      return;
    }

    writeStderr(
      t('commands:wikiSearch.errorPrefix', {
        message: t('commands:wikiSearch.featureUnverified'),
      })
    );
    process.exitCode = 1;
    return;
  }

  await runWikiSearch(options);
}
