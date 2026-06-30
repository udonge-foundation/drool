import type { AutomationScheduleChip } from '@/services/automations/types';

export const AUTOMATION_SCHEDULE_CHIPS: readonly AutomationScheduleChip[] = [
  { label: 'daily', value: 'daily' },
  { label: 'weekly', value: 'weekly' },
  { label: 'monthly', value: 'monthly' },
  { label: 'hourly', value: '0 * * * *' },
  { label: 'custom', value: null },
];
