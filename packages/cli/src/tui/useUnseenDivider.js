import { useCallback, useEffect, useRef, useState } from 'react';

// Extracted from the original 2.1.88
// restored-src/src/components/FullscreenLayout.tsx. Keep the original
// first-scroll-away snapshot and repin lifecycle instead of approximating
// unseen-message state from every scroll event.
export function useUnseenDivider(messageCount) {
  const [dividerIndex, setDividerIndex] = useState(null);
  const countRef = useRef(messageCount);
  countRef.current = messageCount;
  const dividerYRef = useRef(null);

  const onRepin = useCallback(() => {
    // The original implementation defers clearing dividerYRef until React
    // commits the null dividerIndex. This blocks a wheel event in the same
    // stdin batch from taking a second, stale snapshot.
    setDividerIndex(null);
  }, []);

  const onScrollAway = useCallback(handle => {
    const max = Math.max(0, handle.getScrollHeight() - handle.getViewportHeight());
    if (handle.getScrollTop() + handle.getPendingDelta() >= max) return;

    // Snapshot only on the first scroll-away. Later scroll actions must not
    // move the divider baseline or reset the unseen-message count.
    if (dividerYRef.current === null) {
      dividerYRef.current = handle.getScrollHeight();
      setDividerIndex(countRef.current);
    }
  }, []);

  const jumpToNew = useCallback(handle => {
    if (!handle) return;
    // scrollToBottom re-enables sticky follow and mounts the live tail.
    handle.scrollToBottom();
  }, []);

  useEffect(() => {
    if (dividerIndex === null) {
      dividerYRef.current = null;
    } else if (messageCount < dividerIndex) {
      // /clear, rewind, or transcript replacement invalidated the snapshot.
      dividerYRef.current = null;
      setDividerIndex(null);
    }
  }, [messageCount, dividerIndex]);

  const shiftDivider = useCallback((indexDelta, heightDelta) => {
    setDividerIndex(index => index === null ? null : index + indexDelta);
    if (dividerYRef.current !== null) {
      dividerYRef.current += heightDelta;
    }
  }, []);

  return {
    dividerIndex,
    dividerYRef,
    onScrollAway,
    onRepin,
    jumpToNew,
    shiftDivider,
  };
}

export function countUnseenAssistantTurns(messages, dividerIndex) {
  if (!Number.isInteger(dividerIndex) || dividerIndex < 0) return 0;
  let count = 0;
  let previousWasAssistant = false;
  for (let i = dividerIndex; i < messages.length; i++) {
    const message = messages[i];
    if (message?.role === 'progress') continue;
    // Match the original helper: tool-use-only/empty assistant entries do
    // not count and do not split a visible assistant turn.
    if (message?.role === 'assistant' &&
        (typeof message.text !== 'string' || message.text.trim() === '')) continue;
    const isAssistant = message?.role === 'assistant';
    if (isAssistant && !previousWasAssistant) count++;
    previousWasAssistant = isAssistant;
  }
  return count;
}
