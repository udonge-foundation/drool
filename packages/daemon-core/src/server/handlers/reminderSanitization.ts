const REMINDER_DELIMITER_PATTERN =
  /<\/?\s*(system-reminder|existing-visual)\s*>/gi;

function stripAsciiControlChars(value: string): string {
  let out = '';
  for (let i = 0; i < value.length; i += 1) {
    out += value.charCodeAt(i) < 0x20 ? ' ' : value[i];
  }
  return out;
}

/**
 * Neutralize reminder/wrapper delimiter tokens in an untrusted blob (e.g.
 * persisted VISUAL.html) before interpolating it into a system reminder.
 * The literal tags are replaced with HTML-entity variants so the model
 * still sees the original text but cannot terminate the surrounding
 * `<system-reminder>` or `<existing-visual>` block to inject new
 * directives.
 */
export function sanitizeUntrustedReminderBlob(value: string): string {
  return value.replace(REMINDER_DELIMITER_PATTERN, (match) =>
    match.replace(/</g, '&lt;').replace(/>/g, '&gt;')
  );
}

/**
 * Sanitize a short user-controlled string (e.g. an automation name) before
 * inlining it into a system reminder. Strips newlines, angle brackets, and
 * any reminder/wrapper delimiter tokens; collapses whitespace; truncates to
 * a sane length.
 */
export function sanitizeReminderInline(value: string, maxLength = 200): string {
  const stripped = stripAsciiControlChars(
    value.replace(REMINDER_DELIMITER_PATTERN, ' ').replace(/[<>]/g, ' ')
  )
    .replace(/\s+/g, ' ')
    .trim();
  return stripped.length > maxLength
    ? `${stripped.slice(0, maxLength)}…`
    : stripped;
}
