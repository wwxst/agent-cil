/**
 * Direct behavioral port of the Hook attachment cases in original 2.1.88
 * utils/messages.ts normalizeAttachmentForAPI() (circa 4090–4145,
 * 4257–4268), used by query.ts after tool_result assembly.
 *
 * Original: hook_blocking_error, hook_additional_context and
 * hook_stopped_continuation become user isMeta system-reminder messages;
 * hook_success (except SessionStart/UserPromptSubmit), hook_cancelled,
 * hook_non_blocking_error, hook_error_during_execution and
 * hook_system_message are display-only and never sent to the model.
 *
 * Node CLI uses Anthropic's plain {role,content} message format, so the
 * original user/meta representation is adapted into text content blocks
 * in the existing tool_result user turn. Retain source hook attachments
 * separately in AgentLoop.run().hookMessages for UI/session consumers.
 */
const API_VISIBLE_HOOK_ATTACHMENTS = new Set([
  'hook_blocking_error', 'hook_additional_context', 'hook_stopped_continuation',
]);
const DISPLAY_ONLY_HOOK_ATTACHMENTS = new Set([
  'hook_success', 'hook_cancelled', 'hook_error_during_execution',
  'hook_non_blocking_error', 'hook_system_message',
  'hook_permission_decision',
]);

// Original utils/messages.ts wrapInSystemReminder().
export function wrapInSystemReminder(content) {
  return `<system-reminder>\n${content}\n</system-reminder>`;
}

export function normalizeHookAttachmentForAPI(message) {
  if (!message || message.type !== 'attachment' ||
      !message.attachment || typeof message.attachment !== 'object') {
    throw new TypeError('Expected a legacy original Hook attachment.');
  }
  const attachment = message.attachment;
  if (DISPLAY_ONLY_HOOK_ATTACHMENTS.has(attachment.type)) return [];
  if (!API_VISIBLE_HOOK_ATTACHMENTS.has(attachment.type)) {
    // Unlike old CLI's permissive legacy-attachment fallback, a new
    // unsupported node Hook type must not be silently fed to the model.
    throw new TypeError('Unsupported Hook attachment: ' + String(attachment.type));
  }
  const hookName = typeof attachment.hookName === 'string'
    ? attachment.hookName : 'Tool Hook';
  switch (attachment.type) {
    case 'hook_blocking_error': {
      const block = attachment.blockingError;
      if (!block || typeof block.blockingError !== 'string') {
        throw new TypeError('Malformed Hook blocking error.');
      }
      return [{ type: 'text', text: wrapInSystemReminder(
        `${hookName} hook blocking error from command: "${block.command}": ${block.blockingError}`
      ) }];
    }
    case 'hook_additional_context': {
      if (!Array.isArray(attachment.content) ||
          attachment.content.some(x => typeof x !== 'string')) {
        throw new TypeError('Malformed Hook additional context.');
      }
      if (attachment.content.length === 0) return [];
      return [{ type: 'text', text: wrapInSystemReminder(
        `${hookName} hook additional context: ${attachment.content.join('\n')}`
      ) }];
    }
    case 'hook_stopped_continuation': {
      if (typeof attachment.message !== 'string') {
        throw new TypeError('Malformed Hook stop message.');
      }
      return [{ type: 'text', text: wrapInSystemReminder(
        `${hookName} hook stopped continuation: ${attachment.message}`
      ) }];
    }
  }
  return [];
}

/** Original query.ts normalizes these attachments *after* all concurrent
 * tool calls complete. The scheduler result array stays unchanged; append
 * reminders to the same user turn, just as original mergeUserMessages does.
 * Group by tool_use order, never Hook subprocess completion order.
 */
export function normalizeToolHookAttachmentsForAPI(events, toolUses, turn) {
  if (!Array.isArray(events) || !Array.isArray(toolUses)) {
    throw new TypeError('Hook attachment normalization requires arrays.');
  }
  const ordered = [];
  const accepted = new Set();
  for (const toolUse of toolUses) {
    if (!toolUse || typeof toolUse.id !== 'string' || accepted.has(toolUse.id)) continue;
    accepted.add(toolUse.id);
    for (const event of events) {
      if (event?.turn !== turn || event.toolUseId !== toolUse.id) continue;
      ordered.push(...normalizeHookAttachmentForAPI(event.message));
    }
  }
  return ordered;
}
