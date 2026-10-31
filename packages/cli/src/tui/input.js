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

// Original 2.1.88 Select focuses the first option. 2.1.304 adds
// PermissionAskDecision.defaultToNo: the decline option is placed first and
// numeric option selection/index rendering are disabled for that request.
export function getPermissionInitialFocus(defaultToNo = false) {
  return defaultToNo === true ? 'deny' : 'allow';
}
