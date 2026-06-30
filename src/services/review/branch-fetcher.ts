import { logWarn } from '@industry/logging';

import type { BranchInfo } from '@/components/review/types';
import {
  getAllBranches,
  getCurrentBranch,
  getDefaultBaseBranch,
} from '@/services/git-operations';
import { BranchFetchResult } from '@/services/review/types';

/**
 * Fetch and prepare local branch data for the branch selection screen
 */
export async function fetchBranchData(): Promise<BranchFetchResult> {
  try {
    // Fetch all git data in parallel for better performance
    const [branches, currentBranch, suggestedBaseBranch] = await Promise.all([
      getAllBranches(),
      getCurrentBranch(),
      getDefaultBaseBranch(),
    ]);

    // Sort branches: current first, then suggested base, then alphabetical
    const sortedBranches = branches.sort((a, b) => {
      if (a.isCurrent) return -1;
      if (b.isCurrent) return 1;

      if (a.name === suggestedBaseBranch) return -1;
      if (b.name === suggestedBaseBranch) return 1;

      return a.name.localeCompare(b.name);
    });

    return {
      branches: sortedBranches,
      currentBranch,
      suggestedBaseBranch,
      error: null,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logWarn('Failed to fetch branch data', { error: errorMessage });

    return {
      branches: [],
      currentBranch: null,
      suggestedBaseBranch: null,
      error: errorMessage,
    };
  }
}

/**
 * Filter branches based on search query
 */
export function filterBranches(
  branches: BranchInfo[],
  query: string
): BranchInfo[] {
  if (!query.trim()) {
    return branches;
  }

  const lowerQuery = query.toLowerCase();
  return branches.filter((branch) =>
    branch.name.toLowerCase().includes(lowerQuery)
  );
}
