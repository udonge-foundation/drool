import { useRef, useState } from 'react';

import { logException, logWarn } from '@industry/logging';

import { getI18n } from '@/i18n';
import { VSCodeExtensionStatus } from '@/services/enums';
import { getSettingsService } from '@/services/SettingsService';
import { VSCodeCliNotAvailableError } from '@/utils/errors';
import { ideDetector } from '@/utils/ide-detector';

/**
 * Custom hook that handles VSCode extension status for both startup prompting and settings menu
 */
export function useVSCodeExtension() {
  const [status, setStatus] = useState<VSCodeExtensionStatus>(
    VSCodeExtensionStatus.CHECKING
  );
  const [installedVersion, setInstalledVersion] = useState<string | null>(null);
  const checkStarted = useRef(false);

  // Perform check during render (similar to useAuthentication pattern)
  if (!checkStarted.current && status === VSCodeExtensionStatus.CHECKING) {
    checkStarted.current = true;

    void (async () => {
      try {
        // Get the current IDE type
        const ideInfo = ideDetector.detectIde();
        const ideType = ideInfo.type;

        // Check if extension is already installed
        const isInstalled = await ideDetector.isExtensionInstalled();
        if (isInstalled) {
          const version = await ideDetector.getInstalledExtensionVersion();
          setInstalledVersion(version);
          setStatus(VSCodeExtensionStatus.INSTALLED);

          // For app startup: if already installed, skip prompting
          const settings = getSettingsService();
          if (!settings.hasBeenPromptedForIdeExtension(ideType)) {
            settings.setIdeExtensionPromptedAt(ideType);
          }
          return;
        }

        // Extension not installed - check if we should prompt for installation
        const settings = getSettingsService();
        const hasBeenPrompted =
          settings.hasBeenPromptedForIdeExtension(ideType);

        if (ideDetector.isRunningInVSCode() && !hasBeenPrompted) {
          setStatus(VSCodeExtensionStatus.SHOULD_PROMPT);
        } else {
          setStatus(VSCodeExtensionStatus.NOT_INSTALLED);
        }
      } catch (error) {
        if (error instanceof VSCodeCliNotAvailableError) {
          logWarn('VSCode CLI is not available', { error });
        } else {
          logException(error, 'Error checking VSCode extension status');
        }
        // On any errors, skip the prompt for startup but show unavailable for settings
        setStatus(VSCodeExtensionStatus.UNAVAILABLE);
      }
    })();
  }

  const handleVSCodeInstall = async () => {
    // If already installing, return early
    if (status === VSCodeExtensionStatus.INSTALLING) {
      return;
    }

    // If unavailable, return early
    if (status === VSCodeExtensionStatus.UNAVAILABLE) {
      return;
    }

    // Set installing status immediately to update UI
    setStatus(VSCodeExtensionStatus.INSTALLING);

    // Use setTimeout to ensure the UI update happens first
    setTimeout(async () => {
      try {
        // Add timeout protection (60 seconds)
        const installPromise = ideDetector.checkAndInstallExtension({
          forceCheck: true,
        });

        const timeoutPromise = new Promise<boolean>((_, reject) => {
          setTimeout(() => reject(new Error('Installation timeout')), 60000);
        });

        const success = await Promise.race([installPromise, timeoutPromise]);

        if (success) {
          const version = await ideDetector.getInstalledExtensionVersion();
          setInstalledVersion(version);
          setStatus(VSCodeExtensionStatus.INSTALLED);
        } else {
          setInstalledVersion(null);
          setStatus(VSCodeExtensionStatus.NOT_INSTALLED);
        }
      } catch (error) {
        logException(error, 'Error installing VSCode extension');
        setInstalledVersion(null);
        setStatus(VSCodeExtensionStatus.NOT_INSTALLED);
      }
    }, 0);
  };

  const getVSCodeStatusText = () => {
    const t = getI18n().t;
    switch (status) {
      case VSCodeExtensionStatus.CHECKING:
        return t('common:ideExtension.statusChecking');
      case VSCodeExtensionStatus.INSTALLED:
        return installedVersion
          ? t('common:ideExtension.statusInstalled', {
              version: installedVersion,
            })
          : t('common:ideExtension.statusInstalledNoVersion');
      case VSCodeExtensionStatus.NOT_INSTALLED:
        return t('common:ideExtension.statusNotInstalled');
      case VSCodeExtensionStatus.INSTALLING:
        return t('common:ideExtension.statusInstalling');
      case VSCodeExtensionStatus.UNAVAILABLE:
        return t('common:ideExtension.statusVSCodeCLINotAvailable');
      case VSCodeExtensionStatus.SHOULD_PROMPT:
        return t('common:ideExtension.statusReadyToInstall');
      case VSCodeExtensionStatus.SKIP:
        return t('common:ideExtension.statusNotAvailable');
      default:
        return t('common:ideExtension.statusUnknown');
    }
  };

  return {
    status,
    setStatus,
    installedVersion,
    handleVSCodeInstall,
    getVSCodeStatusText,
  };
}
