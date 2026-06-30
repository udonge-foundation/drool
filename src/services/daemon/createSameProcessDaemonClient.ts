import { MachineType } from '@industry/common/daemon';
import {
  DaemonClient,
  InProcessDaemonClientTransport,
} from '@industry/daemon-client';
import { SameProcessTransport } from '@industry/daemon-core/same-process';
import { JsonRpcErrorCode } from '@industry/drool-sdk-ext/protocol/shared';
import { AuthenticationError } from '@industry/logging/errors';

import type {
  CreateSameProcessDaemonClientOptions,
  SameProcessDaemonClientHandle,
} from '@/services/daemon/types';

import type { DaemonUser } from '@industry/daemon-core/same-process';

function assertValidInheritedUser(user: DaemonUser): void {
  if (!user || !user.userId || !user.orgId) {
    throw new AuthenticationError(
      'Authentication failed. Please log in using /provider or configure a provider.',
      {
        code: JsonRpcErrorCode.AUTHENTICATION_ERROR,
        reason: 'missing_authed_user_or_org',
        value: {
          hasUserId: !!user?.userId,
          hasOrgId: !!user?.orgId,
        },
      }
    );
  }
}

export function createSameProcessDaemonClient(
  opts: CreateSameProcessDaemonClientOptions
): SameProcessDaemonClientHandle {
  let clientOnMessage: ((frame: string) => void) | undefined;
  let server: SameProcessTransport | null = null;

  const transport = new InProcessDaemonClientTransport({
    connect: async () => {
      const { connectionHandler, user } = await opts.connect();
      assertValidInheritedUser(user);
      server = new SameProcessTransport({
        user,
        connectionHandler,
        deliverToClient: (frame) => clientOnMessage?.(frame),
      });
      server.start();
    },
    disconnect: () => {
      server?.stop();
      server = null;
    },
    sendMessage: (frame) => server?.handleInboundFrame(frame),
    onMessage: (handler) => {
      clientOnMessage = handler;
      return () => {
        clientOnMessage = undefined;
      };
    },
  });

  const client = new DaemonClient({
    machineType: MachineType.Local,
    requestTimeout: opts.requestTimeout,
    transport,
  });

  return {
    client,
    dispose: () => transport.disconnect(),
  };
}
