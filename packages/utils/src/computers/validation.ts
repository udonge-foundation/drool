// Lowercase alphanumeric + hyphens, starts with letter, max 63 chars
const COMPUTER_NAME_REGEX = /^[a-z]([a-z0-9-]{0,61}[a-z0-9])?$/;

const DEFAULT_COMPUTER_NAME = 'my-computer';

export function validateComputerName(name: string): string | null {
  if (!name) return 'Name is required';
  if (name.length > 63) return 'Name must be 63 characters or less';
  if (!COMPUTER_NAME_REGEX.test(name)) {
    return 'Name must start with a lowercase letter and contain only lowercase letters, numbers, and hyphens';
  }
  return null;
}

/**
 * Normalizes a raw string (e.g. OS hostname) into a valid computer name.
 * Strips common suffixes like `.local`, lowercases, replaces invalid
 * characters with hyphens, and truncates to 63 characters.
 */
/**
 * Given a desired base name and the list of names already in use by the
 * current user, returns the smallest-suffixed variant that is free.
 *
 *   pickAvailableComputerName("laptop", ["laptop"])                  -> "laptop-2"
 *   pickAvailableComputerName("laptop", ["laptop", "laptop-2"])      -> "laptop-3"
 *   pickAvailableComputerName("laptop", ["laptop-3"])                -> "laptop"
 *   pickAvailableComputerName("laptop", [])                          -> "laptop"
 *
 * `base` must already be a valid / normalized computer name; `taken`
 * comparisons are case-insensitive since the name regex is lowercase.
 * The returned string is still capped at 63 chars — if appending a
 * suffix would overflow, the base is trimmed to make room.
 */
export function pickAvailableComputerName(
  base: string,
  taken: Iterable<string>
): string {
  const takenSet = new Set<string>();
  for (const name of taken) takenSet.add(name.toLowerCase());

  if (!takenSet.has(base.toLowerCase())) return base;

  // Escape regex metacharacters in base before building the pattern.
  const escaped = base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`^${escaped}-(\\d+)$`, 'i');
  const usedSuffixes = new Set<number>();
  for (const name of takenSet) {
    const match = pattern.exec(name);
    if (match) usedSuffixes.add(Number(match[1]));
  }

  let n = 2;
  while (usedSuffixes.has(n)) n++;
  const suffix = `-${n}`;
  if (base.length + suffix.length <= 63) return `${base}${suffix}`;
  return `${base.slice(0, 63 - suffix.length)}${suffix}`;
}

/**
 * Input-time sanitizer for computer-name text fields. Keeps only valid
 * character classes, lowercases input, strips invalid leading characters,
 * and caps the result to the backend's max length.
 *
 * Intentionally leaves trailing hyphens alone while typing so users can
 * enter names like `my-computer`; `validateComputerName` blocks submit
 * until the final character is alphanumeric.
 */
export function sanitizeComputerNameInput(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '')
    .replace(/^[^a-z]+/, '')
    .slice(0, 63);
}

export function normalizeComputerName(raw: string): string {
  const normalized = raw
    .toLowerCase()
    .replace(/\.local$/, '')
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/^[^a-z]+/, '')
    .replace(/-+/g, '-')
    .slice(0, 63)
    .replace(/-+$/, '');

  return validateComputerName(normalized) === null
    ? normalized
    : DEFAULT_COMPUTER_NAME;
}
