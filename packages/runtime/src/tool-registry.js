import { validateJsonSchema } from './validation.js';

function isRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export class ToolRegistryError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ToolRegistryError';
  }
}

/** A local registry of callable tools and the public metadata sent to a model. */
export class ToolRegistry {
  #tools = new Map();
  #aliases = new Map();

  register({ name, aliases = [], skipAggregateToolResultBudget = false, description, inputSchema = { type: 'object' }, validateInput, checkPermissions, backfillObservableInput, requiresUserInteraction, isConcurrencySafe, canRunDuringStream = false, interruptBehavior, execute, call, mapToolResultToToolResultBlockParam, maxResultSizeChars = 50_000, persistenceThresholdCeiling = 50_000 } = {}) {
    if (typeof name !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(name)) {
      throw new ToolRegistryError('Tool name must contain 1-128 letters, digits, underscores or hyphens.');
    }
    if (this.#tools.has(name) || this.#aliases.has(name)) throw new ToolRegistryError('Tool name is already registered: ' + name);
    if (!Array.isArray(aliases) || aliases.some(alias =>
      typeof alias !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(alias) ||
      alias === name || this.#tools.has(alias) || this.#aliases.has(alias)) ||
      new Set(aliases).size !== aliases.length) {
      throw new ToolRegistryError('Tool aliases must be unique, valid names that do not collide with registered tools.');
    }
    if (typeof skipAggregateToolResultBudget !== 'boolean') {
      throw new ToolRegistryError('skipAggregateToolResultBudget must be a boolean.');
    }
    if (typeof description !== 'string' || description.trim().length === 0) {
      throw new ToolRegistryError('Tool description must be a non-empty string.');
    }
    if (!isRecord(inputSchema)) throw new ToolRegistryError('Tool inputSchema must be a JSON schema object.');
    if (validateInput !== undefined && typeof validateInput !== 'function') {
      throw new ToolRegistryError('validateInput must be a function when provided.');
    }
    if (checkPermissions !== undefined && typeof checkPermissions !== 'function') {
      throw new ToolRegistryError('checkPermissions must be a function when provided.');
    }
    // Native original Tool.ts method; only the observable copy is backfilled.
    if (backfillObservableInput !== undefined && typeof backfillObservableInput !== 'function') {
      throw new ToolRegistryError('backfillObservableInput must be a function when provided.');
    }
    // Old Tool.ts / toolHooks.ts calls requiresUserInteraction() before
    // deciding whether a PreToolUse allow may bypass user confirmation.
    if (requiresUserInteraction !== undefined && typeof requiresUserInteraction !== 'function') {
      throw new ToolRegistryError('requiresUserInteraction must be a function when provided.');
    }
    if (isConcurrencySafe !== undefined && typeof isConcurrencySafe !== 'function') {
      throw new ToolRegistryError('isConcurrencySafe must be a function when provided.');
    }
    // Trusted explicit opt-in. Concurrency-safety alone does not imply
    // read-only: Bash, Write and Edit must never be speculatively executed.
    if (typeof canRunDuringStream !== 'boolean' ||
      (canRunDuringStream && typeof isConcurrencySafe !== 'function')) {
      throw new ToolRegistryError('canRunDuringStream requires a boolean and isConcurrencySafe.');
    }
    if (interruptBehavior !== undefined && typeof interruptBehavior !== 'function') {
      throw new ToolRegistryError('interruptBehavior must be a function when provided.');
    }
    if (typeof maxResultSizeChars !== 'number' ||
      !(maxResultSizeChars > 0 || maxResultSizeChars === Infinity)) {
      throw new ToolRegistryError('maxResultSizeChars must be positive or Infinity.');
    }
    if (typeof persistenceThresholdCeiling !== 'number' ||
      !(persistenceThresholdCeiling > 0 || persistenceThresholdCeiling === Infinity)) {
      throw new ToolRegistryError('persistenceThresholdCeiling must be positive or Infinity.');
    }
    // Original 2.1.88 Tool.ts provides call() and a result mapper.
    // Existing CLI tools provide execute(); do not break that path.
    if (execute !== undefined && typeof execute !== 'function') {
      throw new ToolRegistryError('Tool execute must be a function when provided.');
    }
    if (call !== undefined && typeof call !== 'function') {
      throw new ToolRegistryError('Tool call must be a function when provided.');
    }
    if (mapToolResultToToolResultBlockParam !== undefined &&
      typeof mapToolResultToToolResultBlockParam !== 'function') {
      throw new ToolRegistryError('Tool result mapper must be a function when provided.');
    }
    if ((typeof call === 'function') !==
      (typeof mapToolResultToToolResultBlockParam === 'function')) {
      throw new ToolRegistryError('Legacy call and result mapper must be registered together.');
    }
    // During a staged port an existing built-in can retain execute() for
    // direct callers while AgentLoop uses its migrated call()+mapper pair.
    if (typeof call !== 'function' && typeof execute !== 'function') {
      throw new ToolRegistryError('Tool requires either legacy call + mapper or execute.');
    }

    let schemaCopy;
    try {
      schemaCopy = structuredClone(inputSchema);
    } catch (cause) {
      throw new ToolRegistryError('Tool inputSchema must contain only cloneable JSON data: ' + cause.message);
    }

    const tool = Object.freeze({
      name,
      aliases: Object.freeze([...aliases]),
      skipAggregateToolResultBudget,
      description,
      inputSchema: schemaCopy,
      validateInput,
      checkPermissions,
      backfillObservableInput,
      requiresUserInteraction,
      isConcurrencySafe,
      canRunDuringStream,
      interruptBehavior,
      execute,
      call,
      mapToolResultToToolResultBlockParam,
      maxResultSizeChars,
      persistenceThresholdCeiling,
    });
    this.#tools.set(name, tool);
    for (const alias of aliases) this.#aliases.set(alias, name);
    return () => {
      if (this.#tools.get(name) === tool) {
        this.#tools.delete(name);
        for (const alias of aliases) {
          if (this.#aliases.get(alias) === name) this.#aliases.delete(alias);
        }
      }
    };
  }

  get(name) {
    return this.#tools.get(this.#aliases.get(name) ?? name);
  }

  has(name) {
    return this.get(name) !== undefined;
  }

  list() {
    return [...this.#tools.values()];
  }

  describe() {
    return this.list().map(tool => ({
      name: tool.name,
      description: tool.description,
      input_schema: structuredClone(tool.inputSchema),
    }));
  }

  async validateInput(name, input, context, expectedTool) {
    const tool = this.get(name);
    if (!tool) return ['Tool is not registered: ' + name];
    if (expectedTool && tool !== expectedTool) return ['Tool definition changed during validation.'];
    if (!isRecord(input)) return ['Tool input must be a JSON object.'];

    const schemaErrors = validateJsonSchema(input, tool.inputSchema);
    if (schemaErrors.length > 0) return schemaErrors;

    const errors = await validateToolInputValues(tool, input, context);
    if (expectedTool && this.get(name) !== expectedTool) {
      return ['Tool definition changed during validation.'];
    }
    return errors;
  }
}

/**
 * The second stage of the legacy 2.1.88 checkPermissionsAndCallTool()
 * validation sequence (tool.validateInput after schema parsing).
 * This is also used by permission updatedInput revalidation, so the two
 * paths cannot drift. Legacy validators may return { result, message }.
 */
export async function validateToolInputValues(tool, input, context) {
  if (!tool.validateInput) return [];
  let result;
  try {
    result = await tool.validateInput(structuredClone(input), context);
  } catch (error) {
    return ['Custom input validator failed: ' + (error instanceof Error ? error.message : String(error))];
  }
  if (result === true || result === undefined || result?.result === true) return [];
  if (Array.isArray(result)) return result.map(item => String(item));
  if (typeof result === 'string') return [result];
  if (result && typeof result === 'object' && result.result === false) {
    return [typeof result.message === 'string' && result.message ? result.message :
      'Custom input validator rejected the input.'];
  }
  return ['Custom input validator rejected the input.'];
}
