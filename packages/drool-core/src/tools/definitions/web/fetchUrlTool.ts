import {
  ToolExecutionLocation,
  TOOL_LLM_ID_FETCH_URL,
} from '@industry/drool-sdk-ext/protocol/tools';

import { FetchUrlToolResultSchema, fetchUrlToolSchema } from './schema';
import { createTool } from '../../create-tool';
import { SandboxSideEffect, Toolkit, ToolUIGroupId } from '../../enums';

export const fetchUrlTool = createTool({
  id: 'fetch_url',
  llmId: TOOL_LLM_ID_FETCH_URL,
  uiGroupId: ToolUIGroupId.FetchUrl,
  displayName: 'Web Fetch',
  description: `Scrapes content from URLs that the user provided, and returns the contents in markdown format. This tool supports both generic webpages and specific integration URLs.

CRITICAL: BEFORE CALLING THIS TOOL, CHECK IF THE URL WILL FAIL

URLs THAT WILL ALWAYS FAIL - DO NOT ATTEMPT TO FETCH:

1. LOCAL/PRIVATE NETWORK URLs:
   - http://localhost:* (any port)
   - http://127.0.0.1:* or http://[::1]:*
   - http://0.0.0.0:*
   - http://10.*.*.* (private network)
   - http://172.16-31.*.* (private network)
   - http://192.168.*.* (private network)
   - http://169.254.*.* (link-local)
   - *.local, *.internal domains
   - http://*.lvh.me:* (localhost aliases)

2. NON-HTTP PROTOCOLS:
   - file:/// (local file system)
   - ssh://, ftp://, powershell://
   - view-source: (browser-specific)

3. CORPORATE/INTERNAL INFRASTRUCTURE:
   - *.corp.{company}.com (corporate networks)
   - Internal staging/production systems (e.g., productioncore.clari.io, gateway-staging.clari.com)
   - Internal dashboards (e.g., goldilocks.*.clari.io)
   - Private Git servers (e.g., git.corp.adobe.com, code.byted.org)
   - Custom ports on private domains (e.g., hisglobal.net:2226)

4. INVALID/BROKEN URL PATTERNS:
   - GitHub pull/new/* (these are creation URLs, not viewable content)
   - URLs with session tokens or temporary parameters
   - Malformed URLs with invalid characters
   - API endpoints expecting POST/PUT/DELETE requests

VALIDATION CHECKLIST - Only proceed if ALL are true:
- URL uses http:// or https:// protocol
- URL doesn't contain localhost, 127.0.0.1, or private IP ranges
- URL was explicitly provided by the user

SUPPORTED INTEGRATION URLS (requires setup at https://app.example.com/settings/integrations):
- Google Docs: docs.google.com/document/d/{doc-id}
- Notion Pages: notion.so/{workspace}/{page-id}
- Linear Issues: linear.app/{workspace}/issue/{id}
- GitHub Pull Requests: github.com/{owner}/{repo}/pull/{number}
- GitHub Issues: github.com/{owner}/{repo}/issues/{number}
- GitHub Workflow Runs: github.com/{owner}/{repo}/actions/runs/{id}
- Sentry Issues: {org}.sentry.io/issues/{id}
- GitLab Merge Requests: gitlab.com/{group}/{project}/-/merge_requests/{number}
- Jira Tickets: {instance}.atlassian.net/browse/{key} or custom Jira domains
- PagerDuty Incidents: {subdomain}.pagerduty.com/incidents/{id}
- Slack Thread URLs: {workspace}.slack.com/archives/{channel}/p{timestamp}

PERFORMANCE TIP: When the user provides multiple URLs, make parallel FetchUrl calls in a single response.

NOTE: For Industry wiki URLs (app.example.com/wiki/...), use the browse-wiki skill instead of this tool.

DO NOT use this tool for:
- URLs not explicitly provided by the user
- Web searching (use web_search tool instead)
- Any URL matching the failure patterns above`,
  executionLocation: ToolExecutionLocation.Server,
  inputSchema: fetchUrlToolSchema,
  isVisibleToUser: true,
  isTopLevelTool: true,
  requiresConfirmation: false,
  sideEffects: [SandboxSideEffect.Network],
  outputSchemas: {
    result: FetchUrlToolResultSchema,
  },
  toolkit: Toolkit.WebSearch,
  isToolEnabled: true,
});
