/**
 * Runtime permission-context updates, adapted from CLI 2.1.88:
 * restored-src/src/utils/permissions/PermissionUpdate.ts
 * and permissionRuleParser.ts (escapeRuleContent/permissionRuleValueToString).
 *
 * Retains the original immutable context-update switch and rule serialization.
 * Settings persistence, telemetry, Bun flags and React state are intentionally
 * NOT part of this Node.js headless port. Updates are in-memory only.
 * Original notice: © Anthropic PBC. All rights reserved.
 */
export function escapeRuleContent(content) {
  return content.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

export function permissionRuleValueToString(ruleValue) {
  if (!ruleValue.ruleContent) return ruleValue.toolName;
  const escapedContent = escapeRuleContent(ruleValue.ruleContent);
  return ruleValue.toolName + '(' + escapedContent + ')';
}

export function extractRules(updates) {
  if (!updates) return [];
  return updates.flatMap(update => {
    switch (update.type) {
      case 'addRules':
        return update.rules;
      default:
        return [];
    }
  });
}

export function hasRules(updates) {
  return extractRules(updates).length > 0;
}

export function applyPermissionUpdate(context, update) {
  switch (update.type) {
    case 'setMode':
      return { ...context, mode: update.mode };

    case 'addRules': {
      const ruleStrings = update.rules.map(rule => permissionRuleValueToString(rule));
      const ruleKind =
        update.behavior === 'allow'
          ? 'alwaysAllowRules'
          : update.behavior === 'deny'
            ? 'alwaysDenyRules'
            : 'alwaysAskRules';
      return {
        ...context,
        [ruleKind]: {
          ...context[ruleKind],
          [update.destination]: [
            ...(context[ruleKind][update.destination] || []),
            ...ruleStrings,
          ],
        },
      };
    }

    case 'replaceRules': {
      const ruleStrings = update.rules.map(rule => permissionRuleValueToString(rule));
      const ruleKind =
        update.behavior === 'allow'
          ? 'alwaysAllowRules'
          : update.behavior === 'deny'
            ? 'alwaysDenyRules'
            : 'alwaysAskRules';
      return {
        ...context,
        [ruleKind]: {
          ...context[ruleKind],
          [update.destination]: ruleStrings,
        },
      };
    }

    case 'addDirectories': {
      const newAdditionalDirs = new Map(context.additionalWorkingDirectories);
      for (const directory of update.directories) {
        newAdditionalDirs.set(directory, { path: directory, source: update.destination });
      }
      return {
        ...context,
        additionalWorkingDirectories: newAdditionalDirs,
      };
    }

    case 'removeRules': {
      const ruleStrings = update.rules.map(rule => permissionRuleValueToString(rule));
      const ruleKind =
        update.behavior === 'allow'
          ? 'alwaysAllowRules'
          : update.behavior === 'deny'
            ? 'alwaysDenyRules'
            : 'alwaysAskRules';
      const existingRules = context[ruleKind][update.destination] || [];
      const rulesToRemove = new Set(ruleStrings);
      const filteredRules = existingRules.filter(rule => !rulesToRemove.has(rule));
      return {
        ...context,
        [ruleKind]: {
          ...context[ruleKind],
          [update.destination]: filteredRules,
        },
      };
    }

    case 'removeDirectories': {
      const newAdditionalDirs = new Map(context.additionalWorkingDirectories);
      for (const directory of update.directories) {
        newAdditionalDirs.delete(directory);
      }
      return { ...context, additionalWorkingDirectories: newAdditionalDirs };
    }

    default:
      return context;
  }
}

export function applyPermissionUpdates(context, updates) {
  let updatedContext = context;
  for (const update of updates) {
    updatedContext = applyPermissionUpdate(updatedContext, update);
  }
  return updatedContext;
}

export function supportsPersistence(destination) {
  return destination === 'localSettings' || destination === 'userSettings' || destination === 'projectSettings';
}
