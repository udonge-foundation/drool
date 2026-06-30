const OPTION_HEADING_PATTERN =
  /^(option|approach|alternative|variant|strategy)\s+([a-z]|\d+|[ivxlcdm]+)\b(?:\s*[:.)\-–—]\s*|\s+\S+|$)/i;

const UNRESOLVED_SPEC_OPTIONS_LLM_ERROR =
  'ExitSpecMode requires one concrete implementation plan. This plan still lists multiple unresolved options. Call AskUser first so the user can choose one option, then call ExitSpecMode with a single concrete plan based on that choice.';

function normalizeOptionHeadingLine(line: string): string {
  return line
    .trim()
    .replace(/^>\s*/, '')
    .replace(/^#{1,6}\s*/, '')
    .replace(/^[-*+]\s+/, '')
    .replace(/^\d+[.)]\s*/, '')
    .replace(/\*\*/g, '')
    .replace(/__/g, '')
    .trim();
}

export function findUnresolvedSpecOptionHeadings(plan: string): string[] {
  const matchedHeadings = new Map<string, string>();

  for (const line of plan.split(/\r?\n/)) {
    const normalizedLine = normalizeOptionHeadingLine(line);
    const match = OPTION_HEADING_PATTERN.exec(normalizedLine);
    if (!match) {
      continue;
    }

    const kind = match[1].toLowerCase();
    const label = match[2].toLowerCase();
    matchedHeadings.set(`${kind}:${label}`, normalizedLine);
  }

  return Array.from(matchedHeadings.values());
}

export function hasUnresolvedSpecOptions(plan: string): boolean {
  return findUnresolvedSpecOptionHeadings(plan).length >= 2;
}

export function getUnresolvedSpecOptionsLlmError(): string {
  return UNRESOLVED_SPEC_OPTIONS_LLM_ERROR;
}
