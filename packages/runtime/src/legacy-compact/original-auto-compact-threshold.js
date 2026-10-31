/**
 * Pinned CLI 2.1.88 services/compact/autoCompact.ts:
 * getEffectiveContextWindowSize() -> getAutoCompactThreshold(),
 * with utils/context.ts MODEL_CONTEXT_WINDOW_DEFAULT and
 * utils/envUtils.ts isEnvTruthy().
 *
 * The full original getContextWindowForModel/getSdkBetas/model capability
 * catalog is not yet present in this headless runtime. Enable the canonical
 * 200K threshold ONLY for source-confirmed 200K first-party model IDs,
 * without pretending that custom deployments or [1m] have that window.
 * This returns 0 (disabled) when the context provenance is unknown.
 */
const MODEL_CONTEXT_WINDOW_DEFAULT=200_000;
const MAX_OUTPUT_TOKENS_FOR_SUMMARY=20_000;
export const AUTOCOMPACT_BUFFER_TOKENS=13_000;
const SOURCE_200K_MODELS=new Set([
  'claude-sonnet-4-6',
  'claude-sonnet-4-5',
  'claude-sonnet-4-5-20250929',
  'claude-opus-4-6',
  'claude-opus-4-5-20251101',
  'claude-haiku-4-5-20251001',
]);

export function isEnvTruthy(envVar) {
  if(!envVar)return false;
  if(typeof envVar==='boolean')return envVar;
  const normalizedValue=String(envVar).toLowerCase().trim();
  return ['1','true','yes','on'].includes(normalizedValue);
}

/** The original source's known-model, no-beta, no-dynamic-capability branch. */
export function getEffectiveContextWindowSize(model,{env=process.env}={}){
  if(typeof model!=='string'||!SOURCE_200K_MODELS.has(model))return 0;
  let contextWindow=MODEL_CONTEXT_WINDOW_DEFAULT;
  const autoCompactWindow=env.CLAUDE_CODE_AUTO_COMPACT_WINDOW;
  if(autoCompactWindow){
    const parsed=parseInt(autoCompactWindow,10);
    if(!Number.isNaN(parsed)&&parsed>0)
      contextWindow=Math.min(contextWindow,parsed);
  }
  return contextWindow-MAX_OUTPUT_TOKENS_FOR_SUMMARY;
}

/** Exact original 2.1.88 buffer and CLAUDE_AUTOCOMPACT_PCT_OVERRIDE math. */
export function getAutoCompactThreshold(model,{env=process.env}={}){
  const effectiveContextWindow=getEffectiveContextWindowSize(model,{env});
  const autocompactThreshold=effectiveContextWindow-AUTOCOMPACT_BUFFER_TOKENS;
  // The old source returns a negative threshold for an impossible window;
  // the Node summary loop rejects negative values. Never promise a
  // successful summary where less than the source reserves can fit.
  if(autocompactThreshold<=0)return 0;
  const envPercent=env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE;
  if(envPercent){
    const parsed=parseFloat(envPercent);
    if(!Number.isNaN(parsed)&&parsed>0&&parsed<=100){
      const percentageThreshold=Math.floor(effectiveContextWindow*(parsed/100));
      return Math.min(percentageThreshold,autocompactThreshold);
    }
  }
  return autocompactThreshold;
}

/** Source isAutoCompactEnabled() env gating, with unavailable user settings
 * deliberately not inferred. The caller owns explicit CLI override precedence. */
export function getOriginalCliAutoCompactThreshold(model,{provider,env=process.env}={}){
  if(provider!=='anthropic'||
     isEnvTruthy(env.DISABLE_COMPACT)||
     isEnvTruthy(env.DISABLE_AUTO_COMPACT))return 0;
  return getAutoCompactThreshold(model,{env});
}
