/**
 * Auto-stage for session title generation.
 * Tracks whether the title was generated from the first message or first file edit.
 */
export enum SessionTitleAutoStage {
  FirstMessage = 'first_message',
  FirstFileEdit = 'first_file_edit',
}
