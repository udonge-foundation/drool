import { exec } from 'node:child_process';
import { promisify } from 'node:util';

import { useCallback, useState } from 'react';

import { logError } from '@industry/logging';

import { ReviewStep } from '@/components/review/enums';
import type {
  CommitInfo,
  ReviewPreset,
  ReviewResults,
} from '@/components/review/types';
import type { UseReviewManager } from '@/hooks/types';

const execAsync = promisify(exec);

const INITIAL_STEP = ReviewStep.Preset;

export function useReviewManager(): UseReviewManager {
  const [show, setShow] = useState(false);
  const [step, setStep] = useState<ReviewStep>(INITIAL_STEP);
  const [preset, setPreset] = useState<ReviewPreset | null>(null);
  const [baseBranch, setBaseBranch] = useState<string | null>(null);
  const [currentBranch, setCurrentBranch] = useState<string | null>(null);
  const [targetCommit, setTargetCommit] = useState<CommitInfo | null>(null);
  const [customInstructions, setCustomInstructions] = useState<string | null>(
    null
  );
  const [reviewResults, setReviewResults] = useState<ReviewResults | null>(
    null
  );
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [onReviewStart, setOnReviewStart] = useState<
    ((openingLine: string, fullMessage: string) => void) | null
  >(null);

  const open = useCallback(
    async (onStart?: (openingLine: string, fullMessage: string) => void) => {
      // Fetch current branch fresh each time the overlay is opened
      try {
        const { stdout } = await execAsync('git rev-parse --abbrev-ref HEAD');
        setCurrentBranch(stdout.trim());
      } catch (err) {
        logError('Failed to get current branch (review manager)', {
          error: err instanceof Error ? err.message : String(err),
        });
        setCurrentBranch(null);
      }

      setShow(true);
      setStep(INITIAL_STEP);
      setPreset(null);
      setBaseBranch(null);
      setTargetCommit(null);
      setCustomInstructions(null);
      setReviewResults(null);
      setError(null);
      setIsLoading(false);
      setOnReviewStart(() => onStart || null);
    },
    []
  );

  const close = useCallback(() => {
    setShow(false);
    // Reset state after a delay to avoid UI flash
    setTimeout(() => {
      setStep(INITIAL_STEP);
      setPreset(null);
      setBaseBranch(null);
      setTargetCommit(null);
      setCustomInstructions(null);
      setReviewResults(null);
      setError(null);
      setIsLoading(false);
      setOnReviewStart(null);
    }, 200);
  }, []);

  const startReview = useCallback(
    (openingLine: string, fullMessage: string) => {
      if (onReviewStart) {
        onReviewStart(openingLine, fullMessage);
        close();
      }
    },
    [onReviewStart, close]
  );

  return {
    show,
    open,
    close,
    step,
    setStep,
    preset,
    setPreset,
    baseBranch,
    setBaseBranch,
    currentBranch,
    targetCommit,
    setTargetCommit,
    customInstructions,
    setCustomInstructions,
    reviewResults,
    setReviewResults,
    error,
    setError,
    isLoading,
    setIsLoading,
    startReview,
  };
}
