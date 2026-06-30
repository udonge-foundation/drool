/**
 * Worker thread pool for parallel session file scanning.
 *
 * Uses `eval: true` workers with self-contained JavaScript so the pool works
 * in every runtime context (CLI daemon, Electron main process, Vite-bundled
 * desktop app) without requiring a separate compiled worker file.
 */
import * as os from 'os';
import { Worker } from 'worker_threads';

import { logInfo, logWarn } from '@industry/logging';

import type { DroolFindHit } from './types';

// ────────────────────────────────────────────────────────────────────────────
// Types shared between main thread and worker
// ────────────────────────────────────────────────────────────────────────────

interface WorkerTask {
  sessionId: string;
  jsonlPath: string;
  query: string;
  opts: {
    kind: string;
    limitHitsPerSession: number;
    contextChars: number;
  };
}

interface WorkerResult {
  sessionId: string;
  title?: string;
  hits: DroolFindHit[];
  totals: {
    byKind: Record<string, number>;
    toolUse: Record<string, number>;
    toolResult: Record<string, number>;
  };
  error?: string;
}

// ────────────────────────────────────────────────────────────────────────────
// Self-contained worker JavaScript
//
// IMPORTANT: This duplicates logic from findHitsInSession, extractors,
// buildSnippet, and normalization. When changing search/extraction logic in
// the TypeScript source, update the worker code below to match.
// ────────────────────────────────────────────────────────────────────────────

const WORKER_SOURCE = `
'use strict';
const { parentPort } = require('worker_threads');
const fs = require('fs');
const readline = require('readline');

const SYS_OPEN = '<system-reminder>';
const SYS_CLOSE = '</system-reminder>';

function strip(text) {
  let out = text;
  while (true) {
    const s = out.indexOf(SYS_OPEN);
    if (s < 0) break;
    const e = out.indexOf(SYS_CLOSE, s + SYS_OPEN.length);
    if (e < 0) { out = out.slice(0, s); break; }
    out = out.slice(0, s) + out.slice(e + SYS_CLOSE.length);
  }
  return out;
}

function norm(text) { return strip(text).trim(); }

function extractStrings(val, out) {
  if (typeof val === 'string') { const t = norm(val); if (t) out.push(t); return; }
  if (Array.isArray(val)) { for (const v of val) extractStrings(v, out); return; }
  if (val && typeof val === 'object') { for (const v of Object.values(val)) extractStrings(v, out); }
}

function extractDocs(sessionId, eventId, msg) {
  const content = msg.content;
  const role = msg.role === 'user' ? 'user' : 'assistant';

  if (typeof content === 'string') {
    const n = norm(content);
    if (!n) return [];
    return [{ id: sessionId + ':message_text:' + eventId + ':0', kind: 'message_text', text: n, snippets: [strip(content)], messageRole: role }];
  }
  if (!Array.isArray(content)) return [];

  const toolNames = {};
  for (const b of content) {
    if (b && b.type === 'tool_use' && typeof b.id === 'string' && typeof b.name === 'string') toolNames[b.id] = b.name;
  }

  const docs = [];
  for (let i = 0; i < content.length; i++) {
    const b = content[i];
    if (!b || typeof b !== 'object') continue;
    const key = String(b.id != null ? b.id : i);

    if (b.type === 'text' && typeof b.text === 'string') {
      const n = norm(b.text);
      if (n) docs.push({ id: sessionId + ':message_text:' + eventId + ':' + key, kind: 'message_text', text: n, snippets: [strip(b.text)], messageRole: role });
    } else if (b.type === 'tool_use') {
      const name = typeof b.name === 'string' ? b.name : '';
      const strs = [];
      extractStrings(b.input, strs);
      const joined = [name, ...strs].filter(Boolean).join('\\n');
      const n = norm(joined);
      if (n) {
        let snippet = '';
        if (name) snippet = '**' + name + '**';
        if (strs.length > 0) snippet += (snippet ? '\\n\\n' : '') + strip(strs.join('\\n'));
        docs.push({ id: sessionId + ':tool_use:' + eventId + ':' + key, kind: 'tool_use', text: n, snippets: snippet ? [snippet] : [], toolName: name || undefined });
      }
    } else if (b.type === 'tool_result') {
      const tuId = typeof b.tool_use_id === 'string' ? b.tool_use_id : key;
      const strs = [];
      extractStrings(b.content, strs);
      const n = norm(strs.join('\\n'));
      if (n) {
        const snippet = typeof b.content === 'string' ? strip(b.content) : strip(strs.join('\\n'));
        docs.push({ id: sessionId + ':tool_result:' + eventId + ':' + tuId, kind: 'tool_result', text: n, snippets: snippet ? [snippet] : [], toolName: toolNames[b.tool_use_id] });
      }
    } else if (b.type === 'document') {
      const src = b.source && typeof b.source === 'object' ? b.source : {};
      const name = typeof src.name === 'string' ? src.name : '';
      const fpath = typeof src.path === 'string' ? src.path : '';
      const parsed = typeof src.parsed_data === 'string' ? src.parsed_data : undefined;
      const data = typeof src.data === 'string' ? src.data : undefined;
      const parts = [name, fpath, parsed || data].filter(Boolean);
      const n = norm(parts.join('\\n'));
      if (n) {
        const body = strip(parsed || data || '');
        const header = [name ? '**' + name + '**' : '', fpath ? '\`' + fpath + '\`' : ''].filter(Boolean).join(' ');
        const snippet = body ? header + (header ? '\\n\\n' : '') + body : header;
        docs.push({ id: sessionId + ':document:' + eventId + ':' + key, kind: 'document', text: n, snippets: snippet ? [snippet] : [] });
      }
    }
  }
  return docs;
}

function buildSnippet(text, query, contextChars) {
  const q = query.trim();
  const lower = text.toLowerCase();
  const qLower = q.toLowerCase();
  let matchIndex = lower.indexOf(qLower);
  let matchLen = q.length;

  if (matchIndex === -1) {
    const tokens = qLower.split(/\\s+/).filter(Boolean);
    for (const tok of tokens) {
      const idx = lower.indexOf(tok);
      if (idx !== -1) { matchIndex = idx; matchLen = tok.length; break; }
    }
  }

  if (matchIndex === -1) {
    const end = Math.min(text.length, contextChars * 2);
    const slice = text.slice(0, end);
    return slice.length < text.length ? slice + '…' : slice;
  }

  const start = Math.max(0, matchIndex - contextChars);
  const end = Math.min(text.length, matchIndex + matchLen + contextChars);
  const pre = start > 0 ? '…' : '';
  const suf = end < text.length ? '…' : '';
  const before = text.slice(start, matchIndex);
  const match = text.slice(matchIndex, matchIndex + matchLen);
  const after = text.slice(matchIndex + matchLen, end);
  return pre + before + '<mark>' + match + '</mark>' + after + suf;
}

function extractTrigrams(text) {
  const t = text.toLowerCase();
  if (t.length < 3) return [];
  const out = [];
  for (let i = 0; i <= t.length - 3; i++) out.push(t.slice(i, i + 3));
  return out;
}

function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const v0 = new Array(b.length + 1);
  const v1 = new Array(b.length + 1);
  for (let i = 0; i <= b.length; i++) v0[i] = i;
  for (let i = 0; i < a.length; i++) {
    v1[0] = i + 1;
    for (let j = 0; j < b.length; j++) {
      v1[j + 1] = Math.min(v1[j] + 1, v0[j + 1] + 1, v0[j] + (a[i] === b[j] ? 0 : 1));
    }
    for (let j = 0; j <= b.length; j++) v0[j] = v1[j];
  }
  return v0[b.length];
}

const MIN_FUZZY_LEN = 5;
const MIN_TRI_OVERLAP = 0.8;

function trigramOverlapToken(token, queryTris) {
  if (!queryTris.size) return 0;
  const t = token.toLowerCase();
  if (t.length < 3) return 0;
  let hits = 0;
  for (let i = 0; i <= t.length - 3; i++) { if (queryTris.has(t.slice(i, i + 3))) hits++; }
  return hits / queryTris.size;
}

function trigramOverlapScore(text, queryTris) {
  if (!queryTris.size || text.length < 3) return 0;
  let hits = 0;
  for (let i = 0; i <= text.length - 3; i++) { if (queryTris.has(text.slice(i, i + 3))) hits++; }
  return hits / queryTris.size;
}

function maxEditDist(q) { return q.length >= 9 ? 2 : 1; }

async function searchFile(task) {
  const { sessionId, jsonlPath, query, opts } = task;
  const stream = fs.createReadStream(jsonlPath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  const hits = [];
  const maxPerKind = Math.max(1, opts.limitHitsPerSession);
  const snippetsByKind = {};
  const totalsByKind = {};
  const totalsToolUse = {};
  const totalsToolResult = {};
  const kinds = ['message_text', 'document', 'tool_use', 'tool_result'];

  const remaining = (kind) => maxPerKind - (snippetsByKind[kind] || 0);
  const canAdd = (kind) => remaining(kind) > 0;
  const shouldStop = () => {
    if (opts.kind !== 'all') return remaining(opts.kind) <= 0;
    return kinds.every((k) => remaining(k) <= 0);
  };

  let title;
  const q = query.trim().toLowerCase();
  const qTokens = q.split(/\\s+/).filter(Boolean);
  const queryTris = new Set(extractTrigrams(q));
  let bestApprox;

  try {
    for await (const line of rl) {
      if (shouldStop()) break;
      const trimmed = line.trim();
      if (!trimmed) continue;
      let evt;
      try { evt = JSON.parse(trimmed); } catch { continue; }

      if (evt.type === 'session_start') {
        if (typeof evt.title === 'string') title = evt.title;
        if (typeof evt.sessionTitle === 'string') title = evt.sessionTitle;
        continue;
      }
      if (evt.type !== 'message') continue;

      const docs = extractDocs(sessionId, typeof evt.id === 'string' ? evt.id : 'unknown', evt.message);

      for (const doc of docs) {
        const kind = doc.kind;
        if (opts.kind !== 'all' && kind !== opts.kind) continue;

        const docLower = doc.text.toLowerCase();
        const exact = q.length > 0 && docLower.includes(q);
        const snippetSources = doc.snippets && doc.snippets.length > 0 ? doc.snippets : [doc.text];
        const ctxChars = Math.min(opts.contextChars, 100);
        const toolName = doc.toolName;

        if (exact) {
          totalsByKind[kind] = (totalsByKind[kind] || 0) + snippetSources.length;
          if (kind === 'tool_use') totalsToolUse[toolName || 'unknown'] = (totalsToolUse[toolName || 'unknown'] || 0) + snippetSources.length;
          if (kind === 'tool_result') totalsToolResult[toolName || 'unknown'] = (totalsToolResult[toolName || 'unknown'] || 0) + snippetSources.length;

          const built = snippetSources.map((s) => buildSnippet(s, query, ctxChars));
          const selected = canAdd(kind) ? built.slice(0, Math.max(0, remaining(kind))) : [];
          if (selected.length === 0) { if (shouldStop()) break; continue; }

          hits.push({ docId: doc.id, kind, toolName, messageRole: doc.messageRole, snippets: selected });
          snippetsByKind[kind] = (snippetsByKind[kind] || 0) + selected.length;
          if (shouldStop()) break;
          continue;
        }

        // Fuzzy matching fallback
        if (hits.length === 0 && qTokens.length === 1 && q.length >= MIN_FUZZY_LEN && queryTris.size > 0) {
          const triScore = trigramOverlapScore(docLower, queryTris);
          if (triScore < 0.2) continue;

          const queryToken = qTokens[0];
          const tokens = docLower.split(/[^a-z0-9_-]+/).filter((t) => t.length > 0 && t.length <= 64);
          let bestToken, bestDist = Infinity, bestTri = 0;
          for (const t of tokens) {
            const d = levenshtein(queryToken, t);
            if (d < bestDist) { bestDist = d; bestToken = t; bestTri = trigramOverlapToken(t, queryTris); }
            else if (d === bestDist && bestToken) { const tri = trigramOverlapToken(t, queryTris); if (tri > bestTri) { bestToken = t; bestTri = tri; } }
            if (bestDist === 0) break;
          }
          if (!bestToken || !isFinite(bestDist)) continue;

          const md = maxEditDist(queryToken);
          const lengthOk = Math.abs(bestToken.length - queryToken.length) <= 2;
          if (!(bestDist <= md && bestTri >= MIN_TRI_OVERLAP && lengthOk)) continue;

          const editScore = Math.max(0, 1 - bestDist / Math.max(1, md));
          const combined = (bestTri * 0.8 + editScore * 0.2) * 0.7 + triScore * 0.3;
          if (!bestApprox || combined > bestApprox.score) {
            bestApprox = { docId: doc.id, kind, text: doc.text, snippetSources, toolName, messageRole: doc.messageRole, score: combined, bestToken };
          }
        }
      }
    }
  } finally {
    rl.close();
    stream.destroy();
  }

  // Use approximate match if no exact hits found
  if (hits.length === 0 && bestApprox && canAdd(bestApprox.kind)) {
    const ctxChars = Math.min(opts.contextChars, 100);
    const built = bestApprox.snippetSources.map((s) => buildSnippet(s, bestApprox.bestToken, ctxChars));
    const selected = built.slice(0, Math.max(0, remaining(bestApprox.kind)));
    if (selected.length > 0) {
      hits.push({ docId: bestApprox.docId, kind: bestApprox.kind, toolName: bestApprox.toolName, messageRole: bestApprox.messageRole, score: bestApprox.score, snippets: selected });
      totalsByKind[bestApprox.kind] = (totalsByKind[bestApprox.kind] || 0) + bestApprox.snippetSources.length;
      const tk = bestApprox.toolName || 'unknown';
      if (bestApprox.kind === 'tool_use') totalsToolUse[tk] = (totalsToolUse[tk] || 0) + bestApprox.snippetSources.length;
      if (bestApprox.kind === 'tool_result') totalsToolResult[tk] = (totalsToolResult[tk] || 0) + bestApprox.snippetSources.length;
    }
  }

  return {
    sessionId, title, hits,
    totals: {
      byKind: { message_text: totalsByKind['message_text'] || 0, document: totalsByKind['document'] || 0, tool_use: totalsByKind['tool_use'] || 0, tool_result: totalsByKind['tool_result'] || 0 },
      toolUse: totalsToolUse,
      toolResult: totalsToolResult,
    },
  };
}

parentPort.on('message', async (msg) => {
  if (msg.type === 'search') {
    try {
      const result = await searchFile(msg.task);
      parentPort.postMessage({ type: 'result', result });
    } catch (e) {
      parentPort.postMessage({ type: 'result', result: { sessionId: msg.task.sessionId, hits: [], totals: { byKind: {}, toolUse: {}, toolResult: {} }, error: e.message } });
    }
  }
});

parentPort.postMessage({ type: 'ready' });
`;

// ────────────────────────────────────────────────────────────────────────────
// Worker pool management
// ────────────────────────────────────────────────────────────────────────────

const DEFAULT_POOL_SIZE = Math.min(os.cpus().length, 8);

export async function searchWithWorkerPool(
  candidates: Array<{
    sessionId: string;
    jsonlPath: string;
    mtimeMs: number;
  }>,
  query: string,
  opts: {
    kind: string;
    limitSessions: number;
    limitHitsPerSession: number;
    contextChars: number;
  },
  poolSize: number = DEFAULT_POOL_SIZE
): Promise<WorkerResult[]> {
  if (candidates.length === 0) return [];

  const actualPoolSize = Math.min(poolSize, candidates.length);
  const workers: Worker[] = [];
  const results: WorkerResult[] = [];

  // Task queue: index into candidates
  let nextTaskIdx = 0;
  let completedCount = 0;
  const totalTasks = candidates.length;

  return new Promise<WorkerResult[]>((resolve, reject) => {
    let settled = false;
    let safetyTimeout: ReturnType<typeof setTimeout> | null = null;

    const cleanup = () => {
      if (safetyTimeout) {
        clearTimeout(safetyTimeout);
        safetyTimeout = null;
      }
      for (const w of workers) {
        try {
          void w.terminate();
        } catch (err) {
          logWarn('[search-worker] Failed to terminate worker', { cause: err });
        }
      }
    };

    const finish = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(results);
    };

    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };

    const dispatchNext = (worker: Worker) => {
      // Early termination: if we already have enough sessions with hits
      if (
        results.filter((r) => r.hits.length > 0).length >= opts.limitSessions
      ) {
        completedCount = totalTasks;
        finish();
        return;
      }

      if (nextTaskIdx >= totalTasks) {
        if (completedCount >= totalTasks) {
          finish();
        }
        return;
      }

      const candidate = candidates[nextTaskIdx++];
      const task: WorkerTask = {
        sessionId: candidate.sessionId,
        jsonlPath: candidate.jsonlPath,
        query,
        opts: {
          kind: opts.kind,
          limitHitsPerSession: opts.limitHitsPerSession,
          contextChars: opts.contextChars,
        },
      };
      worker.postMessage({ type: 'search', task });
    };

    const setupWorker = (worker: Worker) => {
      worker.on('message', (msg: { type: string; result?: WorkerResult }) => {
        if (msg.type === 'ready') {
          dispatchNext(worker);
        } else if (msg.type === 'result' && msg.result) {
          completedCount++;
          if (msg.result.hits.length > 0 && !msg.result.error) {
            results.push(msg.result);
          }
          dispatchNext(worker);
        }
      });

      worker.on('error', (err) => {
        logWarn('[search-worker] Worker error', {
          error: err.message,
        });
        completedCount++;
        if (completedCount >= totalTasks) {
          finish();
        }
      });

      worker.on('exit', (code) => {
        if (code !== 0 && !settled) {
          logWarn('[search-worker] Worker exited with non-zero code', {
            code,
          });
        }
      });
    };

    for (let i = 0; i < actualPoolSize; i++) {
      try {
        const worker = new Worker(WORKER_SOURCE, { eval: true });
        setupWorker(worker);
        workers.push(worker);
      } catch (err) {
        logWarn('[search-worker] Failed to spawn worker', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    if (workers.length === 0) {
      fail(new Error('Failed to spawn any worker threads'));
      return;
    }

    logInfo('[search-worker] Pool started', {
      count: workers.length,
      totalCount: totalTasks,
    });

    safetyTimeout = setTimeout(() => {
      logWarn('[search-worker] Pool timed out, returning partial results', {
        count: completedCount,
        totalCount: totalTasks,
        currentCount: results.filter((r) => r.hits.length > 0).length,
      });
      finish();
    }, 30_000);
  });
}
