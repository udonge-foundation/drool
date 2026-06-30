import { ANSI } from '@/components/chat/constants';
import { KeyFlag } from '@/keyboard/enums';
import {
  matchesCtrlLetterKeyEvent,
  matchesEnterKeyEvent,
  matchesEscapeKeyEvent,
  matchesKeyFlag,
  matchesPrintableKeyEvent,
  matchesTabKeyEvent,
  parseCsiUSequence,
} from '@/keyboard/keyEventMatcher';
import type {
  KeyEventLike,
  DocumentaryKeyboardChordDefinition,
  KeyboardChord,
  KeyboardChordDefinition,
  KeyboardChordId,
  KeyboardMatchableChord,
  KeyboardMatchableChordId,
  KeyboardModifierRequirements,
  KeyboardPrintableMatcherOptions,
  MatchableKeyboardChordDefinition,
} from '@/keyboard/types';

const CTRL_LETTER_CHORD_IDS = {
  c: 'ctrl-c',
  d: 'ctrl-d',
  e: 'ctrl-e',
  g: 'ctrl-g',
  j: 'ctrl-j',
  l: 'ctrl-l',
  n: 'ctrl-n',
  o: 'ctrl-o',
  p: 'ctrl-p',
  r: 'ctrl-r',
  t: 'ctrl-t',
  x: 'ctrl-x',
  y: 'ctrl-y',
  z: 'ctrl-z',
} as const;

function createCtrlLetterChord<
  const TLetter extends keyof typeof CTRL_LETTER_CHORD_IDS,
>(
  letter: TLetter,
  options?: { disallowBareRawInput?: boolean }
): MatchableKeyboardChordDefinition<(typeof CTRL_LETTER_CHORD_IDS)[TLetter]> {
  return {
    id: CTRL_LETTER_CHORD_IDS[letter],
    label: `Ctrl+${letter.toUpperCase()}`,
    matcher: (event: KeyEventLike) =>
      matchesCtrlLetterKeyEvent(event, {
        letter,
        disallowBareRawInput: options?.disallowBareRawInput,
      }),
  };
}

function createKeyFlagChord<const TId extends string>({
  id,
  label,
  flag,
  requiredModifiers,
}: {
  id: TId;
  label: string;
  flag: KeyFlag;
  requiredModifiers?: KeyboardModifierRequirements;
}): MatchableKeyboardChordDefinition<TId> {
  return {
    id,
    label,
    matcher: (event: KeyEventLike) =>
      matchesKeyFlag(event, flag, requiredModifiers),
  };
}

function createPrintableChord<const TId extends string>({
  id,
  label,
  char,
  options,
}: {
  id: TId;
  label: string;
  char: string;
  options?: KeyboardPrintableMatcherOptions;
}): MatchableKeyboardChordDefinition<TId> {
  const matcherOptions = { ctrl: false, meta: false, ...options };
  return {
    id,
    label,
    matcher: (event: KeyEventLike) =>
      matchesPrintableKeyEvent(event, char, matcherOptions),
  };
}

function createDocumentaryChord<const TId extends string>(
  id: TId,
  label: string,
  aliases?: readonly string[]
): DocumentaryKeyboardChordDefinition<TId> {
  return aliases ? { id, label, aliases } : { id, label };
}

function matchesCtrlLetter(
  event: KeyEventLike,
  letter: string,
  options?: { disallowBareRawInput?: boolean }
): boolean {
  return matchesCtrlLetterKeyEvent(event, {
    letter,
    disallowBareRawInput: options?.disallowBareRawInput,
  });
}

function matchesShiftTabSequence(event: KeyEventLike): boolean {
  return (
    event.input === ANSI.SHIFT_TAB_KITTY ||
    event.input === '[9;2u' ||
    matchesTabKeyEvent(event, { ctrl: false, meta: false, shift: true })
  );
}

type TranscriptScrollFlag =
  | KeyFlag.UpArrow
  | KeyFlag.DownArrow
  | KeyFlag.PageUp
  | KeyFlag.PageDown;

const READLINE_NAME_ALIASES: Record<TranscriptScrollFlag, string> = {
  [KeyFlag.UpArrow]: 'up',
  [KeyFlag.DownArrow]: 'down',
  [KeyFlag.PageUp]: 'pageup',
  [KeyFlag.PageDown]: 'pagedown',
};

const SHIFT_MODIFIER = 1;
const ALT_MODIFIER = 2;
const CTRL_MODIFIER = 4;
const SUPER_MODIFIER = 8;
const HYPER_MODIFIER = 16;
const META_MODIFIER = 32;

function hasModifier(modifierMask: number, modifier: number): boolean {
  return Math.floor(modifierMask / modifier) % 2 === 1;
}

function getCsiURealModifierMask(
  sequence: string | undefined
): number | undefined {
  const parsed = parseCsiUSequence(sequence);
  return parsed ? Math.max(0, parsed.modifiers - 1) : undefined;
}

function isCsiUAltOnlyModifier(realMods: number): boolean {
  return (
    hasModifier(realMods, ALT_MODIFIER) &&
    !hasModifier(realMods, CTRL_MODIFIER) &&
    !hasModifier(realMods, SHIFT_MODIFIER)
  );
}

function isCsiUExactAltShiftModifier(realMods: number): boolean {
  return (
    hasModifier(realMods, ALT_MODIFIER) &&
    hasModifier(realMods, SHIFT_MODIFIER) &&
    !hasModifier(realMods, CTRL_MODIFIER) &&
    !hasModifier(realMods, SUPER_MODIFIER) &&
    !hasModifier(realMods, HYPER_MODIFIER) &&
    !hasModifier(realMods, META_MODIFIER)
  );
}

function matchesAltOptionModifier(event: KeyEventLike): boolean {
  const realMods = getCsiURealModifierMask(event.key?.sequence);
  return Boolean(
    (event.key?.alt && !event.key.ctrl && !event.key.shift) ||
      (event.key?.meta &&
        !event.key.alt &&
        !event.key.ctrl &&
        !event.key.shift) ||
      (event.input &&
        event.input.length > 1 &&
        event.input.startsWith(ANSI.ESC) &&
        !event.key?.ctrl &&
        !event.key?.shift) ||
      (realMods !== undefined && isCsiUAltOnlyModifier(realMods))
  );
}

function matchesAutoCompactionToggle(event: KeyEventLike): boolean {
  if (event.isPaste) {
    return false;
  }

  const parsedSequence = parseCsiUSequence(event.key?.sequence);
  const realMods = getCsiURealModifierMask(event.key?.sequence);
  if (
    parsedSequence &&
    (parsedSequence.code === 88 || parsedSequence.code === 120) &&
    realMods !== undefined &&
    isCsiUAltOnlyModifier(realMods)
  ) {
    return true;
  }

  if (
    event.input?.length === 2 &&
    event.input[0] === ANSI.ESC &&
    event.input[1].toLowerCase() === 'x' &&
    !event.key?.ctrl &&
    !event.key?.shift
  ) {
    return true;
  }

  if (!matchesAltOptionModifier(event)) {
    return false;
  }

  const inputChar = event.input?.toLowerCase();
  const keyName = event.key?.name?.toLowerCase();
  return keyName === 'x' || inputChar === 'x';
}

function matchesPasteExpansion(event: KeyEventLike): boolean {
  const parsedSequence = parseCsiUSequence(event.key?.sequence);
  const realMods = getCsiURealModifierMask(event.key?.sequence);
  if (
    parsedSequence &&
    (parsedSequence.code === 86 || parsedSequence.code === 118) &&
    realMods !== undefined &&
    isCsiUExactAltShiftModifier(realMods)
  ) {
    return true;
  }

  const key = event.key;
  if (!key?.alt || !key.shift || key.ctrl) {
    return false;
  }

  const inputChar = event.input?.toLowerCase();
  const keyName = key.name?.toLowerCase();
  return keyName === 'v' || inputChar === 'v';
}

function matchesTranscriptScrollTarget(
  event: KeyEventLike,
  flag: TranscriptScrollFlag
): boolean {
  return (
    matchesKeyFlag(event, flag) ||
    event.key?.name?.toLowerCase() === READLINE_NAME_ALIASES[flag]
  );
}

function matchesAltOnlyKey(
  event: KeyEventLike,
  flag: TranscriptScrollFlag
): boolean {
  return Boolean(
    event.key?.meta &&
      !event.key.ctrl &&
      !event.key.shift &&
      matchesTranscriptScrollTarget(event, flag)
  );
}

function matchesAnyTranscriptScrollKey(event: KeyEventLike): boolean {
  return (
    matchesAltOnlyKey(event, KeyFlag.UpArrow) ||
    matchesAltOnlyKey(event, KeyFlag.DownArrow) ||
    matchesAltOnlyKey(event, KeyFlag.PageUp) ||
    matchesAltOnlyKey(event, KeyFlag.PageDown)
  );
}

const keyboardChords = {
  ctrlC: createCtrlLetterChord('c'),
  ctrlD: createCtrlLetterChord('d'),
  ctrlE: createCtrlLetterChord('e'),
  ctrlG: createCtrlLetterChord('g'),
  ctrlJ: createCtrlLetterChord('j', { disallowBareRawInput: true }),
  ctrlL: createCtrlLetterChord('l'),
  ctrlN: createCtrlLetterChord('n'),
  ctrlO: createCtrlLetterChord('o'),
  ctrlP: createCtrlLetterChord('p'),
  ctrlR: createCtrlLetterChord('r'),
  ctrlT: createCtrlLetterChord('t'),
  ctrlX: createCtrlLetterChord('x'),
  ctrlY: createCtrlLetterChord('y'),
  ctrlZ: createCtrlLetterChord('z'),
  escape: {
    id: 'escape',
    label: 'Esc',
    matcher: matchesEscapeKeyEvent,
  },
  enter: {
    id: 'enter',
    label: 'Enter',
    matcher: (event: KeyEventLike) =>
      matchesEnterKeyEvent(event, {
        ctrl: false,
        meta: false,
        shift: false,
      }),
  },
  shiftEnter: {
    id: 'shift-enter',
    label: 'Shift+Enter',
    aliases: ['kitty modified enter', 'xterm modified enter'],
    matcher: (event: KeyEventLike) =>
      matchesEnterKeyEvent(event, {
        ctrl: false,
        meta: false,
        shift: true,
      }),
  },
  ctrlEnter: {
    id: 'ctrl-enter',
    label: 'Ctrl+Enter',
    matcher: (event: KeyEventLike) =>
      matchesEnterKeyEvent(event, {
        ctrl: true,
        meta: false,
        shift: false,
      }),
  },
  tab: {
    id: 'tab',
    label: 'Tab',
    matcher: (event: KeyEventLike) =>
      matchesTabKeyEvent(event, {
        ctrl: false,
        meta: false,
        shift: false,
      }),
  },
  shiftTab: {
    id: 'shift-tab',
    label: 'Shift+Tab',
    aliases: ['kitty shift-tab'],
    matcher: matchesShiftTabSequence,
  },
  upArrow: createKeyFlagChord({
    id: 'up-arrow',
    label: '↑',
    flag: KeyFlag.UpArrow,
  }),
  downArrow: createKeyFlagChord({
    id: 'down-arrow',
    label: '↓',
    flag: KeyFlag.DownArrow,
  }),
  leftArrow: createKeyFlagChord({
    id: 'left-arrow',
    label: '←',
    flag: KeyFlag.LeftArrow,
  }),
  rightArrow: createKeyFlagChord({
    id: 'right-arrow',
    label: '→',
    flag: KeyFlag.RightArrow,
  }),
  pageUp: createKeyFlagChord({
    id: 'page-up',
    label: 'PageUp',
    flag: KeyFlag.PageUp,
  }),
  pageDown: createKeyFlagChord({
    id: 'page-down',
    label: 'PageDown',
    flag: KeyFlag.PageDown,
  }),
  home: createKeyFlagChord({ id: 'home', label: 'Home', flag: KeyFlag.Home }),
  end: createKeyFlagChord({ id: 'end', label: 'End', flag: KeyFlag.End }),
  space: createPrintableChord({
    id: 'space',
    label: 'Space',
    char: ' ',
    options: { caseSensitive: true },
  }),
  openBracket: createPrintableChord({
    id: 'open-bracket',
    label: '[',
    char: '[',
    options: { caseSensitive: true },
  }),
  closeBracket: createPrintableChord({
    id: 'close-bracket',
    label: ']',
    char: ']',
    options: { caseSensitive: true },
  }),
  topOfList: createPrintableChord({
    id: 'top-of-list',
    label: 'g',
    char: 'g',
  }),
  bottomOfList: createPrintableChord({
    id: 'bottom-of-list',
    label: 'G',
    char: 'G',
    options: { caseSensitive: true },
  }),
  modeToggle: {
    id: 'mode-toggle',
    label: 'Shift+Tab',
    matcher: matchesShiftTabSequence,
  },
  reasoningCycle: {
    id: 'reasoning-cycle',
    label: 'Tab',
    matcher: (event: KeyEventLike) =>
      matchesTabKeyEvent(event, { ctrl: false, meta: false, shift: false }),
  },
  modelCycle: {
    id: 'model-cycle',
    label: 'Ctrl+N',
    matcher: (event: KeyEventLike) => matchesCtrlLetter(event, 'n'),
  },
  autonomyCycle: {
    id: 'autonomy-cycle',
    label: 'Ctrl+L',
    matcher: (event: KeyEventLike) => matchesCtrlLetter(event, 'l'),
  },
  transcriptScrollUp: {
    id: 'transcript-scroll-up',
    label: 'Alt+↑',
    matcher: (event: KeyEventLike) => matchesAltOnlyKey(event, KeyFlag.UpArrow),
  },
  transcriptScrollDown: {
    id: 'transcript-scroll-down',
    label: 'Alt+↓',
    matcher: (event: KeyEventLike) =>
      matchesAltOnlyKey(event, KeyFlag.DownArrow),
  },
  transcriptPageScrollUp: {
    id: 'transcript-page-scroll-up',
    label: 'Alt+PageUp',
    matcher: (event: KeyEventLike) => matchesAltOnlyKey(event, KeyFlag.PageUp),
  },
  transcriptPageScrollDown: {
    id: 'transcript-page-scroll-down',
    label: 'Alt+PageDown',
    matcher: (event: KeyEventLike) =>
      matchesAltOnlyKey(event, KeyFlag.PageDown),
  },
  transcriptScrollAny: {
    id: 'transcript-scroll-any',
    label: 'Alt+↑ / Alt+↓ / Alt+PageUp / Alt+PageDown',
    matcher: matchesAnyTranscriptScrollKey,
  },
  pasteExpansion: {
    id: 'paste-expansion',
    label: 'Alt+Shift+V',
    matcher: matchesPasteExpansion,
  },
  autoCompactionToggle: {
    id: 'auto-compaction-toggle',
    label: 'Alt+X',
    matcher: matchesAutoCompactionToggle,
  },
  modelSelectorFavoriteToggle: createPrintableChord({
    id: 'model-selector-favorite-toggle',
    label: 'f',
    char: 'f',
  }),
  modelSelectorSetDefault: createPrintableChord({
    id: 'model-selector-set-default',
    label: 'd',
    char: 'd',
  }),
  killTask: createPrintableChord({ id: 'kill-task', label: 'k', char: 'k' }),
  forceKill: createPrintableChord({
    id: 'force-kill',
    label: 'f',
    char: 'f',
  }),
  vimUp: createDocumentaryChord('vim-up', 'k', ['K']),
  vimDown: createDocumentaryChord('vim-down', 'j', ['J']),
  missionControlViewJump: createDocumentaryChord(
    'mission-control-view-jump',
    'F / W / M',
    ['features', 'workers', 'models']
  ),
  missionControlFilter: createDocumentaryChord('mission-control-filter', 'T'),
  missionPause: createDocumentaryChord('mission-pause', 'P'),
  missionResume: createDocumentaryChord('mission-resume', 'R'),
  missionDirectory: createDocumentaryChord('mission-directory', 'D'),
  sessionViewerChat: createDocumentaryChord('session-viewer-chat', 's'),
  sessionViewerHandoff: createDocumentaryChord('session-viewer-handoff', 'h'),
  cancelOrBack: createDocumentaryChord('cancel-or-back', 'Esc / q', [
    'escape',
    'q',
  ]),
  selectCurrent: createDocumentaryChord('select-current', 'Enter'),
  navigateUp: createDocumentaryChord('navigate-up', '↑ / k'),
  navigateDown: createDocumentaryChord('navigate-down', '↓ / j'),
  moveLeft: createDocumentaryChord('move-left', '←'),
  moveRight: createDocumentaryChord('move-right', '→'),
  pageScrollUp: createDocumentaryChord('page-scroll-up', 'PageUp'),
  pageScrollDown: createDocumentaryChord('page-scroll-down', 'PageDown'),
  submitMessage: createDocumentaryChord('submit-message', 'Enter'),
  insertNewline: createDocumentaryChord(
    'insert-newline',
    'Shift+Enter / Ctrl+Enter / \\+Enter'
  ),
  helpToggleEmpty: createDocumentaryChord(
    'help-toggle-empty',
    '? (empty input)'
  ),
  bashToggleEmpty: createDocumentaryChord(
    'bash-toggle-empty',
    '! (empty input)'
  ),
  previousWordNavigation: createDocumentaryChord(
    'previous-word-navigation',
    'Option+B / Ctrl+←',
    ['alt+b', 'option+left', 'ctrl+left']
  ),
  nextWordNavigation: createDocumentaryChord(
    'next-word-navigation',
    'Option+F / Ctrl+→',
    ['alt+f', 'option+right', 'ctrl+right']
  ),
  lineStartNavigation: createDocumentaryChord(
    'line-start-navigation',
    'Shift+← / Cmd+← / Ctrl+A'
  ),
  lineEndNavigation: createDocumentaryChord(
    'line-end-navigation',
    'Shift+→ / Cmd+→ / Ctrl+E'
  ),
  deletePreviousCharacter: createDocumentaryChord(
    'delete-previous-character',
    'Backspace / Ctrl+H'
  ),
  deleteNextCharacter: createDocumentaryChord(
    'delete-next-character',
    'Delete / Ctrl+D'
  ),
  deletePreviousWord: createDocumentaryChord(
    'delete-previous-word',
    'Ctrl+W / Option+Backspace'
  ),
  deleteNextWord: createDocumentaryChord(
    'delete-next-word',
    'Option+D / Ctrl+Delete'
  ),
  deleteLinePrefix: createDocumentaryChord('delete-line-prefix', 'Ctrl+U'),
  deleteLineSuffix: createDocumentaryChord('delete-line-suffix', 'Ctrl+K'),
  pasteTextOrImage: createDocumentaryChord(
    'paste-text-or-image',
    'Ctrl+V / Cmd+V / Alt+V'
  ),
  clearImagesOrDeleteForward: createDocumentaryChord(
    'clear-images-or-delete-forward',
    'Ctrl+D'
  ),
  rewindShortcut: createDocumentaryChord(
    'rewind-shortcut',
    'Esc Esc (empty input)'
  ),
  numericShortcut: createDocumentaryChord('numeric-shortcut', '1-4'),
  bulkSelect: createDocumentaryChord('bulk-select', 'Space / a / n / s'),
  renameItem: createDocumentaryChord('rename-item', 'r'),
  importItem: createDocumentaryChord('import-item', 'i'),
  createItem: createDocumentaryChord('create-item', 'c'),
  editItem: createDocumentaryChord('edit-item', 'e'),
  deleteItem: createDocumentaryChord('delete-item', 'd'),
  reviewPresetShortcut: createDocumentaryChord('review-preset-shortcut', '1-4'),
  squadStop: createDocumentaryChord('squad-stop', 's'),
  squadResume: createDocumentaryChord('squad-resume', 'r'),
  squadComposeDm: createDocumentaryChord('squad-compose-dm', 'm'),
  squadPlan: createDocumentaryChord('squad-plan', 'n'),
} as const satisfies Record<string, KeyboardChordDefinition>;

/** Return the canonical keyboard chord registry. */
export function getKeyboardChords() {
  return keyboardChords;
}

const keyboardChordList = Object.values(keyboardChords);

function createKeyboardChordMap(
  chords: readonly KeyboardChord[]
): ReadonlyMap<KeyboardChordId, KeyboardChord> {
  const chordMap = new Map<KeyboardChordId, KeyboardChord>();
  for (const chord of chords) {
    chordMap.set(chord.id, chord);
  }
  return chordMap;
}

const keyboardChordMap = createKeyboardChordMap(keyboardChordList);

/** Return a lookup map keyed by canonical keyboard chord id. */
export function getKeyboardChordMap(): ReadonlyMap<
  KeyboardChordId,
  KeyboardChord
> {
  return keyboardChordMap;
}

function isMatchableChord(
  chord: KeyboardChord
): chord is KeyboardMatchableChord {
  return 'matcher' in chord;
}

/** Match a key event against a runtime-matchable chord or chord id. */
export function matchKeyboardChord(
  event: KeyEventLike,
  chordOrId: KeyboardMatchableChord | KeyboardMatchableChordId
): boolean {
  const chord =
    typeof chordOrId === 'string' ? keyboardChordMap.get(chordOrId) : chordOrId;
  return chord && isMatchableChord(chord) ? chord.matcher(event) : false;
}
