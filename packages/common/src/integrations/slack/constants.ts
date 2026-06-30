/**
 * Canonical incident-response instructions for Slack-triggered sessions.
 *
 * Shared by the Automations UI (prefilled prompt for the Incident Response
 * template) and the backend's legacy auto-run base prompt, which appends a
 * surface-specific AskUser line. Keep this limited to the incident-skill
 * core: automation-scoped runs already get AskUser guidance, repository
 * discovery, and admin-prompt precedence injected by the backend.
 */
export const SLACK_INCIDENT_RESPONSE_PROMPT = [
  'Use the `/incident` skill for Slack incidents and run an RCA if applicable.',
  'If the thread message is an incident or asking for RCA/root-cause analysis, invoke the `incident` skill before investigating.',
].join('\n');
