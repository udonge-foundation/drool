/**
 * Sound playback callbacks. The TUI bootstrap registers concrete handlers
 * that resolve user settings and invoke the audio backend; daemon-mode
 * processes leave them null so the daemon's import graph never pulls in
 * `soundPlayer` (and transitively ink, via KeypressProvider).
 */
type SoundCallback = () => void;

let awaitingInputSoundPlayer: SoundCallback | null = null;
let completionSoundPlayer: SoundCallback | null = null;

export function setAwaitingInputSoundPlayer(
  player: SoundCallback | null
): void {
  awaitingInputSoundPlayer = player;
}

export function setCompletionSoundPlayer(player: SoundCallback | null): void {
  completionSoundPlayer = player;
}

export function playAwaitingInputSound(): void {
  awaitingInputSoundPlayer?.();
}

export function playCompletionSoundIfRegistered(): void {
  completionSoundPlayer?.();
}
