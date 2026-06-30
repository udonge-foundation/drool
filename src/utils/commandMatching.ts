import { Fzf, type FzfResultItem } from 'fzf';

import { SlashCommand } from '@/commands/types';

interface IndexedCommand {
  command: SlashCommand;
  index: number;
}

interface CommandMatch {
  command: SlashCommand;
  originalIndex: number;
  nameResult?: FzfResultItem<IndexedCommand>;
  descriptionResult?: FzfResultItem<IndexedCommand>;
}

interface SlashCommandCompletionSelection {
  input: string;
  cursorPosition: number;
  availableCommands: SlashCommand[];
  displayedCommands: SlashCommand[];
  selectedIndex: number;
}

function getCommandName(command: SlashCommand): string {
  return typeof command.name === 'string' ? command.name : '';
}

function getCommandDescription(command: SlashCommand): string {
  return typeof command.description === 'string' ? command.description : '';
}

export function extractSlashCommandQuery(
  input: string,
  cursorPosition: number
): string | null {
  if (!input.startsWith('/') || cursorPosition < 1) return null;
  const textAfterSlash = input.slice(1, cursorPosition);
  // Once there is whitespace after the slash, the user has finished
  // typing the command name and is providing arguments — hide suggestions.
  if (/\s/.test(textAfterSlash)) return null;
  return textAfterSlash || '';
}

export function matchCommands(
  commands: SlashCommand[],
  query: string
): SlashCommand[] {
  if (!query) {
    return commands;
  }

  const indexedCommands = commands.map((command, index) => ({
    command,
    index,
  }));
  const matchesByIndex = new Map<number, CommandMatch>();

  const nameFzf = new Fzf(indexedCommands, {
    casing: 'case-insensitive',
    selector: ({ command }) => getCommandName(command),
  });
  const descriptionFzf = new Fzf(indexedCommands, {
    casing: 'case-insensitive',
    selector: ({ command }) => getCommandDescription(command),
  });

  const ensureMatch = (indexedCommand: IndexedCommand): CommandMatch => {
    const existing = matchesByIndex.get(indexedCommand.index);
    if (existing) return existing;
    const match: CommandMatch = {
      command: indexedCommand.command,
      originalIndex: indexedCommand.index,
    };
    matchesByIndex.set(indexedCommand.index, match);
    return match;
  };

  for (const result of nameFzf.find(query)) {
    ensureMatch(result.item).nameResult = result;
  }

  for (const result of descriptionFzf.find(query)) {
    ensureMatch(result.item).descriptionResult = result;
  }

  const lowerQuery = query.toLowerCase();

  const getRankBucket = (match: CommandMatch): number => {
    if (!match.nameResult) {
      return 5;
    }

    const name = getCommandName(match.command).toLowerCase();
    if (name === lowerQuery) {
      return 0;
    }

    const isBuiltIn = match.command.suggestionKind === 'internal-menu';
    const isPrefix = name.startsWith(lowerQuery);

    if (isBuiltIn && isPrefix) {
      return 1;
    }

    if (isBuiltIn) {
      return 2;
    }

    if (isPrefix) {
      return 3;
    }

    return 4;
  };

  const getSortScore = (match: CommandMatch): number =>
    (match.nameResult ?? match.descriptionResult)?.score ??
    Number.NEGATIVE_INFINITY;

  const getNameLength = (match: CommandMatch): number =>
    getCommandName(match.command).length;

  return Array.from(matchesByIndex.values())
    .sort((a, b) => {
      const bucketDelta = getRankBucket(a) - getRankBucket(b);
      if (bucketDelta !== 0) return bucketDelta;

      const aName = getCommandName(a.command).toLowerCase();
      const bName = getCommandName(b.command).toLowerCase();
      if (aName.startsWith(lowerQuery) && bName.startsWith(lowerQuery)) {
        const lengthDelta = getNameLength(a) - getNameLength(b);
        if (lengthDelta !== 0) return lengthDelta;
      }

      const scoreDelta = getSortScore(b) - getSortScore(a);
      if (scoreDelta !== 0) return scoreDelta;

      return a.originalIndex - b.originalIndex;
    })
    .map((match) => match.command);
}

export function selectSlashCommandForCompletion({
  input,
  cursorPosition,
  availableCommands,
  displayedCommands,
  selectedIndex,
}: SlashCommandCompletionSelection): SlashCommand | undefined {
  const query = extractSlashCommandQuery(input, cursorPosition);
  if (query === null) {
    return displayedCommands[selectedIndex];
  }

  const currentCommands = matchCommands(availableCommands, query);
  const displayedCommandsAreCurrent =
    currentCommands.length === displayedCommands.length &&
    currentCommands.every(
      (command, index) => command === displayedCommands[index]
    );

  return currentCommands[displayedCommandsAreCurrent ? selectedIndex : 0];
}

export function hasCompletedSlashCommand(
  input: string,
  commands: SlashCommand[]
): boolean {
  if (!input.startsWith('/')) return false;
  const firstSpace = input.indexOf(' ');
  if (firstSpace === -1) return false;
  const name = input.slice(1, firstSpace).toLowerCase();
  return commands.some((c) => c.name.toLowerCase() === name);
}
