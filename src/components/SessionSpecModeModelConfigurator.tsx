import { forwardRef } from 'react';

import { SpecModeModelConfigurator } from '@/components/SpecModeModelConfigurator';
import type {
  SpecModeModelConfiguratorProps,
  SpecModeModelConfiguratorRef,
} from '@/components/types';

import type { ReasoningEffort } from '@industry/drool-sdk-ext/protocol/llm';

type SessionSpecModeModelConfiguratorProps = Pick<
  SpecModeModelConfiguratorProps,
  | 'onClose'
  | 'onBack'
  | 'onStateChange'
  | 'currentMainModel'
  | 'currentSpecModel'
  | 'currentMainReasoningEffort'
  | 'currentSpecReasoningEffort'
> & {
  onSpecModelSet?: (
    model: string,
    effort?: ReasoningEffort
  ) => void | Promise<void>;
  onSpecModelCleared?: () => void | Promise<void>;
};

export const SessionSpecModeModelConfigurator = forwardRef<
  SpecModeModelConfiguratorRef,
  SessionSpecModeModelConfiguratorProps
>(function SessionSpecModeModelConfigurator(props, ref) {
  return (
    <SpecModeModelConfigurator
      ref={ref}
      onSetSpecModel={(model, effort) => props.onSpecModelSet?.(model, effort)}
      onClearSpecModel={() => props.onSpecModelCleared?.()}
      {...props}
    />
  );
});
