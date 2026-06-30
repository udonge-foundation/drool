import {
  TUI_SPINNER_DEFAULT_PRESET,
  tuiSpinnerPresets,
} from '@/utils/tuiSpinner/constants';
import type {
  TuiSpinnerPresetDefinition,
  TuiSpinnerPresetInput,
} from '@/utils/tuiSpinner/types';

const MIN_INTERVAL_MS = 1;

function normalizeIntervalMs(intervalMs: number): number {
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    throw new Error('Spinner interval must be a finite number greater than 0.');
  }
  return Math.max(MIN_INTERVAL_MS, Math.floor(intervalMs));
}

function normalizeFrames(frames: readonly string[]): readonly string[] {
  if (frames.length === 0) {
    throw new Error('Spinner must define at least one frame.');
  }

  if (frames.some((frame) => typeof frame !== 'string' || frame.length === 0)) {
    throw new Error('Spinner frames must be non-empty strings.');
  }

  return frames;
}

function normalizeOffset(offset: number, length: number): number {
  if (!Number.isFinite(offset)) {
    throw new Error('Spinner offset must be a finite number.');
  }

  if (length === 0) {
    return 0;
  }

  const normalized = Math.trunc(offset) % length;
  return normalized < 0 ? normalized + length : normalized;
}

function resolvePreset(
  preset: TuiSpinnerPresetInput
): TuiSpinnerPresetDefinition {
  if (typeof preset !== 'object' || preset === null) {
    return tuiSpinnerPresets[preset];
  }

  const defaultPreset = tuiSpinnerPresets[TUI_SPINNER_DEFAULT_PRESET];
  return {
    frames: normalizeFrames(preset.frames),
    intervalMs: normalizeIntervalMs(
      preset.intervalMs ?? defaultPreset.intervalMs
    ),
  };
}

interface TuiSpinnerState {
  readonly frames: readonly string[];
  readonly intervalMs: number;
  readonly offset: number;
}

class TuiSpinner {
  private readonly state: TuiSpinnerState;

  constructor(state: TuiSpinnerState) {
    this.state = state;
  }

  get intervalMs(): number {
    return this.state.intervalMs;
  }

  get length(): number {
    return this.state.frames.length;
  }

  get offset(): number {
    return this.state.offset;
  }

  frame(index: number): string {
    if (!Number.isFinite(index)) {
      throw new Error('Spinner frame index must be a finite number.');
    }

    const frameIndex = normalizeOffset(
      Math.trunc(index) + this.state.offset,
      this.state.frames.length
    );
    return this.state.frames[frameIndex]!;
  }

  withInterval(intervalMs: number): TuiSpinner {
    return new TuiSpinner({
      ...this.state,
      intervalMs: normalizeIntervalMs(intervalMs),
    });
  }

  withOffset(offset: number): TuiSpinner {
    return new TuiSpinner({
      ...this.state,
      offset: normalizeOffset(offset, this.state.frames.length),
    });
  }
}

export function createTuiSpinner(
  preset: TuiSpinnerPresetInput = TUI_SPINNER_DEFAULT_PRESET
): TuiSpinner {
  const resolvedPreset = resolvePreset(preset);
  return new TuiSpinner({
    frames: normalizeFrames(resolvedPreset.frames),
    intervalMs: normalizeIntervalMs(resolvedPreset.intervalMs),
    offset: 0,
  });
}
