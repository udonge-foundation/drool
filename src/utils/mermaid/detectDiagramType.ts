/**
 * Mermaid diagram type detection.
 *
 * Used by the markdown renderer to decide whether `beautiful-mermaid` can
 * render a diagram in the terminal (ASCII) or whether we must route to the
 * external/self-hosted mermaid viewer.
 *
 * `beautiful-mermaid` v1.1.3 supports: flowchart, state diagrams, sequence,
 * class, ER, and xychart-beta. Everything else (gantt, pie, gitGraph,
 * mindmap, timeline, journey, etc.) is unsupported and must fall back.
 */

import { DetectedMermaidType } from '@/utils/mermaid/enums';

const TERMINAL_SUPPORTED: ReadonlySet<DetectedMermaidType> = new Set([
  DetectedMermaidType.Flowchart,
  DetectedMermaidType.StateDiagram,
  DetectedMermaidType.SequenceDiagram,
  DetectedMermaidType.ClassDiagram,
  DetectedMermaidType.ErDiagram,
  DetectedMermaidType.XyChart,
]);

const YAML_FRONTMATTER_REGEX = /^---\s*\n([\s\S]*?)\n---\s*\n?/;

/**
 * Returns the first non-empty, non-YAML-frontmatter, non-directive line of
 * the mermaid source, trimmed.
 */
function firstMeaningfulLine(source: string): string {
  let code = source;
  const yamlMatch = code.match(YAML_FRONTMATTER_REGEX);
  if (yamlMatch) {
    code = code.slice(yamlMatch[0].length);
  }
  const lines = code.split('\n');
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    // Skip mermaid directives like `%%{init: ...}%%`
    if (line.startsWith('%%')) continue;
    return line;
  }
  return '';
}

/**
 * Detect the mermaid diagram type from its source code.
 * Returns `DetectedMermaidType.Unknown` when nothing matches.
 */
export function detectMermaidDiagramType(source: string): DetectedMermaidType {
  const line = firstMeaningfulLine(source);
  if (!line) return DetectedMermaidType.Unknown;

  const head = line.toLowerCase();

  if (head.startsWith('flowchart') || head.startsWith('graph')) {
    return DetectedMermaidType.Flowchart;
  }
  if (head.startsWith('statediagram')) return DetectedMermaidType.StateDiagram;
  if (head.startsWith('sequencediagram')) {
    return DetectedMermaidType.SequenceDiagram;
  }
  if (head.startsWith('classdiagram')) return DetectedMermaidType.ClassDiagram;
  if (head.startsWith('erdiagram')) return DetectedMermaidType.ErDiagram;
  if (head.startsWith('xychart')) return DetectedMermaidType.XyChart;
  if (head.startsWith('gantt')) return DetectedMermaidType.Gantt;
  if (head.startsWith('pie')) return DetectedMermaidType.Pie;
  if (head.startsWith('gitgraph')) return DetectedMermaidType.GitGraph;
  if (head.startsWith('mindmap')) return DetectedMermaidType.Mindmap;
  if (head.startsWith('timeline')) return DetectedMermaidType.Timeline;
  if (head.startsWith('journey')) return DetectedMermaidType.Journey;
  if (head.startsWith('requirementdiagram')) {
    return DetectedMermaidType.RequirementDiagram;
  }
  if (head.startsWith('c4context') || head.startsWith('c4container')) {
    return DetectedMermaidType.C4;
  }
  if (head.startsWith('quadrantchart')) {
    return DetectedMermaidType.QuadrantChart;
  }
  if (head.startsWith('sankey')) return DetectedMermaidType.Sankey;
  if (head.startsWith('block-beta') || head.startsWith('block')) {
    return DetectedMermaidType.Block;
  }

  return DetectedMermaidType.Unknown;
}

/**
 * Does `beautiful-mermaid` (our in-terminal ASCII renderer) support the
 * given diagram type?
 */
export function isTerminalSupportedMermaidType(
  type: DetectedMermaidType
): boolean {
  return TERMINAL_SUPPORTED.has(type);
}
