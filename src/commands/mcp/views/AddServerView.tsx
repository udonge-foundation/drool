import { Box, Text } from 'ink';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { normalizeServerName } from '@industry/utils/mcp';

import { COLORS } from '@/components/chat/themedColors';
import { MenuContainer } from '@/components/common/MenuContainer';
import { TextInput } from '@/components/common/TextInput';
import { KeypressLayer } from '@/contexts/enums';
import { useKeypressHandler } from '@/hooks/useKeypressHandler';
import { useTerminalDimensions } from '@/hooks/useTerminalDimensions';
import { cleanPastedText } from '@/utils/pasteHandler';

interface AddServerViewProps {
  onSubmit: (
    name: string,
    type: 'stdio' | 'http' | 'sse',
    urlOrCommand: string,
    headers?: Record<string, string>,
    oauth?: false
  ) => void;
  existingServerNames: string[];
}

type FormField = 'name' | 'type' | 'urlOrCommand' | 'headers' | 'auth';
type ServerType = 'stdio' | 'http' | 'sse';
type AuthMode = 'oauth' | 'no-oauth';
const SERVER_TYPE_OPTIONS: ServerType[] = ['http', 'sse', 'stdio'];
const AUTH_MODE_OPTIONS: AuthMode[] = ['oauth', 'no-oauth'];

const stripShortcutPrefix = (label: string) => label.replace(/^\d+\.\s*/u, '');

export function AddServerView({
  onSubmit,
  existingServerNames,
}: AddServerViewProps) {
  const { t } = useTranslation('common');
  const { width: terminalWidth } = useTerminalDimensions();
  const [currentField, setCurrentField] = useState<FormField>('name');
  const [name, setName] = useState('');
  const [type, setType] = useState<ServerType>('http');
  const [urlOrCommand, setUrlOrCommand] = useState('');
  const [selectedTypeIndex, setSelectedTypeIndex] = useState(0);
  const [selectedAuthModeIndex, setSelectedAuthModeIndex] = useState(0);
  const [errorMessage, setErrorMessage] = useState('');
  const [headers, setHeaders] = useState<Record<string, string>>({});
  const [headerInput, setHeaderInput] = useState('');

  // Handler for text inputs with paste cleaning
  const handleTextChange =
    (setter: (value: string) => void) => (val: string) => {
      const cleaned = cleanPastedText(val);
      setter(cleaned);
      setErrorMessage('');
    };

  const handleSubmit = () => {
    // Validate all fields
    if (!name.trim()) {
      setErrorMessage(t('mcpViews.addServer.nameRequired'));
      setCurrentField('name');
      return;
    }

    if (
      existingServerNames.includes(
        normalizeServerName(name.trim()).toLowerCase()
      )
    ) {
      setErrorMessage(t('mcpViews.addServer.nameExists'));
      setCurrentField('name');
      return;
    }

    if (!urlOrCommand.trim()) {
      setErrorMessage(
        type !== 'stdio'
          ? t('mcpViews.addServer.urlRequired')
          : t('mcpViews.addServer.commandRequired')
      );
      setCurrentField('urlOrCommand');
      return;
    }

    // Submit the form with headers for remote servers
    const finalHeaders =
      type !== 'stdio' && Object.keys(headers).length > 0 ? headers : undefined;
    const oauth =
      type !== 'stdio' &&
      AUTH_MODE_OPTIONS[selectedAuthModeIndex] === 'no-oauth'
        ? false
        : undefined;
    onSubmit(name.trim(), type, urlOrCommand.trim(), finalHeaders, oauth);
  };

  const handleTypeSelection = () => {
    const selectedType = SERVER_TYPE_OPTIONS[selectedTypeIndex] ?? 'http';
    setType(selectedType);
    setCurrentField('urlOrCommand');
  };

  const getServerTypeLabel = (serverType: ServerType) => {
    switch (serverType) {
      case 'http':
        return stripShortcutPrefix(t('mcpViews.addServer.httpOption'));
      case 'sse':
        return stripShortcutPrefix(t('mcpViews.addServer.sseOption'));
      case 'stdio':
        return stripShortcutPrefix(t('mcpViews.addServer.stdioOption'));
      default:
        return serverType;
    }
  };

  const getAuthModeLabel = (authMode: AuthMode) => {
    switch (authMode) {
      case 'oauth':
        return stripShortcutPrefix(t('mcpViews.addServer.oauthOption'));
      case 'no-oauth':
        return stripShortcutPrefix(t('mcpViews.addServer.noOauthOption'));
      default:
        return authMode;
    }
  };

  const handleHeaderInput = () => {
    const input = headerInput.trim();

    // Empty input means skip/finish headers. Only API-key/header remotes need
    // the extra OAuth mode prompt; default OAuth remotes submit immediately.
    if (!input) {
      if (Object.keys(headers).length > 0) {
        setCurrentField('auth');
      } else {
        handleSubmit();
      }
      return;
    }

    // Parse header format: "KEY: VALUE"
    const colonIndex = input.indexOf(':');
    if (colonIndex === -1) {
      setErrorMessage(t('mcpViews.addServer.headerFormat'));
      return;
    }

    const key = input.slice(0, colonIndex).trim();
    const value = input.slice(colonIndex + 1).trim();

    if (!key || !value) {
      setErrorMessage(t('mcpViews.addServer.keyValueRequired'));
      return;
    }

    // Add header and clear input
    setHeaders({ ...headers, [key]: value });
    setHeaderInput('');
    setErrorMessage('');
  };

  useKeypressHandler(
    (_input, key) => {
      if (currentField === 'type' || currentField === 'auth') {
        if (key.upArrow) {
          if (currentField === 'type') {
            setSelectedTypeIndex((prev) => Math.max(0, prev - 1));
          } else {
            setSelectedAuthModeIndex((prev) => Math.max(0, prev - 1));
          }
          return true;
        }

        if (key.downArrow) {
          if (currentField === 'type') {
            setSelectedTypeIndex((prev) =>
              Math.min(SERVER_TYPE_OPTIONS.length - 1, prev + 1)
            );
          } else {
            setSelectedAuthModeIndex((prev) =>
              Math.min(AUTH_MODE_OPTIONS.length - 1, prev + 1)
            );
          }
          return true;
        }

        if (key.return) {
          if (currentField === 'type') {
            handleTypeSelection();
          } else {
            handleSubmit();
          }
          return true;
        }

        return false;
      }

      if (key.return) {
        setErrorMessage('');
        if (currentField === 'name') {
          if (!name.trim()) {
            setErrorMessage(t('mcpViews.addServer.nameRequired'));
            return true;
          }
          if (
            existingServerNames.includes(
              normalizeServerName(name.trim()).toLowerCase()
            )
          ) {
            setErrorMessage(t('mcpViews.addServer.nameExists'));
            return true;
          }
          setCurrentField('type');
          return true;
        }
        if (currentField === 'urlOrCommand') {
          if (!urlOrCommand.trim()) {
            setErrorMessage(
              type !== 'stdio'
                ? t('mcpViews.addServer.urlRequired')
                : t('mcpViews.addServer.commandRequired')
            );
            return true;
          }
          // For remote servers, move to headers field; for stdio, submit directly
          if (type !== 'stdio') {
            setCurrentField('headers');
          } else {
            handleSubmit();
          }
          return true;
        }
        if (currentField === 'headers') {
          handleHeaderInput();
          return true;
        }
      }

      return false;
    },
    { layer: KeypressLayer.Navigation }
  );

  return (
    <MenuContainer
      title={t('mcpViews.addServer.title')}
      titleBold={false}
      width={terminalWidth}
      helpText={
        currentField === 'type' || currentField === 'auth'
          ? t('mcpViews.addServer.typeSelectHint')
          : t('mcpViews.addServer.fieldHint')
      }
      showDefaultHelp={false}
    >
      <Box flexDirection="column">
        {/* Server Name Field */}
        <Box>
          <Text
            color={currentField === 'name' ? COLORS.primary : COLORS.text.muted}
          >
            {t('mcpViews.addServer.serverName')}
          </Text>
          {currentField === 'name' ? (
            <TextInput value={name} onChange={handleTextChange(setName)} />
          ) : (
            <Text color={COLORS.text.muted}>
              {name || t('mcpViews.addServer.empty')}
            </Text>
          )}
        </Box>

        <Text> </Text>

        {/* Server Type Field */}
        {currentField === 'type' ? (
          <Box flexDirection="column">
            <Text color={COLORS.primary}>
              {t('mcpViews.addServer.serverType')}
            </Text>
            {SERVER_TYPE_OPTIONS.map((serverType, index) => {
              const isSelected = selectedTypeIndex === index;
              return (
                <Box key={serverType}>
                  <Box width={2}>
                    <Text> </Text>
                  </Box>
                  <Text
                    bold={isSelected}
                    color={isSelected ? COLORS.text.primary : COLORS.text.muted}
                  >
                    {getServerTypeLabel(serverType)}
                  </Text>
                </Box>
              );
            })}
          </Box>
        ) : (currentField === 'urlOrCommand' ||
            currentField === 'headers' ||
            currentField === 'auth') &&
          type ? (
          <Box>
            <Text color={COLORS.text.muted}>
              {t('mcpViews.addServer.serverTypeReadonly')}
            </Text>
            <Text color={COLORS.text.muted}>{type}</Text>
          </Box>
        ) : null}

        {currentField === 'urlOrCommand' && <Text> </Text>}

        {/* URL or Command Field */}
        {currentField === 'urlOrCommand' && (
          <Box>
            <Text color={COLORS.primary}>
              {type !== 'stdio'
                ? t('mcpViews.addServer.urlLabel')
                : t('mcpViews.addServer.commandLabel')}
            </Text>
            <TextInput
              value={urlOrCommand}
              onChange={handleTextChange(setUrlOrCommand)}
            />
          </Box>
        )}

        {/* Headers Field (remote servers only) */}
        {currentField === 'headers' && type !== 'stdio' && (
          <>
            <Text> </Text>

            {/* Show added headers */}
            {Object.keys(headers).length > 0 && (
              <Box flexDirection="column">
                <Text color={COLORS.text.muted}>
                  {t('mcpViews.addServer.headersLabel')}
                </Text>
                {Object.entries(headers).map(([key, value]) => (
                  <Text key={key} color={COLORS.text.muted}>
                    • {key}: {value}
                  </Text>
                ))}
                <Text> </Text>
              </Box>
            )}

            {/* Input for next header */}
            <Box>
              <Text color={COLORS.primary}>
                {Object.keys(headers).length > 0
                  ? t('mcpViews.addServer.addHeaderWithExisting')
                  : t('mcpViews.addServer.addHeaderEmpty')}
              </Text>
              <TextInput
                value={headerInput}
                onChange={handleTextChange(setHeaderInput)}
                placeholder={t('mcpViews.addServer.headerPlaceholder')}
              />
            </Box>
          </>
        )}

        {/* Auth Mode Field (remote servers only) */}
        {currentField === 'auth' && type !== 'stdio' && (
          <>
            <Text> </Text>
            <Box flexDirection="column">
              <Text color={COLORS.primary}>
                {t('mcpViews.addServer.authMode')}
              </Text>
              {AUTH_MODE_OPTIONS.map((authMode, index) => {
                const isSelected = selectedAuthModeIndex === index;
                return (
                  <Box key={authMode}>
                    <Box width={2}>
                      <Text> </Text>
                    </Box>
                    <Text
                      bold={isSelected}
                      color={
                        isSelected ? COLORS.text.primary : COLORS.text.muted
                      }
                    >
                      {getAuthModeLabel(authMode)}
                    </Text>
                  </Box>
                );
              })}
            </Box>
          </>
        )}

        {errorMessage && (
          <>
            <Text> </Text>
            <Text color={COLORS.error}>{errorMessage}</Text>
          </>
        )}
      </Box>
    </MenuContainer>
  );
}
