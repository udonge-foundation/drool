export const PATCH_START_MARKER = '*** Begin Patch\n';
export const PATCH_END_MARKER = '\n*** End Patch';
export const UPDATE_FILE_MARKER = '*** Update File: ';
export const ADD_FILE_MARKER = '*** Add File: ';
export const END_OF_FILE_MARKER = '*** End of File';
export const LINE_ADDITION_PREFIX = '+';
export const LINE_DELETION_PREFIX = '-';
export const CONTEXT_LINE_PREFIX = ' ';

export const MAX_OLD_STR_MATCH_ERRORS = 50;

/**
 * Default threshold for truncating large tool outputs.
 * Tool outputs exceeding this size will be truncated and/or persisted to disk.
 */
export const DEFAULT_OUTPUT_TRUNCATION_THRESHOLD = 40000;

export const TASK_OUTPUT_TRUNCATION_THRESHOLD = 100000;

/**
 * Comprehensive mapping of file extensions to programming languages.
 * Used for language detection in file tools and telemetry.
 */
export const LANGUAGE_EXTENSIONS: Record<string, string> = {
  // JavaScript/TypeScript
  ts: 'typescript',
  tsx: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  // Python
  py: 'python',
  pyx: 'python',
  pyi: 'python',
  // Systems
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  hpp: 'cpp',
  cc: 'cpp',
  cxx: 'cpp',
  rs: 'rust',
  go: 'go',
  // JVM
  java: 'java',
  kt: 'kotlin',
  kts: 'kotlin',
  scala: 'scala',
  // .NET
  cs: 'csharp',
  fs: 'fsharp',
  vb: 'vb',
  // Web
  html: 'html',
  htm: 'html',
  css: 'css',
  scss: 'scss',
  sass: 'sass',
  less: 'less',
  vue: 'vue',
  svelte: 'svelte',
  // Data/Config
  json: 'json',
  yaml: 'yaml',
  yml: 'yaml',
  toml: 'toml',
  xml: 'xml',
  // Shell
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  fish: 'shell',
  ps1: 'powershell',
  // Legacy
  cob: 'cobol',
  cbl: 'cobol',
  cpy: 'cobol',
  f: 'fortran',
  f90: 'fortran',
  f95: 'fortran',
  for: 'fortran',
  // Other
  rb: 'ruby',
  php: 'php',
  swift: 'swift',
  m: 'objective-c',
  mm: 'objective-c',
  pl: 'perl',
  pm: 'perl',
  r: 'r',
  R: 'r',
  dart: 'dart',
  lua: 'lua',
  ex: 'elixir',
  exs: 'elixir',
  erl: 'erlang',
  hrl: 'erlang',
  hs: 'haskell',
  ml: 'ocaml',
  mli: 'ocaml',
  clj: 'clojure',
  cljs: 'clojure',
  tf: 'terraform',
  hcl: 'terraform',
  sol: 'solidity',
  sql: 'sql',
  md: 'markdown',
  proto: 'protobuf',
  graphql: 'graphql',
  gql: 'graphql',
  // Assembly/Mainframe
  asm: 'assembly',
  s: 'assembly',
  // Legacy
  pas: 'pascal',
  ada: 'ada',
  adb: 'ada',
  ads: 'ada',
  // JVM ecosystem
  groovy: 'groovy',
  gradle: 'groovy',
  // Mainframe
  jcl: 'jcl',
};
