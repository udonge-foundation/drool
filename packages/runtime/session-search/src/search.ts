/**
 * Session search implementation.
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';

import { SessionSearchDocKind } from '@industry/common/daemon';
import { logException, logInfo, logWarn } from '@industry/logging';
import { getIndustryHome } from '@industry/utils/cli';
import { getIndustryDirName } from '@industry/utils/environment';
import {
  bloomAddText,
  bloomFromBase64,
  bloomScoreForQuery,
  bloomToBase64,
  buildSnippet,
  createBloom,
  extractTrigrams,
} from '@industry/utils/session-search';

import {
  CANDIDATE_MULTIPLIER,
  DEFAULT_CONTEXT_CHARS,
  DEFAULT_LIMIT_HITS_PER_SESSION,
  DEFAULT_LIMIT_SESSIONS,
  MIN_CANDIDATES,
  MIN_FUZZY_QUERY_LEN,
  MIN_TOKEN_TRIGRAM_OVERLAP,
  SEARCH_BATCH_SIZE,
  SEARCH_SCHEMA_VERSION,
  SHORT_QUERY_BASELINE_SCORE,
} from './constants';
import { getExtractorOptionsByKind } from './extractors/index';
import { listAllSessionJsonlFiles } from './file-discovery';
import { searchWithWorkerPool } from './search-worker-pool';
import { extractDocsFromMessageEvent } from './sessionDocExtraction';

import type {
  DroolFindHit,
  DroolFindOptions,
  DroolFindResults,
  DroolFindSessionResult,
  DroolMessageEvent,
  DroolSessionEvent,
  SessionJsonlFileHandle,
} from './types';
import type { SessionSummaryEvent } from '@industry/common/session/summary';

const EXTRACTOR_OPTIONS_BY_KIND = getExtractorOptionsByKind();

type ManifestSessionState = {
  sessionId: string;
  jsonlPath: string;
  mtimeMs: number;
  size: number;
  offset: number;
  bloomB64: string;
};

type SearchManifest = {
  schemaVersion: number;
  configHash: string;
  sessions: Record<string, ManifestSessionState>;
};

function getSearchCacheDir(): string {
  return path.join(getIndustryHome(), getIndustryDirName(), 'cache', 'search');
}

function getManifestPath(): string {
  return path.join(getSearchCacheDir(), 'manifest.json');
}

function ensureDirSync(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
}

function sha256Json(value: unknown): string {
  const json = JSON.stringify(value);
  return crypto.createHash('sha256').update(json).digest('hex');
}

async function readJsonlAndUpdateBloom(
  handle: SessionJsonlFileHandle,
  startOffset: number,
  bloomB64?: string
): Promise<{ bloomB64: string; newOffset: number; title?: string }> {
  const stream = fs.createReadStream(handle.jsonlPath, {
    encoding: 'utf8',
    start: startOffset,
  });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  const bloom = bloomB64 ? bloomFromBase64(bloomB64) : createBloom();
  let title: string | undefined;

  try {
    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const evt = JSON.parse(trimmed) as DroolSessionEvent;
        if (evt.type === 'session_start') {
          const ss = evt as SessionSummaryEvent;
          if (typeof ss.title === 'string') title = ss.title;
        }
        if (evt.type === 'message') {
          const docs = extractDocsFromMessageEvent(
            handle.sessionId,
            evt as DroolMessageEvent
          );
          for (const d of docs) {
            bloomAddText(bloom, d.text);
          }
        }
      } catch (err) {
        logWarn('[search] Failed to parse JSONL line during bloom update', {
          cause: err,
        });
      }
    }
  } finally {
    rl.close();
    stream.destroy();
  }

  return { bloomB64: bloomToBase64(bloom), newOffset: handle.size, title };
}

async function loadManifest(configHash: string): Promise<{
  manifest: SearchManifest;
  canReuseCache: boolean;
  cacheMissReason?: string;
}> {
  const manifestPath = getManifestPath();
  try {
    const raw = await fs.promises.readFile(manifestPath, 'utf8');
    const parsed = JSON.parse(raw) as SearchManifest;
    if (
      parsed?.schemaVersion === SEARCH_SCHEMA_VERSION &&
      parsed?.configHash === configHash &&
      parsed?.sessions &&
      typeof parsed.sessions === 'object'
    ) {
      return { manifest: parsed, canReuseCache: true };
    }
  } catch (err) {
    logWarn('[search] Failed to load search manifest', { cause: err });
  }
  return {
    manifest: {
      schemaVersion: SEARCH_SCHEMA_VERSION,
      configHash,
      sessions: {},
    },
    canReuseCache: false,
    cacheMissReason: 'manifest missing/invalid or schema mismatch',
  };
}

async function saveManifest(manifest: SearchManifest): Promise<void> {
  await fs.promises.writeFile(
    getManifestPath(),
    JSON.stringify(manifest, null, 2)
  );
}

type CacheUpdateStats = {
  newSessions: number;
  rebuiltOnShrink: number;
  tailUpdates: number;
  unchanged: number;
  appendedBytes: number;
};

async function updateManifestFromFiles(
  manifest: SearchManifest,
  files: SessionJsonlFileHandle[],
  logPrefix: string
): Promise<CacheUpdateStats> {
  const stats: CacheUpdateStats = {
    newSessions: 0,
    rebuiltOnShrink: 0,
    tailUpdates: 0,
    unchanged: 0,
    appendedBytes: 0,
  };

  await files.reduce<Promise<void>>(async (prevPromise, file) => {
    await prevPromise;
    const prev = manifest.sessions[file.jsonlPath];

    if (!prev) {
      stats.newSessions += 1;
      const { bloomB64, newOffset } = await readJsonlAndUpdateBloom(file, 0);
      manifest.sessions[file.jsonlPath] = {
        sessionId: file.sessionId,
        jsonlPath: file.jsonlPath,
        mtimeMs: file.mtimeMs,
        size: file.size,
        offset: newOffset,
        bloomB64,
      };
      return;
    }

    if (file.size < prev.size) {
      stats.rebuiltOnShrink += 1;
      logWarn('[search] Session file shrank; reindexing from start', {
        name: logPrefix,
        sessionId: file.sessionId,
        path: file.jsonlPath,
        originalSize: prev.size,
        endingSize: file.size,
      });
      const { bloomB64, newOffset } = await readJsonlAndUpdateBloom(file, 0);
      manifest.sessions[file.jsonlPath] = {
        ...prev,
        mtimeMs: file.mtimeMs,
        size: file.size,
        offset: newOffset,
        bloomB64,
      };
      return;
    }

    if (file.size > prev.offset) {
      stats.tailUpdates += 1;
      stats.appendedBytes += Math.max(0, file.size - prev.offset);
      const { bloomB64, newOffset } = await readJsonlAndUpdateBloom(
        file,
        prev.offset,
        prev.bloomB64
      );
      prev.bloomB64 = bloomB64;
      prev.mtimeMs = file.mtimeMs;
      prev.size = file.size;
      prev.offset = newOffset;
      return;
    }

    stats.unchanged += 1;
    prev.mtimeMs = file.mtimeMs;
    prev.size = file.size;
  }, Promise.resolve());

  return stats;
}

function getConfigHash(): string {
  return sha256Json({
    schemaVersion: SEARCH_SCHEMA_VERSION,
    tokenize: 'full',
    encoder: 'Default',
    caseFold: true,
    kinds: 'all',
    stripSystemReminders: true,
  });
}

function ensureSearchCacheDirs(): void {
  const industryDir = path.join(getIndustryHome(), getIndustryDirName());
  ensureDirSync(industryDir);
  ensureDirSync(path.join(industryDir, 'cache'));
  ensureDirSync(getSearchCacheDir());
}

function normalizeQuery(query: string): string {
  return query.trim().toLowerCase();
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  const v0 = new Array<number>(b.length + 1);
  const v1 = new Array<number>(b.length + 1);

  for (let i = 0; i <= b.length; i++) v0[i] = i;

  for (let i = 0; i < a.length; i++) {
    v1[0] = i + 1;
    for (let j = 0; j < b.length; j++) {
      const cost = a[i] === b[j] ? 0 : 1;
      v1[j + 1] = Math.min(v1[j] + 1, v0[j + 1] + 1, v0[j] + cost);
    }
    for (let j = 0; j <= b.length; j++) v0[j] = v1[j];
  }

  return v0[b.length];
}

function trigramOverlapScoreToken(
  token: string,
  queryTris: Set<string>
): number {
  if (queryTris.size === 0) return 0;
  const t = token.toLowerCase();
  if (t.length < 3) return 0;
  let hits = 0;
  for (let i = 0; i <= t.length - 3; i++) {
    if (queryTris.has(t.slice(i, i + 3))) hits++;
  }
  return hits / queryTris.size;
}

function maxEditDistanceForQueryToken(q: string): number {
  if (q.length >= 9) return 2;
  return 1;
}

function approximateBestSingleTokenMatch(
  text: string,
  queryToken: string,
  queryTris: Set<string>
): {
  combinedScore: number;
  bestToken?: string;
  editDistance: number;
  tokenTriScore: number;
} {
  const q = queryToken.toLowerCase();
  const tokens = text
    .toLowerCase()
    .split(/[^a-z0-9_-]+/)
    .filter((t) => t.length > 0 && t.length <= 64);

  let bestToken: string | undefined;
  let bestDist = Infinity;
  let bestTri = 0;

  for (const t of tokens) {
    const d = levenshtein(q, t);
    if (d < bestDist) {
      bestDist = d;
      bestToken = t;
      bestTri = trigramOverlapScoreToken(t, queryTris);
    } else if (d === bestDist && bestToken) {
      const tri = trigramOverlapScoreToken(t, queryTris);
      if (tri > bestTri) {
        bestToken = t;
        bestTri = tri;
      }
    }

    if (bestDist === 0) break;
  }

  if (!bestToken || !Number.isFinite(bestDist)) {
    return {
      combinedScore: 0,
      editDistance: Infinity,
      tokenTriScore: 0,
    };
  }

  const maxDist = maxEditDistanceForQueryToken(q);
  const editScore = Math.max(0, 1 - bestDist / Math.max(1, maxDist));
  const combinedScore = bestTri * 0.8 + editScore * 0.2;

  return {
    combinedScore,
    bestToken,
    editDistance: bestDist,
    tokenTriScore: bestTri,
  };
}

function trigramOverlapScore(text: string, queryTris: Set<string>): number {
  if (queryTris.size === 0) return 0;
  if (text.length < 3) return 0;
  let hits = 0;
  for (let i = 0; i <= text.length - 3; i++) {
    if (queryTris.has(text.slice(i, i + 3))) hits++;
  }
  return hits / queryTris.size;
}

async function findHitsInSession(
  sessionId: string,
  jsonlPath: string,
  query: string,
  opts: Required<Omit<DroolFindOptions, 'reindex' | 'json'>>
): Promise<{
  title?: string;
  hits: DroolFindHit[];
  totals: {
    byKind: Record<SessionSearchDocKind, number>;
    toolUse: Record<string, number>;
    toolResult: Record<string, number>;
  };
}> {
  const stream = fs.createReadStream(jsonlPath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  const hits: DroolFindHit[] = [];
  const maxPerKind = Math.max(1, opts.limitHitsPerSession);
  const snippetsByKind = new Map<SessionSearchDocKind, number>();
  const totalsByKind = new Map<SessionSearchDocKind, number>();
  const totalsToolUse = new Map<string, number>();
  const totalsToolResult = new Map<string, number>();
  const allKinds = Object.values(
    SessionSearchDocKind
  ) as SessionSearchDocKind[];

  const remainingForKind = (kind: SessionSearchDocKind) =>
    maxPerKind - (snippetsByKind.get(kind) ?? 0);

  const canAddHit = (kind: SessionSearchDocKind) => remainingForKind(kind) > 0;

  const contextCharsForKind = (kind: SessionSearchDocKind) => {
    const max = EXTRACTOR_OPTIONS_BY_KIND[kind]?.maxSnippetContextChars;
    return max ? Math.min(opts.contextChars, max) : opts.contextChars;
  };

  const recordHit = (hit: DroolFindHit) => {
    if (hit.snippets.length === 0) return;
    hits.push(hit);
    snippetsByKind.set(
      hit.kind,
      (snippetsByKind.get(hit.kind) ?? 0) + hit.snippets.length
    );
  };

  const shouldStopEarly = () => {
    if (opts.kind !== 'all') {
      return remainingForKind(opts.kind) <= 0;
    }
    return allKinds.every((k) => remainingForKind(k) <= 0);
  };
  let title: string | undefined;
  const q = normalizeQuery(query);
  const qTokens = q.split(/\s+/).filter(Boolean);
  const queryTris = new Set(extractTrigrams(q));

  let bestApprox:
    | {
        docId: string;
        kind: SessionSearchDocKind;
        text: string;
        snippetSources: string[];
        toolName?: string;
        messageRole?: 'user' | 'assistant';
        score: number;
        bestToken: string;
      }
    | undefined;

  const toolUseNameById: Record<string, string> = {};

  const finalize = () => {
    rl.close();
    stream.destroy();

    const totals = {
      byKind: {
        [SessionSearchDocKind.MessageText]:
          totalsByKind.get(SessionSearchDocKind.MessageText) ?? 0,
        [SessionSearchDocKind.Document]:
          totalsByKind.get(SessionSearchDocKind.Document) ?? 0,
        [SessionSearchDocKind.ToolUse]:
          totalsByKind.get(SessionSearchDocKind.ToolUse) ?? 0,
        [SessionSearchDocKind.ToolResult]:
          totalsByKind.get(SessionSearchDocKind.ToolResult) ?? 0,
      },
      toolUse: Object.fromEntries(totalsToolUse.entries()),
      toolResult: Object.fromEntries(totalsToolResult.entries()),
    };

    return { title, hits, totals };
  };

  for await (const line of rl) {
    if (shouldStopEarly()) break;

    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const evt = JSON.parse(trimmed) as DroolSessionEvent;
      if (evt.type === 'session_start') {
        const ss = evt as SessionSummaryEvent;
        if (typeof ss.title === 'string') title = ss.title;
        continue;
      }

      if (evt.type !== 'message') continue;

      const msg = (evt as DroolMessageEvent).message as { content?: unknown };
      if (Array.isArray(msg?.content)) {
        for (const block of msg.content as unknown[]) {
          if (!block || typeof block !== 'object') continue;
          const b = block as { type?: unknown; id?: unknown; name?: unknown };
          if (
            b.type === 'tool_use' &&
            typeof b.id === 'string' &&
            typeof b.name === 'string'
          ) {
            toolUseNameById[b.id] = b.name;
          }
        }
      }

      const docs = extractDocsFromMessageEvent(
        sessionId,
        evt as DroolMessageEvent
      );

      for (const doc of docs) {
        const parts = doc.id.split(':');
        const kind = (parts[1] ?? '') as SessionSearchDocKind;
        if (opts.kind !== 'all' && kind !== opts.kind) continue;

        const docLower = doc.text.toLowerCase();
        const exact = q.length > 0 && docLower.includes(q);

        const snippetSources =
          doc.snippets && doc.snippets.length > 0 ? doc.snippets : [doc.text];

        const resolvedToolName =
          doc.toolName ??
          (kind === SessionSearchDocKind.ToolResult
            ? toolUseNameById[parts[3] ?? '']
            : undefined);

        const totalKey = resolvedToolName || 'unknown';

        if (exact) {
          totalsByKind.set(
            kind,
            (totalsByKind.get(kind) ?? 0) + snippetSources.length
          );
          if (kind === SessionSearchDocKind.ToolUse) {
            totalsToolUse.set(
              totalKey,
              (totalsToolUse.get(totalKey) ?? 0) + snippetSources.length
            );
          }
          if (kind === SessionSearchDocKind.ToolResult) {
            totalsToolResult.set(
              totalKey,
              (totalsToolResult.get(totalKey) ?? 0) + snippetSources.length
            );
          }

          const ctxChars = contextCharsForKind(kind);
          const built = snippetSources.map((s) =>
            buildSnippet(s, query, ctxChars)
          );
          const selected = canAddHit(kind)
            ? built.slice(0, Math.max(0, remainingForKind(kind)))
            : [];
          if (selected.length === 0) {
            if (shouldStopEarly()) break;
            continue;
          }

          recordHit({
            docId: doc.id,
            kind,
            toolName: resolvedToolName,
            messageRole: doc.messageRole,
            snippets: selected,
          });
          if (shouldStopEarly()) break;
          continue;
        }

        if (
          hits.length === 0 &&
          qTokens.length === 1 &&
          q.length >= MIN_FUZZY_QUERY_LEN &&
          queryTris.size > 0
        ) {
          const triScore = trigramOverlapScore(docLower, queryTris);
          if (triScore < 0.2) continue;

          const queryToken = qTokens[0];
          const { combinedScore, bestToken, editDistance, tokenTriScore } =
            approximateBestSingleTokenMatch(docLower, queryToken, queryTris);
          if (!bestToken) continue;

          const maxDist = maxEditDistanceForQueryToken(queryToken);
          const lengthDeltaOk =
            Math.abs(bestToken.length - queryToken.length) <= 2;
          const gatedOk =
            editDistance <= maxDist &&
            tokenTriScore >= MIN_TOKEN_TRIGRAM_OVERLAP &&
            lengthDeltaOk;
          if (!gatedOk) continue;

          const combined = combinedScore * 0.7 + triScore * 0.3;
          if (!bestApprox || combined > bestApprox.score) {
            bestApprox = {
              docId: doc.id,
              kind,
              text: doc.text,
              snippetSources,
              toolName: resolvedToolName,
              messageRole: doc.messageRole,
              score: combined,
              bestToken,
            };
          }
        }
      }
    } catch (err) {
      logWarn('[search] Failed to parse JSONL line during session search', {
        cause: err,
      });
    }
  }

  if (hits.length === 0 && bestApprox) {
    if (!canAddHit(bestApprox.kind)) {
      return finalize();
    }

    const ctxChars = contextCharsForKind(bestApprox.kind);
    const built = bestApprox.snippetSources.map((s) =>
      buildSnippet(s, bestApprox.bestToken, ctxChars)
    );
    const selected = built.slice(
      0,
      Math.max(0, remainingForKind(bestApprox.kind))
    );
    if (selected.length === 0) return finalize();

    recordHit({
      docId: bestApprox.docId,
      kind: bestApprox.kind,
      toolName: bestApprox.toolName,
      messageRole: bestApprox.messageRole,
      score: bestApprox.score,
      snippets: selected,
    });

    totalsByKind.set(
      bestApprox.kind,
      (totalsByKind.get(bestApprox.kind) ?? 0) +
        bestApprox.snippetSources.length
    );
    const totalKey = bestApprox.toolName || 'unknown';
    if (bestApprox.kind === SessionSearchDocKind.ToolUse) {
      totalsToolUse.set(
        totalKey,
        (totalsToolUse.get(totalKey) ?? 0) + bestApprox.snippetSources.length
      );
    }
    if (bestApprox.kind === SessionSearchDocKind.ToolResult) {
      totalsToolResult.set(
        totalKey,
        (totalsToolResult.get(totalKey) ?? 0) + bestApprox.snippetSources.length
      );
    }
  }

  return finalize();
}

export async function runDroolSearch(
  query: string,
  options?: DroolFindOptions
): Promise<DroolFindResults> {
  const startMs = Date.now();
  const opts = {
    kind: options?.kind ?? 'all',
    limitSessions: options?.limitSessions ?? DEFAULT_LIMIT_SESSIONS,
    limitHitsPerSession:
      options?.limitHitsPerSession ?? DEFAULT_LIMIT_HITS_PER_SESSION,
    contextChars: options?.contextChars ?? DEFAULT_CONTEXT_CHARS,
    reindex: options?.reindex ?? false,
  };

  const configHash = getConfigHash();
  ensureSearchCacheDirs();

  const { manifest, canReuseCache, cacheMissReason } =
    await loadManifest(configHash);

  if (opts.reindex) {
    logInfo('[search] Reindex requested via --reindex');
  } else if (!canReuseCache) {
    logInfo('[search] Cache miss; rebuilding', {
      reason: cacheMissReason,
    });
  }

  if (opts.reindex || !canReuseCache) manifest.sessions = {};

  const files = await listAllSessionJsonlFiles();
  const fileBySessionId = new Map<string, string>();
  for (const f of files) fileBySessionId.set(f.sessionId, f.jsonlPath);

  const stats = await updateManifestFromFiles(manifest, files, '[search]');
  await saveManifest(manifest);

  logInfo('[search] Cache ready', {
    count: Object.keys(manifest.sessions).length,
    durationMs: Date.now() - startMs,
    query,
    // eslint-disable-next-line industry/no-nested-log-metadata -- niche cache-update counters consumed as a unit
    value: { cacheReuse: canReuseCache && !opts.reindex, ...stats },
  });

  const normalized = normalizeQuery(query);
  const queryTris = extractTrigrams(normalized);

  const scored = files.map((f) => {
    const state = manifest.sessions[f.jsonlPath];
    if (!state) return { file: f, score: 0 };
    const bloomScore = bloomScoreForQuery(
      bloomFromBase64(state.bloomB64),
      normalized
    );

    const score =
      queryTris.length === 0 ? SHORT_QUERY_BASELINE_SCORE : bloomScore;
    return { file: f, score };
  });

  // Filter out sessions whose bloom filter indicates zero match likelihood,
  // then cap to the configured candidate limit as a safety bound.
  const candidates = scored
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(
      0,
      Math.max(opts.limitSessions * CANDIDATE_MULTIPLIER, MIN_CANDIDATES)
    );

  // ── Search candidates using worker thread pool (with fallback) ──────

  const searchCandidateFilesSingleThread = async (
    candidateFiles: SessionJsonlFileHandle[]
  ): Promise<DroolFindSessionResult[]> => {
    const results: DroolFindSessionResult[] = [];
    const searched = new Set<string>();

    for (let i = 0; i < candidateFiles.length; i += SEARCH_BATCH_SIZE) {
      if (results.length >= opts.limitSessions) break;

      const batch = candidateFiles.slice(i, i + SEARCH_BATCH_SIZE);
      const batchPromises = batch.map(async (f) => {
        if (results.length >= opts.limitSessions) return null;
        if (searched.has(f.sessionId)) return null;
        searched.add(f.sessionId);

        const jsonlPath = fileBySessionId.get(f.sessionId);
        if (!jsonlPath) return null;

        try {
          const { title, hits, totals } = await findHitsInSession(
            f.sessionId,
            jsonlPath,
            query,
            opts
          );
          if (hits.length === 0) return null;
          return {
            sessionId: f.sessionId,
            title,
            updatedAt: f.mtimeMs,
            jsonlPath,
            hits,
            totals,
          };
        } catch (error) {
          logException(
            error,
            '[search] Failed to search session (local search)',
            {
              sessionId: f.sessionId,
              path: jsonlPath,
            }
          );
          return null;
        }
      });

      const batchResults = await Promise.all(batchPromises);
      for (const result of batchResults) {
        if (result && results.length < opts.limitSessions) {
          results.push(result);
        }
      }
    }
    return results;
  };

  const searchCandidateFilesWithWorkers = async (
    candidateFiles: SessionJsonlFileHandle[]
  ): Promise<DroolFindSessionResult[]> => {
    const fileLookup = new Map(candidateFiles.map((f) => [f.sessionId, f]));
    try {
      const workerResults = await searchWithWorkerPool(
        candidateFiles.map((f) => ({
          sessionId: f.sessionId,
          jsonlPath: f.jsonlPath,
          mtimeMs: f.mtimeMs,
        })),
        query,
        {
          kind: opts.kind,
          limitSessions: opts.limitSessions,
          limitHitsPerSession: opts.limitHitsPerSession,
          contextChars: opts.contextChars,
        }
      );

      return workerResults
        .filter((r) => r.hits.length > 0 && !r.error)
        .map((r) => ({
          sessionId: r.sessionId,
          title: r.title,
          updatedAt: fileLookup.get(r.sessionId)?.mtimeMs,
          jsonlPath: fileLookup.get(r.sessionId)?.jsonlPath ?? '',
          hits: r.hits as DroolFindHit[],
          totals: r.totals as DroolFindSessionResult['totals'],
        }))
        .slice(0, opts.limitSessions);
    } catch (error) {
      logWarn('[search] Worker pool failed, falling back to single-threaded', {
        error: error instanceof Error ? error.message : String(error),
      });
      return searchCandidateFilesSingleThread(candidateFiles);
    }
  };

  const candidateFiles = candidates.map((c) => c.file);
  let sessions = await searchCandidateFilesWithWorkers(candidateFiles);

  if (sessions.length === 0 && candidates.length < files.length) {
    const searchedIds = new Set(candidateFiles.map((f) => f.sessionId));
    const remaining = files.filter((f) => !searchedIds.has(f.sessionId));
    remaining.sort((a, b) => b.mtimeMs - a.mtimeMs);
    sessions = await searchCandidateFilesSingleThread(remaining);
  }

  return { query, sessions };
}

export async function warmSearchCache(): Promise<void> {
  const startMs = Date.now();
  const configHash = getConfigHash();

  try {
    ensureSearchCacheDirs();

    const { manifest, canReuseCache, cacheMissReason } =
      await loadManifest(configHash);

    if (!canReuseCache) {
      logInfo('[search] Warm cache miss; rebuilding', {
        reason: cacheMissReason,
      });
      manifest.sessions = {};
    }

    const files = await listAllSessionJsonlFiles();
    const stats = await updateManifestFromFiles(manifest, files, '[search]');
    await saveManifest(manifest);

    logInfo('[search] Warm cache ready', {
      count: Object.keys(manifest.sessions).length,
      durationMs: Date.now() - startMs,
      // eslint-disable-next-line industry/no-nested-log-metadata -- niche cache-update counters consumed as a unit
      value: { cacheReuse: canReuseCache, ...stats },
    });
  } catch (error) {
    logException(error, '[search] Warm cache failed');
  }
}
