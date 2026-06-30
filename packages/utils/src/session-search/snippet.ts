function markFirstMatch(snippet: string, needle: string): string {
  if (!needle) return snippet;
  const sLower = snippet.toLowerCase();
  const nLower = needle.toLowerCase();
  const idx = sLower.indexOf(nLower);
  if (idx === -1) return snippet;
  const before = snippet.slice(0, idx);
  const match = snippet.slice(idx, idx + needle.length);
  const after = snippet.slice(idx + needle.length);
  return `${before}<mark>${match}</mark>${after}`;
}

function ensureBalancedFences(
  snippet: string,
  openFenceLine: string,
  closeFenceLine: string
): string {
  let out = snippet;
  if (!out.includes(openFenceLine)) out = `${openFenceLine}\n${out}`;
  if (!out.includes(closeFenceLine)) out = `${out}\n${closeFenceLine}`;
  return out;
}

function getEnclosingCodeFence(
  text: string,
  matchIndex: number
): { openFenceLine: string; closeFenceLine: string } | null {
  // Best-effort line scan for triple-backtick fences.
  const lines = text.split('\n');
  let offset = 0;

  let openFenceLine: string | null = null;
  let openFenceContentStart = -1;

  for (const line of lines) {
    const lineStart = offset;
    const lineEnd = lineStart + line.length;
    const trimmed = line.trimStart();

    const isFence = trimmed.startsWith('```');
    if (isFence) {
      if (!openFenceLine) {
        openFenceLine = line;
        // Content starts after this line's newline.
        openFenceContentStart = lineEnd + 1;
      } else {
        const closeFenceLine = line;
        const closeFenceContentEnd = lineStart - 1;
        const inFence =
          matchIndex >= openFenceContentStart &&
          matchIndex <= closeFenceContentEnd;
        if (inFence) {
          return { openFenceLine, closeFenceLine };
        }

        openFenceLine = null;
        openFenceContentStart = -1;
      }
    }

    offset = lineEnd + 1;
  }

  return null;
}

export function buildSnippet(
  text: string,
  query: string,
  contextChars: number,
  options?: { highlight?: boolean }
): string {
  const highlight = options?.highlight ?? true;
  const q = query.trim();
  const lower = text.toLowerCase();
  const qLower = q.toLowerCase();

  let matchIndex = lower.indexOf(qLower);
  let matchLen = q.length;

  if (matchIndex === -1) {
    const tokens = qLower.split(/\s+/).filter(Boolean);
    for (const tok of tokens) {
      const idx = lower.indexOf(tok);
      if (idx !== -1) {
        matchIndex = idx;
        matchLen = tok.length;
        break;
      }
    }
  }

  if (matchIndex === -1) {
    const end = Math.min(text.length, contextChars * 2);
    const slice = text.slice(0, end);
    return slice.length < text.length ? `${slice}…` : slice;
  }

  const start = Math.max(0, matchIndex - contextChars);
  const end = Math.min(text.length, matchIndex + matchLen + contextChars);
  const prefixEllipsis = start > 0 ? '…' : '';
  const suffixEllipsis = end < text.length ? '…' : '';

  const before = text.slice(start, matchIndex);
  const match = text.slice(matchIndex, matchIndex + matchLen);
  const after = text.slice(matchIndex + matchLen, end);

  const rawSnippet = `${prefixEllipsis}${before}${match}${after}${suffixEllipsis}`;

  // If the match is inside a fenced code block, ensure we keep balanced fences even if
  // our context window doesn't include the fence markers.
  const fenced = getEnclosingCodeFence(text, matchIndex);
  const withFences = fenced
    ? ensureBalancedFences(
        rawSnippet,
        fenced.openFenceLine,
        fenced.closeFenceLine
      )
    : rawSnippet;

  if (!highlight) return withFences;
  return markFirstMatch(withFences, match);
}
