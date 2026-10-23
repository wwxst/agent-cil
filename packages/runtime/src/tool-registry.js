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

  register({ name, description, inputSchema = { type: 'object' }, validateInput, isConcurrencySafe, interruptBehavior, execute } = {}) {
    if (typeof name !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(name)) {
      throw new ToolRegistryError('Tool name must contain 1-128 letters, digits, underscores or hyphens.');
    }
    if (this.#tools.has(name)) throw new ToolRegistryError('Tool is already registered: ' + name);
    if (typeof description !== 'string' || description.trim().length === 0) {
      throw new ToolRegistryError('Tool description must be a non-empty string.');
    }
    if (!isRecord(inputSchema)) throw new ToolRegistryError('Tool inputSchema must be a JSON schema object.');
    if (validateInput !== undefined && typeof validateInput !== 'function') {
      throw new ToolRegistryError('validateInput must be a function when provided.');
    }
    if (isConcurrencySafe !== undefined && typeof isConcurrencySafe !== 'function') {
      throw new ToolRegistryError('isConcurrencySafe must be a function when provided.');
    }
    if (interruptBehavior !== undefined && typeof interruptBehavior !== 'function') {
      throw new ToolRegistryError('interruptBehavior must be a function when provided.');
    }
    if (typeof execute !== 'function') throw new ToolRegistryError('Tool execute must be a function.');

    let schemaCopy;
    try {
      schemaCopy = structuredClone(inputSchema);
    } catch (cause) {
      throw new ToolRegistryError('Tool inputSchema must contain only cloneable JSON data: ' + cause.message);
    }

    const tool = Object.freeze({
      name,
      description,
      inputSchema: schemaCopy,
      validateInput,
      isConcurrencySafe,
      interruptBehavior,
      execute,
    });
    this.#tools.set(name, tool);
    return () => {
      if (this.#tools.get(name) === tool) this.#tools.delete(name);
    };
  }

  get(name) {
    return this.#tools.get(name);
  }

  has(name) {
    return this.#tools.has(name);
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
    const tool = this.#tools.get(name);
    if (!tool) return ['Tool is not registered: ' + name];
    if (expectedTool && tool !== expectedTool) return ['Tool definition changed during validation.'];
    if (!isRecord(input)) return ['Tool input must be a JSON object.'];

    const schemaErrors = validateJsonSchema(input, tool.inputSchema);
    if (schemaErrors.length > 0) return schemaErrors;

    const errors = await validateToolInputValues(tool, input, context);
    if (expectedTool && this.#tools.get(name) !== expectedTool) {
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
