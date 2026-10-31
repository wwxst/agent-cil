/** A missing application policy must never silently authorize tool execution. */
export function defaultDenyPermission({ name } = {}) {
  return {
    behavior: 'deny',
    reason: name
      ? 'No permission policy is configured for tool ' + name + '.'
      : 'No permission policy is configured.',
  };
}
