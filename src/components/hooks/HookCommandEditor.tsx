import { Box, Text } from 'ink';
import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';

import { ANSI } from '@/components/chat/constants';
import { COLORS } from '@/components/chat/themedColors';
import { useKeypressProvider } from '@/contexts/KeypressProvider';
import type { KeyEvent } from '@/contexts/types';
import { BACKSPACE_CODE, DELETE_CODE, ESC_27U } from '@/hooks/constants';
import { EditorStep, HookEventName } from '@/hooks/enums';
import { useKeypressHandler } from '@/hooks/useKeypressHandler';
import { getSettingsService } from '@/services/SettingsService';
import { cleanPastedText } from '@/utils/pasteHandler';

import type { HookConfig } from '@industry/common/cli';

interface HookCommandEditorProps {
  hookType: HookEventName;
  existingConfig: HookConfig | null;
  isNewMatcher: boolean;
  onBack: () => void;
  onSave: () => void;
}

const MATCHER_LIST_KEYS = [
  'common:hookEditor.possibleMatchers',
  'common:hookEditor.toolNamesList1',
  'common:hookEditor.toolNamesList2',
] as const;

const MATCHER_EXAMPLE_KEYS = [
  'common:hookEditor.examples',
  'common:hookEditor.matcherExampleWrite',
  'common:hookEditor.matcherExampleAll',
  'common:hookEditor.matcherExampleRead',
  'common:hookEditor.matcherExampleGit',
] as const;

const REGEX_EXAMPLE_KEYS = [
  'common:hookEditor.examples',
  'common:hookEditor.regexExampleNpm',
  'common:hookEditor.regexExampleGitPush',
  'common:hookEditor.regexExampleDeletion',
  'common:hookEditor.regexExampleTest',
] as const;

const COMMAND_EXAMPLE_KEYS = [
  'common:hookEditor.examples',
  'common:hookEditor.commandExampleReview',
  'common:hookEditor.commandExampleJq',
  'common:hookEditor.commandExampleGrep',
  'common:hookEditor.commandExampleScript',
] as const;

const COMMAND_DETAIL_KEYS = [
  'common:hookEditor.hookReceivesJson',
  'common:hookEditor.toolNameDetail',
  'common:hookEditor.toolInputDetail',
] as const;

const EXIT_CODE_KEYS = [
  'common:hookEditor.exitCodeBehaviors',
  'common:hookEditor.exitCode0',
  'common:hookEditor.exitCode1',
  'common:hookEditor.exitCode2',
  'common:hookEditor.exitCode3',
] as const;

function MutedText({ i18nKey }: { i18nKey: string }) {
  const { t } = useTranslation();
  return <Text color={COLORS.text.muted}>{t(i18nKey)}</Text>;
}

function MutedTextList({ i18nKeys }: { i18nKeys: readonly string[] }) {
  return (
    <>
      {i18nKeys.map((k) => (
        <MutedText key={k} i18nKey={k} />
      ))}
    </>
  );
}

function MutedTextSection({ i18nKeys }: { i18nKeys: readonly string[] }) {
  return (
    <>
      <Box marginTop={1} />
      <MutedTextList i18nKeys={i18nKeys} />
    </>
  );
}

function EditorScreen({
  children,
  footerKey,
}: {
  children: React.ReactNode;
  footerKey: string;
}) {
  const { t } = useTranslation();
  return (
    <Box flexDirection="column">
      <Box
        borderStyle="round"
        borderColor={COLORS.border}
        paddingX={2}
        paddingY={1}
      >
        <Box flexDirection="column">{children}</Box>
      </Box>
      <Box marginTop={1} paddingLeft={2}>
        <Text color={COLORS.text.muted}>{t(footerKey)}</Text>
      </Box>
    </Box>
  );
}

function isExecuteMatcher(matcherStr: string): boolean {
  if (!matcherStr) return false;
  if (matcherStr === 'Execute') return true;
  try {
    const regex = new RegExp(matcherStr);
    return regex.test('Execute');
  } catch {
    return false;
  }
}

function getStepAfterEscape(
  step: EditorStep,
  isNewMatcher: boolean,
  matcher: string
): EditorStep | null {
  if (step === EditorStep.Command) {
    if (isExecuteMatcher(matcher) && isNewMatcher) {
      return EditorStep.CommandRegex;
    }
    if (isNewMatcher) {
      return EditorStep.Matcher;
    }
    return null;
  }
  if (step === EditorStep.CommandRegex && isNewMatcher) {
    return EditorStep.Matcher;
  }
  return null;
}

export function HookCommandEditor({
  hookType,
  existingConfig,
  isNewMatcher,
  onBack,
  onSave,
}: HookCommandEditorProps) {
  const { t } = useTranslation();
  const [step, setStep] = useState<EditorStep>(
    isNewMatcher ? EditorStep.Matcher : EditorStep.Command
  );
  const [matcher, setMatcher] = useState(existingConfig?.matcher || '');
  const [commandRegex, setCommandRegex] = useState(
    existingConfig?.commandRegex || ''
  );
  const [command, setCommand] = useState('');

  const handleEscape = () => {
    const next = getStepAfterEscape(step, isNewMatcher, matcher);
    if (next === null) {
      onBack();
    } else {
      setStep(next);
    }
  };

  let keypressProvider = null;
  try {
    keypressProvider = useKeypressProvider();
  } catch {
    // Not available
  }

  useEffect(() => {
    if (!keypressProvider) return;

    const handler = (event: KeyEvent) => {
      const seq = event.key?.sequence as string | undefined;
      if (seq === ANSI.ESC_KITTY || seq === ESC_27U) {
        const next = getStepAfterEscape(step, isNewMatcher, matcher);
        if (next === null) {
          onBack();
        } else {
          setStep(next);
        }
      }
    };

    keypressProvider.subscribe(handler);
    return () => {
      keypressProvider?.unsubscribe(handler);
    };
  }, [keypressProvider, onBack, step, isNewMatcher, matcher]);

  useKeypressHandler(
    (input, key) => {
      if (key.escape) {
        handleEscape();
        return;
      }

      if (key.return && step === EditorStep.Matcher) {
        if (matcher.trim()) {
          if (isExecuteMatcher(matcher)) {
            setStep(EditorStep.CommandRegex);
          } else {
            setStep(EditorStep.Command);
          }
        }
        return;
      }

      if (key.return && step === EditorStep.CommandRegex) {
        setStep(EditorStep.Command);
        return;
      }

      if (key.return && step === EditorStep.Command) {
        if (command.trim()) {
          const settingsService = getSettingsService();

          settingsService.addHook(
            hookType,
            matcher,
            command,
            undefined,
            commandRegex || undefined
          );

          onSave();
        }
        return;
      }

      if (
        key.backspace ||
        key.delete ||
        input === BACKSPACE_CODE ||
        input === DELETE_CODE
      ) {
        if (step === EditorStep.Matcher) {
          setMatcher((prev) => (prev.length > 0 ? prev.slice(0, -1) : prev));
        } else if (step === EditorStep.CommandRegex) {
          setCommandRegex((prev) =>
            prev.length > 0 ? prev.slice(0, -1) : prev
          );
        } else {
          setCommand((prev) => (prev.length > 0 ? prev.slice(0, -1) : prev));
        }
        return;
      }

      if (input && input.length > 0) {
        const cleanedInput = cleanPastedText(input);

        const finalInput = cleanedInput
          .split('')
          .filter((char) => {
            const code = char.charCodeAt(0);
            return code >= 32 && code !== 127;
          })
          .join('');

        if (finalInput.length > 0) {
          if (step === EditorStep.Matcher) {
            setMatcher((prev) => prev + finalInput);
          } else if (step === EditorStep.CommandRegex) {
            setCommandRegex((prev) => prev + finalInput);
          } else {
            setCommand((prev) => prev + finalInput);
          }
        }
      }
    },
    { isActive: true }
  );

  if (step === EditorStep.Matcher) {
    return (
      <EditorScreen footerKey="common:hookEditor.enterContinueEscBack">
        <Text bold color={COLORS.primary}>
          {hookType}
          {t('common:hookEditor.newMatcher')}
        </Text>
        <Box marginTop={1} />

        <Text>
          {t('common:hookEditor.matcherPattern')}
          {matcher}
          <Text inverse> </Text>
        </Text>
        <MutedText i18nKey="common:hookEditor.matcherExample" />

        <MutedTextSection i18nKeys={MATCHER_LIST_KEYS} />
        <MutedTextSection i18nKeys={MATCHER_EXAMPLE_KEYS} />
        <MutedTextSection i18nKeys={EXIT_CODE_KEYS} />
      </EditorScreen>
    );
  }

  if (step === EditorStep.CommandRegex) {
    return (
      <EditorScreen footerKey="common:hookEditor.enterContinueEscBack">
        <Text bold color={COLORS.primary}>
          {hookType}
          {t('common:hookEditor.matcherLabel')}
          {matcher}
        </Text>
        <Box marginTop={1} />

        <Text>
          {t('common:hookEditor.commandRegex')}
          {commandRegex}
          <Text inverse> </Text>
        </Text>
        <MutedText i18nKey="common:hookEditor.filterDescription" />

        <MutedTextSection i18nKeys={REGEX_EXAMPLE_KEYS} />

        <Box marginTop={1} />
        <MutedText i18nKey="common:hookEditor.leaveEmptyHint" />
      </EditorScreen>
    );
  }

  return (
    <EditorScreen footerKey="common:hookEditor.enterSaveEscBack">
      <Text bold color={COLORS.primary}>
        {hookType}
        {t('common:hookEditor.matcherLabel')}
        {matcher || '*'}
      </Text>
      <Box marginTop={1} />

      <Text>
        {t('common:hookEditor.commandLabel')}
        {command}
        <Text inverse> </Text>
      </Text>
      <MutedText i18nKey="common:hookEditor.enterShellCommand" />

      <MutedTextSection i18nKeys={COMMAND_EXAMPLE_KEYS} />
      <MutedTextSection i18nKeys={COMMAND_DETAIL_KEYS} />
      <MutedTextSection i18nKeys={EXIT_CODE_KEYS} />
    </EditorScreen>
  );
}
