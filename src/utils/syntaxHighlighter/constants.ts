// eslint-disable-next-line industry/constants-file-organization
import { getThemeEngine } from '@/theme/ThemeEngine';
import { SyntaxHighlighterConfig } from '@/utils/syntaxHighlighter/types';

// Default syntax config - theme will be overridden at runtime by getDefaultSyntaxConfig()
export const defaultSyntaxConfig: SyntaxHighlighterConfig = {
  theme: 'dark',
  showLineNumbers: false,
  tabSize: 2,
};
// Language aliases and mappings for better detection
export const LANGUAGE_ALIASES: Record<string, string> = {
  js: 'javascript',
  ts: 'typescript',
  jsx: 'javascript',
  tsx: 'typescript',
  py: 'python',
  rb: 'ruby',
  sh: 'bash',
  yml: 'yaml',
  md: 'markdown',
  json: 'json',
  html: 'xml',
  htm: 'xml',
  'c++': 'cpp',
  'c#': 'csharp',
  cs: 'csharp',
  rs: 'rust',
  go: 'go',
  java: 'java',
  php: 'php',
  sql: 'sql',
  r: 'r',
  swift: 'swift',
  kotlin: 'kotlin',
  dart: 'dart',
  scala: 'scala',
  clojure: 'clojure',
  elixir: 'elixir',
  erlang: 'erlang',
  haskell: 'haskell',
  ocaml: 'ocaml',
  'f#': 'fsharp',
  perl: 'perl',
  lua: 'lua',
  vim: 'vim',
  dockerfile: 'dockerfile',
  makefile: 'makefile',
  cmake: 'cmake',
  nginx: 'nginx',
  apache: 'apache',
  ini: 'ini',
  toml: 'ini',
  cfg: 'ini',
  conf: 'apache',
  diff: 'diff',
  patch: 'diff',
  tex: 'latex',
  latex: 'latex',
  xml: 'xml',
  xhtml: 'xml',
  svg: 'xml',
  css: 'css',
  scss: 'scss',
  sass: 'scss',
  less: 'less',
  stylus: 'stylus',
} as const;
const getSyntaxColors = (): Record<string, string> =>
  getThemeEngine().getSyntaxColors();

/**
 * Syntax color mapping – always sourced from the ThemeEngine.
 */
export const SYNTAX_COLORS: Record<string, string> = new Proxy(
  {} as Record<string, string>,
  {
    get(_target, prop: string) {
      return getSyntaxColors()[prop] ?? 'white';
    },
    ownKeys() {
      return Object.keys(getSyntaxColors());
    },
    getOwnPropertyDescriptor(_target, prop: string) {
      const colors = getSyntaxColors();
      if (prop in colors) {
        return { configurable: true, enumerable: true, value: colors[prop] };
      }
      return undefined;
    },
  }
);
