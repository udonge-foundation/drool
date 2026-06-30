import { Command } from 'commander';

export function makeCommand(): Command {
  return new Command('wiki-upload')
    .description('Upload wiki pages')
    .option('--session-id <id>', 'Session ID that generated the wiki')
    .option('--repo-url <url>', 'Repository URL')
    .option(
      '--wiki-dir <path>',
      'Path to the wiki directory containing markdown files. Auto-discovers <wikiDir>/video/overview.mp4 (video/mp4, max 100 MB) and video/captions.<language>.vtt when present.'
    )
    .option('--cleanup', 'Delete wiki directory after successful upload')
    .option(
      '--check',
      'Check if wiki cloud sync is enabled for the organization'
    )
    .option(
      '--upload-to <targets>',
      'Upload targets: industry, github, or both (comma-separated, default: industry)'
    )
    .option(
      '--copy-from-wiki-run-id <id>',
      'Reuse the video overview from a prior wiki run instead of uploading a new video'
    )
    .hook('preAction', async () => {
      const { bootstrapLightweight } = await import(
        '@/entrypoints/bootstrap/lightweight'
      );
      await bootstrapLightweight();
    })
    .action(async (options) => {
      const { run } = await import('./run.ts');
      await run(options);
    });
}
