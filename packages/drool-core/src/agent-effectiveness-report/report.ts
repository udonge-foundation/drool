import type {
  AgentEffectivenessCodingUsageRow,
  AgentEffectivenessDailyUsageRows,
  AgentEffectivenessHtmlReportRenderOptions,
  AgentEffectivenessTokenEfficiencyTrendPoint,
  AgentEffectivenessMetrics,
  AgentEffectivenessOrganizationTotalUsage,
  AgentEffectivenessPullRequest,
  AgentEffectivenessUserReportRow,
  AgentEffectivenessWorkItem,
  ResolvedAgentEffectivenessReportRequest,
} from './types';

const MS_PER_DAY = 86_400_000;

function emailKey(email?: string | null): string {
  return email?.trim().toLowerCase() || 'unmapped';
}

function normalizedEmail(email?: string | null): string | undefined {
  const normalized = email?.trim().toLowerCase();
  return normalized && normalized.includes('@') ? normalized : undefined;
}

function isGithubNoreplyEmail(email: string): boolean {
  return email.endsWith('@users.noreply.github.com');
}

function githubLoginFromNoreplyEmail(email: string): string | undefined {
  const match = email.match(
    /^(?:(?:\d+)\+)?([^@]+)@users\.noreply\.github\.com$/
  );
  return match?.[1];
}

function normalizeIdentityAliases(
  aliases?: Record<string, string>
): Record<string, string> {
  if (!aliases) {
    return {};
  }
  const normalized: Record<string, string> = {};
  for (const [alias, canonical] of Object.entries(aliases)) {
    const aliasKey = normalizedEmail(alias);
    const canonicalValue = normalizedEmail(canonical);
    if (aliasKey && canonicalValue) {
      normalized[aliasKey] = canonicalValue;
    }
  }
  return normalized;
}

function canonicalizeEmail(
  email: string | null | undefined,
  aliases: Record<string, string>
): string | undefined {
  const normalized = normalizedEmail(email);
  if (!normalized) {
    return undefined;
  }
  return aliases[normalized] ?? normalized;
}

function canonicalizeUsageRow(
  row: AgentEffectivenessCodingUsageRow,
  aliases: Record<string, string>
): AgentEffectivenessCodingUsageRow {
  const canonical = canonicalizeEmail(row.userEmail, aliases);
  if (!canonical || canonical === row.userEmail) {
    return row;
  }
  return { ...row, userEmail: canonical };
}

function canonicalizeWorkItem(
  item: AgentEffectivenessWorkItem,
  aliases: Record<string, string>
): AgentEffectivenessWorkItem {
  const canonical = canonicalizeEmail(item.assigneeEmail, aliases);
  if (!canonical || canonical === item.assigneeEmail) {
    return item;
  }
  return { ...item, assigneeEmail: canonical };
}

function canonicalizePullRequest(
  pr: AgentEffectivenessPullRequest,
  aliases: Record<string, string>
): AgentEffectivenessPullRequest {
  const canonicalAuthor = canonicalizeEmail(pr.authorEmail, aliases);
  const canonicalAuthors = pr.authorEmails?.map(
    (email) => canonicalizeEmail(email, aliases) ?? email
  );
  const authorChanged =
    canonicalAuthor !== undefined && canonicalAuthor !== pr.authorEmail;
  const authorsChanged =
    canonicalAuthors !== undefined &&
    canonicalAuthors.some((email, idx) => email !== pr.authorEmails?.[idx]);
  if (!authorChanged && !authorsChanged) {
    return pr;
  }
  return {
    ...pr,
    ...(authorChanged ? { authorEmail: canonicalAuthor } : {}),
    ...(authorsChanged ? { authorEmails: canonicalAuthors } : {}),
  };
}

function aggregateUsageRowsByCanonicalEmail(
  rows: AgentEffectivenessCodingUsageRow[]
): AgentEffectivenessCodingUsageRow[] {
  const byKey = new Map<string, AgentEffectivenessCodingUsageRow>();
  const ordering: string[] = [];
  for (const row of rows) {
    const key = emailKey(row.userEmail);
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, { ...row });
      ordering.push(key);
      continue;
    }
    byKey.set(key, {
      ...existing,
      userId: existing.userId || row.userId,
      userEmail: existing.userEmail ?? row.userEmail,
      sessions: existing.sessions + row.sessions,
      billingEvents: existing.billingEvents + row.billingEvents,
      billableTokens: existing.billableTokens + row.billableTokens,
      droolCommits: existing.droolCommits + row.droolCommits,
      droolPrsCreated: existing.droolPrsCreated + row.droolPrsCreated,
      toolCalls: existing.toolCalls + row.toolCalls,
      skillCalls: existing.skillCalls + row.skillCalls,
      fileOperations: existing.fileOperations + row.fileOperations,
    });
  }
  return ordering.map(
    (key) => byKey.get(key) as AgentEffectivenessCodingUsageRow
  );
}

function identityKey(value?: string | null): string {
  return (value || '')
    .trim()
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function emailLocalPart(email: string): string {
  return email.split('@')[0] || '';
}

function compactIdentity(value?: string | null): string {
  return identityKey(value).replace(/\s+/g, '');
}

function uniqueMapValue<T>(map: Map<string, T | null>, key: string): T | null {
  return map.get(key) ?? null;
}

function safeDivide(numerator: number, denominator: number): number | null {
  if (
    !Number.isFinite(numerator) ||
    !Number.isFinite(denominator) ||
    denominator <= 0
  ) {
    return null;
  }

  return numerator / denominator;
}

function round(value: number | null, digits = 2): number | null {
  if (value === null || !Number.isFinite(value)) {
    return null;
  }

  const multiplier = 10 ** digits;
  return Math.round(value * multiplier) / multiplier;
}

function sumBy<T>(items: T[], fn: (item: T) => number): number {
  return items.reduce((total, item) => total + fn(item), 0);
}

function parseIsoDateToUtc(value?: string | null): number | null {
  const match = value?.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) {
    return null;
  }

  const [, year, month, day] = match;
  return Date.UTC(Number(year), Number(month) - 1, Number(day));
}

function formatIsoDateFromUtc(value: number): string {
  return new Date(value).toISOString().slice(0, 10);
}

function isoDateFromTimestamp(value?: string | null): string | undefined {
  if (!value) {
    return undefined;
  }

  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp)
    ? formatIsoDateFromUtc(timestamp)
    : undefined;
}

function eachIsoDate(startDate: string, endDate: string): string[] {
  const start = parseIsoDateToUtc(startDate);
  const end = parseIsoDateToUtc(endDate);
  if (start === null || end === null || end < start) {
    return [];
  }

  const dates: string[] = [];
  for (let current = start; current <= end; current += MS_PER_DAY) {
    dates.push(formatIsoDateFromUtc(current));
  }
  return dates;
}

function groupByEmail<T>(
  items: T[],
  getEmail: (item: T) => string | null | undefined
): Map<string, T[]> {
  const grouped = new Map<string, T[]>();

  for (const item of items) {
    const key = emailKey(getEmail(item));
    const existing = grouped.get(key) || [];
    existing.push(item);
    grouped.set(key, existing);
  }

  return grouped;
}

function setUniqueMapping(
  map: Map<string, string | null>,
  key: string,
  email: string
): void {
  if (!key) {
    return;
  }

  const existing = map.get(key);
  if (existing && existing !== email) {
    map.set(key, null);
    return;
  }

  if (existing === undefined) {
    map.set(key, email);
  }
}

function buildAssigneeEmailResolver(
  knownEmails: string[]
): (item: AgentEffectivenessWorkItem) => string | undefined {
  const byLocal = new Map<string, string | null>();
  const byCompactLocal = new Map<string, string | null>();
  const byFirstName = new Map<string, string | null>();

  for (const rawEmail of knownEmails) {
    const email = emailKey(rawEmail);
    const localPart = emailLocalPart(email);
    const localKey = identityKey(localPart);
    setUniqueMapping(byLocal, localKey, email);
    setUniqueMapping(byCompactLocal, compactIdentity(localPart), email);
    setUniqueMapping(byFirstName, localKey.split(' ')[0] || '', email);
  }

  return (item) => {
    if (item.assigneeEmail) {
      return emailKey(item.assigneeEmail);
    }

    const assigneeName = item.assigneeName || '';
    const nameKey = identityKey(assigneeName);
    const compactNameKey = compactIdentity(assigneeName);
    const firstNameKey = nameKey.split(' ')[0] || '';

    return (
      uniqueMapValue(byLocal, nameKey) ||
      uniqueMapValue(byCompactLocal, compactNameKey) ||
      uniqueMapValue(byFirstName, firstNameKey) ||
      undefined
    );
  };
}

function buildPullRequestEmailResolver(
  knownEmails: string[],
  workItems: AgentEffectivenessWorkItem[]
): (pr: AgentEffectivenessPullRequest) => AgentEffectivenessPullRequest {
  const knownEmailSet = new Set(
    knownEmails.map(normalizedEmail).filter((email) => email !== undefined)
  );
  const byLocal = new Map<string, string | null>();
  const byCompactLocal = new Map<string, string | null>();
  const byName = new Map<string, string | null>();
  const workItemAssigneeById = new Map<string, string>();

  for (const rawEmail of knownEmailSet) {
    const localPart = emailLocalPart(rawEmail);
    setUniqueMapping(byLocal, identityKey(localPart), rawEmail);
    setUniqueMapping(byCompactLocal, compactIdentity(localPart), rawEmail);
  }

  for (const item of workItems) {
    const assigneeEmail = normalizedEmail(item.assigneeEmail);
    if (!assigneeEmail) {
      continue;
    }

    workItemAssigneeById.set(item.id, assigneeEmail);

    if (item.assigneeName) {
      setUniqueMapping(byName, identityKey(item.assigneeName), assigneeEmail);
      setUniqueMapping(
        byName,
        compactIdentity(item.assigneeName),
        assigneeEmail
      );
    }
  }

  const resolveIdentity = (identity?: string | null): string | undefined =>
    identity
      ? uniqueMapValue(byLocal, identityKey(identity)) ||
        uniqueMapValue(byCompactLocal, compactIdentity(identity)) ||
        uniqueMapValue(byName, identityKey(identity)) ||
        uniqueMapValue(byName, compactIdentity(identity)) ||
        undefined
      : undefined;

  const resolveLinkedWorkItemAssignee = (
    pr: AgentEffectivenessPullRequest
  ): string | undefined => {
    const linkedAssigneeEmails = new Set(
      pr.linkedWorkItemIds
        .map((id) => workItemAssigneeById.get(id))
        .filter((email) => email !== undefined)
    );

    return linkedAssigneeEmails.size === 1
      ? [...linkedAssigneeEmails][0]
      : undefined;
  };

  return (pr) => {
    const authorEmails = [pr.authorEmail, ...(pr.authorEmails ?? [])].flatMap(
      (email) => {
        const normalized = normalizedEmail(email);
        return normalized ? [normalized] : [];
      }
    );
    const exactKnownEmail = authorEmails.find(
      (email) => knownEmailSet.has(email) && !isGithubNoreplyEmail(email)
    );
    const githubLogin =
      pr.authorLogin ||
      authorEmails.map(githubLoginFromNoreplyEmail).find(Boolean);
    const resolvedEmail =
      exactKnownEmail ||
      resolveLinkedWorkItemAssignee(pr) ||
      resolveIdentity(githubLogin) ||
      resolveIdentity(pr.authorName) ||
      authorEmails.find((email) => !isGithubNoreplyEmail(email));

    return resolvedEmail ? { ...pr, authorEmail: resolvedEmail } : pr;
  };
}

function hasPrAttribution(pr: AgentEffectivenessPullRequest): boolean {
  return pr.aiAssisted === true || pr.industrySessionIds.length > 0;
}

function prCodeChanges(pr: AgentEffectivenessPullRequest): number {
  return pr.additions + pr.deletions;
}

function normalizedStatus(item: AgentEffectivenessWorkItem): string {
  return (item.status || '').trim().toLowerCase();
}

function isCompletedTicket(item: AgentEffectivenessWorkItem): boolean {
  const status = normalizedStatus(item);
  if (item.completedAt) {
    return true;
  }

  if (!status) {
    return true;
  }

  return [
    'done',
    'closed',
    'complete',
    'completed',
    'resolved',
    'shipped',
    'merged',
  ].includes(status);
}

function isInProgressTicket(item: AgentEffectivenessWorkItem): boolean {
  const status = normalizedStatus(item);
  if (isCompletedTicket(item)) {
    return false;
  }

  return [
    'in progress',
    'in-progress',
    'started',
    'active',
    'doing',
    'development',
    'dev',
    'in review',
    'review',
    'qa',
    'testing',
  ].includes(status);
}

function uniqueEmails(
  usageRows: AgentEffectivenessCodingUsageRow[],
  workItems: AgentEffectivenessWorkItem[],
  pullRequests: AgentEffectivenessPullRequest[]
): string[] {
  const emails = new Set<string>();

  for (const row of usageRows) {
    if (row.userEmail) {
      emails.add(emailKey(row.userEmail));
    }
  }

  for (const item of workItems) {
    if (item.assigneeEmail) {
      emails.add(emailKey(item.assigneeEmail));
    }
  }

  for (const pr of pullRequests) {
    if (pr.authorEmail) {
      emails.add(emailKey(pr.authorEmail));
    }
  }

  return [...emails].sort();
}

function hasActiveCodingUsage(row: AgentEffectivenessCodingUsageRow): boolean {
  return (
    row.billableTokens > 0 ||
    row.sessions > 0 ||
    row.droolCommits > 0 ||
    row.droolPrsCreated > 0
  );
}

function reportDayCount(startDate: string, endDate: string): number {
  const start = parseIsoDateToUtc(startDate);
  const end = parseIsoDateToUtc(endDate);
  if (start === null || end === null || end < start) {
    return 1;
  }

  return Math.max(1, Math.floor((end - start) / MS_PER_DAY) + 1);
}

export function buildDailyAgentEffectivenessTokenEfficiencyTrend({
  startDate,
  endDate,
  dailyUsageRows,
  pullRequests,
  workItems,
  identityAliases,
}: {
  startDate: string;
  endDate: string;
  dailyUsageRows: AgentEffectivenessDailyUsageRows[];
  pullRequests: AgentEffectivenessPullRequest[];
  workItems: AgentEffectivenessWorkItem[];
  identityAliases?: Record<string, string>;
}): AgentEffectivenessTokenEfficiencyTrendPoint[] {
  const aliases = normalizeIdentityAliases(identityAliases);
  const canonicalDailyUsageRows = dailyUsageRows.map((entry) => ({
    date: entry.date,
    usageRows: entry.usageRows.map((row) => canonicalizeUsageRow(row, aliases)),
  }));
  const canonicalPullRequests = pullRequests.map((pr) =>
    canonicalizePullRequest(pr, aliases)
  );
  const canonicalWorkItems = workItems.map((item) =>
    canonicalizeWorkItem(item, aliases)
  );
  const dates = eachIsoDate(startDate, endDate);
  const usageByDate = new Map(
    canonicalDailyUsageRows.map((entry) => [entry.date, entry.usageRows])
  );
  const pullRequestsByDate = new Map<string, AgentEffectivenessPullRequest[]>();
  const workItemsByDate = new Map<string, AgentEffectivenessWorkItem[]>();

  for (const pr of canonicalPullRequests) {
    const date = isoDateFromTimestamp(pr.mergedAt);
    if (!date) {
      continue;
    }
    pullRequestsByDate.set(date, [...(pullRequestsByDate.get(date) ?? []), pr]);
  }

  for (const workItem of canonicalWorkItems) {
    const date = isoDateFromTimestamp(
      workItem.completedAt ?? workItem.startedAt
    );
    if (!date) {
      continue;
    }
    workItemsByDate.set(date, [...(workItemsByDate.get(date) ?? []), workItem]);
  }

  return dates.map((date) => {
    const usageRows = (usageByDate.get(date) ?? []).filter(
      hasActiveCodingUsage
    );
    const dayPullRequests = pullRequestsByDate.get(date) ?? [];
    const dayWorkItems = workItemsByDate.get(date) ?? [];
    const activeEmails = new Set<string>();

    for (const row of usageRows) {
      const email = normalizedEmail(row.userEmail);
      if (email) {
        activeEmails.add(email);
      }
    }
    for (const pr of dayPullRequests) {
      const email = normalizedEmail(pr.authorEmail);
      if (email) {
        activeEmails.add(email);
      }
    }
    for (const workItem of dayWorkItems) {
      const email = normalizedEmail(workItem.assigneeEmail);
      if (email) {
        activeEmails.add(email);
      }
    }

    const activePeople = activeEmails.size;
    const billableTokens = sumBy(usageRows, (row) => row.billableTokens);
    const netLoc = sumBy(
      dayPullRequests,
      (pr) => (pr.additions || 0) - (pr.deletions || 0)
    );
    const perPersonTokens =
      activePeople > 0 ? billableTokens / activePeople : null;
    const perPersonNetLoc =
      activePeople > 0 ? Math.abs(netLoc) / activePeople : null;
    const tokensPerNetLocPerPerson =
      perPersonTokens !== null && perPersonNetLoc !== null
        ? perPersonTokens / Math.max(1, perPersonNetLoc)
        : null;

    return {
      date,
      activePeople,
      billableTokens,
      netLoc,
      perPersonTokens: round(perPersonTokens, 2),
      perPersonNetLoc: round(perPersonNetLoc, 2),
      tokensPerNetLocPerPerson: round(tokensPerNetLocPerPerson, 2),
    };
  });
}

export function buildAgentEffectivenessReportMetrics(
  request: ResolvedAgentEffectivenessReportRequest,
  usageRows: AgentEffectivenessCodingUsageRow[],
  totalUsage?: AgentEffectivenessOrganizationTotalUsage
): AgentEffectivenessMetrics {
  const aliases = normalizeIdentityAliases(request.identityAliases);
  const canonicalUsageRows = usageRows.map((row) =>
    canonicalizeUsageRow(row, aliases)
  );
  const canonicalWorkItems = request.workItems.map((item) =>
    canonicalizeWorkItem(item, aliases)
  );
  const canonicalPullRequests = request.pullRequests.map((pr) =>
    canonicalizePullRequest(pr, aliases)
  );
  const aggregatedUsageRows =
    aggregateUsageRowsByCanonicalEmail(canonicalUsageRows);
  const activeUsageRows = aggregatedUsageRows.filter(hasActiveCodingUsage);
  const knownDeliveryEmails = [
    ...activeUsageRows.flatMap((row) => (row.userEmail ? [row.userEmail] : [])),
    ...canonicalPullRequests.flatMap((pr) =>
      pr.authorEmail ? [pr.authorEmail] : []
    ),
    ...canonicalWorkItems.flatMap((item) =>
      item.assigneeEmail ? [item.assigneeEmail] : []
    ),
    ...Object.values(aliases),
  ];
  const resolveAssigneeEmail = buildAssigneeEmailResolver(knownDeliveryEmails);
  const resolvedWorkItems = canonicalWorkItems.map((item) => {
    const assigneeEmail = resolveAssigneeEmail(item);
    return assigneeEmail ? { ...item, assigneeEmail } : item;
  });
  const resolvePullRequestEmail = buildPullRequestEmailResolver(
    knownDeliveryEmails,
    resolvedWorkItems
  );
  const resolvedPullRequests = canonicalPullRequests.map(
    resolvePullRequestEmail
  );
  const checkedRepositories = [
    ...new Set(
      (request.checkedRepositories.length > 0
        ? request.checkedRepositories
        : canonicalPullRequests.flatMap((pr) => (pr.repo ? [pr.repo] : []))
      )
        .map((repo) => repo.trim())
        .filter((repo) => repo.length > 0)
    ),
  ].sort((a, b) => a.localeCompare(b));
  const workItemsByUser = groupByEmail(
    resolvedWorkItems,
    (item) => item.assigneeEmail
  );
  const prsByUser = groupByEmail(resolvedPullRequests, (pr) => pr.authorEmail);
  const usageByUser = new Map(
    activeUsageRows.map((row) => [emailKey(row.userEmail), row])
  );
  const users = uniqueEmails(
    activeUsageRows,
    resolvedWorkItems,
    resolvedPullRequests
  );
  const userRows: AgentEffectivenessUserReportRow[] = users.map((userEmail) => {
    const usage = usageByUser.get(userEmail);
    const workItems = workItemsByUser.get(userEmail) || [];
    const completedWorkItems = workItems.filter(isCompletedTicket);
    const inProgressWorkItems = workItems.filter(isInProgressTicket);
    const pullRequests = prsByUser.get(userEmail) || [];
    const billableTokens = usage?.billableTokens || 0;
    const storyPoints = sumBy(
      completedWorkItems,
      (item) => item.storyPoints || 0
    );
    const pullRequestCount = pullRequests.length;
    const codeAdditions = sumBy(pullRequests, (pr) => pr.additions);
    const codeDeletions = sumBy(pullRequests, (pr) => pr.deletions);
    const codeChanges = codeAdditions + codeDeletions;
    const netLocChange = codeAdditions - codeDeletions;
    const testFileChanges = sumBy(pullRequests, (pr) => pr.testFileChanges);
    const aiAssistedPrs = pullRequests.filter(hasPrAttribution).length;
    const fscUnitCostUsd = request.options.fscUnitCostUsd;
    const creditsPerStoryPoint = round(
      safeDivide(billableTokens, storyPoints),
      2
    );
    const creditsPerCompletedTicket = round(
      safeDivide(billableTokens, completedWorkItems.length),
      2
    );
    const creditsPerPr = round(safeDivide(billableTokens, pullRequestCount), 2);
    const creditsPerNetLoc = round(safeDivide(billableTokens, netLocChange), 2);

    return {
      userEmail,
      userId: usage?.userId,
      industryCredits: billableTokens,
      billableTokens,
      estimatedFscCostUsd:
        fscUnitCostUsd === undefined
          ? undefined
          : billableTokens * fscUnitCostUsd,
      sessions: usage?.sessions || 0,
      droolCommits: usage?.droolCommits || 0,
      droolPrsCreated: usage?.droolPrsCreated || 0,
      storyPoints,
      completedTickets: completedWorkItems.length,
      inProgressTickets: inProgressWorkItems.length,
      pullRequests: pullRequestCount,
      codeAdditions,
      codeDeletions,
      codeChanges,
      netLocChange,
      testFileChanges,
      aiAssistedPrs,
      creditsPerStoryPoint,
      creditsPerCompletedTicket,
      creditsPerPr,
      creditsPerNetLoc,
      tokensPerStoryPoint: creditsPerStoryPoint,
      tokensPerCompletedTicket: creditsPerCompletedTicket,
      tokensPerPr: creditsPerPr,
    };
  });

  const allCompletedWorkItems = resolvedWorkItems.filter(isCompletedTicket);
  const allInProgressWorkItems = resolvedWorkItems.filter(isInProgressTicket);
  const totalBillableTokens = sumBy(userRows, (row) => row.billableTokens);
  const totalStoryPoints = sumBy(
    allCompletedWorkItems,
    (item) => item.storyPoints || 0
  );
  const totalCompletedTickets = allCompletedWorkItems.length;
  const totalPullRequests = resolvedPullRequests.length;
  const totalSessions = sumBy(userRows, (row) => row.sessions);
  const totalCodeAdditions = sumBy(resolvedPullRequests, (pr) => pr.additions);
  const totalCodeDeletions = sumBy(resolvedPullRequests, (pr) => pr.deletions);
  const totalCodeChanges = sumBy(resolvedPullRequests, prCodeChanges);
  const totalNetLocChange = totalCodeAdditions - totalCodeDeletions;
  const totalTestFileChanges = sumBy(
    resolvedPullRequests,
    (pr) => pr.testFileChanges
  );
  const aiAssistedPrs = resolvedPullRequests.filter(hasPrAttribution);
  const aiAssistedCodeChanges = sumBy(aiAssistedPrs, prCodeChanges);
  const aiAssistedTestFileChanges = sumBy(
    aiAssistedPrs,
    (pr) => pr.testFileChanges
  );
  const attributedPrs = aiAssistedPrs.length;
  const attributedPrsWithoutMajorRework = aiAssistedPrs.filter(
    (pr) => pr.majorRework !== true
  ).length;
  const defectLinkedAttributedPrs = aiAssistedPrs.filter(
    (pr) => pr.defectLinked === true
  ).length;
  const mappedUsers = activeUsageRows.filter((row) => row.userEmail).length;
  const deliveryEmails = new Set<string>();
  for (const item of resolvedWorkItems) {
    if (item.assigneeEmail) {
      deliveryEmails.add(emailKey(item.assigneeEmail));
    }
  }
  for (const pr of resolvedPullRequests) {
    if (pr.authorEmail) {
      deliveryEmails.add(emailKey(pr.authorEmail));
    }
  }
  const usageOnlyRows = activeUsageRows.filter(
    (row) => !row.userEmail || !deliveryEmails.has(emailKey(row.userEmail))
  );
  const unaccountedBillableTokens = sumBy(
    usageOnlyRows,
    (row) => row.billableTokens
  );
  const unaccountedSessions = sumBy(usageOnlyRows, (row) => row.sessions);
  const pullRequestsWithoutTicketLinks = resolvedPullRequests.filter(
    (pr) => pr.linkedWorkItemIds.length === 0
  ).length;
  const pullRequestsWithoutIndustryAttribution =
    totalPullRequests - attributedPrs;
  const unaccountedPullRequests = resolvedPullRequests.filter(
    (pr) =>
      !pr.authorEmail ||
      !usageByUser.has(emailKey(pr.authorEmail)) ||
      pr.linkedWorkItemIds.length === 0
  ).length;
  const workItemsWithoutAssigneeEmail = resolvedWorkItems.filter(
    (item) => !item.assigneeEmail
  ).length;
  const workItemsWithoutStoryPoints = resolvedWorkItems.filter(
    (item) => item.storyPoints === undefined
  ).length;
  const dayCount = reportDayCount(request.startDate, request.endDate);
  const creditsPerStoryPoint = round(
    safeDivide(totalBillableTokens, totalStoryPoints),
    2
  );
  const creditsPerCompletedTicket = round(
    safeDivide(totalBillableTokens, totalCompletedTickets),
    2
  );
  const creditsPerPr = round(
    safeDivide(totalBillableTokens, totalPullRequests),
    2
  );
  const creditsPerNetLoc = round(
    safeDivide(totalBillableTokens, totalNetLocChange),
    2
  );

  return {
    organizationId: request.orgId,
    organizationName: request.orgName,
    startDate: request.startDate,
    endDate: request.endDate,
    generatedAt: new Date().toISOString(),
    organizationTotalUsage: totalUsage,
    totals: {
      industryCredits: totalBillableTokens,
      billableTokens: totalBillableTokens,
      industryCreditsPerDay: round(safeDivide(totalBillableTokens, dayCount), 2),
      estimatedFscCostUsd:
        request.options.fscUnitCostUsd === undefined
          ? undefined
          : totalBillableTokens * request.options.fscUnitCostUsd,
      sessions: totalSessions,
      droolCommits: sumBy(userRows, (row) => row.droolCommits),
      droolPrsCreated: sumBy(userRows, (row) => row.droolPrsCreated),
      storyPoints: totalStoryPoints,
      completedTickets: totalCompletedTickets,
      completedTicketsPerDay: round(
        safeDivide(totalCompletedTickets, dayCount),
        2
      ),
      inProgressTickets: allInProgressWorkItems.length,
      pullRequests: totalPullRequests,
      pullRequestsPerDay: round(safeDivide(totalPullRequests, dayCount), 2),
      codeAdditions: totalCodeAdditions,
      codeDeletions: totalCodeDeletions,
      codeChanges: totalCodeChanges,
      netLocChange: totalNetLocChange,
      testFileChanges: totalTestFileChanges,
      aiAssistedPrs: attributedPrs,
      aiAssistedCodeChangeRate: round(
        safeDivide(aiAssistedCodeChanges, totalCodeChanges),
        4
      ),
      aiDrivenTestChangeRate: round(
        safeDivide(aiAssistedTestFileChanges, totalTestFileChanges),
        4
      ),
      aiAcceptanceProxyRate: round(
        safeDivide(attributedPrsWithoutMajorRework, attributedPrs),
        4
      ),
      aiDefectProxyRate: round(
        safeDivide(defectLinkedAttributedPrs, attributedPrs),
        4
      ),
      creditsPerStoryPoint,
      creditsPerCompletedTicket,
      creditsPerPr,
      creditsPerNetLoc,
      tokensPerStoryPoint: creditsPerStoryPoint,
      tokensPerCompletedTicket: creditsPerCompletedTicket,
      tokensPerPr: creditsPerPr,
    },
    coverage: {
      pullRequestTicketLinkRate:
        round(
          safeDivide(
            resolvedPullRequests.filter((pr) => pr.linkedWorkItemIds.length > 0)
              .length,
            totalPullRequests
          ),
          4
        ) || 0,
      ticketStoryPointRate:
        round(
          safeDivide(
            resolvedWorkItems.filter((item) => item.storyPoints !== undefined)
              .length,
            resolvedWorkItems.length
          ),
          4
        ) || 0,
      pullRequestAttributionRate:
        round(safeDivide(attributedPrs, totalPullRequests), 4) || 0,
      mappedUserRate:
        round(safeDivide(mappedUsers, activeUsageRows.length), 4) || 0,
      mappedUsers,
      totalUsers: activeUsageRows.length,
    },
    attributionGaps: {
      usageOnlyUsers: usageOnlyRows.length,
      unaccountedBillableTokens,
      unaccountedSessions,
      unaccountedPullRequests,
      pullRequestsWithoutTicketLinks,
      pullRequestsWithoutIndustryAttribution,
      workItemsWithoutAssigneeEmail,
      workItemsWithoutStoryPoints,
      deliveryMatchedTokenRate:
        round(
          safeDivide(
            totalBillableTokens - unaccountedBillableTokens,
            totalBillableTokens
          ),
          4
        ) || 0,
      deliveryMatchedSessionRate:
        round(
          safeDivide(totalSessions - unaccountedSessions, totalSessions),
          4
        ) || 0,
    },
    users: userRows.sort((a, b) => b.billableTokens - a.billableTokens),
    checkedRepositories,
    caveats: [
      'Attribution metrics are directional until commit-level GitAI attribution is fully available.',
      'Industry usage is fetched through the authenticated usage tool; delivery metadata is collected locally and joined in this deterministic renderer.',
      'AI acceptance and defect rates are proxies derived from PR metadata, not direct code-quality measurements.',
    ],
  };
}

function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatNumber(value: number | null | undefined): string {
  if (value === null || value === undefined) {
    return 'N/A';
  }

  return new Intl.NumberFormat('en-US', {
    maximumFractionDigits: 2,
  }).format(value);
}

function formatCompactNumber(value: number | null | undefined): string {
  if (value === null || value === undefined) {
    return 'N/A';
  }

  return new Intl.NumberFormat('en-US', {
    compactDisplay: 'short',
    maximumFractionDigits: 1,
    notation: 'compact',
  }).format(value);
}

function formatPercent(value: number | null | undefined): string {
  if (value === null || value === undefined) {
    return 'N/A';
  }

  return `${formatNumber(value * 100)}%`;
}

function sortValue(value: number | null | undefined): string {
  return value === null || value === undefined || !Number.isFinite(value)
    ? ''
    : String(value);
}

function formatLineChangeDelta(
  additions: number | undefined,
  deletions: number | undefined
): string {
  return `+${formatNumber(additions || 0)} / -${formatNumber(deletions || 0)}`;
}

function userCodeAdditions(user: AgentEffectivenessUserReportRow): number {
  return user.codeAdditions ?? user.codeChanges ?? 0;
}

function userCodeDeletions(user: AgentEffectivenessUserReportRow): number {
  return user.codeDeletions ?? 0;
}

function userNetLocChange(user: AgentEffectivenessUserReportRow): number {
  return userCodeAdditions(user) - userCodeDeletions(user);
}

function userLineChangeTooltip(user: AgentEffectivenessUserReportRow): string {
  return `Lines changed (+/-): ${formatLineChangeDelta(userCodeAdditions(user), userCodeDeletions(user))}`;
}

function sortableHeader(
  label: string,
  sortType: 'number' | 'text',
  className?: string
): string {
  return `<th${className ? ` class="${className}"` : ''} aria-sort="none"><button type="button" class="sort-button" data-sort-type="${sortType}"><span>${escapeHtml(label)}</span><span class="sort-indicator" aria-hidden="true"></span></button></th>`;
}

function metricCard(
  label: string,
  value: string,
  tooltip: string,
  className?: string
): string {
  return `
    <div class="metric${className ? ` ${escapeHtml(className)}` : ''}" tabindex="0" title="${escapeHtml(tooltip)}" aria-label="${escapeHtml(`${label}: ${tooltip}`)}">
      <div class="label-row">
        <div class="label">${escapeHtml(label)}</div>
        <span class="tooltip-icon" aria-hidden="true">?</span>
        <span class="tooltip">${escapeHtml(tooltip)}</span>
      </div>
      <div class="value">${value}</div>
    </div>`;
}

function summaryCard(label: string, value: string): string {
  return `
    <div class="summary-metric">
      <div class="label">${escapeHtml(label)}</div>
      <div class="value">${value}</div>
    </div>`;
}

function distributionChart(
  title: string,
  subtitle: string,
  users: AgentEffectivenessUserReportRow[],
  getXValue: (user: AgentEffectivenessUserReportRow) => number,
  xAxisLabelSingular: string,
  xAxisLabelPlural: string,
  ratioLabel: string,
  options?: {
    getYValue?: (user: AgentEffectivenessUserReportRow) => number;
    ratioNumeratorLabel?: string;
    tooltipExtra?: (user: AgentEffectivenessUserReportRow) => string[];
    yValueLabel?: string;
  }
): string {
  const getYValue =
    options?.getYValue ??
    ((user: AgentEffectivenessUserReportRow) => user.billableTokens);
  const ratioNumeratorLabel = options?.ratioNumeratorLabel ?? 'credits';
  const yValueLabel = options?.yValueLabel ?? 'Coding-related Industry credits';
  const points = users
    .map((user) => ({
      user,
      xValue: getXValue(user),
      yValue: getYValue(user),
    }))
    .filter(
      (
        point
      ): point is {
        user: AgentEffectivenessUserReportRow;
        xValue: number;
        yValue: number;
      } =>
        Number.isFinite(point.xValue) &&
        Number.isFinite(point.yValue) &&
        point.xValue > 0 &&
        point.yValue > 0
    )
    .sort((a, b) => a.xValue - b.xValue || a.yValue - b.yValue);

  if (points.length === 0) {
    return `
      <div class="distribution-card">
        <div class="distribution-title">${escapeHtml(title)}</div>
        <div class="distribution-subtitle">${escapeHtml(subtitle)}</div>
        <div class="distribution-empty">No attributed users with enough delivery metadata.</div>
      </div>`;
  }

  const maxXValue = Math.max(...points.map((point) => point.xValue), 1);
  const maxYValue = Math.max(...points.map((point) => point.yValue), 1);
  const yAxisLabelTicks = [1, 0.75, 0.5, 0.25];
  const gridLineTicks = [...yAxisLabelTicks, 0];
  const yAxisLabels = yAxisLabelTicks
    .map(
      (ratio) =>
        `<span style="top: ${round((1 - ratio) * 100, 2)}%;">${escapeHtml(formatCompactNumber(maxYValue * ratio))}</span>`
    )
    .join('');
  const gridLines = gridLineTicks
    .map(
      (ratio) =>
        `<span class="chart-grid-line" style="top: ${round((1 - ratio) * 100, 2)}%;"></span>`
    )
    .join('');
  const pointElements = points
    .map((point) => {
      const left = Math.max(
        2,
        Math.min(98, (point.xValue / maxXValue) * 96 + 2)
      );
      const top = Math.max(
        3,
        Math.min(97, 97 - (point.yValue / maxYValue) * 94)
      );
      const creditsPerUnit = safeDivide(point.yValue, point.xValue);
      const xAxisLabel =
        point.xValue === 1 ? xAxisLabelSingular : xAxisLabelPlural;
      const tooltip = [
        point.user.userEmail,
        `${formatNumber(point.yValue)} ${yValueLabel}`,
        `${formatNumber(point.xValue)} ${xAxisLabel}`,
        ...(options?.tooltipExtra?.(point.user) ?? []),
        `${formatNumber(creditsPerUnit)} ${ratioNumeratorLabel} / ${ratioLabel}`,
      ].join(' · ');
      return `<span class="chart-point" style="left: ${round(left, 2)}%; top: ${round(top, 2)}%;" tabindex="0" aria-label="${escapeHtml(tooltip)}"><span class="chart-tooltip">${escapeHtml(tooltip)}</span></span>`;
    })
    .join('');

  return `
    <div class="distribution-card">
      <div class="distribution-title">${escapeHtml(title)}</div>
      <div class="distribution-subtitle">${escapeHtml(subtitle)}</div>
      <div class="distribution-plot" aria-label="${escapeHtml(title)} distribution">
        <div class="chart-y-axis" aria-hidden="true">${yAxisLabels}</div>
        <div class="chart-area">${gridLines}${pointElements}</div>
      </div>
      <div class="distribution-axis">
        <span>0</span>
        <span>${formatNumber(maxXValue)} ${escapeHtml(maxXValue === 1 ? xAxisLabelSingular : xAxisLabelPlural)}</span>
      </div>
    </div>`;
}

function tokenEfficiencyTrendLineChart(
  trendPoints: AgentEffectivenessTokenEfficiencyTrendPoint[] | undefined
): string {
  const orderedPoints = (trendPoints ?? [])
    .slice()
    .sort((a, b) => a.date.localeCompare(b.date));

  if (orderedPoints.length === 0) {
    return `
      <div class="trend-card">
        <div class="distribution-title">Token spend / net LOC over time</div>
        <div class="distribution-subtitle">Lower is better. Ratio is computed from per-person coding-related Industry credits divided by per-person net LOC for each day.</div>
        <div class="line-chart" aria-label="Token spend to net LOC over time">
          <div class="chart-y-axis" aria-hidden="true"></div>
          <div class="line-chart-area">
            <svg class="line-chart-svg" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
              <polyline class="line-chart-line" points="" />
            </svg>
          </div>
        </div>
        <div class="distribution-empty">No daily token-efficiency datapoints were provided.</div>
      </div>`;
  }

  const finiteRatios = orderedPoints
    .map((point) => point.tokensPerNetLocPerPerson)
    .filter(
      (ratio): ratio is number => ratio !== null && Number.isFinite(ratio)
    );
  const maxYValue = Math.max(...finiteRatios, 1);
  const yAxisLabelTicks = [1, 0.75, 0.5, 0.25];
  const gridLineTicks = [...yAxisLabelTicks, 0];
  const yAxisLabels = yAxisLabelTicks
    .map(
      (ratio) =>
        `<span style="top: ${round((1 - ratio) * 100, 2)}%;">${escapeHtml(formatCompactNumber(maxYValue * ratio))}</span>`
    )
    .join('');
  const gridLines = gridLineTicks
    .map(
      (ratio) =>
        `<span class="chart-grid-line" style="top: ${round((1 - ratio) * 100, 2)}%;"></span>`
    )
    .join('');
  const positionedPoints = orderedPoints.map((point, index) => {
    const ratio = point.tokensPerNetLocPerPerson;
    const hasRatio = ratio !== null && Number.isFinite(ratio);
    const left =
      orderedPoints.length === 1
        ? 50
        : (index / (orderedPoints.length - 1)) * 96 + 2;
    const top = hasRatio
      ? Math.max(3, Math.min(97, 97 - ((ratio as number) / maxYValue) * 94))
      : 100;
    return {
      ...point,
      hasRatio,
      left: round(left, 2) ?? left,
      top: round(top, 2) ?? top,
    };
  });
  const polylinePoints = positionedPoints
    .filter((point) => point.hasRatio)
    .map((point) => `${point.left},${point.top}`)
    .join(' ');
  const pointElements = positionedPoints
    .map((point) => {
      const tooltip = point.hasRatio
        ? [
            point.date,
            `${formatNumber(point.activePeople)} active people`,
            `${formatNumber(point.billableTokens)} coding-related Industry credits`,
            `${formatNumber(point.netLoc)} net LOC`,
            `${formatNumber(point.perPersonTokens)} per-person credits`,
            `${formatNumber(point.perPersonNetLoc)} per-person net LOC`,
            `${formatNumber(point.tokensPerNetLocPerPerson)} tokens / net LOC per person`,
          ].join(' · ')
        : `${point.date} · No activity this day`;
      const style = point.hasRatio
        ? `left: ${point.left}%; top: ${point.top}%;`
        : `left: ${point.left}%; top: ${point.top}%; opacity: 0.35;`;
      const emptyAttr = point.hasRatio ? '' : ' data-empty="true"';
      return `<span class="chart-point trend-point" data-trend-point-date="${escapeHtml(point.date)}" style="${style}"${emptyAttr} tabindex="0" aria-label="${escapeHtml(tooltip)}"><span class="chart-tooltip">${escapeHtml(tooltip)}</span></span>`;
    })
    .join('');

  return `
    <div class="trend-card">
      <div class="distribution-title">Token spend / net LOC over time</div>
      <div class="distribution-subtitle">Lower is better. Ratio is computed from per-person coding-related Industry credits divided by per-person net LOC for each day. Days without Industry usage, attributed PRs, or work items show a muted placeholder marker with a "No activity this day" tooltip.</div>
      <div class="line-chart" aria-label="Token spend to net LOC over time">
        <div class="chart-y-axis" aria-hidden="true">${yAxisLabels}</div>
        <div class="line-chart-area">
          ${gridLines}
          <svg class="line-chart-svg" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
            <polyline class="line-chart-line" points="${escapeHtml(polylinePoints)}" />
          </svg>
          ${pointElements}
        </div>
      </div>
      <div class="distribution-axis">
        <span>${escapeHtml(orderedPoints[0]?.date ?? '')}</span>
        <span>${escapeHtml(orderedPoints[orderedPoints.length - 1]?.date ?? '')}</span>
      </div>
    </div>`;
}

function checkedRepositoriesSection(repositories: string[]): string {
  if (repositories.length === 0) {
    return '';
  }

  const repositoryPills = repositories
    .map((repo) => `<span class="repo-pill">${escapeHtml(repo)}</span>`)
    .join('');

  return `
    <section class="card">
      <div class="section-header">
        <span class="section-title">Repositories checked</span>
        <span class="section-divider"></span>
      </div>
      <div class="repo-count">Scanned ${formatNumber(repositories.length)} repositories for merged pull requests in the report window.</div>
      <div class="repo-list">${repositoryPills}</div>
    </section>`;
}

export function renderAgentEffectivenessHtmlReport(
  metrics: AgentEffectivenessMetrics,
  options: AgentEffectivenessHtmlReportRenderOptions = {}
): string {
  const hasStoryPoints = metrics.totals.storyPoints > 0;
  const primaryThroughputLabel = hasStoryPoints
    ? 'Story points'
    : metrics.totals.completedTickets > 0
      ? 'Tickets completed'
      : 'PRs merged';
  const primaryThroughputValue = hasStoryPoints
    ? metrics.totals.storyPoints
    : metrics.totals.completedTickets > 0
      ? metrics.totals.completedTickets
      : metrics.totals.pullRequests;
  const primaryEfficiencyLabel = hasStoryPoints
    ? 'Coding-related Industry credits / story point'
    : metrics.totals.completedTickets > 0
      ? 'Coding-related Industry credits / ticket'
      : 'Coding-related Industry credits / PR';
  const primaryEfficiencyValue = hasStoryPoints
    ? metrics.totals.tokensPerStoryPoint
    : metrics.totals.completedTickets > 0
      ? metrics.totals.tokensPerCompletedTicket
      : metrics.totals.tokensPerPr;
  const primaryThroughputTooltip = hasStoryPoints
    ? 'Total completed work-item estimates in the report window. Jira story points populate this when available; Linear estimates are shown when included in the export.'
    : metrics.totals.completedTickets > 0
      ? 'Completed Linear or Jira work items in the report window. Used as the primary throughput fallback when story points are unavailable.'
      : 'Merged pull requests in the report window. Used as the throughput fallback when ticket data is unavailable.';
  const primaryEfficiencyTooltip = hasStoryPoints
    ? 'Coding-related Industry credits divided by completed story points. Lower values indicate fewer credits per estimated point delivered.'
    : metrics.totals.completedTickets > 0
      ? 'Coding-related Industry credits divided by completed tickets. This is the primary efficiency metric when story points are unavailable.'
      : 'Coding-related Industry credits divided by merged pull requests. This is the fallback efficiency metric when ticket data is unavailable.';
  const dayCount = reportDayCount(metrics.startDate, metrics.endDate);
  const hasUnfilteredTotal =
    metrics.organizationTotalUsage !== undefined &&
    Number.isFinite(metrics.organizationTotalUsage.billableTokens);
  const headlineBillableTokens = hasUnfilteredTotal
    ? (metrics.organizationTotalUsage?.billableTokens ?? 0)
    : metrics.totals.billableTokens;
  const headlineBillableTokensTooltip = hasUnfilteredTotal
    ? 'Total Industry credits used by this organization during the report window across all Industry activity, queried from Industry usage analytics. Charts, scatter plots, ratios, and the per-user breakdown below are computed from coding-related credits only (code generation and code review).'
    : 'Total Industry credits used by this organization during the report window, queried from Industry usage analytics.';
  const billableTokensPerDay = safeDivide(
    metrics.totals.industryCredits,
    dayCount
  );
  const completedTicketsPerDay = safeDivide(
    metrics.totals.completedTickets,
    dayCount
  );
  const pullRequestsPerDay = safeDivide(metrics.totals.pullRequests, dayCount);
  const userRows = metrics.users
    .map(
      (row) => `
      <tr>
        <td data-sort-value="${escapeHtml(row.userEmail.toLowerCase())}">${escapeHtml(row.userEmail)}</td>
        <td class="num" data-sort-value="${sortValue(row.billableTokens)}">${formatNumber(row.billableTokens)}</td>
        <td class="num" data-sort-value="${sortValue(row.storyPoints)}">${formatNumber(row.storyPoints)}</td>
        <td class="num" data-sort-value="${sortValue(row.tokensPerStoryPoint)}">${formatNumber(row.tokensPerStoryPoint)}</td>
        <td class="num" data-sort-value="${sortValue(row.completedTickets)}">${formatNumber(row.completedTickets)}</td>
        <td class="num" data-sort-value="${sortValue(row.inProgressTickets)}">${formatNumber(row.inProgressTickets)}</td>
        <td class="num" data-sort-value="${sortValue(row.tokensPerCompletedTicket)}">${formatNumber(row.tokensPerCompletedTicket)}</td>
        <td class="num" data-sort-value="${sortValue(row.pullRequests)}">${formatNumber(row.pullRequests)}</td>
        <td class="num" data-sort-value="${sortValue(row.codeChanges)}">${formatLineChangeDelta(row.codeAdditions, row.codeDeletions)}</td>
        <td class="num" data-sort-value="${sortValue(row.tokensPerPr)}">${formatNumber(row.tokensPerPr)}</td>
        <td class="num" data-sort-value="${sortValue(row.creditsPerNetLoc)}">${formatNumber(row.creditsPerNetLoc)}</td>
        <td class="num" data-sort-value="${sortValue(row.aiAssistedPrs)}">${formatNumber(row.aiAssistedPrs)}</td>
        <td class="num" data-sort-value="${sortValue(row.sessions)}">${formatNumber(row.sessions)}</td>
      </tr>`
    )
    .join('');

  const caveats = metrics.caveats
    .map((caveat) => `<li>${escapeHtml(caveat)}</li>`)
    .join('');
  const organizationLabel = escapeHtml(
    metrics.organizationName || metrics.organizationId
  );
  const deliveryOnlyUsers = metrics.users.filter(
    (user) =>
      user.billableTokens === 0 &&
      (user.completedTickets > 0 ||
        user.inProgressTickets > 0 ||
        user.pullRequests > 0)
  ).length;
  const deliveryMatchedIndustryUsers = Math.max(
    0,
    metrics.coverage.mappedUsers - metrics.attributionGaps.usageOnlyUsers
  );
  const attributionGapNote = [
    `${formatNumber(metrics.attributionGaps.unaccountedBillableTokens)} coding-related Industry credits`,
    `${formatNumber(metrics.attributionGaps.unaccountedSessions)} sessions`,
    `${formatNumber(metrics.attributionGaps.unaccountedPullRequests)} PRs`,
    `${formatNumber(metrics.attributionGaps.workItemsWithoutAssigneeEmail)} work items without assignee email`,
  ].join(' · ');

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Agent Effectiveness Report</title>
  <style>
    :root {
      color-scheme: dark;
      --text-default: #f2f0f0;
      --text-heading: #f2f0f0;
      --text-subheading: #a89895;
      --text-muted: #b3a9a4;
      --text-label: #bfb7b3;
      --text-highlight: #d56a26;
      --surface-1: #161413;
      --surface-2: #1d1b1a;
      --surface-3: #282523;
      --surface-4: #342f2d;
      --surface-5: #403a37;
      --surface-inverted: #f2f0f0;
      --border-1: #342f2d;
      --border-2: #a89895;
      --border-4: #4c4542;
      --icon-accent: #ee6018;
      --sidebar-notification: #f0a330;
    }
    :root {
      --font-sans: 'Geist', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
      --font-mono: 'Geist Mono', 'SF Mono', Monaco, Inconsolata, 'Roboto Mono', Consolas, 'Liberation Mono', Courier, monospace;
    }
    * { box-sizing: border-box; }
    body { font-family: var(--font-sans); margin: 0; color: var(--text-default); background: var(--surface-1); background-image: repeating-linear-gradient(45deg, rgba(255,255,255,0.018) 0, rgba(255,255,255,0.018) 1px, transparent 1px, transparent 7px); padding: 32px; }
    .shell { margin: 0 auto; max-width: 1200px; min-width: 0; }
    .header-card { background: var(--surface-1); border: 1px solid var(--border-1); border-radius: 0; margin-bottom: 24px; padding: 24px; position: relative; overflow: hidden; }
    .title-row { align-items: flex-start; display: flex; gap: 16px; }
    .report-title { color: var(--text-heading); font-size: 30px; font-weight: 400; letter-spacing: -0.13px; line-height: 1.1; margin: 0; }
    .report-subtitle { color: var(--text-subheading); font-size: 12px; font-weight: 400; letter-spacing: -0.13px; line-height: 1.5; margin: 8px 0 14px; max-width: none; white-space: nowrap; }
    .repo-info { align-items: center; color: var(--text-label); display: flex; flex-wrap: wrap; font-size: 12px; font-weight: 400; letter-spacing: -0.13px; gap: 8px; }
    .header-separator { color: var(--text-subheading); font-weight: 400; }
    .date-badge { background: var(--surface-3); border: 1px solid var(--border-1); border-radius: 0; color: var(--text-default); padding: 3px 10px; }
    .card { background: rgba(22,20,19,0.9); border: 1px solid var(--border-1); border-radius: 0; margin-bottom: 20px; padding: 24px; position: relative; overflow: visible; }
    .metric-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; }
    .summary-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 8px; }
    .metric { background: var(--surface-1); border: 1px solid var(--border-1); border-radius: 0; min-height: 132px; min-width: 0; padding: 18px; position: relative; overflow: visible; }
    .metric--wide { grid-column: span 2; }
    .label-row { align-items: flex-start; display: flex; gap: 6px; justify-content: space-between; position: relative; width: 100%; z-index: 20; }
    .label { color: var(--text-label); font-size: 12px; font-weight: 400; line-height: 1.3; max-width: calc(100% - 22px); text-transform: uppercase; letter-spacing: 0.08em; }
    .tooltip-icon { align-items: center; background: var(--surface-3); border: 1px solid var(--border-1); border-radius: 0; color: var(--text-label); display: inline-flex; flex-shrink: 0; font-size: 10px; font-weight: 700; height: 16px; justify-content: center; line-height: 16px; width: 16px; }
    .tooltip { background: var(--surface-4); border: 1px solid var(--border-4); border-radius: 0; color: var(--text-default); display: none; font-size: 12px; font-weight: 400; letter-spacing: normal; line-height: 1.4; padding: 10px 12px; position: absolute; right: 0; text-transform: none; top: 24px; width: min(300px, 80vw); z-index: 50; }
    .metric:hover .tooltip, .metric:focus .tooltip, .tooltip-icon:hover + .tooltip { display: block; }
    .value { color: var(--text-default); font-size: clamp(24px, 2.6vw, 32px); font-weight: 400; letter-spacing: -0.13px; line-height: 1.1; margin-top: 18px; overflow-wrap: anywhere; text-transform: uppercase; }
    .metric--wide .value { color: var(--text-default); font-size: clamp(34px, 5vw, 48px); white-space: nowrap; overflow-wrap: normal; }
    .metric--wide.metric--standard-value .value { font-size: clamp(24px, 2.6vw, 32px); overflow-wrap: anywhere; white-space: normal; }
    .section-header { align-items: center; border-bottom: 1px solid var(--border-1); display: flex; margin-bottom: 16px; padding-bottom: 10px; }
    .section-title { color: var(--text-heading); font-size: 12px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; white-space: nowrap; }
    .section-divider { display: none; }
    .summary-metric { background: var(--surface-1); border: 1px solid var(--border-1); border-radius: 0; min-width: 0; overflow-wrap: anywhere; padding: 16px; }
    .summary-metric .value { font-size: 24px; margin-top: 8px; }
    .distribution-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; margin-top: 20px; }
    .distribution-card { background: var(--surface-1); border: 1px solid var(--border-1); border-radius: 0; min-width: 0; padding: 16px; }
    .trend-card { background: var(--surface-1); border: 1px solid var(--border-1); border-radius: 0; margin-top: 20px; min-width: 0; padding: 16px; }
    .distribution-title { color: var(--text-heading); font-size: 12px; font-weight: 700; letter-spacing: 0.08em; line-height: 1.2; text-transform: uppercase; }
    .distribution-subtitle, .distribution-empty { color: var(--text-subheading); font-size: 12px; line-height: 1.5; margin-top: 6px; }
    .distribution-plot { display: grid; grid-template-columns: 42px minmax(0, 1fr); column-gap: 10px; height: 208px; margin-top: 14px; position: relative; }
    .line-chart { display: grid; grid-template-columns: 42px minmax(0, 1fr); column-gap: 10px; height: 228px; margin-top: 14px; position: relative; }
    .chart-y-axis { color: var(--text-subheading); font-size: 11px; font-variant-numeric: tabular-nums; position: relative; }
    .chart-y-axis span { position: absolute; right: 0; transform: translateY(-50%); white-space: nowrap; }
    .chart-area { border-bottom: 1px solid var(--border-1); min-width: 0; position: relative; }
    .line-chart-area { border-bottom: 1px solid var(--border-1); min-width: 0; position: relative; }
    .line-chart-svg { height: 100%; inset: 0; overflow: visible; pointer-events: none; position: absolute; width: 100%; }
    .line-chart-line { fill: none; stroke: #F27B2F; stroke-width: 1.5; vector-effect: non-scaling-stroke; }
    .chart-grid-line { border-top: 1px dashed var(--border-1); left: 0; opacity: 0.55; position: absolute; right: 0; }
    .chart-point { background: #F27B2F; border-radius: 2px; display: block; height: 9px; position: absolute; transform: translate(-50%, -50%); width: 9px; z-index: 2; }
    .trend-point { z-index: 3; }
    .chart-point:focus, .chart-point:hover { background: var(--sidebar-notification); outline: 1px solid #F27B2F; outline-offset: 2px; z-index: 20; }
    .chart-tooltip { background: var(--surface-2); border: 1px solid var(--border-1); bottom: 16px; box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15); color: var(--text-default); display: none; font-size: 12px; left: 50%; line-height: 1.4; min-width: 260px; padding: 10px 12px; position: absolute; transform: translateX(-50%); white-space: normal; z-index: 30; }
    .chart-point:focus .chart-tooltip, .chart-point:hover .chart-tooltip { display: block; }
    .distribution-axis { color: var(--text-label); display: flex; font-size: 11px; justify-content: space-between; margin-top: 8px; }
    .table-wrap { overflow-x: auto; width: 100%; }
    table { width: 100%; min-width: 1200px; border-collapse: collapse; background: var(--surface-1); }
    th, td { text-align: left; border-bottom: 1px solid var(--border-1); padding: 10px 12px; font-size: 13px; vertical-align: top; }
    th { background: var(--surface-1); color: var(--text-label); font-size: 11px; font-weight: 700; letter-spacing: 0.05em; text-transform: uppercase; }
    td { color: var(--text-default); }
    .num { font-variant-numeric: tabular-nums; text-align: right; white-space: nowrap; }
    .sort-button { align-items: center; background: transparent; border: 0; color: inherit; cursor: pointer; display: inline-flex; font: inherit; gap: 6px; justify-content: flex-start; letter-spacing: inherit; padding: 0; text-align: inherit; text-transform: inherit; width: 100%; }
    th.num .sort-button { justify-content: flex-end; }
    .sort-button:focus-visible { outline: 1px solid var(--icon-accent); outline-offset: 3px; }
    .sort-indicator { color: var(--text-subheading); font-size: 10px; line-height: 1; min-width: 10px; }
    th[aria-sort="none"] .sort-indicator::before { content: '↕'; }
    th[aria-sort="ascending"] .sort-indicator::before { content: '↑'; color: var(--icon-accent); }
    th[aria-sort="descending"] .sort-indicator::before { content: '↓'; color: var(--icon-accent); }
    .table-pagination { align-items: center; border-top: 1px solid var(--border-1); color: var(--text-subheading); display: flex; font-size: 12px; justify-content: space-between; padding: 14px 0 0; }
    .table-pagination-group { align-items: center; display: flex; gap: 12px; }
    .pagination-button, .page-size-select { background: var(--surface-2); border: 1px solid var(--border-1); border-radius: 0; color: var(--text-default); font: inherit; min-height: 32px; padding: 0 12px; }
    .pagination-button { cursor: pointer; }
    .pagination-button:hover:not(:disabled), .page-size-select:hover { background: var(--surface-3); }
    .pagination-button:disabled { color: var(--text-label); cursor: not-allowed; opacity: 0.45; }
    .pagination-button:focus-visible, .page-size-select:focus-visible { outline: 1px solid var(--icon-accent); outline-offset: 3px; }
    .page-size-select { cursor: pointer; }
    tr:nth-child(even) td { background: var(--surface-2); }
    tr:hover td { background: var(--surface-3); }
    .gap-note { background: rgba(29,27,26,0.72); border: 1px solid var(--border-1); border-left: 3px solid var(--icon-accent); border-radius: 0; color: var(--text-muted); font-size: 13px; line-height: 1.5; margin-top: 16px; padding: 14px 16px; }
    .gap-note strong { color: var(--text-highlight); }
    ul { color: var(--text-muted); line-height: 1.6; margin: 0; padding-left: 20px; }
    .repo-list { align-content: flex-start; display: flex; flex-wrap: wrap; gap: 10px; margin-top: 8px; max-height: 96px; overflow-y: auto; padding-right: 4px; }
    .repo-pill { background: var(--surface-2); border: 1px solid var(--border-1); border-radius: 0; color: var(--text-default); display: inline-flex; font-family: var(--font-mono); font-size: 12px; padding: 7px 11px; }
    .repo-count { color: var(--text-subheading); font-size: 13px; line-height: 1.5; margin-bottom: 12px; }
    .footer { border-top: 1px solid var(--border-1); color: var(--text-subheading); font-size: 12px; margin-top: 16px; padding-top: 14px; text-align: center; }
    @media (max-width: 960px) { .report-subtitle { white-space: normal; } }
    @media (max-width: 960px) { .metric-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
    @media (max-width: 720px) { body { padding: 16px; } .header-card, .card { padding: 18px; } .title-row { gap: 12px; } .report-title { font-size: 24px; } .metric-grid, .summary-grid, .distribution-grid { grid-template-columns: 1fr; } .metric--wide { grid-column: span 1; } .metric--wide .value { font-size: clamp(24px, 10vw, 36px); white-space: normal; } }
  </style>
</head>
<body>
  <main class="shell">
    <div class="header-card">
      <div class="title-row">
        <div>
          <h1 class="report-title">Agent Effectiveness Report</h1>
          <p class="report-subtitle">Quantifies Industry usage against delivery metadata to help explain engineering throughput, efficiency, and AI-assisted work.</p>
          <div class="repo-info">
            <span>${organizationLabel}</span>
            <span class="header-separator">·</span>
            <span class="date-badge">${escapeHtml(metrics.startDate)} to ${escapeHtml(metrics.endDate)}</span>
            <span class="header-separator">·</span>
            <span>Generated ${escapeHtml(metrics.generatedAt)}</span>
          </div>
        </div>
      </div>
    </div>

    <section class="card">
      <div class="section-header">
        <span class="section-title">Summary Metrics</span>
        <span class="section-divider"></span>
      </div>
      <div class="metric-grid">
        ${metricCard('Industry credits', formatNumber(headlineBillableTokens), headlineBillableTokensTooltip, 'metric--wide')}
        ${metricCard(primaryEfficiencyLabel, formatNumber(primaryEfficiencyValue), primaryEfficiencyTooltip, 'metric--wide')}
        ${metricCard(primaryThroughputLabel, formatNumber(primaryThroughputValue), primaryThroughputTooltip)}
        ${metricCard('Tickets in progress', formatNumber(metrics.totals.inProgressTickets), 'Linear or Jira work items marked in-progress, started, in review, QA, or similar. This highlights active pipeline work alongside completed throughput.')}
        ${metricCard('AI-assisted code proxy', formatPercent(metrics.totals.aiAssistedCodeChangeRate), 'Share of changed lines in PRs marked AI-assisted through Industry Drool authorship, co-authorship, or session attribution. Treat as directional until full commit-level attribution is available.')}
        ${metricCard('AI test-change proxy', formatPercent(metrics.totals.aiDrivenTestChangeRate), 'Share of test-file changes that came from AI-assisted PRs. Accuracy depends on PR file metadata and test-file detection coverage.')}
        ${metricCard('Coding-related Industry credits per day', formatNumber(billableTokensPerDay), `Coding-related Industry credits (code generation and code review) averaged across the ${formatNumber(dayCount)} calendar days in the report window.`, 'metric--wide metric--standard-value')}
        ${metricCard('Tickets completed per day', formatNumber(completedTicketsPerDay), `Completed tickets averaged across the ${formatNumber(dayCount)} calendar days in the report window.`)}
        ${metricCard('PRs per day', formatNumber(pullRequestsPerDay), `Merged or attributed pull requests averaged across the ${formatNumber(dayCount)} calendar days in the report window.`)}
      </div>
    </section>

    <section class="card">
      <div class="section-header">
        <span class="section-title">Coverage</span>
        <span class="section-divider"></span>
      </div>
      <div class="summary-grid">
        ${summaryCard('PRs linked to tickets', formatPercent(metrics.coverage.pullRequestTicketLinkRate))}
        ${summaryCard('Tickets with story points', formatPercent(metrics.coverage.ticketStoryPointRate))}
        ${summaryCard('PR attribution coverage', formatPercent(metrics.coverage.pullRequestAttributionRate))}
        ${summaryCard('Delivery-matched Industry users', `${formatNumber(deliveryMatchedIndustryUsers)} / ${formatNumber(metrics.coverage.totalUsers)}`)}
        ${summaryCard('Usage-only users', formatNumber(metrics.attributionGaps.usageOnlyUsers))}
        ${summaryCard('Delivery-only users', formatNumber(deliveryOnlyUsers))}
        ${summaryCard('Unattributed PRs', formatNumber(metrics.attributionGaps.unaccountedPullRequests))}
      </div>
      ${tokenEfficiencyTrendLineChart(options.tokenEfficiencyTrend)}
      <div class="distribution-grid">
        ${distributionChart(
          'Coding credits / tickets',
          'X-axis: completed tickets. Vertical position: coding-related Industry credits. Hover to inspect the user, credits, lines changed (+/-), and credits / ticket.',
          metrics.users,
          (user) => user.completedTickets,
          'completed ticket',
          'completed tickets',
          'ticket',
          { tooltipExtra: (user) => [userLineChangeTooltip(user)] }
        )}
        ${distributionChart(
          'Coding credits / PR',
          'X-axis: attributed PRs. Vertical position: coding-related Industry credits. Hover to inspect the user, credits, lines changed (+/-), and credits / PR.',
          metrics.users,
          (user) => user.pullRequests,
          'attributed PR',
          'attributed PRs',
          'PR',
          { tooltipExtra: (user) => [userLineChangeTooltip(user)] }
        )}
        ${distributionChart(
          'Coding credits / net LOC',
          'X-axis: net LOC change (additions minus deletions). Vertical position: coding-related Industry credits. Hover to inspect the user, credits, lines changed (+/-), and credits / net LOC.',
          metrics.users,
          userNetLocChange,
          'net LOC',
          'net LOC',
          'net LOC',
          { tooltipExtra: (user) => [userLineChangeTooltip(user)] }
        )}
        ${distributionChart(
          'LOC / PR',
          'X-axis: attributed PRs. Vertical position: total lines changed. Hover to inspect the user, lines changed (+/-), PRs, and LOC / PR.',
          metrics.users,
          (user) => user.pullRequests,
          'attributed PR',
          'attributed PRs',
          'PR',
          {
            getYValue: (user) => user.codeChanges,
            ratioNumeratorLabel: 'LOC',
            tooltipExtra: (user) => [userLineChangeTooltip(user)],
            yValueLabel: 'lines changed',
          }
        )}
      </div>
    </section>

    <section class="card">
      <div class="section-header">
        <span class="section-title">Breakdown by user</span>
        <span class="section-divider"></span>
      </div>
      <div class="table-wrap">
        <table data-sortable-table>
          <thead>
            <tr>
              ${sortableHeader('User', 'text')}
              ${sortableHeader('Coding-related Industry credits', 'number', 'num')}
              ${sortableHeader('Story points', 'number', 'num')}
              ${sortableHeader('Coding credits / story point', 'number', 'num')}
              ${sortableHeader('Tickets completed', 'number', 'num')}
              ${sortableHeader('Tickets in progress', 'number', 'num')}
              ${sortableHeader('Coding credits / ticket', 'number', 'num')}
              ${sortableHeader('PRs', 'number', 'num')}
              ${sortableHeader('Lines changed (+/-)', 'number', 'num')}
              ${sortableHeader('Coding credits / PR', 'number', 'num')}
              ${sortableHeader('Coding credits / net LOC', 'number', 'num')}
              ${sortableHeader('AI-assisted PRs', 'number', 'num')}
              ${sortableHeader('Industry sessions', 'number', 'num')}
            </tr>
          </thead>
          <tbody>${userRows}</tbody>
        </table>
      </div>
      <div class="table-pagination" data-table-pagination>
        <div class="table-pagination-group">
          <span data-pagination-range>0–0 of 0 users</span>
        </div>
        <div class="table-pagination-group">
          <span>Items per page</span>
          <select class="page-size-select" aria-label="Items per page" data-page-size>
            <option value="10" selected>10</option>
            <option value="25">25</option>
            <option value="50">50</option>
            <option value="100">100</option>
            <option value="all">All</option>
          </select>
          <button type="button" class="pagination-button" data-page-previous>Previous</button>
          <span data-pagination-page>0 / 0</span>
          <button type="button" class="pagination-button" data-page-next>Next</button>
        </div>
      </div>
      <div class="gap-note"><strong>Attribution gap / margin of error:</strong> ${escapeHtml(attributionGapNote)} were not fully connected across Industry usage, PR, and ticket metadata. Delivery-matched coverage is ${formatPercent(metrics.attributionGaps.deliveryMatchedTokenRate)} of coding-related Industry credits and ${formatPercent(metrics.attributionGaps.deliveryMatchedSessionRate)} of sessions; ${formatNumber(metrics.attributionGaps.pullRequestsWithoutTicketLinks)} PRs lacked ticket links and ${formatNumber(metrics.attributionGaps.pullRequestsWithoutIndustryAttribution)} PRs lacked Industry attribution.</div>
    </section>

    ${checkedRepositoriesSection(metrics.checkedRepositories)}

  <script>
    (() => {
      const table = document.querySelector('[data-sortable-table]');
      if (!table) return;

      const tbody = table.querySelector('tbody');
      const headers = Array.from(table.querySelectorAll('th'));
      const buttons = Array.from(table.querySelectorAll('.sort-button'));
      const rows = Array.from(tbody.querySelectorAll('tr'));
      const pageSizeSelect = document.querySelector('[data-page-size]');
      const previousButton = document.querySelector('[data-page-previous]');
      const nextButton = document.querySelector('[data-page-next]');
      const rangeLabel = document.querySelector('[data-pagination-range]');
      const pageLabel = document.querySelector('[data-pagination-page]');
      let sortedIndex = -1;
      let sortedDirection = 'ascending';
      let currentPage = 0;

      const compareCells = (aCell, bCell, sortType, direction) => {
        const aValue = aCell?.dataset.sortValue ?? '';
        const bValue = bCell?.dataset.sortValue ?? '';
        const aMissing = aValue === '';
        const bMissing = bValue === '';
        if (aMissing || bMissing) {
          return aMissing === bMissing ? 0 : aMissing ? 1 : -1;
        }

        const comparison =
          sortType === 'number'
            ? Number(aValue) - Number(bValue)
            : aValue.localeCompare(bValue, undefined, { sensitivity: 'base' });
        return direction === 'ascending' ? comparison : -comparison;
      };

      const getPageSize = () =>
        pageSizeSelect?.value === 'all'
          ? rows.length
          : Number(pageSizeSelect?.value || 10);

      const renderPage = () => {
        const pageSize = Math.max(1, getPageSize());
        const totalPages = Math.max(1, Math.ceil(rows.length / pageSize));
        currentPage = Math.min(currentPage, totalPages - 1);
        const start = currentPage * pageSize;
        const end = Math.min(start + pageSize, rows.length);

        rows.forEach((row, index) => {
          row.hidden = index < start || index >= end;
          tbody.appendChild(row);
        });

        if (rangeLabel) {
          rangeLabel.textContent =
            rows.length > 0
              ? String(start + 1) + '–' + String(end) + ' of ' + String(rows.length) + ' users'
              : 'No matching users';
        }
        if (pageLabel) {
          pageLabel.textContent =
            rows.length > 0
              ? String(currentPage + 1) + ' / ' + String(totalPages)
              : '0 / 0';
        }
        if (previousButton) previousButton.disabled = currentPage === 0;
        if (nextButton) nextButton.disabled = currentPage >= totalPages - 1;
      };

      for (const button of buttons) {
        button.addEventListener('click', () => {
          const header = button.closest('th');
          const columnIndex = headers.indexOf(header);
          const sortType = button.dataset.sortType || 'text';
          const nextDirection =
            sortedIndex === columnIndex && sortedDirection === 'descending'
              ? 'ascending'
              : sortedIndex === columnIndex
                ? 'descending'
                : sortType === 'number'
                  ? 'descending'
                  : 'ascending';

          sortedIndex = columnIndex;
          sortedDirection = nextDirection;
          for (const item of headers) item.setAttribute('aria-sort', 'none');
          header.setAttribute('aria-sort', nextDirection);

          rows
            .sort((a, b) =>
              compareCells(
                a.children[columnIndex],
                b.children[columnIndex],
                sortType,
                nextDirection
              )
            );
          currentPage = 0;
          renderPage();
        });
      }

      pageSizeSelect?.addEventListener('change', () => {
        currentPage = 0;
        renderPage();
      });
      previousButton?.addEventListener('click', () => {
        currentPage = Math.max(0, currentPage - 1);
        renderPage();
      });
      nextButton?.addEventListener('click', () => {
        currentPage += 1;
        renderPage();
      });

      renderPage();
    })();
  </script>
    <section class="card">
      <div class="section-header">
        <span class="section-title">Caveats</span>
        <span class="section-divider"></span>
      </div>
      <ul>${caveats}</ul>
    </section>

    <div class="footer">Generated by Industry Agent Effectiveness</div>
  </main>
</body>
</html>`;
}
