import {
  MIN_IDE_EXTENSION_VERSION,
  DYNAMIC_CONFIG_SCHEMAS,
} from '@industry/common/feature-flags';
import { MessageVisibility } from '@industry/drool-sdk-ext/protocol/sessionV2';
import { logException, logInfo } from '@industry/logging';
import { fetchDynamicConfigs } from '@industry/runtime/feature-flags';

import { SlashCommand, CommandContext, CommandResult } from '@/commands/types';
import { MessageType } from '@/hooks/enums';
import { getI18n } from '@/i18n';
import { IdeContextManager } from '@/services/IdeContextManager';
import { ideDetector } from '@/utils/ide-detector';

// eslint-disable-next-line industry/constants-file-organization
export const ideCommand: SlashCommand = {
  name: 'ide',
  description: 'Connect to IDE extension (VSCode, Cursor, Windsurf)',
  execute: async (
    _args: string[],
    context: CommandContext
  ): Promise<CommandResult> => {
    const {
      addEphemeralSystemMessage,
      showIdeExtensionPrompt,
      showIdeInstanceSelector,
      ideClient,
    } = context;

    try {
      // Detect IDE (works both inside and outside IDE terminals)
      const ideInfo = ideDetector.detectIde();
      const { displayName } = ideInfo;

      logInfo('[ide command] Checking IDE extension status', {
        clientType: ideInfo.type,
        displayName,
      });

      // Check connection status first
      const isConnected = ideClient?.isConnected() ?? false;

      if (isConnected) {
        // Already connected - show status with disconnect option
        const instanceInfo =
          IdeContextManager.getInstance().getConnectedInstanceInfo();
        const connectedTo = instanceInfo?.ideName || displayName;
        const workspace = instanceInfo?.workspaceFolders?.[0] || process.cwd();

        if (showIdeInstanceSelector) {
          showIdeInstanceSelector({
            initialConnectedInstance: {
              ideName: connectedTo,
              workspace,
            },
            onDisconnect: async () => {
              await IdeContextManager.getInstance().cleanup();
            },
          });
        } else {
          // Fallback to message if selector not available
          addEphemeralSystemMessage(
            getI18n().t('commands:slashMessages.ide.connectedTo', {
              name: connectedTo,
              workspace,
            }),
            {
              messageType: MessageType.SystemNotification,
              visibility: MessageVisibility.UserOnly,
            }
          );
        }
        return { handled: true };
      }

      // Not connected - check if extension is installed
      const isInstalled = await ideDetector.isExtensionInstalled(true);

      if (isInstalled) {
        // Check if version supports connection UI
        const configs = await fetchDynamicConfigs();
        const schema = DYNAMIC_CONFIG_SCHEMAS[MIN_IDE_EXTENSION_VERSION];
        const minVersionConfig = schema.parse(
          configs[MIN_IDE_EXTENSION_VERSION] ?? {}
        );
        const minVersion = minVersionConfig.version;
        const hasConnectionSupport =
          await ideDetector.isExtensionVersionAtLeast(minVersion);

        if (hasConnectionSupport) {
          // Extension installed and up to date - show instance selector
          if (showIdeInstanceSelector) {
            showIdeInstanceSelector();
          } else {
            // Fallback message if selector not available
            addEphemeralSystemMessage(
              getI18n().t('commands:slashMessages.ide.notConnected', {
                displayName,
              }),
              {
                messageType: MessageType.SystemNotification,
                visibility: MessageVisibility.UserOnly,
              }
            );
          }
        } else if (showIdeExtensionPrompt) {
          // Extension installed but outdated - show update prompt
          showIdeExtensionPrompt({ isUpdate: true });
        } else {
          addEphemeralSystemMessage(
            getI18n().t('commands:slashMessages.ide.needsUpdate', {
              displayName,
              version: minVersion,
            }),
            {
              messageType: MessageType.SystemNotification,
              visibility: MessageVisibility.UserOnly,
            }
          );
        }
      } else if (showIdeExtensionPrompt) {
        // Not installed - show interactive prompt
        showIdeExtensionPrompt();
      } else {
        // Fallback if prompt not available in context
        addEphemeralSystemMessage(
          getI18n().t('commands:slashMessages.ide.extensionAvailable', {
            displayName,
          }),
          {
            messageType: MessageType.SystemNotification,
            visibility: MessageVisibility.UserOnly,
          }
        );
      }

      return { handled: true };
    } catch (error) {
      logException(error, '[ide command] Error managing IDE extension');

      const errorMessage =
        error instanceof Error
          ? error.message
          : getI18n().t('commands:slashMessages.ide.failedToManage');

      addEphemeralSystemMessage(errorMessage, {
        messageType: MessageType.SystemNotification,
        visibility: MessageVisibility.UserOnly,
      });

      return { handled: true };
    }
  },
};
