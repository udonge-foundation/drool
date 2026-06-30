import { Box, Text } from 'ink';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { fetch as industryFetch } from '@industry/drool-core/api/fetch';
import { logException } from '@industry/logging';
import { MetaError } from '@industry/logging/errors';
import * as runtimeAuth from '@industry/runtime/auth';

import { getIndustryApiConfig } from '@/api/config';
import { COLORS } from '@/components/chat/themedColors';
import { getWindowedListSlice } from '@/components/common/getWindowedListSlice';
import { MenuContainer } from '@/components/common/MenuContainer';
import type {
  ActiveOrganizationOption,
  ActiveOrganizationOptionsResult,
} from '@/components/types';
import { getRuntimeAuthConfig } from '@/environment';
import { useKeypressHandler } from '@/hooks/useKeypressHandler';
import { useMenuNavigation } from '@/hooks/useMenuNavigation';
import { useMountEffect } from '@/hooks/useMountEffect';
import { sanitizeTerminalDisplayText } from '@/utils/sanitizeTerminalDisplayText';

type CurrentOrganization = {
  id: string;
  name: string;
};

type CurrentUserResponse = {
  organization: CurrentOrganization | null;
  rootOrganization?: CurrentOrganization | null;
  subOrganizationMemberships?: CurrentOrganization[];
};

function sanitizeOrganizationName(name: string): string {
  return sanitizeTerminalDisplayText(name, { stripSgr: true });
}

export async function fetchActiveOrganizationOptions(): Promise<ActiveOrganizationOptionsResult> {
  const response = await industryFetch(
    '/api/app/auth/me',
    { method: 'GET' },
    getIndustryApiConfig()
  );

  if (!response.ok) {
    throw new MetaError('Failed to load organizations', {
      value: { status: response.status },
    });
  }

  const currentUser = (await response.json()) as CurrentUserResponse;
  const optionsById = new Map<string, ActiveOrganizationOption>();

  for (const organization of currentUser.subOrganizationMemberships ?? []) {
    optionsById.set(organization.id, {
      id: organization.id,
      name: sanitizeOrganizationName(organization.name),
      kind: 'sub',
    });
  }

  const options = Array.from(optionsById.values());
  const activeOrganizationId = currentUser.organization?.id ?? null;
  const activeOrganizationName =
    options.find((option) => option.id === activeOrganizationId)?.name ??
    (currentUser.organization?.name
      ? sanitizeOrganizationName(currentUser.organization.name)
      : null) ??
    null;

  return { activeOrganizationId, activeOrganizationName, options };
}

type ActiveOrganizationSelectorProps = {
  onCancel: () => void;
  onSelectComplete: (option: ActiveOrganizationOption) => void;
};

export function ActiveOrganizationSelector({
  onCancel,
  onSelectComplete,
}: ActiveOrganizationSelectorProps) {
  const { t } = useTranslation();
  const [result, setResult] = useState<ActiveOrganizationOptionsResult | null>(
    null
  );
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  useMountEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const nextResult = await fetchActiveOrganizationOptions();
        if (!cancelled) {
          setResult(nextResult);
        }
      } catch (err) {
        logException(err, 'Failed to load active organization options');
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  });

  const options = result?.options ?? [];
  const runtimeAuthConfig = getRuntimeAuthConfig();
  const initialIndex = Math.max(
    0,
    options.findIndex((option) => option.id === result?.activeOrganizationId)
  );

  useKeypressHandler(
    (_input, key) => {
      if (key.escape) {
        onCancel();
      }
    },
    { isActive: !result }
  );

  const { selectedIndex } = useMenuNavigation({
    items: options,
    initialIndex,
    wrapAround: true,
    isActive: Boolean(result) && !isSaving,
    onSelect: (option) => {
      setIsSaving(true);
      void runtimeAuth
        .setActiveOrganizationId(option.id, runtimeAuthConfig)
        .then(async () => {
          runtimeAuth.clearUserCache();
          await runtimeAuth.getRegion(runtimeAuthConfig);
        })
        .then(() => {
          onSelectComplete(option);
        })
        .catch((err) => {
          logException(err, 'Failed to save active organization');
          setError(err instanceof Error ? err.message : String(err));
          setIsSaving(false);
        });
    },
    onCancel,
  });

  const visibleRows = 10;
  const { visibleItems, padCount } = useMemo(
    () =>
      getWindowedListSlice({
        items: options,
        selectedIndex,
        visibleCount: visibleRows,
        anchorRow: 3,
      }),
    [options, selectedIndex]
  );

  return (
    <MenuContainer
      helpText="↑↓ navigate · Enter select · Esc cancel"
      paddingY={0}
      title={t('common:activeOrganizationSelector.title')}
    >
      {result && options.length > 0 && (
        <Box marginBottom={1}>
          <Text color={COLORS.text.muted}>
            {t('common:activeOrganizationSelector.description')}
          </Text>
        </Box>
      )}
      {!result && !error && (
        <Text color={COLORS.text.muted}>
          {t('common:activeOrganizationSelector.loading')}
        </Text>
      )}
      {error && <Text color={COLORS.error}>{error}</Text>}
      {result && options.length === 0 && (
        <Text color={COLORS.text.muted}>
          {t('common:activeOrganizationSelector.empty')}
        </Text>
      )}
      {visibleItems.map((option) => {
        const index = options.indexOf(option);
        const isSelected = index === selectedIndex;
        const isCurrent = option.id === result?.activeOrganizationId;

        return (
          <Box key={option.id}>
            <Box width={2}>
              <Text color={isCurrent ? COLORS.primary : undefined}>
                {isCurrent ? '●' : ' '}
              </Text>
            </Box>
            <Text
              bold={isSelected}
              color={isSelected ? COLORS.text.primary : undefined}
            >
              {option.name}
            </Text>
          </Box>
        );
      })}
      {padCount > 0 &&
        Array.from({ length: padCount }, (_, index) => (
          <Text key={`pad-${index}`}> </Text>
        ))}
      {isSaving && (
        <Box marginTop={1}>
          <Text color={COLORS.text.muted}>
            {t('common:activeOrganizationSelector.saving')}
          </Text>
        </Box>
      )}
    </MenuContainer>
  );
}
