import { useState, useCallback, useRef } from 'react';

import { IdeConnectionStatus } from '@/hooks/enums';
import {
  IdeContextState,
  IdeFileInfo,
  IdeSelection,
  IdeDiagnostic,
} from '@/hooks/types';
import { IdeContextManager } from '@/services/IdeContextManager';
import { JetBrainsIdeClient } from '@/services/JetBrainsIdeClient';
import { VSCodeIdeClient } from '@/services/VSCodeIdeClient';

function isSameIdeFile(a: IdeFileInfo | null, b: IdeFileInfo | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.path === b.path && a.fileName === b.fileName && a.isDirty === b.isDirty
  );
}

function isSameSelection(
  a: IdeSelection | null,
  b: IdeSelection | null
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.startLine === b.startLine &&
    a.startCharacter === b.startCharacter &&
    a.endLine === b.endLine &&
    a.endCharacter === b.endCharacter &&
    a.selectedText === b.selectedText
  );
}

function areSameDiagnostics(a: IdeDiagnostic[], b: IdeDiagnostic[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((diagA, index) => {
    const diagB = b[index];
    return (
      diagA.severity === diagB.severity &&
      diagA.message === diagB.message &&
      diagA.source === diagB.source &&
      diagA.code === diagB.code &&
      diagA.range?.start?.line === diagB.range?.start?.line &&
      diagA.range?.start?.character === diagB.range?.start?.character &&
      diagA.range?.end?.line === diagB.range?.end?.line &&
      diagA.range?.end?.character === diagB.range?.end?.character
    );
  });
}

function areSameOpenFiles(a: IdeFileInfo[], b: IdeFileInfo[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((fileA, index) => isSameIdeFile(fileA, b[index]));
}

export function useIdeContext() {
  const [state, setState] = useState<IdeContextState>({
    activeFile: null,
    activeFileSelection: null,
    openFiles: [],
    diagnostics: {},
    connectionStatus: IdeConnectionStatus.Disconnected,
  });

  const [ideClient, setIdeClient] = useState<
    VSCodeIdeClient | JetBrainsIdeClient | undefined
  >(undefined);
  const initializedRef = useRef(false);

  const updateActiveFile = useCallback(
    (file: IdeFileInfo, selection: IdeSelection) => {
      setState((prev) => {
        // Check if file or selection actually changed
        if (
          isSameIdeFile(prev.activeFile, file) &&
          isSameSelection(prev.activeFileSelection, selection)
        ) {
          // No change, return the same state object to prevent re-render
          return prev;
        }

        return {
          ...prev,
          activeFile: file,
          activeFileSelection: selection,
        };
      });
    },
    []
  );

  const updateOpenFiles = useCallback((files: IdeFileInfo[]) => {
    setState((prev) => {
      // Check if open files actually changed
      if (areSameOpenFiles(prev.openFiles, files)) {
        // No change, return the same state object to prevent re-render
        return prev;
      }

      return {
        ...prev,
        openFiles: files,
      };
    });
  }, []);

  const updateDiagnostics = useCallback(
    (filePath: string, diagnostics: IdeDiagnostic[]) => {
      setState((prev) => {
        // Check if diagnostics actually changed
        const existingDiagnostics = prev.diagnostics[filePath] || [];
        if (areSameDiagnostics(existingDiagnostics, diagnostics)) {
          // No change, return the same state object to prevent re-render
          return prev;
        }

        return {
          ...prev,
          diagnostics: {
            ...prev.diagnostics,
            [filePath]: diagnostics,
          },
        };
      });
    },
    []
  );

  const getActiveFileErrorCount = useCallback(() => {
    if (!state.activeFile) return 0;
    const diagnostics = state.diagnostics[state.activeFile.path] || [];
    return diagnostics.filter((d) => d.severity === 0).length;
  }, [state.activeFile, state.diagnostics]);

  const getSelectedLineCount = useCallback(() => {
    if (!state.activeFileSelection) return 0;
    const { startLine, endLine } = state.activeFileSelection;
    return endLine - startLine + 1;
  }, [state.activeFileSelection]);

  const hasSelection = useCallback(() => {
    if (!state.activeFileSelection) return false;
    const { startLine, endLine, startCharacter, endCharacter } =
      state.activeFileSelection;
    // Check if there's actually a selection range (not just cursor position)
    return startLine !== endLine || startCharacter !== endCharacter;
  }, [state.activeFileSelection]);

  // Set connection status
  const setConnectionStatus = useCallback(
    (status: IdeContextState['connectionStatus']) => {
      setState((prev) => {
        if (prev.connectionStatus === status) return prev;
        return { ...prev, connectionStatus: status };
      });
    },
    []
  );

  // Refresh client from manager (for manual connections via /ide command)
  const refreshClientFromManager = useCallback(() => {
    const manager = IdeContextManager.getInstance();
    const client = manager.getIdeClient();
    if (client) {
      setIdeClient(client);
      setConnectionStatus(IdeConnectionStatus.Connected);
    } else {
      setConnectionStatus(IdeConnectionStatus.Disconnected);
    }
  }, [setConnectionStatus]);

  // Initialize MCP client using manager
  if (!initializedRef.current) {
    const manager = IdeContextManager.getInstance();

    // Set connecting status before attempting connection
    setState((prev) => ({
      ...prev,
      connectionStatus: IdeConnectionStatus.Connecting,
    }));

    // Initialize asynchronously
    manager
      .initialize({
        onActiveFileChange: updateActiveFile,
        onOpenFilesChange: updateOpenFiles,
        onDiagnosticsChange: updateDiagnostics,
        onDisconnect: () => {
          setState((prev) => ({
            ...prev,
            connectionStatus: IdeConnectionStatus.Disconnected,
          }));
          setIdeClient(undefined);
        },
      })
      .then((client) => {
        if (client) {
          setIdeClient(client);
          setState((prev) => ({
            ...prev,
            connectionStatus: IdeConnectionStatus.Connected,
          }));
        } else {
          setState((prev) => ({
            ...prev,
            connectionStatus: IdeConnectionStatus.Disconnected,
          }));
        }
      })
      .catch((_err) => {
        // Error handling is done inside the manager
        setState((prev) => ({
          ...prev,
          connectionStatus: IdeConnectionStatus.Disconnected,
        }));
      });

    initializedRef.current = true;
  }

  return {
    state,
    updateActiveFile,
    updateOpenFiles,
    updateDiagnostics,
    getActiveFileErrorCount,
    getSelectedLineCount,
    hasSelection,
    ideClient,
    refreshClientFromManager,
    setConnectionStatus,
  };
}
