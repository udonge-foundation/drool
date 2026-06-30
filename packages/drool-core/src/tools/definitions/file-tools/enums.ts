export enum RepoLocationType {
  INDEXED_REPO = 'indexedRepo',
  LOCAL_FILE_REPO = 'localFileRepo', // to be deprecated in favor of fileSystem type
  FILE_SYSTEM = 'fileSystem',
  NON_REPO_FILE = 'nonRepoFile',
}
export enum SaveStatus {
  NOT_SAVED = 'notSaved',
  MANUALLY_SAVED = 'manuallySaved',
  AUTO_SAVED = 'autoSaved',
}
