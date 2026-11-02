/**
 * Exact backend-relevant projection of the baked-in model-catalog.json in
 * the supplied Claude CLI 2.1.304 bundle (chunk-6txs1cet.js).
 * Keep IDs, provider IDs, aliases, context flags and output limits in sync
 * with that pinned catalog; UI-only pricing and picker fields stay upstream.
 */
export const MODEL_CATALOG_SOURCE_VERSION = '2.1.304';

export const MODEL_CATALOG_ALIASES = Object.freeze({
  opus: Object.freeze({
    default: 'claude-opus-5-5',
    per_provider: Object.freeze({
      bedrock: 'claude-opus-5-5',
      vertex: 'claude-opus-5-5',
      foundry: 'claude-opus-4-6',
      mantle: 'claude-opus-5-5',
      anthropic_aws: 'claude-opus-5-5',
      gateway: 'claude-opus-4-7',
    }),
  }),
  sonnet: Object.freeze({
    default: 'claude-sonnet-5-5',
    per_provider: Object.freeze({
      bedrock: 'claude-sonnet-4-5',
      vertex: 'claude-sonnet-4-5',
      foundry: 'claude-sonnet-4-5',
      mantle: 'claude-sonnet-4-5',
      anthropic_aws: 'claude-sonnet-4-6',
      gateway: 'claude-sonnet-4-6',
    }),
  }),
  haiku: Object.freeze({
    default: 'claude-haiku-5-5',
    per_provider: Object.freeze({
      bedrock: 'claude-haiku-4-5',
      vertex: 'claude-haiku-4-5',
      foundry: 'claude-haiku-4-5',
      mantle: 'claude-haiku-4-5',
      anthropic_aws: 'claude-haiku-4-5',
      anthropic_google_cloud: 'claude-haiku-4-5',
      gateway: 'claude-haiku-4-5',
    }),
  }),
  fable: Object.freeze({
    default: 'claude-fable-5-1',
    per_provider: Object.freeze({ gateway: 'claude-fable-5' }),
  }),
});
export const MODEL_CATALOG_BEST = 'fable';
export const MODEL_CATALOG_LATEST_PER_FAMILY = Object.freeze({
  fable: 'claude-fable-5-1',
  opus: 'claude-opus-5-5',
  sonnet: 'claude-sonnet-5-5',
  haiku: 'claude-haiku-5-5',
});

// provider_ids are copied from the pinned 2.1.304 catalog, not inferred from
// naming patterns. Null means that provider has no published ID for the row.
const providerIdsById = Object.freeze({
  'claude-3-5-haiku': {first_party:'claude-3-5-haiku-20241022',bedrock:'us.anthropic.claude-3-5-haiku-20241022-v1:0',vertex:'claude-3-5-haiku@20241022',foundry:'claude-3-5-haiku',anthropic_aws:'claude-3-5-haiku-20241022',anthropic_google_cloud:null,mantle:null,gateway:'claude-3-5-haiku-20241022'},
  'claude-haiku-4-5': {first_party:'claude-haiku-4-5-20251001',bedrock:'us.anthropic.claude-haiku-4-5-20251001-v1:0',vertex:'claude-haiku-4-5@20251001',foundry:'claude-haiku-4-5',anthropic_aws:'claude-haiku-4-5-20251001',anthropic_google_cloud:'claude-haiku-4-5-20251001',mantle:'anthropic.claude-haiku-4-5',gateway:'claude-haiku-4-5-20251001'},
  'claude-haiku-5-5': {first_party:'claude-haiku-5-5',bedrock:'us.anthropic.claude-haiku-5-5',vertex:'claude-haiku-5-5',foundry:'claude-haiku-5-5',anthropic_aws:'claude-haiku-5-5',anthropic_google_cloud:'claude-haiku-5-5',mantle:'anthropic.claude-haiku-5-5'},
  'claude-3-5-sonnet': {first_party:'claude-3-5-sonnet-20241022',bedrock:'us.anthropic.claude-3-5-sonnet-20241022-v2:0',vertex:'claude-3-5-sonnet-v2@20241022',foundry:'claude-3-5-sonnet',anthropic_aws:'claude-3-5-sonnet-20241022',anthropic_google_cloud:null,mantle:null,gateway:'claude-3-5-sonnet-20241022'},
  'claude-3-7-sonnet': {first_party:'claude-3-7-sonnet-20250219',bedrock:'us.anthropic.claude-3-7-sonnet-20250219-v1:0',vertex:'claude-3-7-sonnet@20250219',foundry:'claude-3-7-sonnet',anthropic_aws:'claude-3-7-sonnet-20250219',anthropic_google_cloud:null,mantle:null,gateway:'claude-3-7-sonnet-20250219'},
  'claude-sonnet-4-0': {first_party:'claude-sonnet-4-20250514',bedrock:'us.anthropic.claude-sonnet-4-20250514-v1:0',vertex:'claude-sonnet-4@20250514',foundry:'claude-sonnet-4',anthropic_aws:'claude-sonnet-4-20250514',anthropic_google_cloud:null,mantle:null,gateway:'claude-sonnet-4-20250514'},
  'claude-sonnet-4-5': {first_party:'claude-sonnet-4-5-20250929',bedrock:'us.anthropic.claude-sonnet-4-5-20250929-v1:0',vertex:'claude-sonnet-4-5@20250929',foundry:'claude-sonnet-4-5',anthropic_aws:'claude-sonnet-4-5-20250929',anthropic_google_cloud:'claude-sonnet-4-5-20250929',mantle:null,gateway:'claude-sonnet-4-5-20250929'},
  'claude-sonnet-4-6': {first_party:'claude-sonnet-4-6',bedrock:'us.anthropic.claude-sonnet-4-6',vertex:'claude-sonnet-4-6',foundry:'claude-sonnet-4-6',anthropic_aws:'claude-sonnet-4-6',anthropic_google_cloud:'claude-sonnet-4-6',mantle:null,gateway:'claude-sonnet-4-6'},
  'claude-sonnet-5': {first_party:'claude-sonnet-5',bedrock:'us.anthropic.claude-sonnet-5',vertex:'claude-sonnet-5',foundry:'claude-sonnet-5',anthropic_aws:'claude-sonnet-5',anthropic_google_cloud:'claude-sonnet-5',mantle:'anthropic.claude-sonnet-5',gateway:'claude-sonnet-5'},
  'claude-sonnet-5-5': {first_party:'claude-sonnet-5-5',bedrock:'us.anthropic.claude-sonnet-5-5',vertex:'claude-sonnet-5-5',foundry:'claude-sonnet-5-5',anthropic_aws:'claude-sonnet-5-5',anthropic_google_cloud:'claude-sonnet-5-5',mantle:'anthropic.claude-sonnet-5-5',gateway:'claude-sonnet-5-5'},
  'claude-opus-4-0': {first_party:'claude-opus-4-20250514',bedrock:'us.anthropic.claude-opus-4-20250514-v1:0',vertex:'claude-opus-4@20250514',foundry:'claude-opus-4',anthropic_aws:'claude-opus-4-20250514',anthropic_google_cloud:null,mantle:null,gateway:'claude-opus-4-20250514'},
  'claude-opus-4-1': {first_party:'claude-opus-4-1-20250805',bedrock:'us.anthropic.claude-opus-4-1-20250805-v1:0',vertex:'claude-opus-4-1@20250805',foundry:'claude-opus-4-1',anthropic_aws:'claude-opus-4-1-20250805',anthropic_google_cloud:null,mantle:null,gateway:'claude-opus-4-1-20250805'},
  'claude-opus-4-5': {first_party:'claude-opus-4-5-20251101',bedrock:'us.anthropic.claude-opus-4-5-20251101-v1:0',vertex:'claude-opus-4-5@20251101',foundry:'claude-opus-4-5',anthropic_aws:'claude-opus-4-5-20251101',anthropic_google_cloud:'claude-opus-4-5-20251101',mantle:null,gateway:'claude-opus-4-5-20251101'},
  'claude-opus-4-6': {first_party:'claude-opus-4-6',bedrock:'us.anthropic.claude-opus-4-6-v1',vertex:'claude-opus-4-6',foundry:'claude-opus-4-6',anthropic_aws:'claude-opus-4-6',anthropic_google_cloud:'claude-opus-4-6',mantle:null,gateway:'claude-opus-4-6'},
  'claude-opus-4-7': {first_party:'claude-opus-4-7',bedrock:'us.anthropic.claude-opus-4-7',vertex:'claude-opus-4-7',foundry:'claude-opus-4-7',anthropic_aws:'claude-opus-4-7',anthropic_google_cloud:'claude-opus-4-7',mantle:'anthropic.claude-opus-4-7',gateway:'claude-opus-4-7'},
  'claude-opus-4-8': {first_party:'claude-opus-4-8',bedrock:'us.anthropic.claude-opus-4-8',vertex:'claude-opus-4-8',foundry:'claude-opus-4-8',anthropic_aws:'claude-opus-4-8',anthropic_google_cloud:'claude-opus-4-8',mantle:'anthropic.claude-opus-4-8',gateway:'claude-opus-4-8'},
  'claude-opus-5': {first_party:'claude-opus-5',bedrock:'us.anthropic.claude-opus-5',vertex:'claude-opus-5',foundry:'claude-opus-5',anthropic_aws:'claude-opus-5',anthropic_google_cloud:'claude-opus-5',mantle:'anthropic.claude-opus-5',gateway:'claude-opus-5'},
  'claude-opus-5-5': {first_party:'claude-opus-5-5',bedrock:'us.anthropic.claude-opus-5-5',vertex:'claude-opus-5-5',foundry:'claude-opus-5-5',anthropic_aws:'claude-opus-5-5',anthropic_google_cloud:'claude-opus-5-5',mantle:'anthropic.claude-opus-5-5',gateway:'claude-opus-5-5'},
  'claude-fable-5': {first_party:'claude-fable-5',bedrock:'us.anthropic.claude-fable-5',vertex:'claude-fable-5',foundry:'claude-fable-5',anthropic_aws:'claude-fable-5',anthropic_google_cloud:'claude-fable-5',mantle:'anthropic.claude-fable-5',gateway:'claude-fable-5'},
  'claude-fable-5-1': {first_party:'claude-fable-5-1',bedrock:'us.anthropic.claude-fable-5-1',vertex:'claude-fable-5-1',foundry:'claude-fable-5-1',anthropic_aws:'claude-fable-5-1',anthropic_google_cloud:'claude-fable-5-1',mantle:'anthropic.claude-fable-5-1',gateway:'claude-fable-5-1'},
  'claude-mythos-5': {first_party:'claude-mythos-5',bedrock:null,vertex:null,foundry:null,anthropic_aws:null,anthropic_google_cloud:null,mantle:null,gateway:null},
  'claude-mythos-5-1': {first_party:'claude-mythos-5-1',bedrock:null,vertex:null,foundry:null,anthropic_aws:null,anthropic_google_cloud:null,mantle:null,gateway:null},
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
      providerIds:Object.freeze(providerIdsById[id]),
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
  for (const providerId of Object.values(model.providerIds)) {
    if (typeof providerId === 'string') {
      const key = providerId.toLowerCase();
      const existing = byProviderId.get(key);
      if (existing && existing.id !== model.id) {
        throw new Error('2.1.304 model catalog provider ID collision: ' + providerId);
      }
      byProviderId.set(key, model);
    }
  }
}
export function getCatalogModel(modelInput) {
  if (typeof modelInput !== 'string') return undefined;
  const id = modelInput.trim().replace(/(?:\[1m\])+$/i, '').toLowerCase();
  return byId.get(id) ?? byProviderId.get(id);
}
