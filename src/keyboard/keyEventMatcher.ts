import { ESC_27U, ESC_KITTY } from '@/hooks/constants';
import { KeyFlag } from '@/keyboard/enums';
import type {
  KeyEventLike,
  KeyboardModifierRequirements,
  KeyboardPrintableMatcherOptions,
  ParsedCsiUSequence,
} from '@/keyboard/types';

interface CtrlLetterMatcherOptions {
  letter: string;
  disallowBareRawInput?: boolean;
}

const ESC = '\x1b';
const CSI_U_REGEX = new RegExp(
  `^(?:${ESC})?\\[(\\d+)(?:;(\\d+))?(?::(\\d+))?u$`
);
const SHIFT_MODIFIER = 1;
const CTRL_MODIFIER = 4;
const SUPER_MODIFIER = 8;
const HYPER_MODIFIER = 16;
const META_MODIFIER = 32;

/** Parse a Kitty CSI-u sequence into code, modifier, and event-type fields. */
export function parseCsiUSequence(
  sequence?: string
): ParsedCsiUSequence | undefined {
  if (!sequence) {
    return undefined;
  }

  const match = CSI_U_REGEX.exec(sequence);
  if (!match) {
    return undefined;
  }

  return {
    code: Number(match[1]),
    modifiers: Number(match[2] ?? '1'),
    eventType: Number(match[3] ?? '1'),
  };
}

function hasCtrlModifier(modifiers: number): boolean {
  const modBits = Math.max(0, modifiers - 1);
  return Math.floor(modBits / 4) % 2 === 1;
}

function hasModifier(modifierMask: number, modifier: number): boolean {
  return Math.floor(modifierMask / modifier) % 2 === 1;
}

function getCsiURealModifierMask(event: KeyEventLike): number | undefined {
  const parsedSequence = parseCsiUSequence(event.key?.sequence);
  if (!parsedSequence || parsedSequence.eventType === 3) {
    return undefined;
  }
  return Math.max(0, parsedSequence.modifiers - 1);
}

function hasMetaModifier(modifierMask: number): boolean {
  return (
    hasModifier(modifierMask, META_MODIFIER) ||
    hasModifier(modifierMask, SUPER_MODIFIER) ||
    hasModifier(modifierMask, HYPER_MODIFIER)
  );
}

function hasRequiredModifier(
  event: KeyEventLike,
  modifier: keyof KeyboardModifierRequirements
): boolean {
  const realModifierMask = getCsiURealModifierMask(event);
  if (realModifierMask !== undefined) {
    switch (modifier) {
      case 'ctrl':
        return hasModifier(realModifierMask, CTRL_MODIFIER);
      case 'meta':
        return hasMetaModifier(realModifierMask);
      case 'shift':
        return hasModifier(realModifierMask, SHIFT_MODIFIER);
      default:
        return false;
    }
  }
  return Boolean(event.key?.[modifier]);
}

function matchesRequiredModifiers(
  event: KeyEventLike,
  requiredModifiers?: KeyboardModifierRequirements
): boolean {
  if (!requiredModifiers) {
    return true;
  }

  for (const modifier of ['ctrl', 'meta', 'shift'] as const) {
    const required = requiredModifiers[modifier];
    if (
      required !== undefined &&
      hasRequiredModifier(event, modifier) !== required
    ) {
      return false;
    }
  }

  return true;
}

function isBareRawInputAllowed(
  event: KeyEventLike,
  disallowBareRawInput: boolean
): boolean {
  if (!disallowBareRawInput) {
    return true;
  }

  const sequence = event.key?.sequence;
  return Boolean(event.key?.ctrl || (sequence && sequence.startsWith(ESC)));
}

/** Match a Ctrl-letter chord across raw bytes, readline keys, and CSI-u. */
export function matchesCtrlLetterKeyEvent(
  event: KeyEventLike,
  { letter, disallowBareRawInput = false }: CtrlLetterMatcherOptions
): boolean {
  const normalizedLetter = letter.toLowerCase();
  const upperCode = normalizedLetter.toUpperCase().charCodeAt(0);
  const lowerCode = normalizedLetter.charCodeAt(0);
  const rawCode = upperCode - 64;

  const parsedSequence = parseCsiUSequence(event.key?.sequence);
  if (
    parsedSequence &&
    parsedSequence.eventType !== 3 &&
    hasCtrlModifier(parsedSequence.modifiers) &&
    (parsedSequence.code === upperCode ||
      parsedSequence.code === lowerCode ||
      parsedSequence.code === rawCode)
  ) {
    return true;
  }

  if (event.input === String.fromCharCode(rawCode)) {
    return isBareRawInputAllowed(event, disallowBareRawInput);
  }

  if (!event.key?.ctrl) {
    return false;
  }

  const keyName = event.key.name?.toLowerCase();
  const inputChar = event.input?.toLowerCase();
  return keyName === normalizedLetter || inputChar === normalizedLetter;
}

/** Match Escape across raw, readline, and Kitty CSI-u event shapes. */
export function matchesEscapeKeyEvent(event: KeyEventLike): boolean {
  const sequence = event.key?.sequence;
  if (sequence === ESC_KITTY || sequence === ESC_27U) {
    return true;
  }

  if (event.key?.escape) {
    return true;
  }

  return event.input === ESC && !event.isPaste;
}

/** Match a named key flag, optionally requiring exact modifier states. */
export function matchesKeyFlag(
  event: KeyEventLike,
  flag: KeyFlag,
  requiredModifiers?: KeyboardModifierRequirements
): boolean {
  if (!event.key?.[flag]) {
    return false;
  }

  const parsedSequence = parseCsiUSequence(event.key.sequence);
  if (parsedSequence?.eventType === 3) {
    return false;
  }

  return matchesRequiredModifiers(event, requiredModifiers);
}

/** Match Tab with optional exact modifier requirements. */
export function matchesTabKeyEvent(
  event: KeyEventLike,
  options?: KeyboardModifierRequirements
): boolean {
  return matchesKeyFlag(event, KeyFlag.Tab, {
    ctrl: options?.ctrl,
    meta: options?.meta,
    shift: options?.shift,
  });
}

/** Match Enter with optional exact modifier requirements. */
export function matchesEnterKeyEvent(
  event: KeyEventLike,
  options?: KeyboardModifierRequirements
): boolean {
  return matchesKeyFlag(event, KeyFlag.Return, options);
}

/** Match printable input, optionally requiring exact case and modifiers. */
export function matchesPrintableKeyEvent(
  event: KeyEventLike,
  expected: string,
  options?: KeyboardPrintableMatcherOptions
): boolean {
  const actualInput = event.input ?? '';
  if (actualInput.length === 0) {
    return false;
  }

  if (!matchesRequiredModifiers(event, options)) {
    return false;
  }

  if (options?.caseSensitive) {
    return actualInput === expected;
  }

  return actualInput.toLowerCase() === expected.toLowerCase();
}
