import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { Box, Text } from 'ink';
import * as yaml from 'js-yaml';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { findGitRoot } from '@industry/utils/shell/node';

import { customCommandsLoader } from '@/commands/custom/CustomCommandsLoader';
import { COLORS } from '@/components/chat/themedColors';
import { useKeypressHandler } from '@/hooks/useKeypressHandler';

import type { CustomCommand } from '@industry/common/settings';

interface CommandsManagerProps {
  onClose: () => void;
}

interface ImportCandidate {
  id: string;
  file: string;
  dir: string;
  source: 'Agents' | 'Claude';
  scope: 'W' | 'G';
  selected: boolean;
  name?: string;
  description?: string;
  argumentHint?: string;
}

function abbreviateDisplayPath(
  absPath: string,
  gitRoot: string | null
): string {
  try {
    if (gitRoot && absPath.startsWith(gitRoot + path.sep)) {
      return path.relative(gitRoot, absPath);
    }
    const home = os.homedir();
    if (absPath.startsWith(home + path.sep)) {
      return `~/${path.relative(home, absPath)}`;
    }
  } catch {
    /* ignore */
  }
  return absPath;
}

export function CommandsManager({ onClose }: CommandsManagerProps) {
  const { t } = useTranslation();
  const [items, setItems] = useState<CustomCommand[]>([]);
  const [selected, setSelected] = useState(0);
  const [loading, setLoading] = useState(false);
  const [mode, setMode] = useState<'list' | 'import'>('list');
  const [importIndex, setImportIndex] = useState(0);
  const [importItems, setImportItems] = useState<ImportCandidate[]>([]);

  const reload = async () => {
    setLoading(true);
    const commands = await customCommandsLoader.getCommands();
    setItems(commands);
    setSelected(0);
    setLoading(false);
  };

  const discoverImportItems = async (): Promise<ImportCandidate[]> => {
    const out: ImportCandidate[] = [];
    const gitRoot = findGitRoot();
    const candidates: Array<{
      dir: string;
      source: 'Agents' | 'Claude';
      scope: 'W' | 'G';
    }> = [];

    if (gitRoot) {
      const agentsProj = path.join(gitRoot, '.agents', 'commands');
      const claudeProj = path.join(gitRoot, '.claude', 'commands');
      if (fs.existsSync(agentsProj))
        candidates.push({ dir: agentsProj, source: 'Agents', scope: 'W' });
      if (fs.existsSync(claudeProj))
        candidates.push({ dir: claudeProj, source: 'Claude', scope: 'W' });
    }
    const agentsHome = path.join(os.homedir(), '.agents', 'commands');
    const claudeHome = path.join(os.homedir(), '.claude', 'commands');
    if (fs.existsSync(agentsHome))
      candidates.push({ dir: agentsHome, source: 'Agents', scope: 'G' });
    if (fs.existsSync(claudeHome))
      candidates.push({ dir: claudeHome, source: 'Claude', scope: 'G' });

    // Helpers to align UI with Industry representation
    const normalizeName = (fileName: string): string =>
      fileName
        .replace(/\.[^.]+$/, '')
        .toLowerCase()
        .replace(/[^a-z0-9-_]/g, '-')
        .replace(/--+/g, '-');
    type ImportFM = { description?: string; 'argument-hint'?: string };
    const parseFrontmatter = (
      text: string
    ): { meta: ImportFM; body: string } => {
      if (!text.startsWith('---\n')) return { meta: {}, body: text };
      const end = text.indexOf('\n---\n', 4);
      if (end === -1) return { meta: {}, body: text };
      const fm = text.substring(4, end);
      let meta: ImportFM = {};
      try {
        const parsed = yaml.load(fm);
        meta = (
          parsed && typeof parsed === 'object' ? (parsed as ImportFM) : {}
        ) as ImportFM;
      } catch {
        meta = {};
      }
      const body = text.substring(end + 5);
      return { meta, body };
    };
    const readFirstNonEmptyLine = (text: string): string | null => {
      for (const l of text.split(/\r?\n/)) {
        const s = l.trim();
        if (s) return s;
      }
      return null;
    };

    await Promise.all(
      candidates.map(async (c) => {
        try {
          const files = await fs.promises.readdir(c.dir);
          const entries = await Promise.all(
            files
              .filter((f) => f.toLowerCase().endsWith('.md'))
              .map(async (f) => {
                const name = normalizeName(f);
                let description: string | undefined;
                let argumentHint: string | undefined;
                try {
                  const full = path.join(c.dir, f);
                  const raw = await fs.promises.readFile(full, 'utf8');
                  const { meta, body } = parseFrontmatter(raw);
                  description =
                    meta.description || readFirstNonEmptyLine(body) || name;
                  argumentHint = meta['argument-hint'];
                } catch {
                  /* ignore per-file parsing failures */
                }
                return {
                  id: `${c.dir}:${f}`,
                  file: f,
                  dir: c.dir,
                  source: c.source,
                  scope: c.scope,
                  selected: false,
                  name,
                  description,
                  argumentHint,
                };
              })
          );
          entries.forEach((e) => out.push(e));
        } catch {
          /* ignore */
        }
      })
    );
    return out;
  };

  const importSelected = async (): Promise<number> => {
    let dest: string;
    const gitRoot = findGitRoot();
    if (gitRoot && fs.existsSync(path.join(gitRoot, '.industry'))) {
      dest = path.join(gitRoot, '.industry', 'commands');
    } else {
      dest = path.join(os.homedir(), '.industry', 'commands');
    }
    await fs.promises.mkdir(dest, { recursive: true });
    let copied = 0;
    const selectedItems = importItems.filter((i) => i.selected);
    await Promise.all(
      selectedItems.map(async (item) => {
        const src = path.join(item.dir, item.file);
        const dst = path.join(dest, item.file);
        try {
          try {
            await fs.promises.access(dst, fs.constants.F_OK);
            return; // skip existing
          } catch {
            /* not exists */
          }
          const data = await fs.promises.readFile(src);
          await fs.promises.writeFile(dst, data);
          const st = await fs.promises.stat(src);
          await fs.promises.chmod(dst, st.mode);
          copied++;
        } catch {
          /* ignore per-file */
        }
      })
    );
    return copied;
  };

  useEffect(() => {
    void reload();
  }, []);

  useKeypressHandler((_input, key) => {
    if (mode === 'list') {
      if (key.escape) {
        onClose();
        return;
      }
      if (key.upArrow) {
        setSelected((s) => (s <= 0 ? Math.max(items.length - 1, 0) : s - 1));
        return;
      }
      if (key.downArrow) {
        setSelected((s) => (s >= items.length - 1 ? 0 : s + 1));
        return;
      }
      if (key.return) {
        return;
      }
      if (_input === 'r' || _input === 'R') {
        void reload();
        return;
      }
      if (_input === 'i' || _input === 'I') {
        setLoading(true);
        void (async () => {
          const candidates = await discoverImportItems();
          setImportItems(candidates);
          setImportIndex(0);
          setLoading(false);
          setMode('import');
        })();
      }
    } else if (mode === 'import') {
      if (key.escape) {
        setMode('list');
        return;
      }
      if (_input === 'b' || _input === 'B') {
        setMode('list');
        return;
      }
      if (key.upArrow) {
        setImportIndex((s) =>
          s <= 0 ? Math.max(importItems.length - 1, 0) : s - 1
        );
        return;
      }
      if (key.downArrow) {
        setImportIndex((s) => (s >= importItems.length - 1 ? 0 : s + 1));
        return;
      }
      if (key.return) {
        // No-op if nothing is selected
        const anySelected = importItems.some((i) => i.selected);
        if (!anySelected) return;
        setLoading(true);
        void (async () => {
          await importSelected();
          await reload();
          setMode('list');
          setLoading(false);
        })();
        return;
      }
      if (_input === ' ' && importItems.length > 0) {
        setImportItems((arr) =>
          arr.map((it, i) =>
            i === importIndex ? { ...it, selected: !it.selected } : it
          )
        );
        return;
      }
      if (_input === 'a' || _input === 'A') {
        const allSelected = importItems.every((i) => i.selected);
        setImportItems((arr) =>
          arr.map((it) => ({ ...it, selected: !allSelected }))
        );
      }
    }
  });

  return (
    <Box
      borderStyle="round"
      borderColor={COLORS.border}
      paddingX={1}
      flexDirection="column"
      width={90}
    >
      <Text bold>
        {mode === 'list'
          ? t('common:commandsManager.titleList')
          : t('common:commandsManager.titleImport')}
      </Text>
      <Box marginTop={1} />
      {loading ? (
        <Text color={COLORS.text.muted}>
          {t('common:commandsManager.working')}
        </Text>
      ) : mode === 'list' ? (
        items.length === 0 ? (
          <Text color={COLORS.text.muted}>
            {t('common:commandsManager.noCommandsFound')}
          </Text>
        ) : (
          items.map((c, idx) => {
            const isSel = idx === selected;
            const nameColor = isSel ? COLORS.primary : undefined;
            const metaKind = c.isExecutable
              ? t('common:commandsManager.kindExecutable')
              : t('common:commandsManager.kindMarkdown');
            const metaScope =
              c.source === 'workspace'
                ? t('common:commandsManager.locationWorkspace')
                : t('common:commandsManager.locationPersonal');
            // Abbreviate long absolute paths for readability
            const displayPath = abbreviateDisplayPath(
              c.filePath,
              findGitRoot()
            );
            // Avoid showing a duplicated description when it equals the normalized name
            const norm = (s: string) =>
              s
                .toLowerCase()
                .replace(/[^a-z0-9-_]/g, '-')
                .replace(/--+/g, '-');
            const showDescription =
              !!c.description && norm(c.description) !== norm(c.name);
            return (
              <Box
                key={`${c.source}:${c.name}`}
                flexDirection="column"
                marginBottom={1}
              >
                <Text color={nameColor} bold={isSel}>
                  {isSel ? '> ' : '  '}/{c.name}
                  {c.argumentHint ? (
                    <Text color={COLORS.text.muted}> {c.argumentHint}</Text>
                  ) : null}
                </Text>
                {showDescription ? (
                  <Text color={COLORS.text.muted}> {c.description}</Text>
                ) : null}
                <Text>
                  <Text color={COLORS.text.muted}>
                    {' '}
                    {t('common:commandsManager.kindLabel')}
                  </Text>{' '}
                  <Text
                    color={
                      c.isExecutable ? COLORS.success : COLORS.text.secondary
                    }
                  >
                    {metaKind}
                  </Text>
                  <Text color={COLORS.text.muted}>
                    {'  •  '}
                    {t('common:commandsManager.locationLabel')}
                  </Text>{' '}
                  <Text color={COLORS.text.secondary}>{metaScope}</Text>
                  <Text color={COLORS.text.muted}>
                    {'  •  '}
                    {t('common:commandsManager.fileLabel')}
                  </Text>{' '}
                  <Text color={COLORS.text.secondary}>{displayPath}</Text>
                </Text>
              </Box>
            );
          })
        )
      ) : importItems.length === 0 ? (
        <Text color={COLORS.text.muted}>
          {t('common:commandsManager.noImportCandidates')}
        </Text>
      ) : (
        importItems.map((it, idx) => {
          const isSel = idx === importIndex;
          const color = isSel ? COLORS.primary : undefined;
          const mark = it.selected ? '[x]' : '[ ]';
          // Shorten display path
          const displayPath = abbreviateDisplayPath(
            path.join(it.dir, it.file),
            findGitRoot()
          );
          const scope =
            it.scope === 'W'
              ? t('common:commandsManager.locationWorkspace')
              : t('common:commandsManager.locationPersonal');
          const name = it.name || it.file.replace(/\.[^.]+$/, '');
          const desc = it.description;
          return (
            <Box key={it.id} flexDirection="column" marginBottom={1}>
              <Text color={color} bold={isSel}>
                {isSel ? '> ' : '  '}
                {mark} /{name}
                {it.argumentHint ? (
                  <Text color={COLORS.text.muted}> {it.argumentHint}</Text>
                ) : null}
              </Text>
              {desc ? <Text color={COLORS.text.muted}> {desc}</Text> : null}
              <Text>
                <Text color={COLORS.text.muted}>
                  {' '}
                  {t('common:commandsManager.kindLabel')}
                </Text>{' '}
                <Text color={COLORS.text.secondary}>
                  {t('common:commandsManager.kindMarkdown')}
                </Text>
                <Text color={COLORS.text.muted}>
                  {'  •  '}
                  {t('common:commandsManager.sourceLabel')}
                </Text>{' '}
                <Text color={COLORS.text.secondary}>{it.source}</Text>
                <Text color={COLORS.text.muted}>
                  {'  •  '}
                  {t('common:commandsManager.locationLabel')}
                </Text>{' '}
                <Text color={COLORS.text.secondary}>{scope}</Text>
                <Text color={COLORS.text.muted}>
                  {'  •  '}
                  {t('common:commandsManager.fileLabel')}
                </Text>{' '}
                <Text color={COLORS.text.secondary}>{displayPath}</Text>
              </Text>
            </Box>
          );
        })
      )}
      <Box marginTop={1}>
        {mode === 'list' ? (
          <Text color={COLORS.text.muted}>
            {t('common:commandsManager.helpList')}
          </Text>
        ) : (
          <Text color={COLORS.text.muted}>
            {t('common:commandsManager.helpImport')}
          </Text>
        )}
      </Box>
    </Box>
  );
}
