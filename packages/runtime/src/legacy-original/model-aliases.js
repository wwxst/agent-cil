/**
 * Pinned CLI 2.1.88 utils/model/aliases.ts + model.ts dependency closure.
 *
 * Keep the original MODEL_ALIASES, parseUserSpecifiedModel and
 * getRuntimeMainLoopModel names and lookup priority. The owner-provided
 * 2.1.304 CLI still has these aliases but selects family defaults from a
 * remotely updated model catalog; that dynamic catalog is NOT yet ported.
 *
 * This headless first-party Messages API supports the original source's
 * bare model aliases with pinned 2.1.88 defaults and documented environment
 * overrides, without misrouting DeepSeek/OpenAI custom model identifiers.
 * The original [1m] tag requires an additional API beta and model capability
 * negotiation, which cannot be safely simulated by passing it as an API ID.
 */
export const MODEL_ALIASES = [
  'sonnet', 'opus', 'haiku', 'best',
  'sonnet[1m]', 'opus[1m]', 'opusplan',
];
export function isModelAlias(modelInput) {
  return MODEL_ALIASES.includes(modelInput);
}
const PINNED_DEFAULTS = Object.freeze({
  sonnet:'claude-sonnet-4-6',
  opus:'claude-opus-4-6',
  haiku:'claude-haiku-4-5-20251001',
});
function getDefaultModel(family,env) {
  const key='ANTHROPIC_DEFAULT_'+family.toUpperCase()+'_MODEL';
  const configured=env[key];
  return typeof configured==='string'&&configured.trim()
    ? configured.trim() : PINNED_DEFAULTS[family];
}
export const getDefaultSonnetModel=(env=process.env)=>getDefaultModel('sonnet',env);
export const getDefaultOpusModel=(env=process.env)=>getDefaultModel('opus',env);
export const getDefaultHaikuModel=(env=process.env)=>getDefaultModel('haiku',env);
export const getBestModel=getDefaultOpusModel;

/**
 * Original 2.1.88 parseUserSpecifiedModel() alias switch, preserving
 * casing for custom provider IDs and first-party custom gateways.
 *
 * The full source handles [1m] via has1mContext()/request beta/capability
 * negotiation. Until ported, reject the suffix rather than silently turning
 * a 1m request into a 200k request or sending an invalid API model ID.
 */
export function parseUserSpecifiedModel(modelInput,{env=process.env}={}) {
  if(typeof modelInput!=='string')throw new TypeError('Model setting must be text.');
  const modelInputTrimmed=modelInput.trim();
  if(!modelInputTrimmed)throw new TypeError('Model setting cannot be empty.');
  const normalizedModel=modelInputTrimmed.toLowerCase();
  if(/\[1m\]$/i.test(normalizedModel)) {
    throw new TypeError('[1m] model selection requires original context-window beta negotiation, not yet available in agent-cil.');
  }
  if(isModelAlias(normalizedModel)) {
    switch(normalizedModel) {
      case 'opusplan':return getDefaultSonnetModel(env);
      case 'sonnet':return getDefaultSonnetModel(env);
      case 'haiku':return getDefaultHaikuModel(env);
      case 'opus':return getDefaultOpusModel(env);
      case 'best':return getBestModel(env);
      default:break;
    }
  }
  return modelInputTrimmed;
}
/** Original 2.1.88 model.ts selected runtime mode adjustments. */
export function getRuntimeMainLoopModel({
  permissionMode,mainLoopModel,userSpecifiedModel,env=process.env,
}={}) {
  const chosen=typeof userSpecifiedModel==='string'
    ? userSpecifiedModel.trim().toLowerCase():'';
  if(chosen==='opusplan'&&permissionMode==='plan')
    return getDefaultOpusModel(env);
  if(chosen==='haiku'&&permissionMode==='plan')
    return getDefaultSonnetModel(env);
  return mainLoopModel;
}
export function resolveOriginalCliModel({
  provider,model,permissionMode='default',env=process.env,
}={}) {
  if(provider!=='anthropic')return model;
  const resolved=parseUserSpecifiedModel(model,{env});
  return getRuntimeMainLoopModel({
    permissionMode,mainLoopModel:resolved,userSpecifiedModel:model,env,
  });
}
