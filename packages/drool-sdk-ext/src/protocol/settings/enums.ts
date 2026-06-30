/**
 * Settings hierarchy level enum.
 * Precedence order (highest to lowest): Org -> Runtime -> Folder -> Project -> User
 */
export enum SettingsLevel {
  Org = 'org',
  Runtime = 'runtime',
  User = 'user',
  Project = 'project',
  Folder = 'folder',
  Dynamic = 'dynamic',
  BuiltIn = 'builtin',
}

export enum DroolLocation {
  Project = 'project',
  Personal = 'personal',
}

export enum SkillLocation {
  Project = 'project',
  Personal = 'personal',
  Builtin = 'builtin',
}

export enum SandboxMode {
  PerCommand = 'per-command',
  WholeProcess = 'whole-process',
}
