import { JSONUIProvider, Renderer } from '@json-render/ink';
import { Box } from 'ink';
import { Component } from 'react';

import { logWarn } from '@industry/logging';

import type { JsonRenderSpec } from '@industry/utils/jsonRender';
import type { ErrorInfo, ReactNode } from 'react';

interface JsonRenderBlockProps {
  spec: JsonRenderSpec;
  maxWidth?: number;
}

interface JsonRenderErrorBoundaryProps {
  children: ReactNode;
  resetKey: unknown;
}

interface JsonRenderErrorBoundaryState {
  hasError: boolean;
  resetKey: unknown;
}

class JsonRenderErrorBoundary extends Component<
  JsonRenderErrorBoundaryProps,
  JsonRenderErrorBoundaryState
> {
  constructor(props: JsonRenderErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, resetKey: props.resetKey };
  }

  static getDerivedStateFromProps(
    props: JsonRenderErrorBoundaryProps,
    state: JsonRenderErrorBoundaryState
  ): JsonRenderErrorBoundaryState | null {
    if (props.resetKey === state.resetKey) {
      return null;
    }

    return { hasError: false, resetKey: props.resetKey };
  }

  static getDerivedStateFromError(): Pick<
    JsonRenderErrorBoundaryState,
    'hasError'
  > {
    return { hasError: true };
  }

  componentDidCatch(error: Error, _errorInfo: ErrorInfo): void {
    logWarn('Failed to render CLI JSON render block', { cause: error });
  }

  render(): ReactNode {
    const { children } = this.props;
    const { hasError } = this.state;

    if (hasError) {
      return null;
    }

    return children;
  }
}

export function JsonRenderBlock({ spec, maxWidth }: JsonRenderBlockProps) {
  const validSpec = !spec || !spec.root || !spec.elements ? null : spec;

  if (!validSpec) {
    return null;
  }

  return (
    <Box flexDirection="column" width={maxWidth}>
      <JsonRenderErrorBoundary resetKey={validSpec}>
        <JSONUIProvider initialState={{}}>
          <Renderer spec={validSpec} />
        </JSONUIProvider>
      </JsonRenderErrorBoundary>
    </Box>
  );
}
