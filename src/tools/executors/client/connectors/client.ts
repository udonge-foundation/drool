import {
  CONNECTORS_API_ROUTES,
  ListConnectorToolsResponseSchema,
  type ConnectorTool,
  type ListConnectorToolsRequest,
} from '@industry/common/api/connectors';
import { fetch } from '@industry/drool-core/api/fetch';

import { getIndustryApiConfig } from '@/api/config';
import { JSON_HEADERS } from '@/tools/executors/client/connectors/constants';
import { ConnectorToolsResponseError } from '@/tools/executors/client/connectors/errors';
import type { FetchConnectorToolsOptions } from '@/tools/executors/client/connectors/types';

/**
 * Fetch the connector tools available to the current user via the Merge Agent
 * Handler `tools/list` endpoint. Shared by the ConnectorSearch executor and the
 * pre-turn connector-tools reminder.
 *
 * Throws on network/HTTP failure and {@link ConnectorToolsResponseError} on an
 * unexpected payload shape.
 */
export async function fetchConnectorTools(
  authenticatedOnly?: boolean,
  options?: FetchConnectorToolsOptions
): Promise<ConnectorTool[]> {
  const { signal, timeoutMs, discoveryOnly } = options ?? {};
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let requestSignal = signal;
  if (timeoutMs != null) {
    const controller = new AbortController();
    timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    // Honor the caller's signal alongside the timeout: aborting it must still
    // abort the request even though the timeout controller's signal is used.
    if (signal) {
      if (signal.aborted) {
        controller.abort();
      } else {
        signal.addEventListener('abort', () => controller.abort(), {
          once: true,
        });
      }
    }
    requestSignal = controller.signal;
  }

  try {
    const body: ListConnectorToolsRequest = {
      authenticatedOnly,
      ...(discoveryOnly ? { discoveryOnly } : {}),
    };
    const response = await fetch(
      CONNECTORS_API_ROUTES.toolsList,
      {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify(body),
        ...(requestSignal ? { signal: requestSignal } : {}),
      },
      getIndustryApiConfig()
    );
    const parsed = ListConnectorToolsResponseSchema.safeParse(
      await response.json()
    );
    if (!parsed.success) {
      throw new ConnectorToolsResponseError();
    }
    return parsed.data.tools;
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}
