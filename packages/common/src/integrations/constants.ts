import { IntegrationType } from './enums';

export const IntegrationTitles: Record<IntegrationType, string> = {
  [IntegrationType.GITHUB]: 'GitHub',
  [IntegrationType.GITHUB_ES]: 'GitHub Enterprise',
  [IntegrationType.GITHUB_PERSONAL]: 'GitHub',
  [IntegrationType.GITLAB]: 'GitLab',
  [IntegrationType.GITLAB_SH]: 'GitLab Self-Hosted',
  [IntegrationType.GITLAB_PERSONAL]: 'GitLab',
  [IntegrationType.SLACK]: 'Slack',
  [IntegrationType.LINEAR]: 'Linear',
  [IntegrationType.JIRA]: 'Jira',
  [IntegrationType.CONFLUENCE]: 'Confluence',
  [IntegrationType.GOOGLE_DOCS]: 'Google Docs',
  [IntegrationType.WEB_PAGE]: 'Web Page',
  [IntegrationType.NOTION]: 'Notion',
  [IntegrationType.FIGMA]: 'Figma',
  [IntegrationType.SENTRY]: 'Sentry',
  [IntegrationType.PAGERDUTY]: 'PagerDuty',
};

export const USER_LEVEL_INTEGRATIONS: IntegrationType[] = [
  IntegrationType.GITHUB_PERSONAL,
  IntegrationType.GITLAB_PERSONAL,
  IntegrationType.NOTION,
  IntegrationType.FIGMA,
  IntegrationType.GOOGLE_DOCS,
];
