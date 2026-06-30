import { GitCloneRefOptions } from './types';

/**
 * Build the `git clone` argument list for a marketplace/plugin source.
 *
 * When a `sha` is pinned we use a blobless partial clone (`--filter=blob:none
 * --no-checkout`) so an untrusted source can't force a full-history blob
 * download; the follow-up `git checkout <sha>` fetches blobs on demand for the
 * pinned commit only. Otherwise we keep the shallow clone and pass `--branch
 * <ref>` to pin to a branch or tag.
 */
export function buildGitCloneArgs(options: GitCloneRefOptions): string[] {
  if (options.sha) {
    return ['--filter=blob:none', '--no-checkout'];
  }

  const args = ['--depth', '1'];
  if (options.ref) {
    args.push('--branch', options.ref);
  }
  return args;
}
