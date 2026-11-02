import React, { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import chalk from 'chalk';
import Box from '../../../../legacy/2.1.88/restored-src/src/ink/components/Box.js';
import ScrollBox, { type ScrollBoxHandle } from '../../../../legacy/2.1.88/restored-src/src/ink/components/ScrollBox.js';
import Text from '../../../../legacy/2.1.88/restored-src/src/ink/components/Text.js';
import { useTerminalFocus } from '../../../../legacy/2.1.88/restored-src/src/ink/hooks/use-terminal-focus.js';
import { useTerminalSize } from '../../../../legacy/2.1.88/restored-src/src/hooks/useTerminalSize.js';
import { BaseTextInput } from '../../../../legacy/2.1.88/restored-src/src/components/BaseTextInput.node.js';
import PermissionPrompt from './PermissionPrompt.tsx';
import MessageContent from './MessageContent.tsx';
import { useTextInput } from './useTextInput.js';
import { addToHistory } from '../../../../legacy/2.1.88/restored-src/src/history.js';
import { getCoalescedEnterText } from './input.js';
import { translate } from '../i18n.js';
import { countUnseenAssistantTurns, useUnseenDivider } from './useUnseenDivider.js';

function formatToolResultContent(content, locale) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map(block => {
    if (block?.type === 'text' && typeof block.text === 'string') return block.text;
    if (block?.type === 'image') return translate(locale, 'tuiToolImageResult');
    return translate(locale, 'tuiToolOtherResult', {
      type: String(block?.type ?? 'unknown'),
    });
  }).filter(Boolean).join('\n');
}

export default function AgentTui({ controller, initialHistory = [], onSubmit, onInterrupt, onExit }) {
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const locale = snapshot.locale;
  const terminalFocus = useTerminalFocus();
  const terminalSize = useTerminalSize();
  const terminalRows = Math.max(5, terminalSize.rows || 24);
  const terminalColumns = Math.max(10, terminalSize.columns || 80);
  const scrollRef = useRef<ScrollBoxHandle | null>(null);
  const {
    dividerIndex,
    dividerYRef,
    onScrollAway,
    onRepin,
    jumpToNew,
  } = useUnseenDivider(snapshot.messages.length);
  const [scrollMetrics, setScrollMetrics] = useState<{
    scrollTop: number;
    pendingDelta: number;
    viewportHeight: number;
    scrollHeight: number;
    sticky: boolean;
  } | null>(null);
  useEffect(() => {
    if (snapshot.pendingApproval) {
      setScrollMetrics(null);
      return;
    }
    const handle = scrollRef.current;
    if (!handle) {
      setScrollMetrics(null);
      return;
    }
    const update = () => {
      const scrollTop = handle.getScrollTop();
      const pendingDelta = handle.getPendingDelta();
      const viewportHeight = handle.getViewportHeight();
      const scrollHeight = handle.getScrollHeight();
      const atBottom = handle.isSticky() ||
        scrollTop + pendingDelta >= Math.max(0, scrollHeight - viewportHeight);
      if (atBottom) onRepin();
      else onScrollAway(handle);
      setScrollMetrics({
        scrollTop,
        pendingDelta,
        viewportHeight,
        scrollHeight,
        sticky: handle.isSticky(),
      });
    };
    update();
    return handle.subscribe(update);
  }, [snapshot.pendingApproval, onRepin, onScrollAway]);
  const repinScroll = useCallback(() => {
    jumpToNew(scrollRef.current);
    onRepin();
  }, [jumpToNew, onRepin]);
  const [value, setValueState] = useState('');
  const valueRef = useRef('');
  const setValue = useCallback(nextValue => {
    const resolved = typeof nextValue === 'function' ? nextValue(valueRef.current) : nextValue;
    valueRef.current = resolved;
    setValueState(resolved);
  }, []);
  const [offset, setOffsetState] = useState(0);
  const offsetRef = useRef(0);
  const setOffset = useCallback(nextOffset => {
    const resolved = typeof nextOffset === 'function' ? nextOffset(offsetRef.current) : nextOffset;
    const clamped = Math.max(0, Math.min(valueRef.current.length, resolved));
    offsetRef.current = clamped;
    setOffsetState(clamped);
  }, []);
  const [history, setHistoryState] = useState(() => Array.isArray(initialHistory) ? initialHistory.slice(-100) : []);
  const historyRef = useRef(history);
  const setHistory = useCallback(nextHistory => {
    const resolved = typeof nextHistory === 'function' ? nextHistory(historyRef.current) : nextHistory;
    historyRef.current = resolved;
    setHistoryState(resolved);
  }, []);
  const [historyIndex, setHistoryIndexState] = useState(-1);
  const historyIndexRef = useRef(-1);
  const setHistoryIndex = useCallback(nextIndex => {
    const resolved = typeof nextIndex === 'function' ? nextIndex(historyIndexRef.current) : nextIndex;
    historyIndexRef.current = resolved;
    setHistoryIndexState(resolved);
  }, []);
  const draftRef = useRef('');
  const [inputReady, setInputReady] = useState(false);
  const [isPasting, setIsPasting] = useState(false);
  // PermissionPrompt reuses the original 2.1.88 focus reducer and feedback
  // semantics. Keep its active input on the same original mutable text-input
  // path so coalesced Enter, paste, cursor state and cancellation stay unified.
  const [approvalFeedback, setApprovalFeedbackState] = useState({ accept: '', reject: '' });
  const approvalFeedbackRef = useRef(approvalFeedback);
  const [permissionInputType, setPermissionInputTypeState] = useState(null);
  const permissionInputTypeRef = useRef(null);
  const [feedbackOffset, setFeedbackOffsetState] = useState(0);
  const feedbackOffsetRef = useRef(0);
  const permissionKeyHandlerRef = useRef(null);
  const permissionSubmitHandlerRef = useRef(null);
  const setApprovalFeedback = useCallback((type, nextValue) => {
    if (type !== 'accept' && type !== 'reject') return;
    const current = approvalFeedbackRef.current;
    const resolved = typeof nextValue === 'function' ? nextValue(current[type]) : nextValue;
    const next = { ...current, [type]: String(resolved ?? '') };
    approvalFeedbackRef.current = next;
    setApprovalFeedbackState(next);
  }, []);
  const getApprovalFeedback = useCallback(() => approvalFeedbackRef.current, []);
  const setPermissionInputType = useCallback(type => {
    if (type !== null && type !== 'accept' && type !== 'reject') return;
    if (permissionInputTypeRef.current === type) return;
    permissionInputTypeRef.current = type;
    if (type) {
      const nextOffset = approvalFeedbackRef.current[type].length;
      feedbackOffsetRef.current = nextOffset;
      setFeedbackOffsetState(nextOffset);
    }
    setPermissionInputTypeState(type);
  }, []);
  const registerPermissionKeyHandler = useCallback(handler => {
    permissionKeyHandlerRef.current = typeof handler === 'function' ? handler : null;
  }, []);
  const registerPermissionSubmitHandler = useCallback(handler => {
    permissionSubmitHandlerRef.current = typeof handler === 'function' ? handler : null;
  }, []);
  const resolvePermissionSelection = useCallback((selectedValue, feedback, permissionUpdates) => {
    const approved = selectedValue === 'allow' || selectedValue === 'allow-session';
    return controller.resolveApproval(approved, feedback, permissionUpdates);
  }, [controller]);
  const cancelPermission = useCallback(() => {
    // 2.1.304 only records Escape attribution when the active request accepts
    // cancellation; a stale/double Escape after abort must not increment it.
    const resolved = controller.resolveApproval(false);
    if (resolved) controller.recordPermissionEscape();
    return resolved;
  }, [controller]);
  const onPermissionPasteStateChange = useCallback(pasting => {
    if (permissionInputTypeRef.current) setIsPasting(pasting);
  }, []);
  const setFeedbackOffset = useCallback(nextOffset => {
    const resolved = typeof nextOffset === 'function' ? nextOffset(feedbackOffsetRef.current) : nextOffset;
    const type = permissionInputTypeRef.current;
    const maxLength = type ? approvalFeedbackRef.current[type].length : 0;
    const next = Math.max(0, Math.min(maxLength, resolved));
    feedbackOffsetRef.current = next;
    setFeedbackOffsetState(next);
  }, []);
  const previousApprovalIdRef = useRef(null);
  useLayoutEffect(() => {
    const currentApprovalId = snapshot.pendingApproval?.id ?? null;
    if (previousApprovalIdRef.current === currentApprovalId) return;
    previousApprovalIdRef.current = currentApprovalId;
    permissionInputTypeRef.current = null;
    setPermissionInputTypeState(null);
    approvalFeedbackRef.current = { accept: '', reject: '' };
    setApprovalFeedbackState(approvalFeedbackRef.current);
    feedbackOffsetRef.current = 0;
    setFeedbackOffsetState(0);
    setIsPasting(false);
  }, [snapshot.pendingApproval?.id]);

  const submit = useCallback((submittedValue = valueRef.current) => {
    const text = String(submittedValue ?? '').trimEnd();
    const currentSnapshot = controller.getSnapshot();
    if (!text.trim() || currentSnapshot.busy || currentSnapshot.pendingApproval) return;
    // Match the original REPL: submitting returns the transcript to live
    // follow and clears the previous unseen-message baseline.
    repinScroll();
    setHistory(previous => [...previous, text].slice(-100));
    addToHistory(text);
    setHistoryIndex(-1);
    draftRef.current = '';
    setValue('');
    setOffset(0);
    void Promise.resolve(onSubmit(text)).catch(error => {
      controller.pushSystemMessage(error instanceof Error ? error.message : String(error));
      controller.setBusy(false);
    });
  }, [onSubmit, controller, setHistory, setHistoryIndex, setValue, setOffset, repinScroll]);

  const onHistoryUp = useCallback(() => {
    const entries = historyRef.current;
    if (!entries.length) return;
    const current = historyIndexRef.current;
    if (current < 0) draftRef.current = valueRef.current;
    const next = current < 0 ? entries.length - 1 : Math.max(0, current - 1);
    setHistoryIndex(next);
    const text = entries[next] ?? '';
    setValue(text);
    setOffset(text.length);
  }, [setHistoryIndex, setValue, setOffset]);

  const onHistoryDown = useCallback(() => {
    const entries = historyRef.current;
    const current = historyIndexRef.current;
    if (current < 0) return;
    const next = current + 1;
    if (next >= entries.length) {
      setHistoryIndex(-1);
      const text = draftRef.current;
      setValue(text);
      setOffset(text.length);
      return;
    }
    setHistoryIndex(next);
    const text = entries[next] ?? '';
    setValue(text);
    setOffset(text.length);
  }, [setHistoryIndex, setValue, setOffset]);

  const resetHistory = useCallback(() => {
    setHistoryIndex(-1);
    draftRef.current = '';
  }, [setHistoryIndex]);

  const canInput = inputReady && snapshot.inputEnabled && !snapshot.busy && !snapshot.pendingApproval;

  const onPaste = useCallback(text => {
    const feedbackType = permissionInputTypeRef.current;
    const canFeedbackInput = Boolean(snapshot.pendingApproval && feedbackType);
    if (process.env.AGENT_CIL_DEBUG_TUI_INPUT === '1') {
      process.stdout.write('[tui-paste] ' + JSON.stringify({ text, canInput, canFeedbackInput }) + '\\n');
    }
    if (!canInput && !canFeedbackInput) return;
    const pasted = String(text ?? '');
    if (canFeedbackInput) {
      const current = approvalFeedbackRef.current[feedbackType];
      const cursor = feedbackOffsetRef.current;
      setApprovalFeedback(feedbackType, current.slice(0, cursor) + pasted + current.slice(cursor));
      setFeedbackOffset(cursor + pasted.length);
      return;
    }
    const current = valueRef.current;
    const cursor = offsetRef.current;
    const next = current.slice(0, cursor) + pasted + current.slice(cursor);
    setValue(next);
    setOffset(cursor + pasted.length);
    setHistoryIndex(-1);
  }, [canInput, snapshot.pendingApproval, setApprovalFeedback, setFeedbackOffset, setValue, setOffset, setHistoryIndex]);

  const onExitMessage = useCallback((show, key) => {
    if (!show) {
      controller.setStatus('');
      return;
    }
    controller.setStatus(key === 'Ctrl-D'
      ? translate(locale, 'pressCtrlDAgain')
      : translate(locale, 'pressCtrlCAgain'));
  }, [controller, locale]);

  // The original SelectInputOption passes Select.onCancel as TextInput.onExit.
  // While editing permission feedback, double Ctrl-D cancels that request; it
  // must never invoke the REPL's session-exit callback.
  const onActiveInputExit = useCallback(() => {
    if (permissionInputTypeRef.current && controller.getSnapshot().pendingApproval) {
      cancelPermission();
      return;
    }
    onExit?.();
  }, [controller, cancelPermission, onExit]);
  const onActiveInputExitMessage = useCallback((show, key) => {
    if (permissionInputTypeRef.current && controller.getSnapshot().pendingApproval) {
      controller.setStatus('');
      return;
    }
    onExitMessage(show, key);
  }, [controller, onExitMessage]);

  const onClearInput = useCallback(() => {
    setValue('');
    setOffset(0);
    setHistoryIndex(-1);
  }, [setValue, setOffset, setHistoryIndex]);

  const inputFilter = useCallback((input, key) => {
    const currentSnapshot = controller.getSnapshot();

    // Use one interrupt state machine for active cancellation, cleanup, idle
    // input clearing, and the original 800ms double-press exit.
    if (key.ctrl && (input.toLowerCase() === 'c' || input === '\x03')) {
      if (!currentSnapshot.busy) {
        onClearInput();
        resetHistory();
      }
      onInterrupt?.();
      return null;
    }

    // The original 2.1.88 Select navigation owns option focus. Enter only
    // confirms the focused option (initially Deny); it never grants by itself.
    // Y/N remain explicit shortcuts while full PermissionPrompt is ported.
    if (currentSnapshot.pendingApproval) {
      const handled = permissionKeyHandlerRef.current?.(input, key);
      if (handled) return null;
      // Only the original PermissionPrompt feedback field may receive text.
      // A missing/unmounted handler remains fail-closed.
      return permissionInputTypeRef.current ? input : null;
    }

    // The original 2.1.88 ScrollBox owns transcript history. PageUp/PageDown
    // and Home/End only take over while the prompt is empty; multiline prompt
    // editing keeps its normal cursor behavior. 2.1.304 also exposes the
    // absolute top/bottom bindings as Ctrl+Home/Ctrl+End.
    const unmodifiedPagerKey = !key.ctrl && !key.meta && !key.shift &&
      (key.pageUp || key.pageDown || key.home || key.end);
    const controlBoundaryKey = key.ctrl && !key.meta && !key.shift &&
      (key.home || key.end);
    if (valueRef.current.length === 0 && (unmodifiedPagerKey || controlBoundaryKey)) {
      const scroll = scrollRef.current;
      if (scroll) {
        const viewportHeight = scroll.getViewportHeight();
        const scrollHeight = scroll.getFreshScrollHeight();
        // Match the 2.1.304 ScrollBox guard: keys must not clear sticky follow
        // when the transcript currently fits in the viewport.
        if (scrollHeight <= viewportHeight) return null;
        const page = Math.max(1, viewportHeight || terminalRows);
        const effectiveTop = scroll.getScrollTop() + scroll.getPendingDelta();
        const maxScrollTop = Math.max(0, scrollHeight - viewportHeight);
        if (key.home) {
          scroll.scrollTo(0);
          onScrollAway(scroll);
        } else if (key.end) {
          repinScroll();
        } else if (key.pageUp) {
          if (effectiveTop - page <= 0) scroll.scrollTo(0);
          else scroll.scrollBy(-page);
          onScrollAway(scroll);
        } else if (effectiveTop + page >= maxScrollTop) {
          repinScroll();
        } else {
          scroll.scrollBy(page);
          onScrollAway(scroll);
        }
      }
      return null;
    }

    // Ordinary editing is disabled until startup work is complete and while
    // an AgentLoop turn is active.
    if (currentSnapshot.busy || !currentSnapshot.inputEnabled) return null;

    // Ink may emit printable text and Return in one discreteUpdates batch.
    // Submit from the synchronous edit buffer before the hook can observe a
    // stale render-time value.
    if (key.return && !key.shift && !key.meta) {
      const coalescedEnterText = getCoalescedEnterText(input);
      const insertion = coalescedEnterText ??
        (input === '\r' || input === '\n' ? '' : input);
      const current = valueRef.current;
      const cursor = offsetRef.current;
      submit(current.slice(0, cursor) + insertion + current.slice(cursor));
      return null;
    }
    return input;
  }, [controller, onClearInput, resetHistory, onInterrupt, submit, terminalRows, onScrollAway, repinScroll]);

  const activeInputValue = permissionInputType
    ? approvalFeedback[permissionInputType]
    : value;
  const activeInputOffset = permissionInputType ? feedbackOffset : offset;
  const setActiveInputValue = useCallback(nextValue => {
    const type = permissionInputTypeRef.current;
    if (type) setApprovalFeedback(type, nextValue);
    else setValue(nextValue);
  }, [setApprovalFeedback, setValue]);
  const setActiveInputOffset = useCallback(nextOffset => {
    if (permissionInputTypeRef.current) setFeedbackOffset(nextOffset);
    else setOffset(nextOffset);
  }, [setFeedbackOffset, setOffset]);
  const handleInputSubmit = useCallback(submittedValue => {
    if (permissionInputTypeRef.current) {
      // Original SelectInputOption delegates Enter to its TextInput onSubmit,
      // which selects the currently focused option with the retained feedback.
      permissionSubmitHandlerRef.current?.();
      return;
    }
    submit(submittedValue);
  }, [submit]);
  const inputState = useTextInput({
    value: activeInputValue,
    onChange: setActiveInputValue,
    onSubmit: handleInputSubmit,
    onExit: onActiveInputExit,
    onExitMessage: onActiveInputExitMessage,
    onHistoryUp: () => { if (!permissionInputTypeRef.current) onHistoryUp(); },
    onHistoryDown: () => { if (!permissionInputTypeRef.current) onHistoryDown(); },
    onHistoryReset: resetHistory,
    onClearInput,
    multiline: true,
    cursorChar: ' ',
    invert: text => chalk.inverse(text),
    themeText: text => chalk.white(text),
    columns: terminalColumns,
    disableCursorMovementForUpDownKeys: false,
    disableEscapeDoublePress: false,
    maxVisibleLines: Math.max(2, Math.min(8, terminalRows - 10)),
    externalOffset: activeInputOffset,
    onOffsetChange: setActiveInputOffset,
    inputFilter,
  });

  useEffect(() => {
    setInputReady(true);
  }, []);

  const visibleMessages = snapshot.messages;
  const scrollHandle = scrollRef.current;
  const scrollBottom = scrollHandle
    ? scrollHandle.getScrollTop() + scrollHandle.getPendingDelta() + scrollHandle.getViewportHeight()
    : 0;
  const dividerY = dividerYRef.current;
  // Match 2.1.304 FullscreenLayout: the bottom pill is visible only while
  // the viewport remains above the original scroll-away snapshot.
  const showJumpHint = !snapshot.pendingApproval && scrollMetrics !== null &&
    scrollHandle !== null && !scrollHandle.isSticky() &&
    dividerY !== null && scrollBottom < dividerY &&
    scrollBottom < scrollHandle.getScrollHeight();
  const unseenAssistantCount = dividerIndex === null
    ? 0
    : countUnseenAssistantTurns(visibleMessages, dividerIndex);
  const jumpHint = unseenAssistantCount > 0
    ? translate(locale, unseenAssistantCount === 1 ? 'tuiNewMessage' : 'tuiNewMessages', {
      count: unseenAssistantCount,
    })
    : translate(locale, 'tuiJumpToLatest');
  const maxInputLines = Math.max(2, Math.min(8, terminalRows - 10));
  const promptWrapWidth = Math.max(10, terminalColumns - 16);
  const promptLineCount = value.split('\n').reduce(
    (total, line) => total + Math.max(1, Math.ceil(line.length / promptWrapWidth)),
    0,
  );
  const visiblePromptLines = Math.max(1, Math.min(maxInputLines, promptLineCount));
  const transcriptHeight = Math.max(
    snapshot.pendingApproval ? 1 : 3,
    terminalRows - (
      snapshot.pendingApproval ? 23 : canInput ? 13 + visiblePromptLines : 7
    ),
  );
  const placeholder = translate(locale, 'tuiPlaceholder');
  const permissionLabel = snapshot.permissionMode === 'acceptEdits'
    ? translate(locale, 'tuiPermissionAuto')
    : translate(locale, 'tuiPermissionApproval');
  const status = isPasting
    ? translate(locale, 'tuiPasting')
    : snapshot.notification?.text || snapshot.status || translate(locale, 'tuiReady');

  return (
    <Box flexDirection="column" padding={1} width={terminalColumns} height={terminalRows}>
      <Box flexDirection="row" justifyContent="space-between">
        <Text bold color="cyan">agent-cil</Text>
        <Text dimColor>{snapshot.model} · {permissionLabel}</Text>
      </Box>
      {/* A pending approval is the active modal task. Keep the full original
          PermissionPrompt visible on short terminals instead of squeezing it
          between a transcript viewport and the normal footer. */}
      {!snapshot.pendingApproval ? (
      <Box
        position="relative"
        flexDirection="column"
        height={transcriptHeight}
        flexGrow={0}
        flexShrink={0}
        width="100%"
        marginTop={1}
        overflow="hidden"
      >
      <ScrollBox
        ref={scrollRef}
        flexDirection="column"
        height={transcriptHeight}
        flexGrow={0}
        flexShrink={0}
        minHeight={3}
        width="100%"
        stickyScroll
      >
        {visibleMessages.map(message => (
          <Box key={message.id} flexDirection="column" marginBottom={1}>
            {message.role === 'tool' ? (
              <Text
                bold
                color={message.status === 'succeeded' ? 'green'
                  : message.status === 'running' ? 'cyan' : 'yellow'}
              >
                {'› ' + message.toolName + ' · ' + translate(locale,
                  message.status === 'running' ? 'tuiToolRunning'
                    : message.status === 'succeeded' ? 'tuiToolSucceeded'
                      : message.status === 'denied' ? 'tuiToolDenied'
                        : message.status === 'interrupted' ? 'tuiToolInterrupted'
                          : 'tuiToolFailed')}
              </Text>
            ) : (
              <>
                <Text bold color={message.role === 'user' ? 'green' : message.role === 'assistant' ? 'cyan' : 'yellow'}>
                  {message.role === 'user'
                    ? translate(locale, 'tuiRoleYou')
                    : message.role === 'assistant'
                      ? translate(locale, 'tuiRoleAssistant')
                      : 'agent-cil'}
                </Text>
                {message.role === 'assistant' && message.streaming
                  ? <Text>{message.text || ' '}</Text>
                  : <MessageContent text={message.text || ' '} />}
              </>
            )}
            {message.role === 'tool' && message.resultContent !== undefined ? (
              <Box flexDirection="row" marginLeft={2}>
                <Text dimColor>⎿ </Text>
                <Box flexGrow={1}>
                  <MessageContent text={formatToolResultContent(message.resultContent, locale) || ' '} />
                </Box>
              </Box>
            ) : null}
          </Box>
        ))}
      </ScrollBox>
      {showJumpHint ? (
        <Box position="absolute" bottom={0} left={0} right={0} justifyContent="center">
          <Box paddingX={1} backgroundColor="ansi:yellow">
            <Text bold color="ansi:black">{jumpHint}</Text>
          </Box>
        </Box>
      ) : null}
      </Box>
      ) : null}
      {snapshot.pendingApproval ? (
        <PermissionPrompt
          key={snapshot.pendingApproval.id}
          locale={locale}
          name={snapshot.pendingApproval.name}
          reason={snapshot.pendingApproval.reason}
          defaultToNo={snapshot.pendingApproval.defaultToNo}
          input={snapshot.pendingApproval.input}
          terminalFocus={terminalFocus}
          inputReady={inputReady}
          inputState={inputState}
          feedbackValues={approvalFeedback}
          getFeedbackValues={getApprovalFeedback}
          onFeedbackChange={setApprovalFeedback}
          onFeedbackModeChange={setPermissionInputType}
          onKeyHandlerChange={registerPermissionKeyHandler}
          onSubmitHandlerChange={registerPermissionSubmitHandler}
          onSelect={resolvePermissionSelection}
          onCancel={cancelPermission}
          onPaste={onPaste}
          onIsPastingChange={onPermissionPasteStateChange}
        />
      ) : null}
      {canInput ? (
        <Box
          flexDirection="column"
          borderStyle="round"
          borderColor="cyan"
          padding={1}
          marginTop={1}
        >
          <Box flexDirection="row">
            <Text bold color="green">{translate(locale, 'userPrompt')}</Text>
            <Box flexGrow={1}>
              <BaseTextInput
                inputState={inputState}
                terminalFocus={terminalFocus}
                focus
                showCursor={canInput}
                value={value}
                onChange={setValue}
                cursorOffset={inputState.offset}
                onChangeCursorOffset={inputState.setOffset}
                multiline
                placeholder={placeholder}
                onPaste={onPaste}
                onIsPastingChange={pasting => { if (canInput) setIsPasting(pasting); }}
                invert={text => chalk.inverse(text)}
              />
            </Box>
          </Box>
        </Box>
      ) : null}
{!snapshot.pendingApproval ? (
        <Box flexDirection="column" marginTop={1}>
          <Text dimColor>{status}</Text>
          <Text dimColor>{translate(locale, 'tuiFooterHelp')}</Text>
        </Box>
      ) : null}
    </Box>
  );
}
