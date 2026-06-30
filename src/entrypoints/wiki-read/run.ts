import chalk from 'chalk';

import { getAuthHeadersOrThrow } from '@/api/config';
import { fetchBackend } from '@/api/fetchBackend';
import { getAuthErrorMessage } from '@/commands/authHelpers';
import {
  assertWikiFeatureEnabled,
  extract403Message,
  isNetworkErrorMessage,
  writeStderr,
  writeStdout,
} from '@/entrypoints/wiki-shared/wiki-utils';
import { getI18n } from '@/i18n';

import type {
  GetWikiPageResponse,
  GetWikiRunResponse,
  ListWikiRunHistoryResponse,
  ListWikiRunsResponse,
} from '@industry/common/api/v0/wiki';
import type { PageTreeNode } from '@industry/common/wiki';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface WikiReadOptions {
  repoUrl?: string;
  wikiRunId?: string;
  page?: string;
  json?: boolean;
}

// ---------------------------------------------------------------------------
// Wiki run resolution
// ---------------------------------------------------------------------------

export async function resolveWikiRunId(
  repoUrl: string,
  headers: Record<string, string>
): Promise<string> {
  const t = getI18n().t;

  const response = await fetchBackend('/api/v0/wiki', { headers });

  if (!response.ok) {
    if (response.status === 401) {
      throw new Error('AUTH_FAILED');
    }
    if (response.status === 403) {
      const serverMessage = await extract403Message(response);
      // eslint-disable-next-line industry/structured-logging -- sentinel string parsed by catch handler below
      throw new Error(`CLOUD_SYNC_DISABLED:${serverMessage}`);
    }
    const body = await response.text().catch(() => 'Unknown error');
    throw new Error(
      t('commands:wikiRead.apiFailed', {
        status: response.status,
        body,
      })
    );
  }

  const data = (await response.json()) as ListWikiRunsResponse;
  const matchingRun = data.wikiRuns.find(
    (wikiRun) =>
      wikiRun.repoUrl === repoUrl ||
      wikiRun.repoUrl.replace(/\.git$/, '') === repoUrl.replace(/\.git$/, '')
  );

  if (!matchingRun) {
    throw new Error('NO_WIKI_FOUND');
  }

  return matchingRun.wikiRunId;
}

// ---------------------------------------------------------------------------
// Page tree rendering
// ---------------------------------------------------------------------------

export function renderPageTree(
  nodes: PageTreeNode[],
  indent: number = 0
): string {
  const lines: string[] = [];
  const prefix = '  '.repeat(indent);

  for (const node of nodes) {
    const pageIdDisplay = chalk.dim(`(${node.pageId})`);
    lines.push(`${prefix}${chalk.bold(node.title)} ${pageIdDisplay}`);

    if (node.children && node.children.length > 0) {
      lines.push(renderPageTree(node.children, indent + 1));
    }
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Main logic
// ---------------------------------------------------------------------------

export async function runWikiRead(options: WikiReadOptions): Promise<void> {
  const t = getI18n().t;

  if (!options.repoUrl && !options.wikiRunId) {
    writeStderr(
      t('commands:wikiRead.errorPrefix', {
        message: t('commands:wikiRead.missingIdentifier'),
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

  // Show history listing when --repo-url is provided without --wiki-run-id and --page
  if (options.repoUrl && !options.wikiRunId && !options.page) {
    try {
      const encodedRepoUrl = encodeURIComponent(options.repoUrl);
      const response = await fetchBackend(
        `/api/v0/wiki/history/${encodedRepoUrl}`,
        { headers }
      );

      if (!response.ok) {
        if (response.status === 401) {
          writeStderr(
            t('commands:wikiRead.errorPrefix', {
              message: t('commands:wikiRead.authFailed'),
            })
          );
        } else if (response.status === 403) {
          const serverMessage = await extract403Message(response);
          writeStderr(
            t('commands:wikiRead.errorPrefix', {
              message: t('commands:wikiRead.cloudSyncDisabled', {
                message: serverMessage,
              }),
            })
          );
        } else {
          const body = await response.text().catch(() => 'Unknown error');
          writeStderr(
            t('commands:wikiRead.errorPrefix', {
              message: t('commands:wikiRead.apiFailed', {
                status: response.status,
                body,
              }),
            })
          );
        }
        process.exitCode = 1;
        return;
      }

      const data = (await response.json()) as ListWikiRunHistoryResponse;

      if (options.json) {
        writeStdout(JSON.stringify(data.wikiRuns, null, 2));
      } else {
        writeStdout(
          chalk.bold(
            `Wiki history for ${options.repoUrl} (${data.wikiRuns.length} runs):\n`
          )
        );

        for (const wikiRun of data.wikiRuns) {
          const date = new Date(wikiRun.createdAt).toLocaleString();
          const shortHash = wikiRun.commitHash.slice(0, 7);

          writeStdout(
            `  ${chalk.bold(wikiRun.wikiRunId)}  ${date}  branch:${wikiRun.branch}  commit:${shortHash}  pages:${wikiRun.pageCount}`
          );
        }

        writeStdout('');
        writeStdout(
          chalk.dim('Use --wiki-run-id <id> to view a specific version')
        );
      }
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (isNetworkErrorMessage(message)) {
        writeStderr(
          t('commands:wikiRead.errorPrefix', {
            message: t('commands:wikiRead.networkError', { message }),
          })
        );
      } else {
        writeStderr(
          t('commands:wikiRead.errorPrefix', {
            message: t('commands:wikiRead.genericError', { message }),
          })
        );
      }
      process.exitCode = 1;
      return;
    }
  }

  // Resolve wiki run ID
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
        t('commands:wikiRead.errorPrefix', {
          message: t('commands:wikiRead.authFailed'),
        })
      );
    } else if (message.startsWith('CLOUD_SYNC_DISABLED:')) {
      const serverMessage = message.slice('CLOUD_SYNC_DISABLED:'.length);
      writeStderr(
        t('commands:wikiRead.errorPrefix', {
          message: t('commands:wikiRead.cloudSyncDisabled', {
            message: serverMessage,
          }),
        })
      );
    } else if (message === 'NO_WIKI_FOUND') {
      writeStderr(
        t('commands:wikiRead.errorPrefix', {
          message: t('commands:wikiRead.noWikiFound', {
            repoUrl: options.repoUrl!,
          }),
        })
      );
    } else {
      writeStderr(
        t('commands:wikiRead.errorPrefix', {
          message,
        })
      );
    }
    process.exitCode = 1;
    return;
  }

  try {
    if (options.page) {
      const response = await fetchBackend(
        `/api/v0/wiki/${encodeURIComponent(wikiRunId)}/pages/${encodeURIComponent(options.page)}`,
        { headers }
      );

      if (!response.ok) {
        if (response.status === 404) {
          writeStderr(
            t('commands:wikiRead.errorPrefix', {
              message: t('commands:wikiRead.pageNotFound', {
                pageId: options.page,
              }),
            })
          );
        } else if (response.status === 401) {
          writeStderr(
            t('commands:wikiRead.errorPrefix', {
              message: t('commands:wikiRead.authFailed'),
            })
          );
        } else if (response.status === 403) {
          const serverMessage = await extract403Message(response);
          writeStderr(
            t('commands:wikiRead.errorPrefix', {
              message: t('commands:wikiRead.cloudSyncDisabled', {
                message: serverMessage,
              }),
            })
          );
        } else {
          const body = await response.text().catch(() => 'Unknown error');
          writeStderr(
            t('commands:wikiRead.errorPrefix', {
              message: t('commands:wikiRead.apiFailed', {
                status: response.status,
                body,
              }),
            })
          );
        }
        process.exitCode = 1;
        return;
      }

      const page = (await response.json()) as GetWikiPageResponse;

      if (options.json) {
        writeStdout(JSON.stringify(page, null, 2));
      } else {
        writeStdout(chalk.bold(page.title));
        writeStdout(chalk.dim(`Path: ${page.path}`));
        writeStdout('');
        writeStdout(page.content);
      }
    } else {
      const response = await fetchBackend(
        `/api/v0/wiki/${encodeURIComponent(wikiRunId)}`,
        { headers }
      );

      if (!response.ok) {
        if (response.status === 404) {
          writeStderr(
            t('commands:wikiRead.errorPrefix', {
              message: t('commands:wikiRead.wikiRunNotFound', {
                wikiRunId,
              }),
            })
          );
        } else if (response.status === 401) {
          writeStderr(
            t('commands:wikiRead.errorPrefix', {
              message: t('commands:wikiRead.authFailed'),
            })
          );
        } else if (response.status === 403) {
          const serverMessage = await extract403Message(response);
          writeStderr(
            t('commands:wikiRead.errorPrefix', {
              message: t('commands:wikiRead.cloudSyncDisabled', {
                message: serverMessage,
              }),
            })
          );
        } else {
          const body = await response.text().catch(() => 'Unknown error');
          writeStderr(
            t('commands:wikiRead.errorPrefix', {
              message: t('commands:wikiRead.apiFailed', {
                status: response.status,
                body,
              }),
            })
          );
        }
        process.exitCode = 1;
        return;
      }

      const wikiRun = (await response.json()) as GetWikiRunResponse;

      if (options.json) {
        writeStdout(JSON.stringify(wikiRun, null, 2));
      } else {
        writeStdout(
          chalk.bold(
            t('commands:wikiRead.treeHeader', {
              wikiRunId,
              pageCount: wikiRun.pageCount,
            })
          )
        );
        writeStdout('');
        writeStdout(renderPageTree(wikiRun.pageTree));
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (isNetworkErrorMessage(message)) {
      writeStderr(
        t('commands:wikiRead.errorPrefix', {
          message: t('commands:wikiRead.networkError', { message }),
        })
      );
    } else {
      writeStderr(
        t('commands:wikiRead.errorPrefix', {
          message: t('commands:wikiRead.genericError', { message }),
        })
      );
    }
    process.exitCode = 1;
  }
}

// ---------------------------------------------------------------------------
// Exported run function
// ---------------------------------------------------------------------------

export async function run(options: WikiReadOptions): Promise<void> {
  try {
    await assertWikiFeatureEnabled();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const t = getI18n().t;

    if (message === 'WIKI_FEATURE_DISABLED') {
      writeStderr(
        t('commands:wikiRead.errorPrefix', {
          message: t('commands:wikiRead.featureDisabled'),
        })
      );
      process.exitCode = 1;
      return;
    }

    writeStderr(
      t('commands:wikiRead.errorPrefix', {
        message: t('commands:wikiRead.featureUnverified'),
      })
    );
    process.exitCode = 1;
    return;
  }

  await runWikiRead(options);
}
