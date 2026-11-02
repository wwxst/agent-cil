// Preserve the coalesced-Enter behavior from CLI 2.1.88's useTextInput.
// parse-keypress deliberately does not reinterpret a printable run ending in
// CR as a separate Return key; the input hook recognizes this transport case.
export function getCoalescedEnterText(input) {
  if (
    typeof input !== 'string' ||
    input.length <= 1 ||
    !input.endsWith('\r') ||
    input.slice(0, -1).includes('\r') ||
    input[input.length - 2] === '\\'
  ) {
    return null;
  }
  return input.slice(0, -1);
}

/**
 * PermissionPrompt in the pinned 2.1.88 REPL commits an explicit selection
 * through Select.onChange; Enter is never itself an unconditional "allow".
 * Keep the currently wired BaseTextInput bridge fail-closed until the complete
 * original PermissionPrompt/Select dependency graph is imported and mounted.
 *
 * null means the key did not decide the permission. All input is swallowed
 * while an approval is pending so it cannot leak into the task prompt.
 */
// Original 2.1.88 Select focuses the first option. 2.1.304 adds
// PermissionAskDecision.defaultToNo for asks that must open on the decline
// option rather than allowing a stray Enter/shortcut to approve.
// Reused from the original 2.1.88 utils/stringUtils.ts. This matters
// for the CustomSelect numeric shortcut when users type with a CJK IME.
export function normalizeFullWidthDigits(input) {
  return input.replace(/[０-９]/g, ch =>
    String.fromCharCode(ch.charCodeAt(0) - 0xfee0),
  );
}

export function getPermissionInitialFocus(defaultToNo = false) {
  return defaultToNo === true ? 'deny' : 'allow';
}

export function approvalDecisionFromKey(input, key = {}) {
  if (key.escape) return false;
  if (key.ctrl || key.meta || key.shift) return null;
  const effectiveInput = getCoalescedEnterText(input) ?? input;
  if (typeof effectiveInput !== 'string') return null;
  // defaultToNo changes the initial focused option; it must not turn an
  // explicit affirmative shortcut into a denial.
  if (effectiveInput.toLowerCase() === 'y') return true;
  if (effectiveInput.toLowerCase() === 'n') return false;
  return null;
}
