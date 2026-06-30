import chalk from 'chalk';

import { SessionSearchDocKind } from '@industry/common/daemon';
import { logException } from '@industry/logging';
import { MetaError } from '@industry/logging/errors';
import {
  runDroolSearch,
  type DroolFindOptions,
} from '@industry/runtime/session-search';

import { getI18n } from '@/i18n';
import { formatDroolSearchResultsHuman } from '@/search/sessionSearch';

const parseKind = (value: string): DroolFindOptions['kind'] => {
  if (value === 'all') return 'all';
  if ((Object.values(SessionSearchDocKind) as string[]).includes(value)) {
    return value as SessionSearchDocKind;
  }
  throw new MetaError('Invalid --kind value', { value: { kind: value } });
};

export async function run(
  query: string,
  opts: {
    kind: string;
    limitSessions: number;
    limitHits: number;
    contextChars: number;
    json?: boolean;
    reindex?: boolean;
  }
): Promise<void> {
  try {
    const options: DroolFindOptions = {
      kind: parseKind(opts.kind),
      limitSessions: opts.limitSessions,
      limitHitsPerSession: opts.limitHits,
      contextChars: opts.contextChars,
      json: Boolean(opts.json),
      reindex: Boolean(opts.reindex),
    };

    const results = await runDroolSearch(query, options);

    if (options.json) {
      process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
      return;
    }

    process.stdout.write(`${formatDroolSearchResultsHuman(results)}\n`);
  } catch (error) {
    logException(error, 'search command failed');
    process.stderr.write(
      `${chalk.red(getI18n().t('commands:search.searchFailed'))} ${String(error)}\n`
    );
    process.exitCode = 1;
  }
}
