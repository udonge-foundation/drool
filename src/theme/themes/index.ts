import { BuiltInThemeName } from '@industry/common/settings/enums';

import { industryDark } from '@/theme/themes/industry-dark';
import { industryLight } from '@/theme/themes/industry-light';
import type { DroolTheme } from '@/theme/types';

// eslint-disable-next-line no-barrel-files/no-barrel-files
export { industryDark };

/** All built-in themes keyed by name */
// eslint-disable-next-line industry/constants-file-organization
export const builtInThemes: Record<string, DroolTheme> = {
  [BuiltInThemeName.IndustryDark]: industryDark,
  [BuiltInThemeName.IndustryLight]: industryLight,
};
