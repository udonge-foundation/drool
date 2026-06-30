/**
 * Session search - CLI-specific formatting utilities.
 * Core search functionality is provided by @industry/runtime/session-search.
 */
import chalk from 'chalk';

import { SessionSearchDocKind } from '@industry/common/daemon';

import { COLORS } from '@/components/chat/themedColors';
import { getI18n } from '@/i18n';

import type { DroolFindResults } from '@industry/runtime/session-search';

/**
 * Format search results for human-readable CLI output.
 */
export function formatDroolSearchResultsHuman(
  results: DroolFindResults
): string {
  const lines: string[] = [];

  const mica4 = chalk.hex(COLORS.primary);

  const renderMarked = (snippet: string) =>
    snippet.replaceAll(/<mark>([\s\S]*?)<\/mark>/g, (_, inner: string) =>
      chalk.bgHex(COLORS.primary).white(inner)
    );

  const totalMatches = results.sessions.reduce((acc, s) => {
    const totals = s.totals?.byKind;
    if (!totals)
      return acc + s.hits.reduce((hitAcc, h) => hitAcc + h.snippets.length, 0);
    return acc + Object.values(totals).reduce((a, v) => a + v, 0);
  }, 0);

  const t = getI18n().t;

  lines.push(
    chalk.bold(
      t('common:sessionSearch.totalDocumentMatches', { count: totalMatches })
    )
  );
  lines.push(
    chalk.bold(
      t('common:sessionSearch.sessionMatches', {
        count: results.sessions.length,
      })
    )
  );
  lines.push('');

  const kindOrder: SessionSearchDocKind[] = [
    SessionSearchDocKind.MessageText,
    SessionSearchDocKind.Document,
    SessionSearchDocKind.ToolUse,
    SessionSearchDocKind.ToolResult,
  ];

  const kindHeading = (kind: SessionSearchDocKind) => {
    if (kind === SessionSearchDocKind.ToolUse)
      return `[${t('common:sessionSearch.toolCall')}]`;
    if (kind === SessionSearchDocKind.ToolResult)
      return `[${t('common:sessionSearch.toolResult')}]`;
    return `[${t('common:sessionSearch.document')}]`;
  };

  const writeSnippetNumbered = (idx: number, snippet: string) => {
    lines.push(`  ${idx + 1}.`);
    lines.push(renderMarked(snippet));
  };

  for (let i = 0; i < results.sessions.length; i++) {
    const session = results.sessions[i];
    const title = session.title ? `: ${session.title}` : '';
    lines.push(chalk.cyan(`${i + 1}. Session ${session.sessionId}${title}`));
    lines.push('');

    const hitsByKind = new Map<SessionSearchDocKind, string[]>();
    const messageSnippetsByRole = new Map<'user' | 'assistant', string[]>();
    const toolHitsByKind = new Map<
      SessionSearchDocKind,
      Map<string, string[]>
    >();
    for (const hit of session.hits) {
      if (hit.kind === SessionSearchDocKind.MessageText) {
        const role = hit.messageRole ?? 'assistant';
        const arr = messageSnippetsByRole.get(role) ?? [];
        arr.push(...hit.snippets);
        messageSnippetsByRole.set(role, arr);
        continue;
      }
      if (
        hit.kind === SessionSearchDocKind.ToolUse ||
        hit.kind === SessionSearchDocKind.ToolResult
      ) {
        const toolName = hit.toolName || 'unknown';
        const byName =
          toolHitsByKind.get(hit.kind) ?? new Map<string, string[]>();
        const arr = byName.get(toolName) ?? [];
        arr.push(...hit.snippets);
        byName.set(toolName, arr);
        toolHitsByKind.set(hit.kind, byName);
      } else {
        const arr = hitsByKind.get(hit.kind) ?? [];
        arr.push(...hit.snippets);
        hitsByKind.set(hit.kind, arr);
      }
    }

    for (const kind of kindOrder) {
      if (kind === SessionSearchDocKind.MessageText) {
        const userSnips = messageSnippetsByRole.get('user') ?? [];
        const assistantSnips = messageSnippetsByRole.get('assistant') ?? [];

        const writeRoleSection = (sectionTitle: string, snips: string[]) => {
          if (snips.length === 0) return;
          lines.push(`${mica4(sectionTitle)} (${snips.length} matches)`);
          for (let sIdx = 0; sIdx < snips.length; sIdx++) {
            writeSnippetNumbered(sIdx, snips[sIdx]);
          }
          lines.push('');
        };

        writeRoleSection(t('common:sessionSearch.userQuery'), userSnips);
        writeRoleSection(
          t('common:sessionSearch.droolResponse'),
          assistantSnips
        );
        continue;
      }

      if (
        kind === SessionSearchDocKind.ToolUse ||
        kind === SessionSearchDocKind.ToolResult
      ) {
        const byName = toolHitsByKind.get(kind);
        if (!byName || byName.size === 0) continue;

        const prefix =
          kind === SessionSearchDocKind.ToolUse ? 'tool_call' : 'tool_result';
        for (const [toolName, snippets] of byName.entries()) {
          const totals =
            kind === SessionSearchDocKind.ToolUse
              ? session.totals?.toolUse?.[toolName]
              : session.totals?.toolResult?.[toolName];

          const total = totals ?? snippets.length;
          const showing = snippets.length;
          const shouldShowShowing = showing === 3 && total > showing;
          const suffix = shouldShowShowing
            ? t('common:sessionSearch.showingMatches', { showing, total })
            : t('common:sessionSearch.matchCount', { count: total });

          const heading = `[${prefix}: ${toolName}]`;
          lines.push(`${mica4(heading)} ${suffix}`);
          for (let sIdx = 0; sIdx < snippets.length; sIdx++) {
            writeSnippetNumbered(sIdx, snippets[sIdx]);
          }
          lines.push('');
        }
        continue;
      }

      const snippets = hitsByKind.get(kind) ?? [];
      if (snippets.length === 0) continue;

      const heading = kindHeading(kind);
      lines.push(`${mica4(heading)} (${snippets.length} matches)`);
      for (let sIdx = 0; sIdx < snippets.length; sIdx++) {
        writeSnippetNumbered(sIdx, snippets[sIdx]);
      }
      lines.push('');
    }

    if (i < results.sessions.length - 1) {
      lines.push('----------------------------------------');
    }
  }

  if (results.sessions.length === 0)
    lines.push(chalk.gray(t('common:sessionSearch.noMatches')));

  return lines.join('\n');
}
