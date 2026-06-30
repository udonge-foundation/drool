/**
 * Mapping from slash command names to their i18n description keys.
 * Used to resolve localized descriptions at display time.
 */

import { getI18n } from '@/i18n/index';

/** Maps command names to their i18n key in the commands namespace */
const COMMAND_DESCRIPTION_KEYS: Record<string, string> = {
  account: 'commands:descriptions.account',
  automations: 'commands:descriptions.automations',
  billing: 'commands:descriptions.billing',
  bug: 'commands:descriptions.bug',
  clear: 'commands:descriptions.clear',
  commands: 'commands:descriptions.commandsManager',
  compress: 'commands:descriptions.compact',
  context: 'commands:descriptions.context',
  copy: 'commands:descriptions.copy',
  cost: 'commands:descriptions.cost',
  'create-skill': 'commands:descriptions.createSkill',
  cwd: 'commands:descriptions.cwd',
  diagnostics: 'commands:descriptions.diagnostics',
  drools: 'commands:descriptions.drools',
  fast: 'commands:descriptions.fast',
  favorite: 'commands:descriptions.favorite',
  fork: 'commands:descriptions.fork',
  pin: 'commands:descriptions.pin',
  'git-ai': 'commands:descriptions.gitAi',
  help: 'commands:descriptions.help',
  hooks: 'commands:descriptions.hooks',
  ide: 'commands:descriptions.ide',
  'install-slack-app': 'commands:descriptions.installSlackApp',
  language: 'commands:descriptions.language',
  limits: 'commands:descriptions.limits',
  login: 'commands:descriptions.login',
  logout: 'commands:descriptions.logout',
  loop: 'commands:descriptions.loop',
  mcp: 'commands:descriptions.mcp',
  missions: 'commands:descriptions.missions',
  model: 'commands:descriptions.model',
  new: 'commands:descriptions.new',
  plugins: 'commands:descriptions.plugins',
  quit: 'commands:descriptions.quit',
  'readiness-fix': 'commands:descriptions.readinessFix',
  'readiness-report': 'commands:descriptions.readinessReport',
  rename: 'commands:descriptions.rename',
  review: 'commands:descriptions.review',
  'rewind-conversation': 'commands:descriptions.rewind',
  sessions: 'commands:descriptions.sessions',
  settings: 'commands:descriptions.settings',
  'setup-incident-response': 'commands:descriptions.setupIncidentResponse',
  share: 'commands:descriptions.share',
  skills: 'commands:descriptions.skills',
  stats: 'commands:descriptions.stats',
  status: 'commands:descriptions.status',
  statusline: 'commands:descriptions.statusline',
  'terminal-setup': 'commands:descriptions.terminalSetup',
  update: 'commands:descriptions.update',
  wrapped: 'commands:descriptions.wrapped',
};

/**
 * Get the localized description for a slash command.
 * Falls back to the command's original English description if no i18n key is mapped.
 */
export function getLocalizedCommandDescription(
  commandName: string,
  fallbackDescription: string
): string {
  const key = COMMAND_DESCRIPTION_KEYS[commandName.toLowerCase()];
  if (!key) {
    return fallbackDescription;
  }

  try {
    const t = getI18n().t.bind(getI18n());
    return t(key);
  } catch {
    // i18n not initialized yet, fall back to English
    return fallbackDescription;
  }
}
