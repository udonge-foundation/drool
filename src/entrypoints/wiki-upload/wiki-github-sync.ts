import { execFile } from 'child_process';
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { basename, dirname, extname, join, relative } from 'path';
import { promisify } from 'util';

import type { PageTreeNode } from '@industry/common/wiki';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Internal helpers (defined before use to satisfy no-use-before-define)
// ---------------------------------------------------------------------------

function writeStdout(message: string): void {
  process.stdout.write(`${message}\n`);
}

function writeStderr(message: string): void {
  process.stderr.write(`${message}\n`);
}

/** Image file extensions to copy alongside markdown */
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);

/**
 * Recursively collects all file paths relative to baseDir.
 */
function collectFiles(dir: string, baseDir: string): string[] {
  const results: string[] = [];

  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return results;
  }

  for (const entry of entries) {
    // Skip hidden files and directories
    if (entry.startsWith('.')) continue;

    const fullPath = join(dir, entry);
    let stat;
    try {
      stat = lstatSync(fullPath);
    } catch {
      continue;
    }

    // Skip symlinks to prevent path-traversal exfiltration
    if (stat.isSymbolicLink()) continue;

    if (stat.isDirectory()) {
      results.push(...collectFiles(fullPath, baseDir));
    } else if (stat.isFile()) {
      results.push(relative(baseDir, fullPath).replaceAll('\\', '/'));
    }
  }

  return results.sort();
}

/**
 * Resolves a potentially relative target path against the current file's
 * original path to produce an absolute (relative to wiki root) path.
 */
function resolveTarget(
  target: string,
  currentOrigPath: string | undefined
): string | null {
  if (!target) return null;

  // Normalize separators
  const normalized = target.replaceAll('\\', '/');

  // If it starts with ./ or ../, it's relative to the current file
  if (
    (normalized.startsWith('./') || normalized.startsWith('../')) &&
    currentOrigPath
  ) {
    const currentDir = dirname(currentOrigPath);
    const parts = [...currentDir.split('/'), ...normalized.split('/')];
    const resolved: string[] = [];

    for (const part of parts) {
      if (part === '.' || part === '') continue;
      if (part === '..') {
        resolved.pop();
      } else {
        resolved.push(part);
      }
    }

    return resolved.join('/');
  }

  // Bare relative link: a simple filename (no / separator) with .md extension
  // or no extension — treat as relative to the current file's directory.
  // e.g. "architecture.md" from "overview/index.md" → "overview/architecture.md"
  if (currentOrigPath && !normalized.includes('/')) {
    const ext = extname(normalized).toLowerCase();
    if (ext === '.md' || ext === '') {
      const currentDir = dirname(currentOrigPath);
      if (currentDir && currentDir !== '.') {
        return `${currentDir}/${normalized}`;
      }
    }
  }

  // Otherwise treat as absolute from wiki root (strip leading /)
  return normalized.replace(/^\//, '');
}

/**
 * Attempts to rewrite a single link target to a flat base filename.
 * Returns the rewritten link or null if not an internal link.
 */
function rewriteLink(
  href: string,
  currentOrigPath: string | undefined,
  lookupByOriginal: Map<string, string>,
  lookupByOriginalNoExt: Map<string, string>
): string | null {
  // Skip external URLs, anchors-only, and mailto
  if (
    href.startsWith('http://') ||
    href.startsWith('https://') ||
    href.startsWith('#') ||
    href.startsWith('mailto:')
  ) {
    return null;
  }

  // Separate anchor fragment
  let anchor = '';
  let target = href;
  const hashIdx = target.indexOf('#');
  if (hashIdx !== -1) {
    anchor = target.slice(hashIdx);
    target = target.slice(0, hashIdx);
  }

  // Skip non-markdown links (images, etc.)
  if (target && !target.toLowerCase().endsWith('.md')) {
    // Check if it's a path that could be an md file without extension
    const withMd = `${target}.md`;
    const resolved = resolveTarget(withMd, currentOrigPath);
    if (resolved) {
      const flatName =
        lookupByOriginal.get(resolved) ??
        lookupByOriginalNoExt.get(resolved.replace(/\.md$/i, ''));
      if (flatName) {
        return flatName + anchor;
      }
    }
    return null;
  }

  // Resolve the target path
  const resolved = resolveTarget(target, currentOrigPath);
  if (!resolved) return null;

  // Look up the flat name
  const flatName =
    lookupByOriginal.get(resolved) ??
    lookupByOriginalNoExt.get(resolved.replace(/\.md$/i, ''));

  if (flatName) {
    return flatName + anchor;
  }

  return null;
}

/**
 * Rewrites markdown links in `content` but skips any links that appear inside
 * fenced code blocks (``` or ~~~ delimiters). The `replacer` callback receives
 * the full match, link text, and href — identical to the signature used by
 * `String.prototype.replace` with the link regex.
 */
export function rewriteLinksOutsideCodeBlocks(
  content: string,
  replacer: (match: string, text: string, href: string) => string
): string {
  // Split on fenced code block boundaries (``` or ~~~, possibly with info string)
  const fencePattern = /^(```|~~~).*$/gm;
  const parts: string[] = [];
  let lastIndex = 0;
  let insideCodeBlock = false;

  for (const m of content.matchAll(fencePattern)) {
    const fenceStart = m.index;
    const fenceEnd = fenceStart + m[0].length;

    if (!insideCodeBlock) {
      // Text before this opening fence — rewrite links in it
      parts.push(
        content
          .slice(lastIndex, fenceStart)
          .replace(/(?<!!)\[([^\]]*)\]\(([^)]+)\)/g, replacer)
      );
      // Push the fence line as-is
      parts.push(content.slice(fenceStart, fenceEnd));
      insideCodeBlock = true;
    } else {
      // Text inside code block + closing fence — preserve as-is
      parts.push(content.slice(lastIndex, fenceEnd));
      insideCodeBlock = false;
    }

    lastIndex = fenceEnd;
  }

  // Remaining text after last fence (or all text if no fences)
  const remaining = content.slice(lastIndex);
  if (insideCodeBlock) {
    // Unclosed code block — preserve as-is
    parts.push(remaining);
  } else {
    parts.push(remaining.replace(/(?<!!)\[([^\]]*)\]\(([^)]+)\)/g, replacer));
  }

  return parts.join('');
}

/**
 * Resolves a PageTreeNode's flat name from the fileMapping.
 */
function resolveNodeFlatName(
  node: PageTreeNode,
  fileMapping: Map<string, string>
): string | null {
  // Try direct path lookup
  const direct = fileMapping.get(node.path);
  if (direct) return direct;

  // Try with .md extension if not already present
  if (!node.path.endsWith('.md')) {
    const withMd = fileMapping.get(`${node.path}.md`);
    if (withMd) return withMd;

    // Try index.md under this path
    const indexPath = `${node.path}/index.md`;
    const indexFlat = fileMapping.get(indexPath);
    if (indexFlat) return indexFlat;
  }

  return null;
}

/**
 * Recursively renders sidebar children with indentation.
 */
function renderSidebarChildren(
  children: PageTreeNode[],
  fileMapping: Map<string, string>,
  lines: string[],
  depth: number
): void {
  const indent = '  '.repeat(depth + 1);

  for (const child of children) {
    const flatName = resolveNodeFlatName(child, fileMapping);

    if (flatName) {
      lines.push(`${indent}- [${child.title}](${flatName})`);
    } else {
      lines.push(`${indent}- ${child.title}`);
    }

    if (child.children && child.children.length > 0) {
      renderSidebarChildren(child.children, fileMapping, lines, depth + 1);
    }
  }
}

/**
 * Derives the `.wiki.git` URL from a repository URL.
 * Supports HTTPS and SSH formats.
 */
export function deriveWikiGitUrl(repoUrl: string): string | null {
  // HTTPS: https://github.com/owner/repo → https://github.com/owner/repo.wiki.git
  const httpsMatch = repoUrl.match(
    /^https?:\/\/(github\.com\/[^/]+\/[^/]+?)(?:\.git)?$/
  );
  if (httpsMatch) {
    return `https://${httpsMatch[1]}.wiki.git`;
  }

  // SSH: git@github.com:owner/repo.git → git@github.com:owner/repo.wiki.git
  const sshMatch = repoUrl.match(
    /^git@(github\.com):([^/]+\/[^/]+?)(?:\.git)?$/
  );
  if (sshMatch) {
    return `git@${sshMatch[1]}:${sshMatch[2]}.wiki.git`;
  }

  return null;
}

/**
 * Derives the browser-accessible wiki URL from a repository URL.
 */
function deriveWikiBrowserUrl(repoUrl: string): string {
  // Strip .git suffix and trailing slashes
  const cleaned = repoUrl.replace(/\.git$/, '').replace(/\/+$/, '');

  // Convert SSH to HTTPS if needed
  const sshMatch = cleaned.match(/^git@github\.com:(.+)$/);
  if (sshMatch) {
    return `https://github.com/${sshMatch[1]}/wiki`;
  }

  return `${cleaned}/wiki`;
}

// ---------------------------------------------------------------------------
// Exported functions
// ---------------------------------------------------------------------------

/**
 * Converts a relative file path to the flat base filename used by GitHub wiki.
 * Replaces `/` with `--`, collapses `index.md` to parent directory name,
 * and strips the `.md` extension.
 *
 * Examples:
 *   `overview/architecture.md`  → `overview--architecture`
 *   `overview/index.md`         → `overview`
 *   `apps/cli/index.md`         → `apps--cli`
 *   `by-the-numbers.md`         → `by-the-numbers`
 *   `index.md`                  → `Home`
 */
export function toFlatBaseName(relPath: string): string {
  // Normalize path separators
  const normalized = relPath.replaceAll('\\', '/');

  // Strip .md extension
  const withoutExt = normalized.replace(/\.md$/i, '');

  // Determine the directory and base
  const parts = withoutExt.split('/');
  const lastPart = parts[parts.length - 1];

  // Handle index files
  if (lastPart.toLowerCase() === 'index') {
    if (parts.length === 1) {
      // Root index.md → Home
      return 'Home';
    }
    // Nested index — collapse to parent path
    const parentParts = parts.slice(0, -1);
    return parentParts.join('--');
  }

  // Non-index file — replace / with --
  return parts.join('--');
}

/**
 * Copies all markdown and image files from a hierarchical wikiDir to a flat
 * outDir, renaming with `--` separator. Index files collapse to parent name.
 *
 * Returns a Map<originalRelativePath, flatBaseName> for use with link rewriting.
 * The original wikiDir is never modified.
 */
export function flattenWikiFiles(
  wikiDir: string,
  outDir: string
): Map<string, string> {
  const fileMapping = new Map<string, string>();

  mkdirSync(outDir, { recursive: true });

  // Recursively collect all files
  const allFiles = collectFiles(wikiDir, wikiDir);

  for (const relPath of allFiles) {
    const ext = extname(relPath).toLowerCase();
    const srcPath = join(wikiDir, relPath);

    if (ext === '.md') {
      const flatName = toFlatBaseName(relPath);
      const destPath = join(outDir, `${flatName}.md`);
      copyFileSync(srcPath, destPath);
      fileMapping.set(relPath, flatName);
    } else if (IMAGE_EXTENSIONS.has(ext)) {
      // Copy image files to flat output with same basename
      // (images are referenced by flat name in GitHub wiki)
      const imgBaseName = basename(relPath);
      const destPath = join(outDir, imgBaseName);
      // Avoid overwriting if duplicate basenames exist
      if (!existsSync(destPath)) {
        copyFileSync(srcPath, destPath);
      } else {
        writeStderr(
          `Warning: Image name collision — '${relPath}' has the same basename as an already-copied image ('${imgBaseName}'). Keeping the first copy.`
        );
      }
    }
  }

  return fileMapping;
}

/**
 * Rewrites ALL internal markdown links in all .md files in outDir to use flat
 * base filenames. Handles relative paths, absolute paths, .md extension
 * stripping, and anchor fragments.
 *
 * A link is considered "internal" if it targets a .md file in the fileMapping
 * or if the resolved path matches a known file.
 */
export function rewriteInternalLinks(
  outDir: string,
  fileMapping: Map<string, string>
): void {
  // Build a reverse lookup: originalRelPath → flatBaseName
  const lookupByOriginal = new Map<string, string>();
  const lookupByOriginalNoExt = new Map<string, string>();

  for (const [origPath, flatName] of fileMapping) {
    lookupByOriginal.set(origPath, flatName);
    // Also index without .md extension for matching
    const noExt = origPath.replace(/\.md$/i, '');
    lookupByOriginalNoExt.set(noExt, flatName);
  }

  // Process each .md file in the output directory
  const files = readdirSync(outDir).filter((f) =>
    f.toLowerCase().endsWith('.md')
  );

  for (const file of files) {
    const filePath = join(outDir, file);
    let content = readFileSync(filePath, 'utf-8');

    // Find the original path for this file (to resolve relative links)
    const currentFlatName = file.replace(/\.md$/i, '');
    let currentOrigPath: string | undefined;
    for (const [orig, flat] of fileMapping) {
      if (flat === currentFlatName) {
        currentOrigPath = orig;
        break;
      }
    }

    // Rewrite markdown links: [text](target) and [text](target#anchor)
    // Skip links inside fenced code blocks
    content = rewriteLinksOutsideCodeBlocks(
      content,
      (match, text: string, href: string) => {
        const rewritten = rewriteLink(
          href,
          currentOrigPath,
          lookupByOriginal,
          lookupByOriginalNoExt
        );
        if (rewritten !== null) {
          return `[${text}](${rewritten})`;
        }
        return match;
      }
    );

    writeFileSync(filePath, content, 'utf-8');
  }
}

/**
 * Generates `_Sidebar.md` content with section headers, separators between
 * top-level groups, and indented links for nested pages. All links use flat
 * base filenames.
 */
export function generateSidebar(
  pageTree: PageTreeNode[],
  fileMapping: Map<string, string>
): string {
  const lines: string[] = [];

  for (let i = 0; i < pageTree.length; i++) {
    const node = pageTree[i];

    if (i > 0) {
      lines.push('');
      lines.push('---');
      lines.push('');
    }

    if (node.children && node.children.length > 0) {
      // This is a section with children — use section header
      const flatName = resolveNodeFlatName(node, fileMapping);
      if (flatName) {
        lines.push(`### [${node.title}](${flatName})`);
      } else {
        lines.push(`### ${node.title}`);
      }

      // Add children as indented links
      renderSidebarChildren(node.children, fileMapping, lines, 0);
    } else {
      // Leaf node at top level — just a link
      const flatName = resolveNodeFlatName(node, fileMapping);
      if (flatName) {
        lines.push(`[${node.title}](${flatName})`);
      } else {
        lines.push(node.title);
      }
    }
  }

  return `${lines.join('\n')}\n`;
}

/**
 * Generates `Home.md` content from the root `index.md` or first overview page.
 * Links are rewritten and a "Generated by Industry" footer is appended.
 */
export function generateHomePage(
  wikiDir: string,
  fileMapping: Map<string, string>
): string {
  // Try to find root index.md
  let content = '';
  const rootIndex = join(wikiDir, 'index.md');

  if (existsSync(rootIndex)) {
    content = readFileSync(rootIndex, 'utf-8');
  } else {
    // Try overview/index.md
    const overviewIndex = join(wikiDir, 'overview', 'index.md');
    if (existsSync(overviewIndex)) {
      content = readFileSync(overviewIndex, 'utf-8');
    } else {
      // Find first .md file as fallback
      const files = readdirSync(wikiDir)
        .filter((f) => f.endsWith('.md'))
        .sort();
      if (files.length > 0) {
        content = readFileSync(join(wikiDir, files[0]), 'utf-8');
      }
    }
  }

  // Build reverse lookup for link rewriting
  const lookupByOriginal = new Map<string, string>();
  const lookupByOriginalNoExt = new Map<string, string>();
  for (const [origPath, flatName] of fileMapping) {
    lookupByOriginal.set(origPath, flatName);
    const noExt = origPath.replace(/\.md$/i, '');
    lookupByOriginalNoExt.set(noExt, flatName);
  }

  // Determine the original path of the home page source for relative link resolution
  let homeOrigPath: string | undefined;
  if (existsSync(rootIndex)) {
    homeOrigPath = 'index.md';
  } else {
    const overviewIndex = join(wikiDir, 'overview', 'index.md');
    if (existsSync(overviewIndex)) {
      homeOrigPath = 'overview/index.md';
    }
  }

  // Rewrite internal links in content (skip links inside fenced code blocks)
  content = rewriteLinksOutsideCodeBlocks(
    content,
    (match, text: string, href: string) => {
      const rewritten = rewriteLink(
        href,
        homeOrigPath,
        lookupByOriginal,
        lookupByOriginalNoExt
      );
      if (rewritten !== null) {
        return `[${text}](${rewritten})`;
      }
      return match;
    }
  );

  // Append footer
  const footer = '\n\n---\n\n_Generated by [Industry](https://example.com)_\n';

  return content.trimEnd() + footer;
}

/**
 * Orchestrates the full GitHub wiki sync pipeline:
 * 1. Create temp directory
 * 2. Flatten wiki files
 * 3. Rewrite internal links
 * 4. Generate _Sidebar.md
 * 5. Generate Home.md
 * 6. Clone .wiki.git
 * 7. Replace content
 * 8. Commit & force push
 *
 * Returns { success: boolean, error?: string }.
 */
export async function syncToGitHubWiki(options: {
  wikiDir: string;
  repoUrl: string;
  pageTree: PageTreeNode[];
}): Promise<{ success: boolean; error?: string }> {
  const { wikiDir, repoUrl, pageTree } = options;

  // Create temp directories
  const tmpBase = join(
    tmpdir(),
    `wiki-sync-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  const flatDir = join(tmpBase, 'flat');
  const cloneDir = join(tmpBase, 'clone');

  try {
    mkdirSync(tmpBase, { recursive: true });

    // Step 1: Flatten wiki files
    writeStdout('Flattening wiki files...');
    const fileMapping = flattenWikiFiles(wikiDir, flatDir);
    writeStdout(`Flattened ${fileMapping.size} files`);

    // Step 2: Rewrite internal links
    writeStdout('Rewriting internal links...');
    rewriteInternalLinks(flatDir, fileMapping);

    // Step 3: Generate _Sidebar.md
    writeStdout('Generating sidebar...');
    const sidebarContent = generateSidebar(pageTree, fileMapping);
    writeFileSync(join(flatDir, '_Sidebar.md'), sidebarContent, 'utf-8');

    // Step 4: Generate Home.md
    writeStdout('Generating home page...');
    const homeContent = generateHomePage(wikiDir, fileMapping);
    writeFileSync(join(flatDir, 'Home.md'), homeContent, 'utf-8');

    // Step 5: Derive wiki git URL
    const wikiGitUrl = deriveWikiGitUrl(repoUrl);
    if (!wikiGitUrl) {
      return {
        success: false,
        error: `Unable to derive wiki URL from: ${repoUrl}`,
      };
    }

    // Step 6: Clone wiki repo
    writeStdout(`Cloning wiki from ${wikiGitUrl}...`);
    await execFileAsync('git', ['clone', wikiGitUrl, cloneDir], {
      timeout: 30_000,
    });

    // Step 7: Replace content — remove all existing files except .git
    const cloneEntries = readdirSync(cloneDir);
    for (const entry of cloneEntries) {
      if (entry === '.git') continue;
      rmSync(join(cloneDir, entry), { recursive: true, force: true });
    }

    // Copy all flat files into the clone
    const flatFiles = readdirSync(flatDir);
    for (const file of flatFiles) {
      copyFileSync(join(flatDir, file), join(cloneDir, file));
    }

    // Step 8: Commit and force push
    writeStdout('Pushing to GitHub wiki...');
    await execFileAsync('git', ['add', '-A'], { cwd: cloneDir });
    await execFileAsync(
      'git',
      ['commit', '-m', 'Update wiki (synced by Industry)', '--allow-empty'],
      { cwd: cloneDir }
    );
    await execFileAsync('git', ['push', '--force'], { cwd: cloneDir });

    // Derive the wiki browser URL
    const wikiUrl = deriveWikiBrowserUrl(repoUrl);
    writeStdout(`Successfully synced wiki to ${wikiUrl}`);

    return { success: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    writeStderr(`GitHub wiki sync failed: ${message}`);
    return { success: false, error: message };
  } finally {
    // Clean up temp directory
    try {
      rmSync(tmpBase, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  }
}
