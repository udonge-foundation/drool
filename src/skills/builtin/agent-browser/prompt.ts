import agentBrowserSkillContent from '../../../../builtin-skills/agent-browser/SKILL.md' with { type: 'text' };

export const AGENT_BROWSER_BASE_PROMPT = agentBrowserSkillContent
  .replace(/^---[\s\S]*?---\s*/, '')
  .trim();
