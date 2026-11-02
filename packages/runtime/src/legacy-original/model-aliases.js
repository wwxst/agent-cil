/**
 * Model resolution restored from 2.1.88 utils/model/{aliases,model,modelAllowlist}.ts
 * and upgraded against the 2.1.304 baked-in model catalog.
 *
 * The source's remote served/published catalogs drive its interactive model
 * picker and are not a replacement for this runtime model-ID catalog. This
 * headless CLI consumes the exact 2.1.304 baked-in first-party IDs, family
 * aliases, model context metadata and output-token limits.
 */
import {
  MODEL_CATALOG_ALIASES,
  MODEL_CATALOG_BEST,
  MODEL_CATALOG_MODELS,
  getCatalogModel,
} from './model-catalog.js';

export const MODEL_ALIASES = Object.freeze([
  'sonnet', 'opus', 'haiku', 'fable', 'best',
  'sonnet[1m]', 'opus[1m]', 'opusplan',
]);
export const MODEL_FAMILY_ALIASES = Object.freeze([
  'sonnet', 'opus', 'haiku', 'fable',
]);

export function isModelAlias(modelInput) {
  return MODEL_ALIASES.includes(modelInput);
}
export function isModelFamilyAlias(model) {
  return MODEL_FAMILY_ALIASES.includes(model);
}

const CONTEXT_1M_BETA_HEADER = 'context-1m-2025-08-07';
const DEFAULT_CONTEXT_WINDOW = 200_000;
const DEFAULT_OUTPUT_TOKENS = 32_000;
const DEFAULT_OUTPUT_TOKENS_UPPER = 128_000;

function stripOneMSuffix(model) {
  return model.replace(/(?:\[1m\])+$/i, '');
}
function hasOneMSuffix(model) {
  return /(?:\[1m\])+$/i.test(model);
}
function envTruthy(value) {
  return typeof value === 'string' &&
    ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}
export function is1mContextDisabled(env = process.env) {
  return envTruthy(env.CLAUDE_CODE_DISABLE_1M_CONTEXT);
}
function normalizeModelInput(modelInput) {
  if (typeof modelInput !== 'string') throw new TypeError('Model setting must be text.');
  const value = modelInput.trim();
  if (!value) throw new TypeError('Model setting cannot be empty.');
  if (value.length > 256 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new TypeError('Model setting must be at most 256 characters without control characters.');
  }
  return value;
}
function familyDefault(family, { env = process.env, apiProvider = 'firstParty' } = {}) {
  const envName = 'ANTHROPIC_DEFAULT_' + family.toUpperCase() + '_MODEL';
  if (typeof env[envName] === 'string' && env[envName].trim()) return env[envName].trim();
  const entry = MODEL_CATALOG_ALIASES[family];
  if (!entry) throw new TypeError('Unknown model family: ' + family);
  const providerValue = apiProvider === 'anthropic' ? 'firstParty' : apiProvider;
  return entry.perProvider?.[providerValue] ?? entry.default;
}
export const getDefaultSonnetModel = (env = process.env, options = {}) =>
  familyDefault('sonnet', { ...options, env });
export const getDefaultOpusModel = (env = process.env, options = {}) =>
  familyDefault('opus', { ...options, env });
export const getDefaultHaikuModel = (env = process.env, options = {}) =>
  familyDefault('haiku', { ...options, env });
export const getDefaultFableModel = (env = process.env, options = {}) =>
  familyDefault('fable', { ...options, env });

export function getBestModel(env = process.env, options = {}) {
  const family = MODEL_CATALOG_BEST;
  if (family === 'fable') return getDefaultFableModel(env, options);
  if (family === 'opus') return getDefaultOpusModel(env, options);
  return familyDefault(family, { ...options, env });
}

function resolveAlias(alias, { env = process.env, apiProvider = 'firstParty' } = {}) {
  switch (alias) {
    case 'sonnet': return getDefaultSonnetModel(env, { apiProvider });
    case 'opus': return getDefaultOpusModel(env, { apiProvider });
    case 'haiku': return getDefaultHaikuModel(env, { apiProvider });
    case 'fable': return getDefaultFableModel(env, { apiProvider });
    case 'best': return getBestModel(env, { apiProvider });
    case 'opusplan': return getDefaultSonnetModel(env, { apiProvider });
    default: return undefined;
  }
}

/**
 * 2.1.304 parseUserSpecifiedModel behavior:
 * - aliases are case-insensitive and resolve through the model catalog;
 * - custom provider IDs preserve their spelling;
 * - [1m] remains a model-selection attribute until the adapter constructs
 *   the provider request (native 1M models do not need the beta header).
 */
export function parseUserSpecifiedModel(modelInput, {
  env = process.env, apiProvider = 'firstParty',
} = {}) {
  const value = normalizeModelInput(modelInput);
  const withOneM = hasOneMSuffix(value);
  const withoutOneM = stripOneMSuffix(value);
  const alias = withoutOneM.toLowerCase();
  const resolved = resolveAlias(alias, { env, apiProvider });
  if (resolved === undefined) return value;
  if (alias === 'best') return resolved;
  return withOneM ? resolved.replace(/(?:\[1m\])+$/i, '') + '[1m]' : resolved;
}

/** Resolve the 2.1.304 catalog entry for a canonical ID or provider ID. */
export function getModelMetadata(model) {
  return getCatalogModel(model);
}
export function getCanonicalModelName(model) {
  const metadata = getCatalogModel(model);
  if (metadata) return metadata.id;
  return stripOneMSuffix(String(model ?? '').trim()).replace(/-\d{8}$/, '').toLowerCase();
}
export function getModelFamily(model) {
  const metadata = getCatalogModel(model);
  if (metadata) return metadata.family;
  const canonical = getCanonicalModelName(model);
  return MODEL_FAMILY_ALIASES.find(family =>
    canonical.includes(family) && (
      canonical.startsWith('claude-' + family) ||
      canonical === family
    ),
  );
}
export function modelSupports1M(model) {
  const context = getCatalogModel(model)?.context;
  return context?.native_1m === true || context?.supports_1m_beta === true;
}
export function getModelContextWindow(model, { env = process.env } = {}) {
  if (hasOneMSuffix(String(model ?? '')) && !is1mContextDisabled(env)) return 1_000_000;
  return getCatalogModel(model)?.context?.window ?? DEFAULT_CONTEXT_WINDOW;
}
export function getModelMaxOutputTokens(model) {
  const limits = getCatalogModel(model)?.maxOutputTokens;
  return limits
    ? { default: limits.default, upperLimit: limits.upper }
    : { default: DEFAULT_OUTPUT_TOKENS, upperLimit: DEFAULT_OUTPUT_TOKENS_UPPER };
}

/**
 * Convert the CLI's model setting into an API model ID plus required beta
 * headers. The [1m] suffix is never sent as part of the API model ID.
 */
export function resolveModelRequest(modelInput, {
  provider = 'anthropic', env = process.env,
} = {}) {
  const model = normalizeModelInput(modelInput);
  if (!hasOneMSuffix(model)) return { model, betaHeaders: [] };
  if (provider !== 'anthropic') {
    throw new TypeError('The [1m] context option is supported only by the Anthropic provider.');
  }
  if (is1mContextDisabled(env)) {
    throw new TypeError('1M context is disabled by CLAUDE_CODE_DISABLE_1M_CONTEXT.');
  }
  const apiModel = stripOneMSuffix(model);
  const metadata = getCatalogModel(apiModel);
  const context = metadata?.context;
  if (context?.native_1m === true) {
    return { model: apiModel, betaHeaders: [] };
  }
  if (metadata && context?.supports_1m_beta !== true) {
    throw new TypeError('Model ' + apiModel + ' does not support the 1M context beta.');
  }
  return { model: apiModel, betaHeaders: [CONTEXT_1M_BETA_HEADER] };
}

function normalizedPolicyValue(value) {
  return stripOneMSuffix(value.trim()).toLowerCase();
}
function canonicalPolicyModel(value, env) {
  const normalized = normalizedPolicyValue(value);
  const parsed = isModelAlias(value) || isModelAlias(stripOneMSuffix(value))
    ? parseUserSpecifiedModel(value, { env })
    : value;
  return getCanonicalModelName(parsed);
}
function prefixMatchesModel(modelName, prefix) {
  return modelName.startsWith(prefix) &&
    (modelName.length === prefix.length || modelName[prefix.length] === '-');
}
function familyHasSpecificEntries(family, allowlist) {
  return allowlist.some(entry => {
    if (isModelFamilyAlias(entry)) return false;
    const index = entry.indexOf(family);
    if (index < 0) return false;
    const end = index + family.length;
    return end === entry.length || entry[end] === '-';
  });
}
function modelBelongsToFamily(model, family, env) {
  const resolved = canonicalPolicyModel(model, env);
  const modelFamily = getModelFamily(resolved);
  return modelFamily === family || resolved.includes(family);
}
function modelMatchesVersionPrefix(model, entry, env) {
  const resolved = canonicalPolicyModel(model, env);
  if (prefixMatchesModel(resolved, entry)) return true;
  return !entry.startsWith('claude-') &&
    prefixMatchesModel(resolved, 'claude-' + entry);
}
function modelMatchesPolicyEntry(model, entry, env) {
  const family = MODEL_FAMILY_ALIASES.find(value => entry === value);
  if (family) return modelBelongsToFamily(model, family, env);
  const normalizedModel = normalizedPolicyValue(model);
  if (normalizedModel === entry) return true;
  const canonical = canonicalPolicyModel(model, env);
  if (canonical === entry) return true;
  if (isModelAlias(entry)) {
    return canonicalPolicyModel(entry, env) === canonical;
  }
  return modelMatchesVersionPrefix(model, entry, env);
}

/**
 * Port of 2.1.88 modelAllowlist.ts, extended with 2.1.304 deniedModels.
 * Family aliases are wildcards unless a version-qualified entry narrows
 * that family. Denies always win over allows.
 */
export function isModelAllowed(model, {
  availableModels, deniedModels = [], env = process.env,
} = {}) {
  if (typeof model !== 'string' || !model.trim()) return false;
  if (!Array.isArray(deniedModels) || deniedModels.some(x => typeof x !== 'string')) return false;
  const denies = deniedModels.map(x => x.trim().toLowerCase()).filter(Boolean);
  if (denies.some(entry => modelMatchesPolicyEntry(model, entry, env))) return false;
  if (availableModels === undefined || availableModels === null) return true;
  if (!Array.isArray(availableModels) || availableModels.some(x => typeof x !== 'string')) return false;
  const allowlist = availableModels.map(x => x.trim().toLowerCase()).filter(Boolean);
  if (allowlist.length === 0) return false;

  const normalized = normalizedPolicyValue(model);
  if (allowlist.includes(normalized)) {
    if (!isModelFamilyAlias(normalized) ||
        !familyHasSpecificEntries(normalized, allowlist)) return true;
  }
  for (const family of MODEL_FAMILY_ALIASES) {
    if (allowlist.includes(family) &&
        !familyHasSpecificEntries(family, allowlist) &&
        modelBelongsToFamily(model, family, env)) return true;
  }
  const canonical = canonicalPolicyModel(model, env);
  if (allowlist.includes(canonical)) return true;
  for (const entry of allowlist) {
    if (isModelAlias(entry) && canonicalPolicyModel(entry, env) === canonical) return true;
    if (!isModelFamilyAlias(entry) && !isModelAlias(entry) &&
        modelMatchesVersionPrefix(model, entry, env)) return true;
  }
  return false;
}

function getAllowedDefaultModel({ env, availableModels, deniedModels }) {
  const candidates = [
    getDefaultSonnetModel(env),
    getDefaultOpusModel(env),
    getDefaultHaikuModel(env),
    getDefaultFableModel(env),
  ];
  for (const candidate of candidates) {
    if (isModelAllowed(candidate, { availableModels, deniedModels, env })) return candidate;
  }
  for (const entry of availableModels ?? []) {
    if (!entry || isModelFamilyAlias(entry.toLowerCase())) continue;
    const candidate = parseUserSpecifiedModel(entry, { env });
    if (isModelAllowed(candidate, { availableModels, deniedModels, env })) return candidate;
  }
  throw new TypeError('No model remains available after applying availableModels and deniedModels.');
}

/** Original 2.1.304 plan-mode model adjustment with policy-safe fallback. */
export function getRuntimeMainLoopModel({
  permissionMode, mainLoopModel, userSpecifiedModel, env = process.env,
  availableModels, deniedModels = [], exceeds200kTokens = false,
} = {}) {
  const chosen = typeof userSpecifiedModel === 'string'
    ? stripOneMSuffix(userSpecifiedModel.trim()).toLowerCase() : '';
  if (permissionMode !== 'plan') return mainLoopModel;
  if (chosen === 'opusplan' && !exceeds200kTokens) {
    const candidate = getDefaultOpusModel(env);
    return isModelAllowed(candidate, { availableModels, deniedModels, env })
      ? candidate : mainLoopModel;
  }
  if (chosen === 'haiku') {
    const candidate = getDefaultSonnetModel(env);
    return isModelAllowed(candidate, { availableModels, deniedModels, env })
      ? candidate : mainLoopModel;
  }
  return mainLoopModel;
}

/**
 * Resolve only Anthropic aliases. OpenAI and DeepSeek IDs stay byte-for-byte
 * intact; provider-specific 1M requests are rejected instead of leaking a
 * Claude beta option into an unrelated API.
 */
export function resolveOriginalCliModel({
  provider, model, permissionMode = 'default', env = process.env,
  availableModels, deniedModels = [], exceeds200kTokens = false,
} = {}) {
  if (provider !== 'anthropic') {
    if (typeof model === 'string' && hasOneMSuffix(model)) {
      throw new TypeError('The [1m] context option is supported only by the Anthropic provider.');
    }
    return model;
  }
  const requested = parseUserSpecifiedModel(model, { env });
  const allowed = isModelAllowed(requested, { availableModels, deniedModels, env });
  const mainLoopModel = allowed
    ? requested
    : getAllowedDefaultModel({ env, availableModels, deniedModels });
  if (hasOneMSuffix(mainLoopModel)) resolveModelRequest(mainLoopModel, { provider, env });
  return getRuntimeMainLoopModel({
    permissionMode,
    mainLoopModel,
    userSpecifiedModel: allowed ? model : undefined,
    env,
    availableModels,
    deniedModels,
    exceeds200kTokens,
  });
}
