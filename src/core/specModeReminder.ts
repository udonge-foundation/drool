type SpecModeReminderOptions = {
  isAskUserEnabled: boolean;
  isNonOpenAI: boolean;
};

export function buildSpecModeReminder({
  isAskUserEnabled,
  isNonOpenAI,
}: SpecModeReminderOptions): string {
  const sections: string[] = [
    `Spec mode is active. Do NOT edit files, change configuration, make commits, issue writes to external systems (e.g., Linear/GitHub/Slack API writes, starting services or processes), or otherwise mutate the repo or system state until the user approves the spec. Read-only tools remain available: read files, run non-mutating commands, and fetch linked artifacts (tickets, bug reports, logs/traces, Sentry/Axiom, Slack threads, linked PRs, design docs), subject to autonomy and sandbox rules.`,
    `When your plan is ready, present it by calling ExitSpecMode; the user will be prompted to confirm or edit.`,
  ];

  if (isAskUserEnabled) {
    sections.push(
      `Use the AskUser tool to gather requirements, clarify decisions, and choose among viable implementation approaches before finalizing your spec. If there are several equally strong alternatives, or if the user asks for options to go through, review, or choose from, first output the options with enough detail for the user to compare them, then call AskUser with a concise choice prompt containing only the option labels. Do NOT call ExitSpecMode with a plan that still lists multiple unresolved options. After the user chooses, call ExitSpecMode with one concrete plan based on that choice.`
    );
  }

  if (isNonOpenAI) {
    sections.push(
      `IMPORTANT: Do not make calls to Edit, Create, and ApplyPatch tools when spec mode is active.`
    );
  }

  sections.push(
    `When your spec involves architecture, data flows, state machines, or complex interactions, include Mermaid diagrams (using \`\`\`mermaid code blocks) in your plan to visualize the design. Only include diagrams when they add clarity -- not for simple or linear changes. Keep participant/node names short (under ~20 chars) so diagrams render as ASCII art in the terminal. Use short aliases and add a legend comment below the diagram if full names are needed. Only use these supported diagram types: flowchart/graph, stateDiagram, sequenceDiagram, classDiagram, erDiagram, xychart-beta. Do NOT use gantt, pie, gitGraph, mindmap, timeline, journey, quadrantChart, sankey, or block diagrams as they cannot be rendered.`
  );

  return `\n${sections.join('\n\n')}\n`;
}
