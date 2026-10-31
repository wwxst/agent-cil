/**
 * Headless Node.js port of the tool-specific permission stage of CLI 2.1.88
 * restored-src/src/utils/permissions/permissions.ts.
 *
 * 2.1.88 calls tool.checkPermissions(parsedInput, context) after whole-tool
 * deny/ask rules, then resolves deny/ask/allow/passthrough against the
 * applicable mode. This port preserves the tool callback and its restrictive
 * decisions, but deliberately does not port Bun/React/sandbox/classifier
 * modes. The caller supplies the already-checked CLI policy decision.
 *
 * Original notice: © Anthropic PBC. All rights reserved.
 */
export async function resolveToolSpecificPermission({
  tool, input, baseDecision, context,
} = {}) {
  // A global deny, invalid global decision or global policy input rewrite
  // must never be overridden by a tool implementation. After a rewrite, the
  // agent loop revalidates and re-enters this stage with the effective input.
  if (!baseDecision || !['allow', 'deny', 'ask'].includes(baseDecision.behavior)) {
    return baseDecision;
  }
  if (baseDecision.behavior === 'deny' || baseDecision.updatedInput !== undefined) {
    return baseDecision;
  }
  if (!tool || typeof tool.checkPermissions !== 'function') return baseDecision;

  // The tool implementation may not mutate the policy's input in-place.
  // It can only request a rewrite explicitly through updatedInput, which the
  // AgentLoop must schema-validate and reauthorize.
  const toolDecision = await tool.checkPermissions(structuredClone(input), context);
  if (!toolDecision || !['allow', 'deny', 'ask', 'passthrough'].includes(toolDecision.behavior)) {
    return { behavior: 'deny', reason: 'Tool-specific permission check returned an invalid decision.' };
  }

  const reason = typeof toolDecision.reason === 'string' ? toolDecision.reason
    : typeof toolDecision.message === 'string' ? toolDecision.message : '';

  if (toolDecision.behavior === 'deny') {
    // Deny is terminal, including when returned alongside an updatedInput.
    return { behavior: 'deny', reason: reason || 'Tool-specific permission check denied the action.' };
  }

  if (toolDecision.behavior === 'ask') {
    return {
      ...baseDecision,
      behavior: 'ask',
      reason: reason || baseDecision.reason || 'Tool-specific permission check requires approval.',
      ...(toolDecision.defaultToNo === true || baseDecision.defaultToNo === true
        ? { defaultToNo: true } : {}),
      ...(toolDecision.updatedInput !== undefined
        ? { updatedInput: toolDecision.updatedInput } : {}),
    };
  }

  // Original permissions.ts:hasPermissionsToUseToolInner(): the whole-tool
  // deny/ask rules are checked first, but an ordinary tool-specific allow
  // is final in default mode (step 3). Do NOT conflate the CLI's fallback
  // "ask" with a configured whole-tool ask rule, an external policy ask,
  // or Hook-mandated approval. Only the explicitly tagged default fallback
  // may be promoted, and only by an affirmative tool-specific allow.
  const defaultModeAsk = baseDecision.behavior === 'ask' &&
    baseDecision.decisionReason?.type === 'mode' &&
    baseDecision.decisionReason?.mode === 'default';
  if (defaultModeAsk && toolDecision.behavior === 'allow') {
    return {
      behavior: 'allow',
      reason: reason || 'Allowed by tool-specific permission rule.',
      ...(toolDecision.decisionReason ? { decisionReason: toolDecision.decisionReason } : {}),
      ...(toolDecision.updatedInput !== undefined
        ? { updatedInput: toolDecision.updatedInput } : {}),
    };
  }
  // Passthrough remains ask in default mode; an explicit global ask/deny or
  // external/custom policy cannot be overridden by tool-specific allow.
  return {
    ...baseDecision,
    ...(toolDecision.updatedInput !== undefined
      ? { updatedInput: toolDecision.updatedInput } : {}),
  };
}
