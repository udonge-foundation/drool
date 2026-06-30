import path from 'path';

import { logWarn } from '@industry/logging';

import { DynamicContextDiscovery } from '@/utils/dynamicContextDiscovery';
import {
  findAllAgentsMdGuidelines,
  findAllDesignMdGuidelines,
} from '@/utils/industryPaths';
import type { CommandBlock } from '@/utils/types';

const MAX_GUIDELINES_TOTAL_SIZE = 80_000; // 80k characters

function getGuidelineDisplayPath(guideline: {
  filePath: string;
  fileName: string;
  isPersonal: boolean;
}): string {
  if (!guideline.isPersonal) {
    return guideline.filePath;
  }

  return `~/${path.basename(path.dirname(guideline.filePath))}/${guideline.fileName}`;
}

export async function getGuidelinesInfo(
  currentFolder: string
): Promise<CommandBlock[]> {
  const guidelines = await findAllAgentsMdGuidelines({
    startPath: currentFolder,
  });

  if (guidelines.length === 0) {
    const discovery = DynamicContextDiscovery.getInstance();
    discovery.seedLoadedGuidelines([]);
    return [];
  }

  const blocks: CommandBlock[] = [];
  const includedFilePaths: string[] = [];
  let totalSize = 0;

  for (const guideline of guidelines) {
    const displayPath = getGuidelineDisplayPath(guideline);

    const wrappedContent = `<coding_guidelines>\n${guideline.content.trimEnd()}\n</coding_guidelines>`;
    const blockSize = wrappedContent.length;

    // Check if adding this block would exceed the limit
    if (totalSize + blockSize > MAX_GUIDELINES_TOTAL_SIZE) {
      const remainingSpace = MAX_GUIDELINES_TOTAL_SIZE - totalSize;

      // Only include partial content if we have meaningful space (>200 chars)
      if (remainingSpace > 200) {
        // Calculate how much content we can fit
        const availableContentSpace = remainingSpace - 100; // Reserve space for wrapper + marker
        const trimmedContent = guideline.content.slice(
          0,
          availableContentSpace
        );

        blocks.push({
          cmd: `cat ${displayPath}`,
          out: `<coding_guidelines>\n${trimmedContent.trimEnd()}\n... [truncated - guidelines exceed ${MAX_GUIDELINES_TOTAL_SIZE} character limit]\n</coding_guidelines>`,
        });
      }

      // Log warning about truncation
      logWarn('Guidelines truncated due to size limit', {
        totalCount: guidelines.length,
        fileCount: blocks.length,
        skippedCount: guidelines.length - blocks.length,
      });
      break; // Stop processing remaining files
    }

    // Add block normally
    blocks.push({
      cmd: `cat ${displayPath}`,
      out: wrappedContent,
    });
    includedFilePaths.push(guideline.filePath);
    totalSize += blockSize;
  }

  // Seed only guidelines that were fully included in the output,
  // so truncated guidelines remain eligible for dynamic discovery later.
  const discovery = DynamicContextDiscovery.getInstance();
  discovery.seedLoadedGuidelines(includedFilePaths);

  return blocks;
}

export async function getDesignGuidelinesInfo(
  currentFolder: string
): Promise<CommandBlock[]> {
  const guidelines = await findAllDesignMdGuidelines({
    startPath: currentFolder,
  });
  if (guidelines.length === 0) {
    return [];
  }

  const blocks: CommandBlock[] = [];
  let totalSize = 0;

  for (const guideline of guidelines) {
    const displayPath = getGuidelineDisplayPath(guideline);

    const wrappedContent = `<design_guidelines>\n${guideline.content.trimEnd()}\n</design_guidelines>`;
    const blockSize = wrappedContent.length;

    if (totalSize + blockSize > MAX_GUIDELINES_TOTAL_SIZE) {
      const remainingSpace = MAX_GUIDELINES_TOTAL_SIZE - totalSize;

      if (remainingSpace > 200) {
        const availableContentSpace = remainingSpace - 100;
        const trimmedContent = guideline.content.slice(
          0,
          availableContentSpace
        );

        blocks.push({
          cmd: `cat ${displayPath}`,
          out: `<design_guidelines>\n${trimmedContent.trimEnd()}\n... [truncated - guidelines exceed ${MAX_GUIDELINES_TOTAL_SIZE} character limit]\n</design_guidelines>`,
        });
      }

      logWarn('Design guidelines truncated due to size limit', {
        totalCount: guidelines.length,
        fileCount: blocks.length,
        skippedCount: guidelines.length - blocks.length,
      });
      break;
    }

    blocks.push({
      cmd: `cat ${displayPath}`,
      out: wrappedContent,
    });
    totalSize += blockSize;
  }

  return blocks;
}
