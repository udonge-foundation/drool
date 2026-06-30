import {
  INDUSTRY_CLI_BANNER,
  DYNAMIC_CONFIG_SCHEMAS,
} from '@industry/common/feature-flags';
import { logWarn } from '@industry/logging';
import { fetchDynamicConfigs } from '@industry/runtime/feature-flags';

import type { BannerContent, BannerData } from '@/services/types';

const EMPTY: BannerContent = { header: null, footer: null };

function toBannerData(title: string, body: string): BannerData | null {
  if (title.trim() && body.trim()) {
    return { title: title.trim(), body: body.trim() };
  }
  return null;
}

export async function fetchBanners(): Promise<BannerContent> {
  try {
    const configs = await fetchDynamicConfigs();
    const schema = DYNAMIC_CONFIG_SCHEMAS[INDUSTRY_CLI_BANNER];
    const config = schema.parse(configs[INDUSTRY_CLI_BANNER] ?? {});

    return {
      header: toBannerData(config.headerTitle, config.headerBody),
      footer: toBannerData(config.footerTitle, config.footerBody),
    };
  } catch (err) {
    logWarn('[BannerService] Failed to fetch banner config', { cause: err });
    return EMPTY;
  }
}
