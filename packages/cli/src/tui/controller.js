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
    loadTranscript(messages) {
      if (!Array.isArray(messages)) {
        throw new TypeError('Initial transcript must be an array of model messages.');
      }
      if (snapshot.messages.length !== 0) return false;

      const rows = [];
      const toolRows = new Map();
      const toolNames = new Map();
      for (const source of messages) {
        if (source?.role !== 'assistant' || !Array.isArray(source.content)) continue;
        for (const block of source.content) {
          if (block?.type === 'tool_use' && typeof block.id === 'string' && block.id) {
            toolNames.set(block.id, typeof block.name === 'string' && block.name
              ? block.name : 'Tool');
          }
        }
      }

      const appendText = (role, text) => {
        if (typeof text !== 'string' || text.length === 0) return;
        rows.push({ id: nextMessageId++, role, text });
      };
      const appendToolUse = block => {
        if (typeof block?.id !== 'string' || !block.id ||
            toolRows.has(block.id)) return;
        const row = {
          id: nextMessageId++,
          role: 'tool',
          toolUseId: block.id,
          toolName: toolNames.get(block.id) ?? 'Tool',
          status: 'running',
          ...(block.input !== undefined ? { input: structuredClone(block.input) } : {}),
        };
        rows.push(row);
        toolRows.set(block.id, row);
      };
      const appendToolResult = block => {
        if (typeof block?.tool_use_id !== 'string' || !block.tool_use_id) return;
        let row = toolRows.get(block.tool_use_id);
        if (!row) {
          row = {
            id: nextMessageId++,
            role: 'tool',
            toolUseId: block.tool_use_id,
            toolName: toolNames.get(block.tool_use_id) ?? 'Tool',
            status: 'running',
          };
          rows.push(row);
          toolRows.set(block.tool_use_id, row);
        }
        const resultContent = block.content === undefined
          ? '' : structuredClone(block.content);
        Object.assign(row, {
          resultContent,
          resultIsError: block.is_error === true,
          status: block.is_error === true ? 'failed' : 'succeeded',
        });
      };

      for (const source of messages) {
        if (source?.role !== 'user' && source?.role !== 'assistant') continue;
        const content = typeof source.content === 'string'
          ? [{ type: 'text', text: source.content }]
          : Array.isArray(source.content) ? source.content : [];

        if (source.role === 'assistant') {
          let text = '';
          const flushText = () => {
            appendText('assistant', text);
            text = '';
          };
          for (const block of content) {
            if (block?.type === 'text' && typeof block.text === 'string') {
              text += block.text;
            } else if (block?.type === 'tool_use') {
              flushText();
              appendToolUse(block);
            }
          }
          flushText();
          continue;
        }

        let text = '';
        let imageCount = 0;
        const flushUserText = () => {
          if (imageCount > 0) {
            text += (text ? '\n' : '') + '[' + imageCount + ' image attachment' +
              (imageCount === 1 ? '' : 's') + ']';
            imageCount = 0;
          }
          appendText(text.startsWith('<task_notification>') ? 'system' : 'user', text);
          text = '';
        };
        for (const block of content) {
          if (block?.type === 'tool_result') {
            flushUserText();
            appendToolResult(block);
          } else if (block?.type === 'text' && typeof block.text === 'string') {
            text += block.text;
          } else if (block?.type === 'image') {
            imageCount += 1;
          }
        }
        flushUserText();
      }

      if (rows.length === 0) return false;
      publish({ messages: rows });
      return true;
    },
    beginAssistantMessage() {
      activeAssistantId = nextMessageId++;
      publish({
        messages: [...snapshot.messages, {
          id: activeAssistantId,
          role: 'assistant',
          text: '',
          streaming: true,
        }],
      });
    },
    appendAssistantText(text) {
      if (!activeAssistantId || !text) return;
      publish({
        messages: snapshot.messages.map(message => message.id === activeAssistantId
          ? { ...message, text: message.text + text }
          : message),
      });
    },
    finishAssistantMessage() {
      if (activeAssistantId !== null) {
        const finishedId = activeAssistantId;
        const activeMessage = snapshot.messages.find(message => message.id === finishedId);
        if (activeMessage) {
          // The adapter renders tool_use as dedicated tool rows. When a
          // model response contains no text, retaining its empty assistant
          // placeholder adds a phantom transcript row above those results.
          const messages = activeMessage.text.length === 0
            ? snapshot.messages.filter(message => message.id !== finishedId)
            : snapshot.messages.map(message => message.id === finishedId
              ? { ...message, streaming: false }
              : message);
          publish({ messages });
        }
      }
      activeAssistantId = null;
    },
    beginToolMessage(toolUseId, toolName) {
      if (typeof toolUseId !== 'string' || !toolUseId ||
          typeof toolName !== 'string' || !toolName) return null;
      const existing = snapshot.messages.find(message => message.role === 'tool' &&
        message.toolUseId === toolUseId);
      if (existing) return existing.id;
      const message = {
        id: nextMessageId++,
        role: 'tool',
        toolUseId,
        toolName,
        status: 'running',
      };
      publish({ messages: [...snapshot.messages, message] });
      return message.id;
    },
    setToolMessageResult({ toolUseId, toolName, content, isError = false } = {}) {
      if (typeof toolUseId !== 'string' || !toolUseId ||
          typeof toolName !== 'string' || !toolName ||
          (typeof content !== 'string' && !Array.isArray(content))) return false;
      let resultContent;
      try {
        resultContent = structuredClone(content);
      } catch {
        return false;
      }
      let found = false;
      const messages = snapshot.messages.map(message => {
        if (message.role !== 'tool' || message.toolUseId !== toolUseId) return message;
        found = true;
        return {
          ...message,
          resultContent,
          resultIsError: isError === true,
        };
      });
      if (found) publish({ messages });
      return found;
    },
    finishToolMessage({ toolUseId, isError = false, denied = false, interrupted = false } = {}) {
      if (typeof toolUseId !== 'string' || !toolUseId) return false;
      const status = interrupted ? 'interrupted'
        : denied ? 'denied'
          : isError ? 'failed' : 'succeeded';
      let found = false;
      const messages = snapshot.messages.map(message => {
        if (message.role !== 'tool' || message.toolUseId !== toolUseId) return message;
        found = true;
        return message.status === status ? message : { ...message, status };
      });
      if (found) publish({ messages });
      return found;
    },
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
    setModel(model) { publish({ model }); },
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
    resolveApproval(approved, feedback, permissionUpdates) {
      const request = pendingApproval;
      if (!request) return false;
      const normalizedFeedback = typeof feedback === 'string' ? feedback.trim() : '';
      request.finish({
        approved: Boolean(approved),
        reason: approved
          ? 'User approved the tool call.'
          : (normalizedFeedback || 'User denied the tool call.'),
        ...(approved && normalizedFeedback ? { acceptFeedback: normalizedFeedback } : {}),
        ...(approved && Array.isArray(permissionUpdates) && permissionUpdates.length
          ? { permissionUpdates: structuredClone(permissionUpdates) } : {}),
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
