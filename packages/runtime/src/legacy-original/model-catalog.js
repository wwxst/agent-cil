/**
 * Headless runtime projection of the baked-in model-catalog.json shipped by
 * Claude CLI 2.1.304 (the model catalog module in the supplied 2.1.304 bundle).
 *
 * The interactive picker/pricing presentation is intentionally not copied:
 * this table retains the source catalog's model IDs, family aliases, 1M
 * context capabilities and output-token limits used by the backend runtime.
 * Do not hand-edit model launches independently of the pinned source catalog.
 */
export const MODEL_CATALOG_SOURCE_VERSION = '2.1.304';

export const MODEL_CATALOG_ALIASES = Object.freeze({
  opus: Object.freeze({
    default: 'claude-opus-5-5',
    perProvider: Object.freeze({
      bedrock: 'claude-opus-5-5',
      vertex: 'claude-opus-5-5',
      foundry: 'claude-opus-4-6',
      mantle: 'claude-opus-5-5',
      anthropicAws: 'claude-opus-5-5',
      gateway: 'claude-opus-4-7',
    }),
  }),
  sonnet: Object.freeze({
    default: 'claude-sonnet-5-5',
    perProvider: Object.freeze({
      bedrock: 'claude-sonnet-4-5',
      vertex: 'claude-sonnet-4-5',
      foundry: 'claude-sonnet-4-5',
      mantle: 'claude-sonnet-4-5',
      anthropicAws: 'claude-sonnet-4-6',
      gateway: 'claude-sonnet-4-6',
    }),
  }),
  haiku: Object.freeze({
    default: 'claude-haiku-5-5',
    perProvider: Object.freeze({
      bedrock: 'claude-haiku-4-5',
      vertex: 'claude-haiku-4-5',
      foundry: 'claude-haiku-4-5',
      mantle: 'claude-haiku-4-5',
      anthropicAws: 'claude-haiku-4-5',
      anthropicGoogleCloud: 'claude-haiku-4-5',
      gateway: 'claude-haiku-4-5',
    }),
  }),
  fable: Object.freeze({
    default: 'claude-fable-5-1',
    perProvider: Object.freeze({ gateway: 'claude-fable-5' }),
  }),
});

export const MODEL_CATALOG_BEST = 'fable';
export const MODEL_CATALOG_LATEST_PER_FAMILY = Object.freeze({
  fable: 'claude-fable-5-1',
  opus: 'claude-opus-5-5',
  sonnet: 'claude-sonnet-5-5',
  haiku: 'claude-haiku-5-5',
});

const rows = [
  ['claude-3-5-haiku','haiku','claude-3-5-haiku-20241022','Haiku 3.5',null,8192,8192],
  ['claude-haiku-4-5','haiku','claude-haiku-4-5-20251001','Haiku 4.5',{window:200000,supports_1m_suffix:true},32000,64000],
  ['claude-haiku-5-5','haiku','claude-haiku-5-5','Haiku 5.5',{window:1000000,native_1m:true,supports_1m_beta:true},128000,128000],
  ['claude-3-5-sonnet','sonnet','claude-3-5-sonnet-20241022','Sonnet 3.5',null,8192,8192],
  ['claude-3-7-sonnet','sonnet','claude-3-7-sonnet-20250219','Sonnet 3.7',null,32000,64000],
  ['claude-sonnet-4-0','sonnet','claude-sonnet-4-20250514','Sonnet 4',{window:200000,supports_1m_beta:true,supports_1m_suffix:true},32000,64000],
  ['claude-sonnet-4-5','sonnet','claude-sonnet-4-5-20250929','Sonnet 4.5',{window:200000,supports_1m_beta:true,supports_1m_suffix:true},32000,64000],
  ['claude-sonnet-4-6','sonnet','claude-sonnet-4-6','Sonnet 4.6',{window:200000,supports_1m_beta:true,supports_1m_suffix:true},32000,128000],
  ['claude-sonnet-5','sonnet','claude-sonnet-5','Sonnet 5',{window:1000000,native_1m:true,supports_1m_beta:true},64000,128000],
  ['claude-sonnet-5-5','sonnet','claude-sonnet-5-5','Sonnet 5.5',{window:1000000,native_1m:true,supports_1m_beta:true},128000,128000],
  ['claude-opus-4-0','opus','claude-opus-4-20250514','Opus 4',{window:200000,supports_1m_suffix:true},32000,32000],
  ['claude-opus-4-1','opus','claude-opus-4-1-20250805','Opus 4.1',{window:200000,supports_1m_suffix:true},32000,32000],
  ['claude-opus-4-5','opus','claude-opus-4-5-20251101','Opus 4.5',{window:200000,supports_1m_suffix:true},32000,64000],
  ['claude-opus-4-6','opus','claude-opus-4-6','Opus 4.6',{window:200000,supports_1m_beta:true,supports_1m_suffix:true},64000,128000],
  ['claude-opus-4-7','opus','claude-opus-4-7','Opus 4.7',{window:1000000,native_1m:true,supports_1m_beta:true,supports_1m_suffix:true},64000,128000],
  ['claude-opus-4-8','opus','claude-opus-4-8','Opus 4.8',{window:1000000,native_1m:true,supports_1m_beta:true,supports_1m_suffix:true},64000,128000],
  ['claude-opus-5','opus','claude-opus-5','Opus 5',{window:1000000,native_1m:true,supports_1m_beta:true,supports_1m_suffix:true},64000,128000],
  ['claude-opus-5-5','opus','claude-opus-5-5','Opus 5.5',{window:1000000,native_1m:true,supports_1m_beta:true,supports_1m_suffix:true},128000,128000],
  ['claude-fable-5','fable','claude-fable-5','Fable 5',{window:1000000,native_1m:true,supports_1m_beta:true},64000,128000],
  ['claude-fable-5-1','fable','claude-fable-5-1','Fable 5.1',{window:1000000,native_1m:true,supports_1m_beta:true},64000,128000],
  ['claude-mythos-5','mythos','claude-mythos-5','Mythos 5',{window:1000000,native_1m:true,supports_1m_beta:true},64000,128000],
  ['claude-mythos-5-1','mythos','claude-mythos-5-1','Mythos 5.1',{window:1000000,native_1m:true,supports_1m_beta:true},64000,128000],
];

export const MODEL_CATALOG_MODELS = Object.freeze(rows.map(
  ([id,family,firstPartyId,displayName,context,defaultOutputTokens,maxOutputTokens]) =>
    Object.freeze({
      id,family,firstPartyId,displayName,
      ...(context ? {context:Object.freeze(context)} : {}),
      maxOutputTokens:Object.freeze({
        default:defaultOutputTokens,
        upper:maxOutputTokens,
      }),
    }),
));

const byId = new Map();
const byProviderId = new Map();
for (const model of MODEL_CATALOG_MODELS) {
  byId.set(model.id, model);
  byProviderId.set(model.firstPartyId.toLowerCase(), model);
}
export function getCatalogModel(modelInput) {
  if (typeof modelInput !== 'string') return undefined;
  const id = modelInput.trim().replace(/(?:\\[1m\\])+$/i, '').toLowerCase();
  return byId.get(id) ?? byProviderId.get(id);
}
