import React, { useCallback, useLayoutEffect, useMemo, useState } from 'react';
import Box from '../../../../legacy/2.1.88/restored-src/src/ink/components/Box.js';
import Text from '../../../../legacy/2.1.88/restored-src/src/ink/components/Text.js';
import { BaseTextInput } from '../../../../legacy/2.1.88/restored-src/src/components/BaseTextInput.node.js';
import { SelectOption } from '../../../../legacy/2.1.88/restored-src/src/components/CustomSelect/select-option.node.js';

import { useSelectNavigation } from '../../../../legacy/2.1.88/restored-src/src/components/CustomSelect/use-select-navigation.js';
import useInput from '../../../../legacy/2.1.88/restored-src/src/ink/hooks/use-input.node.js';
import { translate } from '../i18n.js';
import { getPermissionInitialFocus } from './input.js';
import { normalizeFullWidthDigits } from '../../../../legacy/2.1.88/restored-src/src/utils/stringUtils.ts';

export default function PermissionPrompt({
  locale,
  name,
  reason,
  defaultToNo = false,
  input,
  terminalFocus,
  inputReady,
  inputState,
  feedbackValues,
  getFeedbackValues,
  onFeedbackChange,
  onFeedbackModeChange,
  onKeyHandlerChange,
  onSelect,
  onCancel,
  onPaste,
  onIsPastingChange,
}) {
  // Preserve the original 2.1.88 Allow/Deny Select and the 2.1.304
  // defaultToNo contract: decline is first, indexes are hidden, and numeric
  // selection is disabled whenever the producer marks an ask defaultToNo.
  const options = useMemo(() => {
    const allow: {
      value: string;
      label: React.ReactNode;
      feedbackConfig?: { type: 'accept' | 'reject'; placeholder: string };
    } = {
      value: 'allow',
      label: translate(locale, 'tuiPermissionAllowOnce'),
      feedbackConfig: {
        type: 'accept',
        placeholder: translate(locale, 'tuiPermissionAcceptFeedbackPlaceholder'),
      },
    };
    const deny = {
      value: 'deny',
      label: translate(locale, 'tuiPermissionDeny'),
      feedbackConfig: {
        type: 'reject' as const,
        placeholder: translate(locale, 'tuiPermissionRejectFeedbackPlaceholder'),
      },
    };
    // The pinned 2.1.88 BashPermissionRequest only exposes additional
    // allow-rule choices when its original classifier/suggestion pipeline
    // supplies them. That pipeline is not wired yet, so do not invent a
    // synthetic "allow this command for the session" option here.
    return defaultToNo ? [deny, allow] : [allow, deny];
  }, [locale, defaultToNo]);

  const [acceptInputMode, setAcceptInputMode] = useState(false);
  const [rejectInputMode, setRejectInputMode] = useState(false);

  // This is the 2.1.88 PermissionPrompt focus/feedback contract: moving away
  // from an empty feedback option collapses its editor; typed feedback is kept.
  const handleFocus = useCallback(value => {
    const nextOption = options.find(option => option.value === value);
    const values = getFeedbackValues();
    if (nextOption?.feedbackConfig?.type !== 'accept' &&
        acceptInputMode && !values.accept.trim()) {
      setAcceptInputMode(false);
    }
    if (nextOption?.feedbackConfig?.type !== 'reject' &&
        rejectInputMode && !values.reject.trim()) {
      setRejectInputMode(false);
    }
  }, [options, acceptInputMode, rejectInputMode, getFeedbackValues]);

  const navigation = useSelectNavigation({
    options,
    initialFocusValue: getPermissionInitialFocus(defaultToNo),
    onFocus: handleFocus,
  });

  const focusedOption = options.find(option => option.value === navigation.focusedValue);
  const focusedFeedbackType = focusedOption?.feedbackConfig?.type;
  const feedbackInputMode =
    (focusedFeedbackType === 'accept' && acceptInputMode) ||
    (focusedFeedbackType === 'reject' && rejectInputMode);

  // Select normally owns a useInput listener even when no feedback option is
  // expanded. Reuse that listener directly; the visible BaseTextInput becomes
  // the sole listener while feedback editing is active.
  useInput(inputState.onInput, { isActive: !(feedbackInputMode && inputReady) });
  const showTabHint = Boolean(focusedFeedbackType && !feedbackInputMode);
  const activeFeedbackValue = focusedFeedbackType
    ? feedbackValues[focusedFeedbackType] ?? ''
    : '';

  useLayoutEffect(() => {
    onFeedbackModeChange(feedbackInputMode ? focusedFeedbackType : null);
  }, [feedbackInputMode, focusedFeedbackType, onFeedbackModeChange]);

  const handleInputModeToggle = useCallback(value => {
    const option = options.find(candidate => candidate.value === value);
    const type = option?.feedbackConfig?.type;
    if (!type) return;
    if (type === 'accept') setAcceptInputMode(current => !current);
    if (type === 'reject') setRejectInputMode(current => !current);
  }, [options]);

  const handleSelect = useCallback(value => {
    const option = options.find(candidate => candidate.value === value);
    if (!option) return false;
    const type = option.feedbackConfig?.type;
    const feedback = type ? getFeedbackValues()[type].trim() : '';
    // 2.1.304 allows the caller to veto a stale selection by returning false.
    return onSelect(value, feedback || undefined) !== false;
  }, [options, getFeedbackValues, onSelect]);

  const handleCancel = useCallback(() => {
    return onCancel();
  }, [onCancel]);

  // AgentTui owns the single terminal input stream. The original selector
  // navigation reducer owns focus; this adapter routes only the same
  // Select/PermissionPrompt key contracts through that existing input stream.
  const focusedValue = navigation.focusedValue;
  const focusPreviousOption = navigation.focusPreviousOption;
  const focusNextOption = navigation.focusNextOption;
  const handleKey = useCallback((inputText, key = {}) => {
    if (key.escape) {
      handleCancel();
      return true;
    }
    if (key.tab) {
      if (focusedValue !== undefined) handleInputModeToggle(focusedValue);
      return true;
    }
    if (key.upArrow || (feedbackInputMode && key.ctrl && inputText === 'p')) {
      // Original useSelectInput keeps Ctrl+P/Ctrl+N navigation active while
      // a SelectInputOption feedback editor is focused.
      focusPreviousOption();
      return true;
    }
    if (key.downArrow || (feedbackInputMode && key.ctrl && inputText === 'n')) {
      focusNextOption();
      return true;
    }
    if (!feedbackInputMode && key.pageUp) {
      navigation.focusPreviousPage();
      return true;
    }
    if (!feedbackInputMode && key.pageDown) {
      navigation.focusNextPage();
      return true;
    }
    if (!feedbackInputMode && !defaultToNo) {
      // Original CustomSelect supports immediate 1-based option selection,
      // including full-width digits. 2.1.304 hideIndexes/defaultToNo disables
      // this path entirely so a stray digit cannot approve a sensitive ask.
      const normalizedInput = normalizeFullWidthDigits(inputText);
      if (/^[0-9]+$/.test(normalizedInput)) {
        const option = options[Number(normalizedInput) - 1];
        if (option) {
          handleSelect(option.value);
          return true;
        }
        return true;
      }
    }
    if (key.submit) {
      if (focusedValue !== undefined) handleSelect(focusedValue);
      return true;
    }
    if (key.return && !key.shift && !key.ctrl && !key.meta) {
      // In input mode, original SelectInputOption delegates Enter to its
      // TextInput onSubmit callback so coalesced text+Enter is not lost.
      if (feedbackInputMode) return false;
      if (focusedValue !== undefined) handleSelect(focusedValue);
      return true;
    }
    // No input is ever allowed to leak into the main task prompt. Only the
    // focused original feedback input receives otherwise-unhandled keys.
    return !feedbackInputMode;
  }, [handleCancel, handleInputModeToggle, handleSelect, focusedValue, focusPreviousOption, focusNextOption, feedbackInputMode, defaultToNo]);

  useLayoutEffect(() => {
    onKeyHandlerChange(handleKey);
    return () => onKeyHandlerChange(null);
  }, [onKeyHandlerChange, handleKey]);

  const acceptPlaceholder = translate(locale, 'tuiPermissionAcceptFeedbackPlaceholder');
  const rejectPlaceholder = translate(locale, 'tuiPermissionRejectFeedbackPlaceholder');
  const placeholder = focusedFeedbackType === 'accept' ? acceptPlaceholder : rejectPlaceholder;
  const optionIndexWidth = defaultToNo ? 0 : String(options.length).length;

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" padding={1} marginTop={1}>
      <Text bold color="yellow">{translate(locale, 'tuiPermissionRequired')} · {name}</Text>
      <Text>{translate(locale, 'tuiPermissionQuestion')}</Text>
      <Text>{reason}</Text>
      <Text dimColor={true}>{input}</Text>
      <Box flexDirection="column" marginTop={1}>
        {navigation.visibleOptions.map(option => {
          const isFocused = navigation.focusedValue === option.value;
          const optionType = option.feedbackConfig?.type;
          const showInput = isFocused && feedbackInputMode && optionType === focusedFeedbackType;
          return (
            <SelectOption
              key={option.value}
              isFocused={isFocused}
              isSelected={false}
              declareCursor={!showInput}
            >
              <Box flexDirection="row">
                {!defaultToNo ? <Text dimColor={true}>{`${option.index + 1}.`.padEnd(optionIndexWidth + 1)}</Text> : null}
                <Text>{option.label}</Text>
                {showInput ? (
                  <Box flexGrow={1} marginLeft={1}>
                    {inputReady ? (
                      <BaseTextInput
                        inputState={inputState}
                        terminalFocus={terminalFocus}
                        focus
                        showCursor
                        value={activeFeedbackValue}
                        onChange={value => onFeedbackChange(focusedFeedbackType, value)}
                        cursorOffset={inputState.offset}
                        onChangeCursorOffset={inputState.setOffset}
                        multiline
                        placeholder={placeholder}
                        onPaste={onPaste}
                        onIsPastingChange={onIsPastingChange}
                      />
                    ) : <Text dimColor={true}>{placeholder}</Text>}
                  </Box>
                ) : null}
              </Box>
            </SelectOption>
          );
        })}
      </Box>
      <Box marginTop={1}>
        <Text dimColor={true}>
          {translate(locale, name === 'Bash' ? 'tuiPermissionSelectHint' : 'tuiPermissionApprove')}
          {' · ' + translate(locale, defaultToNo ? 'tuiPermissionDefaultDeny' : 'tuiPermissionDefaultAllow')}
          {showTabHint ? ' · ' + translate(locale, 'tuiPermissionTabHint') : ''}
        </Text>
      </Box>
      <Text dimColor={true}>{translate(locale, 'tuiPermissionEscHint')}</Text>
    </Box>
  );
}
