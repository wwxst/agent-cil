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
const LEGACY_OPUS_MODEL_IDS = new Set([
  'claude-opus-4-20250514',
  'claude-opus-4-1-20250805',
  'claude-opus-4-0',
  'claude-opus-4-1',
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
