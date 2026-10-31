const SUPPORTED_TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']);

function isRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function equalJsonValue(left, right) {
  if (Object.is(left, right)) return true;
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return false;
  }
}

/**
 * Validate the intentionally small JSON Schema subset used by local tools.
 * Supported keywords: type, enum, properties, required, additionalProperties,
 * items, min/max length, min/max items, and minimum/maximum.
 */
export function validateJsonSchema(value, schema, path = '$') {
  if (!isRecord(schema)) return [path + ': schema must be an object.'];
  const errors = [];

  if (schema.type !== undefined) {
    if (typeof schema.type !== 'string' || !SUPPORTED_TYPES.has(schema.type)) {
      return [path + ': unsupported schema type.'];
    }
    const matches = schema.type === 'object' ? isRecord(value)
      : schema.type === 'array' ? Array.isArray(value)
      : schema.type === 'integer' ? Number.isSafeInteger(value)
      : schema.type === 'number' ? typeof value === 'number' && Number.isFinite(value)
      : schema.type === 'null' ? value === null
      : typeof value === schema.type;
    if (!matches) return [path + ': expected ' + schema.type + '.'];
  }

  if (schema.enum !== undefined) {
    if (!Array.isArray(schema.enum) || !schema.enum.some(candidate => equalJsonValue(candidate, value))) {
      errors.push(path + ': value is not in the allowed enum.');
    }
  }

  if (typeof value === 'string') {
    if (Number.isSafeInteger(schema.minLength) && value.length < schema.minLength) {
      errors.push(path + ': string is shorter than minLength.');
    }
    if (Number.isSafeInteger(schema.maxLength) && value.length > schema.maxLength) {
      errors.push(path + ': string exceeds maxLength.');
    }
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    if (typeof schema.minimum === 'number' && value < schema.minimum) {
      errors.push(path + ': number is below minimum.');
    }
    if (typeof schema.maximum === 'number' && value > schema.maximum) {
      errors.push(path + ': number exceeds maximum.');
    }
  }

  if (Array.isArray(value)) {
    if (Number.isSafeInteger(schema.minItems) && value.length < schema.minItems) {
      errors.push(path + ': array has fewer than minItems.');
    }
    if (Number.isSafeInteger(schema.maxItems) && value.length > schema.maxItems) {
      errors.push(path + ': array exceeds maxItems.');
    }
    if (schema.items !== undefined) {
      for (let index = 0; index < value.length; index += 1) {
        errors.push(...validateJsonSchema(value[index], schema.items, path + '[' + index + ']'));
      }
    }
  }

  if (isRecord(value)) {
    const properties = schema.properties === undefined ? {} : schema.properties;
    if (!isRecord(properties)) {
      errors.push(path + ': schema properties must be an object.');
      return errors;
    }
    if (schema.required !== undefined && (!Array.isArray(schema.required)
      || schema.required.some(key => typeof key !== 'string'))) {
      errors.push(path + ': schema required must be an array of property names.');
      return errors;
    }

    for (const key of schema.required ?? []) {
      if (!Object.hasOwn(value, key)) errors.push(path + '.' + key + ': required property is missing.');
    }
    for (const [key, childSchema] of Object.entries(properties)) {
      if (Object.hasOwn(value, key)) errors.push(...validateJsonSchema(value[key], childSchema, path + '.' + key));
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!Object.hasOwn(properties, key)) errors.push(path + '.' + key + ': additional property is not allowed.');
      }
    }
  }

  return errors;
}
