export function extractRuntimeSettingsPathArg(argv: string[]): {
  runtimeSettingsPathArg: string | null;
  filteredArgv: string[];
} {
  const filteredArgv: string[] = [];
  let runtimeSettingsPathArg: string | null = null;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === '--settings') {
      const next = argv[i + 1];
      if (!next || next.startsWith('-')) {
        throw new Error('Missing value for --settings <path>');
      }
      runtimeSettingsPathArg = next;
      i += 1;
      continue;
    }

    if (arg.startsWith('--settings=')) {
      const inlineValue = arg.slice('--settings='.length).trim();
      if (!inlineValue) {
        throw new Error('Missing value for --settings <path>');
      }
      runtimeSettingsPathArg = inlineValue;
      continue;
    }

    filteredArgv.push(arg);
  }

  return { runtimeSettingsPathArg, filteredArgv };
}

export function getSubcommandUserArgs(
  filteredArgv: string[],
  subcommand: string
): string[] {
  const subcommandIndex = filteredArgv.indexOf(subcommand);
  if (subcommandIndex === -1) {
    return [];
  }

  return filteredArgv.slice(subcommandIndex + 1);
}
