import { parseMermaid, type MermaidGraph } from 'beautiful-mermaid';

import { detectMermaidDiagramType } from '@/utils/mermaid/detectDiagramType';
import { DetectedMermaidType } from '@/utils/mermaid/enums';

function getAsciiLayoutRootIds(graph: MermaidGraph): Set<string> {
  const roots = new Set<string>();
  const nodesFound = new Set<string>();

  for (const nodeId of graph.nodes.keys()) {
    if (!nodesFound.has(nodeId)) {
      roots.add(nodeId);
    }

    nodesFound.add(nodeId);

    for (const edge of graph.edges) {
      if (edge.source === nodeId) {
        nodesFound.add(edge.target);
      }
    }
  }

  return roots;
}

export function shouldSkipTerminalMermaidRender(source: string): boolean {
  if (detectMermaidDiagramType(source) !== DetectedMermaidType.Flowchart) {
    return false;
  }

  let graph: MermaidGraph;
  try {
    graph = parseMermaid(source);
  } catch {
    return false;
  }

  if (graph.direction === 'LR' || graph.direction === 'RL') {
    return false;
  }

  const rootIds = getAsciiLayoutRootIds(graph);
  const unlabeledIncomingEdgesByRoot = new Map<string, number>();

  for (const edge of graph.edges) {
    if (!rootIds.has(edge.target) || edge.source === edge.target) {
      continue;
    }

    if ((edge.label ?? '').length > 0) {
      continue;
    }

    const count = (unlabeledIncomingEdgesByRoot.get(edge.target) ?? 0) + 1;
    if (count >= 2) {
      return true;
    }
    unlabeledIncomingEdgesByRoot.set(edge.target, count);
  }

  return false;
}
