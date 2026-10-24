/**
 * Node port of 2.1.88 utils/hooks.ts executeHooks() result-aggregation loop,
 * source lines 2745–2865. Original source remains in
 * ../legacy-original/hooks.ts.
 *
 * Original invariant: multiple PreToolUse hooks combine using
 * deny > ask > allow > passthrough, regardless of completion order.
 * Each yielded state is passed unchanged into runPreToolUseHooks().
 */
export async function* aggregateHookResults(outcomes, signal) {
  let permissionBehavior;
  for (const pending of outcomes) {
    if (signal?.aborted) return;
    const result = await pending;
    if (signal?.aborted) return;

    // Port of executeHooks() after "for await (const result of all(...))".
    if (result.preventContinuation) {
      yield { preventContinuation: true, stopReason: result.stopReason };
    }
    if (result.blockingError) yield { blockingError: result.blockingError };
    if (result.message) yield { message: result.message };
    if (result.additionalContexts?.length) {
      yield { additionalContexts: result.additionalContexts };
    }

    // Original switch from executeHooks: deny > ask > allow.
    // A hook with exit code 2 is a blocking denial even without JSON.
    // Unlike the source's JSON path, it has no permissionBehavior field:
    // normalize it to deny to prevent a later allow undoing the block.
    const nextBehavior = result.blockingError ? 'deny' : result.permissionBehavior;
    if (nextBehavior) {
      switch (nextBehavior) {
        case 'deny':
          permissionBehavior = 'deny';
          break;
        case 'ask':
          if (permissionBehavior !== 'deny') permissionBehavior = 'ask';
          break;
        case 'allow':
          if (!permissionBehavior) permissionBehavior = 'allow';
          break;
        case 'passthrough':
          break;
        default:
          throw new TypeError('Unrecognized PreToolUse permission behavior.');
      }
    }

    if (permissionBehavior !== undefined) {
      // Preserve the 2.1.88 result.updatedInput gating: an input returned
      // by allow/ask is included; a deny must never rewrite executable input.
      const updatedInput = result.updatedInput &&
        (result.permissionBehavior === 'allow' || result.permissionBehavior === 'ask')
          ? result.updatedInput
          : undefined;
      yield {
        permissionBehavior,
        hookPermissionDecisionReason: result.hookPermissionDecisionReason,
        hookSource: result.hookSource,
        updatedInput,
      };
    }
    if (result.updatedInput && result.permissionBehavior === undefined &&
        !result.blockingError) {
      yield { updatedInput: result.updatedInput };
    }
  }
}
