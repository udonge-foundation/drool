/**
 * Module-level terminal focus state shared between KeypressProvider (the
 * sole writer) and downstream consumers like soundPlayer (read-only).
 *
 * Lives outside KeypressProvider.tsx so non-TUI code paths can read the
 * focus state without dragging ink (which KeypressProvider imports via
 * `useStdin`) into their import graph.
 */

let currentTerminalFocusState = true;

export function getTerminalFocusState(): boolean {
  return currentTerminalFocusState;
}

export function setTerminalFocusState(focused: boolean): void {
  currentTerminalFocusState = focused;
}
