import { parseAskUserQuestionnaire as parseSharedAskUserQuestionnaire } from '@industry/utils/askUser';

import type { AskUserParsedQuestionnaire } from '@/utils/askUser/types';

export function parseAskUserQuestionnaire(
  questionnaire: string
): AskUserParsedQuestionnaire {
  return parseSharedAskUserQuestionnaire(questionnaire);
}
