import {
  RelayAuthMethod,
  RelayAuthResponseType,
} from '@industry/common/relay/enums';
import { RelayAuthenticateResponseSchema } from '@industry/common/relay/schemas';
import { RelayCloseCode } from '@industry/common/shared';
import { logWarn } from '@industry/logging';
import { MetaError } from '@industry/logging/errors';
import { OtelTracing } from '@industry/logging/tracing';

import type { RelayAuthTransport } from './types';
import type { Context } from '@opentelemetry/api';

const AUTH_TIMEOUT_MS = 10_000;

export function authenticateRelay(
  transport: RelayAuthTransport,
  token: string,
  ctx: Context
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;

    /* eslint-disable no-use-before-define -- mutual recursion between settle/handlers */
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      transport.removeMessageListener(onMessage);
      if (transport.removeCloseListener) transport.removeCloseListener(onClose);
      if (transport.removeErrorListener) transport.removeErrorListener(onError);
      fn();
    };

    const onMessage = (data: string) => {
      let json: unknown;
      try {
        json = JSON.parse(data);
      } catch (err) {
        logWarn('Failed to parse relay auth message', { cause: err });
        return;
      }
      const result = RelayAuthenticateResponseSchema.safeParse(json);
      if (!result.success) return;

      const response = result.data;
      if (response.type === RelayAuthResponseType.AuthOk) {
        settle(() => resolve());
      } else {
        settle(() =>
          reject(
            new MetaError(
              'message' in response ? response.message : 'Relay auth rejected',
              { code: RelayCloseCode.Unauthorized }
            )
          )
        );
      }
    };

    const onClose = () => {
      settle(() =>
        reject(new MetaError('Connection closed during relay authentication'))
      );
    };

    const onError = (err: Error) => {
      settle(() => reject(new MetaError(err.message, { cause: err })));
    };
    /* eslint-enable no-use-before-define */

    transport.addMessageListener(onMessage);
    if (transport.addCloseListener) transport.addCloseListener(onClose);
    if (transport.addErrorListener) transport.addErrorListener(onError);

    const timer = setTimeout(() => {
      settle(() => reject(new MetaError('Relay authentication timeout')));
    }, AUTH_TIMEOUT_MS);

    const _meta: { traceparent?: string; tracestate?: string } =
      OtelTracing.injectContext({}, ctx);
    transport.send(
      JSON.stringify({
        method: RelayAuthMethod.AUTHENTICATE,
        token,
        ...(_meta.traceparent ? { _meta } : {}),
      })
    );
  });
}
