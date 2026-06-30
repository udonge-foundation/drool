import { mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const packageJson = JSON.parse(
  readFileSync(join(rootDir, 'package.json'), 'utf8')
);

const defaultOutDir = join(rootDir, 'dist', 'bin');
const version = packageJson.version ?? '0.0.0';
const bunExecutable = process.env.BUN_EXECUTABLE ?? 'bun';
const compileExecutablePath = process.env.BUN_COMPILE_EXECUTABLE_PATH;

function defineString(name, value) {
  return `${name}=${JSON.stringify(value)}`;
}

const targets = [
  {
    name: 'win32-x64',
    bunTarget: 'bun-windows-x64',
    outfile: 'drool-win32-x64.exe',
    extraArgs: [
      '--windows-title',
      'Drool',
      '--windows-description',
      'Drool CLI',
      '--windows-version',
      `${version}.0`,
    ],
  },
  {
    name: 'linux-x64',
    bunTarget: 'bun-linux-x64',
    outfile: 'drool-linux-x64',
    extraArgs: [],
  },
  {
    name: 'darwin-arm64',
    bunTarget: 'bun-darwin-arm64',
    outfile: 'drool-darwin-arm64',
    extraArgs: [],
  },
];

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const release = args.includes('--release');
const environment = release ? 'production' : 'development';
const outDirArg = args.find((arg) => arg.startsWith('--outdir='));
const outDir = outDirArg ? outDirArg.slice('--outdir='.length) : defaultOutDir;
const requestedTargets = args
  .filter((arg) => !arg.startsWith('--') && arg.trim())
  .map((arg) => arg.toLowerCase());

const selectedTargets = requestedTargets.length
  ? targets.filter((target) => requestedTargets.includes(target.name))
  : targets;

const unknownTargets = requestedTargets.filter(
  (name) => !targets.some((target) => target.name === name)
);

if (unknownTargets.length > 0) {
  console.error(`Unknown target(s): ${unknownTargets.join(', ')}`);
  console.error(`Supported targets: ${targets.map((target) => target.name).join(', ')}`);
  process.exit(1);
}

mkdirSync(outDir, { recursive: true });

for (const target of selectedTargets) {
  const outfile = join(outDir, target.outfile);
  const buildArgs = [
    'build',
    join(rootDir, 'src', 'index.ts'),
    '--compile',
    ...(compileExecutablePath
      ? ['--compile-executable-path', compileExecutablePath]
      : []),
    '--external',
    'keytar',
    '--target',
    target.bunTarget,
    '--outfile',
    outfile,
    '--define',
    defineString('process.env.CLI_VERSION', version),
    '--define',
    defineString('__INDUSTRY_ENV__', environment),
    '--define',
    defineString('__INDUSTRY_DEPLOYMENT_ENV__', environment),
    '--define',
    defineString('__INDUSTRY_API_BASE_URL__', 'https://api.example.com'),
    '--define',
    defineString('__INDUSTRY_API_BASE_URL_EU__', 'https://api.eu.example.com'),
    '--define',
    defineString('__INDUSTRY_APP_BASE_URL__', 'https://app.example.com'),
    '--define',
    defineString('__INDUSTRY_DOWNLOADS_BUCKET__', 'downloads.example.com'),
    '--define',
    defineString('__INDUSTRY_DOWNLOADS_PREFIX__', ''),
    '--define',
    defineString('process.env.INDUSTRY_ENV', environment),
    '--define',
    '__INDUSTRY_AUTO_UPDATE_ENABLED__=false',
    '--define',
    '__INDUSTRY_AIRGAP_ENABLED__=true',
    ...(release
      ? [
          '--define',
          defineString('process.env.NODE_ENV', 'production'),
          '--production',
          '--minify',
          '--no-compile-autoload-dotenv',
          '--no-compile-autoload-bunfig',
          '--no-compile-autoload-tsconfig',
          '--no-compile-autoload-package-json',
        ]
      : []),
    ...target.extraArgs,
  ];

  console.log(`\nBuilding ${target.name} -> ${outfile}`);
  console.log(`${bunExecutable} ${buildArgs.map((arg) => JSON.stringify(arg)).join(' ')}`);

  if (dryRun) {
    continue;
  }

  const result = spawnSync(bunExecutable, buildArgs, {
    cwd: rootDir,
    stdio: 'inherit',
    shell: false,
  });

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

if (release) {
  for (const entry of readdirSync(outDir)) {
    if (entry.endsWith('.map')) {
      rmSync(join(outDir, entry), { force: true });
    }
  }
}
