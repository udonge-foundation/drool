import { useMemo } from 'react';

import { detectLanguage } from '@/utils/syntaxHighlighter/highlight';

export function useLanguageFromFilePath(filePath?: string): string | undefined {
  return useMemo(() => {
    if (!filePath) return undefined;
    const ext = filePath.split('.').pop() ?? '';
    return detectLanguage(ext);
  }, [filePath]);
}
