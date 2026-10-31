export function createTuiController({ locale = 'en', model = 'default', permissionMode = 'default' } = {}) {
  let snapshot = {
    locale,
    model,
    permissionMode,
    messages: [],
    status: '',
    busy: false,
    pendingApproval: null,
    inputEnabled: false,
    notification: null,
    attribution: { escapeCount: 0 },
  };
  const listeners = new Set();
  let activeAssistantId = null;
  let nextMessageId = 1;
  let instance;
  let closed = false;
  let exitCode = 0;
  let resolveExit;
  const exitPromise = new Promise(resolve => { resolveExit = resolve; });
  let pendingApproval = null;

  const publish = patch => {
    snapshot = { ...snapshot, ...patch };
    for (const listener of listeners) listener();
  };
  const addMessage = (role, text) => {
    const message = { id: nextMessageId++, role, text: String(text ?? '') };
    publish({ messages: [...snapshot.messages, message] });
    return message.id;
  };

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot() { return snapshot; },
    addMessage,
    beginAssistantMessage() {
      activeAssistantId = addMessage('assistant', '');
    },
    appendAssistantText(text) {
      if (!activeAssistantId || !text) return;
      publish({
        messages: snapshot.messages.map(message => message.id === activeAssistantId
          ? { ...message, text: message.text + text }
          : message),
      });
    },
    finishAssistantMessage() { activeAssistantId = null; },
    pushSystemMessage(text) { addMessage('system', text); },
    setStatus(status) { publish({ status: String(status ?? '') }); },
    setNotification(notification) {
      if (!notification) {
        publish({ notification: null });
      } else if (notification.remove) {
        if (snapshot.notification?.key === notification.key) publish({ notification: null });
      } else {
        publish({ notification });
      }
    },
    setBusy(busy) { publish({ busy: Boolean(busy) }); },
    setInputEnabled(inputEnabled) { publish({ inputEnabled: Boolean(inputEnabled) }); },
    setLocale(locale) { publish({ locale }); },
    setPermissionMode(permissionMode) { publish({ permissionMode }); },
    requestApproval({ name, input, reason, defaultToNo = false, signal }) {
      if (closed || signal?.aborted) {
        return Promise.resolve({ approved: false, reason: 'Interactive approval was cancelled.' });
      }
      if (pendingApproval) {
        return Promise.resolve({ approved: false, reason: 'Another permission request is already pending.' });
      }
      return new Promise(resolve => {
        let settled = false;
        const id = nextMessageId++;
        const cleanup = () => signal?.removeEventListener('abort', onAbort);
        const finish = result => {
          if (settled) return;
          settled = true;
          cleanup();
          if (pendingApproval?.id === id) pendingApproval = null;
          publish({ pendingApproval: null });
          resolve(result);
        };
        const onAbort = () => finish({ approved: false, reason: 'Permission request was interrupted.' });
        pendingApproval = { id, finish };
        let inputText;
        try { inputText = JSON.stringify(input, null, 2); }
        catch { inputText = String(input); }
        publish({
          pendingApproval: {
            id, name, reason, input: inputText,
            // A missing 2.1.304 flag preserves the original Select's
            // first-option approval focus; true explicitly focuses Deny.
            defaultToNo: defaultToNo === true,
          },
        });
        signal?.addEventListener('abort', onAbort, { once: true });
        if (signal?.aborted) onAbort();
      });
    },
    resolveApproval(approved, feedback) {
      const request = pendingApproval;
      if (!request) return false;
      const normalizedFeedback = typeof feedback === 'string' ? feedback.trim() : '';
      request.finish({
        approved: Boolean(approved),
        reason: approved
          ? 'User approved the tool call.'
          : (normalizedFeedback || 'User denied the tool call.'),
        ...(approved && normalizedFeedback ? { acceptFeedback: normalizedFeedback } : {}),
      });
      return true;
    },
    recordPermissionEscape() {
      publish({
        attribution: {
          ...snapshot.attribution,
          escapeCount: snapshot.attribution.escapeCount + 1,
        },
      });
    },
    attachInstance(value) {
      instance = value;
      if (closed) instance.unmount();
      void instance.waitUntilExit().then(() => {
        if (!closed) closed = true;
        instance?.cleanup?.();
        resolveExit(exitCode);
      }).catch(() => {
        if (!closed) exitCode = 1;
        closed = true;
        instance?.cleanup?.();
        resolveExit(exitCode);
      });
    },
    close(code = 0) {
      if (closed) return;
      closed = true;
      exitCode = Number.isInteger(code) ? code : 0;
      if (pendingApproval) pendingApproval.finish({ approved: false, reason: 'The interactive session is closing.' });
      publish({ busy: false, status: '', notification: null });
      if (instance) instance.unmount();
      else resolveExit(exitCode);
    },
    waitUntilExit() { return exitPromise; },
    getExitCode() { return exitCode; },
  };
}
