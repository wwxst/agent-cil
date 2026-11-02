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
  'sonnet[1m]', 'opus[1m]', 'fable[1m]', 'opusplan',
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
  const providerValue = apiProvider === 'anthropic' || apiProvider === 'firstParty'
    ? 'first_party'
    : apiProvider === 'anthropicAws' ? 'anthropic_aws'
    : apiProvider === 'anthropicGoogleCloud' ? 'anthropic_google_cloud'
    : apiProvider;
  return entry.per_provider?.[providerValue] ?? entry.default;
}
export const getDefaultSonnetModel = (env = process.env, options = {}) =>
  familyDefault('sonnet', { ...options, env });
export const getDefaultOpusModel = (env = process.env, options = {}) =>
  familyDefault('opus', { ...options, env });
export const getDefaultHaikuModel = (env = process.env, options = {}) =>
  familyDefault('haiku', { ...options, env });
export const getDefaultFableModel = (env = process.env, options = {}) =>
  familyDefault('fable', { ...options, env });

let resolvingBestModel = false;
export function getBestModel(env = process.env, options = {}) {
  const family = MODEL_CATALOG_BEST;
  if (family !== 'fable') return familyDefault(family, { ...options, env });
  const candidate = getDefaultFableModel(env, options);
  // Mirror 2.1.304's resolvingBestModel guard: an allowlist containing the
  // "best" alias must be able to resolve that alias without recursing.
  if (resolvingBestModel) return candidate;
  resolvingBestModel = true;
  try {
    // Fable is the baked-in best family only when provider/policy permits it;
    // otherwise the source resolver falls back to the current Opus default.
    return isModelAllowed(candidate, {
      availableModels: options.availableModels,
      deniedModels: options.deniedModels,
      env,
    }) ? candidate : getDefaultOpusModel(env, options);
  } finally {
    resolvingBestModel = false;
  }
}

function resolveAlias(alias, {
  env = process.env, apiProvider = 'firstParty',
  availableModels, deniedModels = [],
} = {}) {
  const options = { apiProvider, availableModels, deniedModels };
  switch (alias) {
    case 'sonnet': return getDefaultSonnetModel(env, options);
    case 'opus': return getDefaultOpusModel(env, options);
    case 'haiku': return getDefaultHaikuModel(env, options);
    case 'fable': return getDefaultFableModel(env, options);
    case 'best': return getBestModel(env, options);
    case 'opusplan': return getDefaultSonnetModel(env, options);
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
  env = process.env, apiProvider = 'firstParty', firstPartyBaseUrl = true,
  availableModels, deniedModels = [],
} = {}) {
  const value = normalizeModelInput(modelInput);
  const withOneM = hasOneMSuffix(value);
  const oneMEnabled = withOneM && !is1mContextDisabled(env);
  const withoutOneM = stripOneMSuffix(value);
  const alias = withoutOneM.toLowerCase();
  const resolved = resolveAlias(alias, { env, apiProvider, availableModels, deniedModels });

  if (resolved !== undefined) {
    // 2.1.304 treats [1m] family aliases as a model-selection attribute.
    // opusplan/sonnet/haiku/opus append it; best resolves dynamically.
    if (!oneMEnabled || alias === 'best') return stripOneMSuffix(resolved);
    if (alias === 'fable') {
      // Fable only appends the suffix for a non-first-party API base URL.
      return firstPartyBaseUrl ? stripOneMSuffix(resolved)
        : stripOneMSuffix(resolved) + '[1m]';
    }
    return stripOneMSuffix(resolved) + '[1m]';
  }

  if (!oneMEnabled) return value;
  const metadata = getCatalogModel(withoutOneM);
  // Native 1M model IDs do not need an explicit suffix on first-party URLs.
  if (firstPartyBaseUrl && metadata?.context?.native_1m === true) {
    return withoutOneM;
  }
  return withoutOneM + '[1m]';
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
  return context?.native_1m === true ||
    context?.supports_1m_beta === true ||
    context?.supports_1m_suffix === true;
}
export function getModelContextWindow(model, { env = process.env } = {}) {
  const context = getCatalogModel(model)?.context;
  if (is1mContextDisabled(env)) return DEFAULT_CONTEXT_WINDOW;
  if (hasOneMSuffix(String(model ?? ''))) return 1_000_000;
  return context?.window ?? DEFAULT_CONTEXT_WINDOW;
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
  const apiModel = stripOneMSuffix(model);
  if (is1mContextDisabled(env)) {
    return { model: apiModel, betaHeaders: [] };
  }
  const metadata = getCatalogModel(apiModel);
  const context = metadata?.context;
  if (context?.native_1m === true) {
    return { model: apiModel, betaHeaders: [] };
  }
  if (metadata &&
      context?.supports_1m_beta !== true &&
      context?.supports_1m_suffix !== true) {
    throw new TypeError('Model ' + apiModel + ' does not support 1M context.');
  }
  return {
    model: apiModel,
    betaHeaders: context?.supports_1m_beta === true || !metadata
      ? [CONTEXT_1M_BETA_HEADER] : [],
  };
}

function normalizedPolicyValue(value) {
  return stripOneMSuffix(value.trim()).toLowerCase();
}
function canonicalPolicyModel(value, env, availableModels, deniedModels) {
  const normalized = normalizedPolicyValue(value);
  const parsed = isModelAlias(normalized) || isModelAlias(stripOneMSuffix(normalized))
    ? parseUserSpecifiedModel(value, { env, availableModels, deniedModels })
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
function modelBelongsToFamily(model, family, env, availableModels, deniedModels) {
  const resolved = canonicalPolicyModel(model, env, availableModels, deniedModels);
  const modelFamily = getModelFamily(resolved);
  return modelFamily === family || resolved.includes(family);
}
function modelMatchesVersionPrefix(model, entry, env, availableModels, deniedModels) {
  const resolved = canonicalPolicyModel(model, env, availableModels, deniedModels);
  if (prefixMatchesModel(resolved, entry)) return true;
  return !entry.startsWith('claude-') &&
    prefixMatchesModel(resolved, 'claude-' + entry);
}
function modelMatchesPolicyEntry(model, entry, env, availableModels, deniedModels) {
  const family = MODEL_FAMILY_ALIASES.find(value => entry === value);
  if (family) return modelBelongsToFamily(
    model, family, env, availableModels, deniedModels,
  );
  const normalizedModel = normalizedPolicyValue(model);
  if (normalizedModel === entry) return true;
  const canonical = canonicalPolicyModel(model, env, availableModels, deniedModels);
  if (canonical === entry) return true;
  if (isModelAlias(entry)) {
    return canonicalPolicyModel(entry, env, availableModels, deniedModels) === canonical;
  }
  return modelMatchesVersionPrefix(model, entry, env, availableModels, deniedModels);
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
  if (denies.some(entry => modelMatchesPolicyEntry(
    model, entry, env, availableModels, deniedModels,
  ))) return false;
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
        modelBelongsToFamily(model, family, env, allowlist, denies)) return true;
  }
  const canonical = canonicalPolicyModel(model, env, allowlist, denies);
  if (allowlist.includes(canonical)) return true;
  for (const entry of allowlist) {
    if (isModelAlias(entry) &&
        canonicalPolicyModel(entry, env, allowlist, denies) === canonical) return true;
    if (!isModelFamilyAlias(entry) && !isModelAlias(entry) &&
        modelMatchesVersionPrefix(model, entry, env, allowlist, denies)) return true;
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
    const parsed = parseUserSpecifiedModel(entry, { env });
    const metadata = getCatalogModel(parsed) ??
      (!String(parsed).toLowerCase().startsWith('claude-')
        ? getCatalogModel('claude-' + parsed) : undefined);
    const candidate = metadata?.id ?? parsed;
    if (isModelAllowed(candidate, { availableModels, deniedModels, env })) return candidate;
  }
  throw new TypeError('No model remains available after applying availableModels and deniedModels.');
}

function getNewestAllowedFamilyModel(family, {
  env, availableModels, deniedModels,
} = {}) {
  // 2.1.304 stepDownRestrictedFamilyAliasPick walks the source catalog from
  // newest to oldest and selects the newest model that survives policy.
  const candidates = MODEL_CATALOG_MODELS.filter(model => model.family === family);
  for (let i = candidates.length - 1; i >= 0; i -= 1) {
    const candidate = candidates[i].id;
    if (isModelAllowed(candidate, { availableModels, deniedModels, env })) {
      return candidate;
    }
  }
  return undefined;
}

/** Original 2.1.304 plan-mode model adjustment with policy-safe step-down. */
export function getRuntimeMainLoopModel({
  permissionMode, mainLoopModel, userSpecifiedModel, env = process.env,
  availableModels, deniedModels = [], exceeds200kTokens = false,
} = {}) {
  const chosen = typeof userSpecifiedModel === 'string'
    ? userSpecifiedModel.trim().toLowerCase() : '';
  if (permissionMode !== 'plan') return mainLoopModel;

  const isOpusPlan = chosen === 'opusplan' || chosen === 'opusplan[1m]';
  if (isOpusPlan && exceeds200kTokens) return mainLoopModel;
  if (!isOpusPlan && chosen !== 'haiku') return mainLoopModel;

  const family = isOpusPlan ? 'opus' : 'sonnet';
  const wantsOneM = chosen === 'opusplan[1m]';
  const preferred = family === 'opus'
    ? getDefaultOpusModel(env)
    : getDefaultSonnetModel(env);
  if (isModelAllowed(preferred, { availableModels, deniedModels, env })) {
    return wantsOneM
      ? stripOneMSuffix(preferred) + '[1m]'
      : preferred;
  }

  const fallback = getNewestAllowedFamilyModel(family, {
    env, availableModels, deniedModels,
  });
  if (!fallback) return mainLoopModel;
  const context = getCatalogModel(fallback)?.context;
  if (!wantsOneM || context?.native_1m === true) return fallback;
  return context?.supports_1m_suffix === true
    ? fallback + '[1m]'
    : mainLoopModel;
}

/**
 * Resolve only Anthropic aliases. OpenAI and DeepSeek IDs stay byte-for-byte
 * intact; provider-specific 1M requests are rejected instead of leaking a
 * Claude beta option into an unrelated API.
 */
export function resolveOriginalCliModel({
  provider, model, permissionMode = 'default', env = process.env,
  availableModels, deniedModels = [], exceeds200kTokens = false,
  firstPartyBaseUrl = true,
} = {}) {
  if (provider !== 'anthropic') {
    if (typeof model === 'string' && hasOneMSuffix(model)) {
      throw new TypeError('The [1m] context option is supported only by the Anthropic provider.');
    }
    return model;
  }
  const requested = parseUserSpecifiedModel(model, {
    env, firstPartyBaseUrl, availableModels, deniedModels,
  });
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
