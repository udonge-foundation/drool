import { IndustryFeatureFlags } from '@industry/common/feature-flags';
import { fetchFeatureFlags } from '@industry/runtime/feature-flags';

import { getI18n } from '@/i18n';

interface WikiUploadOptions {
  sessionId?: string;
  repoUrl?: string;
  wikiDir?: string;
  cleanup?: boolean;
  check?: boolean;
  uploadTo?: string;
  copyFromWikiRunId?: string;
}

function writeStderr(message: string): void {
  process.stderr.write(`${message}\n`);
}

async function assertWikiFeatureEnabled(): Promise<void> {
  const flags = await fetchFeatureFlags();
  const wikiFlag = flags[IndustryFeatureFlags.Wiki.statsigName];

  if (wikiFlag === false) {
    throw new Error('WIKI_FEATURE_DISABLED');
  }

  if (wikiFlag !== true) {
    throw new Error('WIKI_FEATURE_UNVERIFIED');
  }
}

export async function run(options: WikiUploadOptions): Promise<void> {
  // --check mode doesn't need wiki feature flag
  if (options.check) {
    const { checkWikiCloudSync } = await import('./handler.ts');
    await checkWikiCloudSync();
    return;
  }

  // Validate required options when not using --check
  if (!options.repoUrl) {
    writeStderr("error: required option '--repo-url <url>' not specified");
    process.exitCode = 1;
    return;
  }

  if (!options.wikiDir) {
    writeStderr("error: required option '--wiki-dir <path>' not specified");
    process.exitCode = 1;
    return;
  }

  try {
    await assertWikiFeatureEnabled();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    if (message === 'WIKI_FEATURE_DISABLED') {
      writeStderr(
        getI18n().t('commands:wikiUpload.errorPrefix', {
          message: getI18n().t('commands:wikiUpload.featureDisabled'),
        })
      );
      process.exitCode = 1;
      return;
    }

    writeStderr(
      getI18n().t('commands:wikiUpload.errorPrefix', {
        message: getI18n().t('commands:wikiUpload.featureUnverified'),
      })
    );
    process.exitCode = 1;
    return;
  }

  const { runWikiUpload } = await import('./handler.ts');
  await runWikiUpload({
    sessionId: options.sessionId,
    repoUrl: options.repoUrl,
    wikiDir: options.wikiDir,
    cleanup: options.cleanup,
    uploadTo: options.uploadTo,
    copyFromWikiRunId: options.copyFromWikiRunId,
  });
}
