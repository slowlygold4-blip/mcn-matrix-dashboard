import {gzipSync} from 'node:zlib';
import {validateSourceWorkOwners,validateFoundationWorkOwners} from './source-work-owner-contract.mjs';
import {replicaPartitionByteLimit,replicaBatchByteLimit} from './replica-partition-budget.mjs';
import { publishingFile, publishingPartValid, auditPublishing } from './replica-publishing.mjs';
import {creatorFile,creatorKind,creatorPartValid,auditCreatorPublication} from './replica-creator.mjs';
import {foundationFile,foundationKind,foundationPartValid,auditFoundationPublication} from './replica-foundation.mjs';
import { createHash } from 'node:crypto';
import { PUBLIC_SOURCE_WORK_FIELDS, publicSourceWorkFieldsValid } from './public-replica-source-work.mjs';
import { setImmediate as yieldToCollector } from 'node:timers/promises';
import { isCalendarDate } from './utils.mjs';
import { derivePublicHistoryDateIndex, verifyPublicHistoryDateIndex,
  auditPublicHistoryDatePublication } from './public-history-range.mjs';
import { CREATOR_SOURCE_PLAY_NOTE } from './work-play-semantics.mjs';

export const PUBLIC_REPLICA_ORIGIN = 'https://mcn-matrix-observatory.slowlygold4.chatgpt.site';
export const PUBLIC_REPLICA_SUMMARY_FIELDS = Object.freeze(['targetId', 'date', 'capturedAt',
  'followers', 'followersAt', 'likes', 'likesAt', 'posts', 'postsAt']);
const SHA = /^[a-f0-9]{64}$/;
const PATH = /^(catalog|topics|summary|date-summary-index|publishing)\.json$|^(daily|works|work-metrics)\/[1-9]\d{0,7}\.json$|^(summary|date-summary|publishing)\/\d{6}\.json$|^creator\/(index|authors|insights|works-\d{3})\.json$|^foundation\/(index|authors|works|sources|observations|other-authors|other-works|pending-authors)\.json$/;
const SUMMARY_SHARD_LIMIT = 4096;
const SUMMARY_SHARD_ROWS = 2000;
const REDUCED_UPLOAD_BATCH_FILES = 8;
const SUMMARY_INDEX_FIELDS = ['version', 'asOf', 'timeZone', 'format', 'count', 'shards'];
const COUNTS = ['accounts', 'enabledAccounts', 'boards', 'daily', 'works', 'workMetrics',
  'topics', 'topicDaily', 'excludedAccountSnapshots'];
const POLICY = ['readOnly', 'platformComplete', 'independentlyVerified', 'missingDatesFilled',
  'accountDailyEvidence', 'worksMetricEvidence', 'topicEvidence', 'estimate', 'note', 'textRendering'];
const DAILY_FIELDS = ['targetId', 'id', 'date', 'capturedAt', 'sourceChecksum', 'sampleCount',
  'followers', 'likes', 'posts', 'estimatedPlays', 'estimatedPlaysDelta', 'estimatedPlaysProxy',
  ...['followers', 'likes', 'posts'].flatMap(name => [`${name}Delta`, `${name}At`, `${name}Checksum`,
    `${name}BaselineAt`, `${name}BaselineChecksum`])];
const BASE_WORK_FIELDS = ['targetId', 'id', 'externalId', 'caption', 'url', 'publishedAt', 'publishedOn',
  'publicationDateBasis', 'firstSeenAt',
  'lastObservedAt', 'likes', 'comments', 'shares', 'collects', 'plays', 'playsEvidence'];
const WORK_FIELDS = [...BASE_WORK_FIELDS, ...PUBLIC_SOURCE_WORK_FIELDS];
// Already sealed v1/v2 generations predate the source-only publication date.
// This exact older shape is accepted only when a trusted baseline caller opts in.
const LEGACY_WORK_FIELDS = BASE_WORK_FIELDS.filter(key => !['publishedOn', 'publicationDateBasis'].includes(key));
const METRIC_FIELDS = ['targetId', 'id', 'workId', 'externalId', 'capturedAt', 'likes', 'comments',
  'shares', 'collects', 'plays', 'playsEvidence'];
const TOPIC_FIELDS = ['targetId', 'id', 'date', 'capturedAt', 'participants', 'views', 'qualityStatus',
  'sourceChecksum', 'metricsEvidence', ...['participants', 'views'].flatMap(name =>
    [`${name}Delta`, `${name}BaselineAt`, `${name}BaselineChecksum`])];
const PRIVATE = /^(raw_json|rawJson|locator|cookie|cookies|password|token|access_token|accessToken|refresh_token|refreshToken|authorization|settings|metadata_json|sourceRepositoryCredential|sourceUrl|credentials|secret|client_secret|clientSecret|api_key|apiKey)$/i;
const trustedPublications = new WeakSet();
const sealedReplicaSources = new WeakSet();
let processFlight = null;
const hash = text => createHash('sha256').update(text).digest('hex');
const integer = value => Number.isSafeInteger(value) && value >= 0;
const identifier = value => Number.isSafeInteger(value) && value > 0 && value <= 99_999_999;
const canonicalTime = value => typeof value === 'string' && Number.isFinite(Date.parse(value))
  && new Date(value).toISOString() === value;
const workPublicationValid = (item, asOf) => {
  if (item.publishedOn !== null && !isCalendarDate(item.publishedOn)) return false;
  if (item.publishedAt !== null
    && (!canonicalTime(item.publishedAt) || Date.parse(item.publishedAt) > Date.parse(asOf))) return false;
  if (item.publicationDateBasis === 'platform-timestamp') return item.publishedAt !== null;
  if (item.publicationDateBasis === 'creator-source-date-only')
    return item.publishedAt === null && item.publishedOn !== null;
  return item.publicationDateBasis === 'missing' && item.publishedAt === null && item.publishedOn === null;
};
const legacyWorkPublicationValid = (item, asOf) => item.publishedAt === null
  || (canonicalTime(item.publishedAt) && Date.parse(item.publishedAt) <= Date.parse(asOf));
const ownKeys = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && Object.keys(value).every(key => keys.includes(key));
const scalar = value => value === null || typeof value === 'string' || typeof value === 'boolean'
  || (typeof value === 'number' && Number.isFinite(value));
const flat = (value, except = []) => Object.entries(value).every(([key, child]) => except.includes(key) || scalar(child));
const fail = code => { const error = new Error(code); error.code = code; throw error; };
const demand = (condition, code = 'invalid-source') => { if (!condition) fail(code); };
/** Snapshot source bytes once. Sealing is immutability, never validation. */
export function sealPublicReplicaSource(serialized) {
  demand(ownKeys(serialized, ['manifest', 'files']) && Array.isArray(serialized.files));
  const freeze = value => {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
      Object.freeze(value);
      for (const child of Object.values(value)) freeze(child);
    }
    return value;
  };
  const manifest = freeze(structuredClone(serialized.manifest));
  const files = Object.freeze(serialized.files.map(file => {
    demand(file && typeof file === 'object' && !Array.isArray(file));
    return Object.freeze({ ...file });
  }));
  const snapshot = Object.freeze({ manifest, files });
  sealedReplicaSources.add(snapshot);
  return snapshot;
}
const shardPath = number => `summary/${String(number).padStart(6, '0')}.json`;
const safePath = path => {
  if (typeof path !== 'string' || !PATH.test(path)) return false;
  const shard = /^(?:summary|date-summary)\/(\d{6})\.json$/.exec(path);
  return !shard || (Number(shard[1]) > 0 && Number(shard[1]) <= SUMMARY_SHARD_LIMIT);
};
const dateFile = file => file?.path === 'date-summary-index.json' || file?.path?.startsWith('date-summary/')
  || ['summaryDateIndex', 'summaryDateShard'].includes(file?.kind);
const metaOf = ({ content, ...meta }) => meta;
const beijingFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
});
const publicationDate = value => {
  const parts = beijingFormatter.formatToParts(new Date(value));
  const field = type => parts.find(part => part.type === type)?.value;
  return `${field('year')}-${field('month')}-${field('day')}`;
};
function privateKey(value) {
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(([key, child]) => PRIVATE.test(key) || privateKey(child));
}
function metadataValid(file) {
  if (!file || !safePath(file.path) || !SHA.test(file.sha256 ?? '')
    || !integer(file.bytes) || file.bytes < 1 || !integer(file.count)) return false;
  const [, folder, target] = /^(daily|works|work-metrics)\/(\d+)\.json$/.exec(file.path) ?? [];
  const kind = folder ? { daily: 'daily', works: 'works', 'work-metrics': 'workMetrics' }[folder]
    : foundationFile(file) ? foundationKind(file.path) : creatorFile(file) ? creatorKind(file.path) : file.path.startsWith('publishing/') ? 'publishingShard' : file.path.startsWith('summary/') ? 'summaryShard'
      : file.path.startsWith('date-summary/') ? 'summaryDateShard'
        : file.path === 'date-summary-index.json' ? 'summaryDateIndex' : file.path.slice(0, -5);
  if (['summaryShard', 'summaryDateShard'].includes(kind) && (file.count < 1 || file.count > SUMMARY_SHARD_ROWS)) return false;
  return file.kind === kind && (folder
    ? ownKeys(file, ['path', 'kind', 'targetId', 'count', 'bytes', 'sha256'])
      && identifier(file.targetId) && file.targetId === Number(target)
    : ownKeys(file, ['path', 'kind', 'count', 'bytes', 'sha256']));
}
function summaryRowsMatch(items, source, offset = 0) {
  return items.every((item, index) => source[offset + index]
    && PUBLIC_REPLICA_SUMMARY_FIELDS.every(key => item[key] === source[offset + index][key]));
}
function summaryDescriptorValid(value, index) {
  return ownKeys(value, ['path', 'count', 'bytes', 'sha256']) && value.path === shardPath(index + 1)
    && identifier(value.count) && value.count <= SUMMARY_SHARD_ROWS
    && integer(value.bytes) && value.bytes > 0 && SHA.test(value.sha256 ?? '');
}
function playsEvidenceValid(value, plays) {
  if (!ownKeys(value, ['basis', 'actualCountVerified', 'mayBePlaceholder', 'note'])
    || value.actualCountVerified !== false) return false;
  if (value.basis === 'creator-source-cumulative') return integer(plays)
    && value.mayBePlaceholder === (plays === 0 ? true : null)
    && value.note === CREATOR_SOURCE_PLAY_NOTE;
  return ['missing', 'source-reported-unverified'].includes(value.basis)
    && [true, null].includes(value.mayBePlaceholder) && typeof value.note === 'string';
}
function coverageValid(value, asOf) {
  const bounded = time => time === null || (canonicalTime(time) && Date.parse(time) <= Date.parse(asOf));
  return ownKeys(value, ['version', 'profileObservedAt', 'works']) && value.version === 1
    && bounded(value.profileObservedAt) && ownKeys(value.works, ['status', 'attemptedAt', 'observedAt'])
    && ['complete', 'limited', 'unavailable', 'missing'].includes(value.works.status)
    && bounded(value.works.attemptedAt) && bounded(value.works.observedAt)
    && (!['complete', 'limited'].includes(value.works.status)
      || (value.works.observedAt !== null && value.works.attemptedAt !== null))
    && (value.works.status !== 'missing' || (value.works.observedAt === null && value.works.attemptedAt === null))
    && (value.works.attemptedAt === null || value.works.observedAt === null
      || Date.parse(value.works.observedAt) <= Date.parse(value.works.attemptedAt));
}
function creatorSourceLinksValid(value, accounts, asOf) {
  if (!ownKeys(value, ['revision','modifiedAt','rowCount','links',...(value?.workOwners===undefined?[]:['workOwners']),...(value?.foundationWorkOwners===undefined?[]:['foundationWorkOwners'])]) || typeof value.revision !== 'string'
    || !value.revision || !canonicalTime(value.modifiedAt) || Date.parse(value.modifiedAt)>Date.parse(asOf)
    || !integer(value.rowCount) || !Array.isArray(value.links) || !Array.isArray(accounts)) return false;
  const ids=new Set(accounts.map(account=>account.id)), rows=new Set(), targets=new Set();
  try{validateSourceWorkOwners(value.workOwners,{accountIds:ids});validateFoundationWorkOwners(value.foundationWorkOwners,{accountIds:ids});}catch{return false;}
  return value.links.every(link=>{
    if(!ownKeys(link,['authorRow','targetId']) || !identifier(link.authorRow) || !ids.has(link.targetId)
      || rows.has(link.authorRow) || targets.has(link.targetId)) return false;
    rows.add(link.authorRow);targets.add(link.targetId);return true;
  });
}

function accountValid(value, asOf) {
  const fields = ['id', 'label', 'platform', 'enabled', 'boardKeys', 'classification', 'historyRevision', 'latest'];
  if (!ownKeys(value, value?.coverage === undefined ? fields : [...fields, 'coverage'])
    || (value.coverage !== undefined && !coverageValid(value.coverage, asOf))
    || !identifier(value.id) || typeof value.label !== 'string' || typeof value.enabled !== 'boolean'
    || !['douyin', 'bilibili', 'xiaohongshu', 'unknown'].includes(value.platform)
    || !Array.isArray(value.boardKeys) || !value.boardKeys.every(key => typeof key === 'string')
    || !ownKeys(value.historyRevision, ['snapshotMaxId', 'postMaxId', 'postMetricMaxId'])
    || !Object.values(value.historyRevision).every(integer) || !ownKeys(value.latest, ['followers', 'likes', 'posts'])) return false;
  const c = value.classification;
  return ownKeys(c, ['theme', 'primaryKey', 'primaryLabel', 'labels', 'needsReview', 'mode'])
    && flat(c, ['theme', 'labels']) && ownKeys(c.theme, ['key', 'label', 'confirmed', 'mode']) && flat(c.theme)
    && Array.isArray(c.labels) && c.labels.every(label => ownKeys(label, ['key', 'label', 'confidence']) && flat(label))
    && Object.values(value.latest).every(metric => ownKeys(metric, ['value', 'observedAt', 'sourceChecksum', 'date']) && flat(metric));
}

/** Validates all source bytes and derives the only permitted compact daily index.
 * No filesystem, database, credential or network access occurs here. */
export async function preparePublicReplicaPublication(serialized, { signal, dateIndex = false, workSchemaVersion = 'v3' } = {}) {
  try {
    demand(typeof dateIndex === 'boolean' && ['v2', 'v3'].includes(workSchemaVersion));
    demand(serialized && ownKeys(serialized, ['manifest', 'files']));
    const manifest = JSON.parse(JSON.stringify(serialized.manifest));
    const sourceFiles = serialized.files.map(file => ({ ...file }));
    demand(ownKeys(manifest, ['version', 'asOf', 'timeZone', 'policy', 'counts', 'files'])
      && manifest.version === 1 && canonicalTime(manifest.asOf) && Date.parse(manifest.asOf) <= Date.now()
      && manifest.timeZone === 'Asia/Shanghai' && ownKeys(manifest.counts, COUNTS)
      && COUNTS.every(key => integer(manifest.counts[key])) && ownKeys(manifest.policy, POLICY)
      && manifest.policy.readOnly === true && manifest.policy.platformComplete === false
      && manifest.policy.independentlyVerified === false && manifest.policy.missingDatesFilled === false
      && flat(manifest.policy)
      && !privateKey(manifest) && Array.isArray(manifest.files) && manifest.files.length > 0
      && Array.isArray(serialized.files) && sourceFiles.length === manifest.files.length);
    demand(manifest.counts.daily <= SUMMARY_SHARD_LIMIT * SUMMARY_SHARD_ROWS, 'invalid-summary');
    demand(manifest.files.every(metadataValid)
      && new Set(manifest.files.map(file => file.path)).size === manifest.files.length);
    const byPath = new Map(sourceFiles.map(file => [file.path, file]));
    demand(byPath.size === sourceFiles.length && ['catalog.json', 'topics.json'].every(path => byPath.has(path)));
    const dateMetas = manifest.files.filter(dateFile);
    if (dateMetas.length) {
      // Existing sealed sidecars are validated, never regenerated/reordered in place.
      // Removing only the new sidecars reconstructs their exact original source manifest.
      const baseManifest = { ...manifest, files: manifest.files.filter(file => !dateFile(file)) };
      const base = await preparePublicReplicaPublication({ manifest: baseManifest,
        files: sourceFiles.filter(file => !dateFile(file)) }, { signal, workSchemaVersion });
      demand(hash(JSON.stringify(base.manifest)) === hash(JSON.stringify(baseManifest)), 'invalid-summary');
      const indexMeta = dateMetas.find(file => file.kind === 'summaryDateIndex');
      demand(indexMeta && dateMetas.filter(file => file.kind === 'summaryDateIndex').length === 1, 'invalid-summary');
      for (const meta of dateMetas) {
        if (signal?.aborted) fail('aborted');
        const source = byPath.get(meta.path);
        demand(source && ownKeys(source, [...Object.keys(meta), 'content'])
          && Object.keys(meta).every(key => source[key] === meta[key]) && typeof source.content === 'string'
          && source.content.length <= 1_000_000 && Buffer.byteLength(source.content) === meta.bytes
          && hash(source.content) === meta.sha256);
        const part = JSON.parse(source.content);
        demand(!privateKey(part) && part.version === 1 && part.asOf === manifest.asOf && part.timeZone === 'Asia/Shanghai');
      }
      const indexContent = byPath.get(indexMeta.path).content;
      const index = verifyPublicHistoryDateIndex({ sourceManifest: base.manifest, indexContent, indexMeta });
      demand(dateMetas.length === index.shards.length + 1 && index.shards.every(descriptor => {
        const meta = dateMetas.find(file => file.path === descriptor.path);
        return meta?.kind === 'summaryDateShard' && ['count', 'bytes', 'sha256'].every(key => meta[key] === descriptor[key]);
      }), 'invalid-summary');
      const baseByPath = new Map(base.files.map(file => [file.path, file.content]));
      await auditPublicHistoryDatePublication({ sourceManifest: base.manifest, indexContent, indexMeta,
        readSourcePart: async path => baseByPath.get(path), readPart: async path => byPath.get(path)?.content, signal });
      if (signal?.aborted) fail('aborted');
      const result = { manifest, files: manifest.files.map(meta => ({ ...meta, content: byPath.get(meta.path).content })) };
      trustedPublications.add(result); return result;
    }
    const files = [], parsed = new Map(), summaryItems = [];
    for (let index = 0; index < manifest.files.length; index++) {
      if (signal?.aborted) fail('aborted');
      const meta = manifest.files[index], source = byPath.get(meta.path);
      demand(source && ownKeys(source, [...Object.keys(meta), 'content'])
        && Object.keys(meta).every(key => source[key] === meta[key]) && typeof source.content === 'string'
        && Buffer.byteLength(source.content) <= replicaPartitionByteLimit(meta.path)
        && Buffer.byteLength(source.content) === meta.bytes
        && hash(source.content) === meta.sha256);
      const part = JSON.parse(source.content);
      demand(part?.version === 1 && part.asOf === manifest.asOf && part.timeZone === 'Asia/Shanghai'
        && !privateKey(part));
      if (foundationFile(meta)) {
        demand(foundationPartValid(part,meta,manifest.asOf));
      } else if (creatorFile(meta)) {
        demand(creatorPartValid(part,meta,manifest.asOf));
      } else if (publishingFile(meta)) {
        demand(publishingPartValid(part,meta,manifest.asOf));
      } else if (meta.kind === 'catalog') {
        demand(ownKeys(part, ['version', 'asOf', 'timeZone', 'accounts', 'boards', 'classificationRuleVersion', ...(part.creatorSourceLinks === undefined ? [] : ['creatorSourceLinks'])])
          && (part.creatorSourceLinks === undefined || creatorSourceLinksValid(part.creatorSourceLinks, part.accounts, manifest.asOf))
          && Array.isArray(part.accounts) && Array.isArray(part.boards) && part.accounts.length === meta.count
          && part.accounts.every(value => accountValid(value, manifest.asOf))
          && part.boards.every(item => ownKeys(item, ['key', 'name', 'enabled', 'accountCount', 'enabledAccountCount']) && flat(item))
          && typeof part.classificationRuleVersion === 'string'
          && new Set(part.accounts.map(item => item.id)).size === part.accounts.length);
      } else if (meta.kind === 'topics') {
        demand(ownKeys(part, ['version', 'asOf', 'timeZone', 'topics', 'items'])
          && Array.isArray(part.topics) && Array.isArray(part.items) && part.items.length === meta.count
          && part.topics.every(item => ownKeys(item, ['id', 'label', 'enabled']) && identifier(item.id) && flat(item))
          && part.items.every(item => ownKeys(item, TOPIC_FIELDS) && flat(item)));
      } else if (meta.kind === 'summary' && part.format === 'daily-shards-v1') {
        demand(ownKeys(part, SUMMARY_INDEX_FIELDS) && integer(part.count) && part.count === meta.count
          && Array.isArray(part.shards) && part.shards.length <= SUMMARY_SHARD_LIMIT
          && part.shards.every(summaryDescriptorValid) && source.content.length <= 1_000_000, 'invalid-summary');
      } else {
        demand(ownKeys(part, ['version', 'asOf', 'timeZone', 'items']) && Array.isArray(part.items)
          && part.items.length === meta.count && (['summary', 'summaryShard'].includes(meta.kind)
            ? part.items.every(item => ownKeys(item, PUBLIC_REPLICA_SUMMARY_FIELDS) && flat(item))
            : part.items.every(item => item.targetId === meta.targetId
              && ownKeys(item, { daily: DAILY_FIELDS, works: workSchemaVersion === 'v2'
                ? LEGACY_WORK_FIELDS : item.source != null ? WORK_FIELDS : BASE_WORK_FIELDS, workMetrics: METRIC_FIELDS }[meta.kind])
              && flat(item, meta.kind === 'daily' ? [] : ['playsEvidence'])
              && (meta.kind !== 'works' || (workSchemaVersion === 'v2'
                ? legacyWorkPublicationValid(item, manifest.asOf)
                : workPublicationValid(item, manifest.asOf) && publicSourceWorkFieldsValid(item, manifest.asOf)))
              && (meta.kind === 'daily' || playsEvidenceValid(item.playsEvidence, item.plays)))));
      }
      if (meta.kind === 'daily') for (const point of part.items) {
        demand(isCalendarDate(point.date) && canonicalTime(point.capturedAt)
          && Date.parse(point.capturedAt) <= Date.parse(manifest.asOf)
          && publicationDate(point.capturedAt) === point.date);
        for (const field of ['followers', 'likes', 'posts']) {
          demand(point[field] === null || integer(point[field]));
          demand(point[`${field}At`] === null || (canonicalTime(point[`${field}At`])
            && Date.parse(point[`${field}At`]) <= Date.parse(manifest.asOf)));
          if (point[field] !== null) demand(canonicalTime(point[`${field}At`])
            && (point[`${field}At`] === point.capturedAt || publicationDate(point[`${field}At`]) === point.date)
            && Date.parse(point[`${field}At`]) <= Date.parse(point.capturedAt));
        }
        summaryItems.push(Object.fromEntries(PUBLIC_REPLICA_SUMMARY_FIELDS.map(key => [key, point[key] ?? null])));
      }
      parsed.set(meta.path, part); files.push({ ...meta, content: source.content });
      // Bounded CPU slices allow the normal collector to regain the event loop.
      if (index % 12 === 11) await yieldToCollector(undefined, { signal });
    }
    await auditPublishing({manifest,readPart:async path=>parsed.get(path)});
    await auditCreatorPublication({manifest,readPart:async path=>parsed.get(path)});
    await auditFoundationPublication({manifest,readPart:async path=>parsed.get(path)});
    const catalog = parsed.get('catalog.json'), topics = parsed.get('topics.json');
    const accountIds = new Set(catalog.accounts.map(item => item.id));
    demand(manifest.files.filter(file => file.targetId).every(file => accountIds.has(file.targetId)));
    const expectedCounts = { accounts: catalog.accounts.length,
      enabledAccounts: catalog.accounts.filter(item => item.enabled === true).length,
      boards: catalog.boards.length, daily: summaryItems.length,
      works: files.filter(file => file.kind === 'works').reduce((sum, file) => sum + file.count, 0),
      workMetrics: files.filter(file => file.kind === 'workMetrics').reduce((sum, file) => sum + file.count, 0),
      topics: topics.topics.length, topicDaily: topics.items.length };
    demand(Object.entries(expectedCounts).every(([key, value]) => manifest.counts[key] === value));
    const common = { version: 1, asOf: manifest.asOf, timeZone: 'Asia/Shanghai' };
    const existingShards = files.filter(file => file.kind === 'summaryShard');
    if (byPath.has('summary.json')) {
      const summary = parsed.get('summary.json');
      if (summary.format === 'daily-shards-v1') {
        demand(summary.count === summaryItems.length && summary.shards.length === existingShards.length, 'invalid-summary');
        let offset = 0;
        for (const descriptor of summary.shards) {
          const meta = files.find(file => file.path === descriptor.path);
          demand(meta?.kind === 'summaryShard' && ['count', 'bytes', 'sha256'].every(key => meta[key] === descriptor[key]), 'invalid-summary');
          const part = parsed.get(descriptor.path);
          demand(summaryRowsMatch(part.items, summaryItems, offset), 'invalid-summary');
          offset += part.items.length;
        }
        demand(offset === summaryItems.length, 'invalid-summary');
      } else {
        // Preserve previously sealed legacy bytes, including manifest order,
        // so their stable manifest/batch hashes and durable checkpoints survive.
        demand(existingShards.length === 0 && summary.items.length === summaryItems.length
          && summaryRowsMatch(summary.items, summaryItems), 'invalid-summary');
      }
    } else {
      demand(existingShards.length === 0, 'invalid-summary');
      demand(Math.ceil(summaryItems.length / SUMMARY_SHARD_ROWS) <= SUMMARY_SHARD_LIMIT, 'invalid-summary');
      const shards = [];
      for (let offset = 0; offset < summaryItems.length; offset += SUMMARY_SHARD_ROWS) {
        if (signal?.aborted) fail('aborted');
        const items = summaryItems.slice(offset, offset + SUMMARY_SHARD_ROWS);
        const content = `${JSON.stringify({ ...common, items })}\n`;
        demand(content.length <= 1_000_000, 'invalid-summary');
        shards.push({ path: shardPath(shards.length + 1), kind: 'summaryShard', count: items.length,
          bytes: Buffer.byteLength(content), sha256: hash(content), content });
        if (shards.length % 12 === 0) await yieldToCollector(undefined, { signal });
      }
      const content = `${JSON.stringify({ ...common, format: 'daily-shards-v1', count: summaryItems.length,
        shards: shards.map(({ path, count, bytes, sha256 }) => ({ path, count, bytes, sha256 })) })}\n`;
      demand(content.length <= 1_000_000, 'invalid-summary');
      const summary = { path: 'summary.json', kind: 'summary', count: summaryItems.length,
        bytes: Buffer.byteLength(content), sha256: hash(content), content };
      for (const file of [summary, ...shards]) {
        files.push(file); const { content: _, ...meta } = file; manifest.files.push(meta);
      }
    }
    let result = { manifest, files };
    if (dateIndex) {
      // Opt-in applies only to a new generation; old/default bytes remain unchanged.
      const baseByPath = new Map(files.map(file => [file.path, file.content]));
      const derived = await derivePublicHistoryDateIndex({ sourceManifest: manifest,
        readPart: async path => baseByPath.get(path), signal });
      const extras = [derived.indexFile, ...derived.files], extraByPath = new Map(extras.map(file => [file.path, file.content]));
      await auditPublicHistoryDatePublication({ sourceManifest: manifest,
        indexMeta: metaOf(derived.indexFile), indexContent: derived.indexFile.content,
        readSourcePart: async path => baseByPath.get(path), readPart: async path => extraByPath.get(path), signal });
      if (signal?.aborted) fail('aborted');
      result = { manifest: { ...manifest, files: [...manifest.files, ...extras.map(metaOf)] }, files: [...files, ...extras] };
    }
    if (signal?.aborted) fail('aborted');
    trustedPublications.add(result); return result;
  } catch (error) {
    // The source may contain credentials, and even JSON parser errors can quote it.
    fail(signal?.aborted ? 'aborted' : ['invalid-source', 'invalid-summary'].includes(error?.code) ? error.code : 'invalid-source');
  }
}

function batchesFor(publication) {
  const batches = []; let files = [];
  for (const file of publication.files) {
    const candidate = [...files, { path: file.path, sha256: file.sha256, data: file.content }];
    const payload = { action: 'upload', asOf: publication.manifest.asOf, files: candidate };
    // Account for escaped strings and UTF-8, not just the unescaped partition lengths.
    if (files.length && (candidate.length > 35 || Buffer.byteLength(JSON.stringify(payload)) > replicaBatchByteLimit(candidate))) {
      batches.push(files); files = [];
    }
    files.push(candidate.at(-1));
    demand(Buffer.byteLength(JSON.stringify({ action: 'upload', asOf: publication.manifest.asOf, files })) <= replicaBatchByteLimit(files),
      'partition-too-large');
  }
  if (files.length) batches.push(files);
  return batches;
}

function freshCheckpoint(manifest, batches) {
  return { version: 1, origin: PUBLIC_REPLICA_ORIGIN, asOf: manifest.asOf,
    manifestSha256: hash(JSON.stringify(manifest)), batchSha256: batches.map(batch => hash(JSON.stringify(batch))),
    completedBatches: [], activated: false, readbackFiles: [] };
}
function resumable(value, expected) {
  return value && ownKeys(value, Object.keys(expected)) && value.version === 1
    && value.origin === expected.origin && value.asOf === expected.asOf
    && value.manifestSha256 === expected.manifestSha256
    && JSON.stringify(value.batchSha256) === JSON.stringify(expected.batchSha256)
    && Array.isArray(value.completedBatches) && value.completedBatches.every(index => integer(index) && index < expected.batchSha256.length)
    && new Set(value.completedBatches).size === value.completedBatches.length
    && typeof value.activated === 'boolean' && Array.isArray(value.readbackFiles)
    && value.readbackFiles.every(safePath);
}

/** A passive, single-flight producer. Caller owns scheduling, read-only export,
 * secure credentials and checkpoint persistence. All failures resolve safely. */
export function createPublicReplicaSync({ fetchImpl = globalThis.fetch, getCredential,
  loadCheckpoint = async () => null, saveCheckpoint = async () => {}, requestTimeoutMs = 120_000, activationTimeoutMs = requestTimeoutMs, compressRequests = false, reuseUnchanged = false,
  operationTimeoutMs = 480_000 } = {}) {
  demand(typeof reuseUnchanged === 'boolean' && typeof compressRequests === 'boolean' && typeof fetchImpl === 'function' && typeof getCredential === 'function'
    && typeof loadCheckpoint === 'function' && typeof saveCheckpoint === 'function'
    && integer(requestTimeoutMs) && requestTimeoutMs > 0 && requestTimeoutMs <= 120_000
    && integer(activationTimeoutMs) && activationTimeoutMs > 0 && activationTimeoutMs <= 300_000
    && integer(operationTimeoutMs) && operationTimeoutMs > 0 && operationTimeoutMs <= 480_000, 'invalid-configuration');
  const preparedSources = new WeakMap();
  let controller = null, state = { status: 'idle', origin: PUBLIC_REPLICA_ORIGIN };
  const snapshot = () => structuredClone(state);
  const report = value => { state = { ...state, ...value }; return snapshot(); };
  function sync(serialized, { signal, dateIndex = false } = {}) {
    if (processFlight) return Promise.resolve({ status: 'busy', code: 'sync-in-progress', origin: PUBLIC_REPLICA_ORIGIN });
    controller = new AbortController();
    const operationSignal = AbortSignal.any([controller.signal, AbortSignal.timeout(operationTimeoutMs), ...(signal ? [signal] : [])]);
    state = { status: 'running', phase: 'validate', origin: PUBLIC_REPLICA_ORIGIN, requestEncoding: compressRequests ? 'gzip' : 'identity' };
    const flight = (async () => {
      let checkpoint, publication;
      // Only diagnostics created by this operation are trusted. Thrown values
      // from transport/credential plugins cannot supply arbitrary private data.
      const transportFailures = new WeakMap();
      const responseContexts = new WeakMap();
      const transportFail = (code, diagnostic) => {
        const error = Object.assign(new Error(code), { code });
        transportFailures.set(error, diagnostic); throw error;
      };
      const bodyFail = (response, code) => {
        const context = responseContexts.get(response);
        if (context && (operationSignal.aborted || context.deadline.aborted)) {
          transportFail(code, { kind: operationSignal.aborted ? 'aborted' : 'request-timeout',
            ...context.requestContext, httpStatus: context.httpStatus });
        }
        fail(code);
      };
      try {
        if (operationSignal.aborted) fail('aborted');
        const immutable = sealedReplicaSources.has(serialized);
        const cached = immutable ? preparedSources.get(serialized)?.get(dateIndex) : null;
        report({ sourceValidation: cached ? 'reused-immutable' : 'full' });
        publication = cached?.publication ?? await preparePublicReplicaPublication(serialized, { signal: operationSignal, dateIndex });
        demand(trustedPublications.has(publication));
        const { manifest, files } = publication, asOf = manifest.asOf;
        const batches = cached?.batches ?? batchesFor(publication);
        report({ asOf, parts: files.length, batchesTotal: batches.length, phase: 'resume' });
        const expected = cached?.expected ?? freshCheckpoint(manifest, batches);
        if (immutable && !cached) {
          // Cache only validated, immutable bytes and the deterministic upload
          // plan. Credentials, checkpoints and remote responses remain fresh.
          for (const batch of batches) { batch.forEach(Object.freeze); Object.freeze(batch); }
          Object.freeze(batches);
          for (const key of ['batchSha256', 'completedBatches', 'readbackFiles']) Object.freeze(expected[key]);
          Object.freeze(expected);
          const modes = preparedSources.get(serialized) ?? new Map();
          modes.set(dateIndex, { publication, batches, expected });
          preparedSources.set(serialized, modes);
        }
        const loaded = await loadCheckpoint();
        checkpoint = resumable(loaded, expected) ? structuredClone(loaded) : structuredClone(expected);
        let saves = Promise.resolve();
        const persist = async () => {
          if (operationSignal.aborted) fail('aborted');
          const next = structuredClone(checkpoint);
          // Concurrent uploads may finish in any order. Durable checkpoints
          // are written in that order so an older snapshot cannot win last.
          saves = saves.then(() => saveCheckpoint(next)); await saves;
        };
        const request = async (url, init = {}, optional = false) => {
          if (operationSignal.aborted) fail('aborted');
          let response;
          // Full source audits may outlast ordinary upload/read requests. Both
          // deadlines remain bounded by the enclosing operation and caller abort.
          const requestDeadline = AbortSignal.timeout(init.method === 'POST' && state.phase === 'activate'
            ? activationTimeoutMs : requestTimeoutMs);
          const requestContext = { method: init.method === 'POST' ? 'POST' : 'GET', phase: state.phase };
          try {
            response = await fetchImpl(url, { ...init, redirect: 'error', cache: 'no-store',
              signal: AbortSignal.any([operationSignal, requestDeadline, ...(init.signal ? [init.signal] : [])]) });
          } catch {
            transportFail(operationSignal.aborted ? 'aborted' : 'network-failed', {
              kind: operationSignal.aborted ? 'aborted' : requestDeadline.aborted ? 'request-timeout' : 'network',
              ...requestContext, httpStatus: null,
            });
          }
          if (optional && [404, 503].includes(response.status)) return null;
          if (!response.ok) {
            let activationReason = null;
            if (init.method === 'POST' && state.phase === 'activate' && response.status === 409) {
              // Only fixed server literals may enter diagnostics. Never retain
              // arbitrary response strings, private fields or thrown messages.
              const reasons = new Map([
                ['分区清单不一致，未发布','missing-upload'],
                ['存储分片缺失或损坏，未发布','missing-upload'],
                ['历史索引缺失，未发布','missing-upload'],
                ['历史分片缺失，未发布','missing-upload'],
                ['日期历史未通过全量来源核对，未发布','date-proof-rejected'],
                ['每日发片索引核验失败','publishing-proof-rejected'],
                ['作者作品与经营统计核验失败，未发布','creator-proof-rejected'],
                ['补充来源与统一名册核验失败，未发布','foundation-proof-rejected'],
                ['历史分片记录数不一致，未发布','summary-proof-rejected'],
                ['历史索引校验失败，未发布','summary-proof-rejected'],
                ['历史分片校验失败，未发布','summary-proof-rejected'],
                ['历史发布不可改写','immutable-generation-conflict'],
                ['并发发布清单冲突，未确认本次发布','immutable-generation-conflict'],
              ]);
              try { const text = await response.text(); if (Buffer.byteLength(text) <= 4096) activationReason = reasons.get(JSON.parse(text)?.error) ?? null; }
              catch { /* Preserve the original HTTP refusal, never its body. */ }
            }
            // A lost remote staging area must be replayable even if a local
            // checkpoint once acknowledged all uploads. The server still owns
            // the final atomic completeness check.
            if (init.method === 'POST' && state.phase === 'activate' && response.status === 409
              && (activationReason === null || activationReason === 'missing-upload')) {
              checkpoint.completedBatches = []; checkpoint.activated = false; await persist();
            }
            // No body, headers, URL, request payload or exception message enters
            // status. Keep the actual refusal attached to its own error so an
            // aborted sibling upload cannot replace the first failure.
            const httpStatus = Number.isInteger(response.status) && response.status >= 100 && response.status <= 599
              ? response.status : null;
            const category = [401, 403].includes(httpStatus) ? 'authorization'
              : httpStatus === 429 ? 'rate-limited' : httpStatus === 409 ? 'conflict'
                : httpStatus >= 500 ? 'server' : 'other';
            transportFail(init.method === 'POST' ? 'sync-rejected' : 'readback-rejected', {
              kind: 'http', ...requestContext, httpStatus, category,
              ...(activationReason ? { activationReason } : {}),
            });
          }
          responseContexts.set(response, { deadline: requestDeadline, requestContext,
            httpStatus: Number.isInteger(response.status) && response.status >= 100 && response.status <= 599 ? response.status : null });
          return response;
        };
        const decode = async response => {
          try {
            const body = await response.text(); demand(Buffer.byteLength(body) <= 8_000_000, 'invalid-response');
            return JSON.parse(body);
          } catch { bodyFail(response, 'invalid-response'); }
        };
        const endpoint = `${PUBLIC_REPLICA_ORIGIN}/api/replica`;
        const generationUrl = `${endpoint}?${new URLSearchParams({ generation: asOf })}`;
        const matchesManifest = value => ownKeys(value, ['manifest', 'publishedAt', 'readOnly', 'collectionRequiresLocalComputer'])
          && canonicalTime(value.publishedAt) && value.collectionRequiresLocalComputer === true
          && value.readOnly === true && value.manifest?.asOf === asOf
          && hash(JSON.stringify(value.manifest)) === expected.manifestSha256;
        const existing = await request(generationUrl, {}, true);
        if (existing) {
          demand(matchesManifest(await decode(existing)), 'generation-conflict');
          checkpoint.activated = true;
        } else {
          checkpoint.activated = false;
          report({ phase: 'upload' });
          await persist();
          let credential;
          try { credential = await getCredential(); } catch { fail('credential-unavailable'); }
          demand(typeof credential === 'string' && /^[a-f0-9]{64}$/.test(credential), 'credential-unavailable');
          const send = async (body, signal) => {
            const plain=JSON.stringify(body.action==='upload'&&reuseUnchanged?{...body,reuseUnchanged:true}:body);
            const response=await request(endpoint, { method: 'POST', ...(signal ? { signal } : {}),
              headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${credential}`,
                ...(compressRequests?{'Content-Encoding':'gzip'}:{}) },
              body: compressRequests ? gzipSync(plain,{level:1}) : plain });
            const value=await decode(response);
            if(body.action==='upload'&&reuseUnchanged){
              const number=name=>{const text=response.headers.get(name);return /^(?:0|[1-9]\d?)$/.test(text??'')&&Number(text)<=body.files.length?Number(text):null;};
              const reused=number('X-Replica-Reused'),stored=number('X-Replica-Stored');
              if(reused!==null&&stored!==null&&reused+stored>=body.files.length){const old=state.storageReceipts??{files:0,reused:0,stored:0};report({storageReceipts:{files:old.files+body.files.length,reused:old.reused+reused,stored:old.stored+stored}});}
            }
            return value;
          };
          const completed = new Set(checkpoint.completedBatches);
          let reducedUploadBatches = false;
          const uploadParts = async (parts, signal) => {
            const accepted = await send({ action: 'upload', asOf, files: parts }, signal);
            demand(ownKeys(accepted, ['accepted', 'asOf']) && accepted.asOf === asOf
              && accepted.accepted === parts.length, 'invalid-upload-receipt');
          };
          const uploadBatch = async (batch, signal) => {
            if (!reducedUploadBatches || batch.length <= REDUCED_UPLOAD_BATCH_FILES) {
              try { await uploadParts(batch, signal); return; }
              catch (error) {
                const diagnostic = transportFailures.get(error);
                if (batch.length <= REDUCED_UPLOAD_BATCH_FILES || diagnostic?.kind !== 'http'
                  || ![502, 503].includes(diagnostic.httpStatus) || diagnostic.phase !== 'upload') throw error;
                // Keep the original batch hash/checkpoint unchanged. A 502/503 may
                // follow partial remote writes, so replay only immutable parts.
                reducedUploadBatches = true;
              }
            }
            for (let offset = 0; offset < batch.length; offset += REDUCED_UPLOAD_BATCH_FILES) {
              await uploadParts(batch.slice(offset, offset + REDUCED_UPLOAD_BATCH_FILES), signal);
            }
          };
          const batchAbort = new AbortController(); let cursor = 0, uploadError = null;
          const worker = async () => {
            while (!uploadError && cursor < batches.length) {
              const index = cursor++; if (completed.has(index)) continue;
              try {
                await uploadBatch(batches[index], batchAbort.signal);
                completed.add(index); checkpoint.completedBatches = [...completed].sort((a, b) => a - b);
                await persist(); report({ batchesCompleted: completed.size });
              } catch (error) {
                if (!uploadError) uploadError = error;
                batchAbort.abort();
              }
            }
          };
          // Stop scheduling on the first error, abort siblings and drain them.
          // No upload Promise survives this operation or races a later retry.
          await Promise.allSettled(Array.from({ length: Math.min(4, batches.length) }, worker));
          if (uploadError) throw uploadError;
          demand(completed.size === batches.length, 'incomplete-upload');
          if (operationSignal.aborted) fail('aborted');
          report({ phase: 'activate', activationAttempted: true });
          const activated = await send({ action: 'activate', asOf, manifest });
          demand(ownKeys(activated, ['published', 'asOf', 'parts']) && activated.published === true
            && activated.asOf === asOf && activated.parts === files.length,
            'invalid-activation-receipt');
          checkpoint.activated = true; await persist();
        }
        report({ phase: 'readback' });
        demand(matchesManifest(await decode(await request(generationUrl))), 'readback-manifest-mismatch');
        const paths = ['catalog.json', 'topics.json', 'summary.json'];
        paths.push(...files.filter(file=>creatorFile(file)||foundationFile(file)).map(file=>file.path));
        for (const kind of ['daily', 'works', 'workMetrics']) {
          const file = files.find(item => item.kind === kind); if (file) paths.push(file.path);
        }
        const summary = JSON.parse(files.find(file => file.path === 'summary.json').content);
        if (summary.format === 'daily-shards-v1' && summary.shards.length) {
          paths.push(summary.shards[0].path);
          if (summary.shards.length > 1) paths.push(summary.shards.at(-1).path);
        }
        const dateIndexFile = files.find(file => file.kind === 'summaryDateIndex');
        const dateSummary = dateIndexFile ? JSON.parse(dateIndexFile.content) : null;
        if (dateSummary) {
          paths.push(dateIndexFile.path);
          if (dateSummary.shards.length) {
            paths.push(dateSummary.shards[0].path);
            if (dateSummary.shards.length > 1) paths.push(dateSummary.shards.at(-1).path);
          }
        }
        // Always read these bodies again, including after a crash or replay.
        checkpoint.readbackFiles = [];
        for (const path of paths) {
          const file = files.find(item => item.path === path);
          const response = await request(`${endpoint}?${new URLSearchParams({ generation: asOf, part: path })}`);
          let body;
          try { body = await response.text(); } catch { bodyFail(response, 'readback-failed'); }
          demand(Buffer.byteLength(body) === file.bytes && hash(body) === file.sha256, 'readback-hash-mismatch');
          let part; try { part = JSON.parse(body); } catch { fail('readback-failed'); }
          demand(part.asOf === asOf && part.version === 1 && part.timeZone === 'Asia/Shanghai', 'readback-cutoff-mismatch');
          checkpoint.readbackFiles.push(path);
        }
        await persist();
        return report({ status: 'success', phase: 'complete', manifestSha256: expected.manifestSha256,
          batchesCompleted: checkpoint.completedBatches.length, readbackFiles: [...checkpoint.readbackFiles],
          sourceFilesValidated: files.filter(file => !['summary', 'summaryShard', 'summaryDateIndex', 'summaryDateShard'].includes(file.kind)).length,
          summaryFormat: summary.format ?? 'legacy-items-v1', summaryShards: summary.shards?.length ?? 0,
          ...(dateSummary ? { dateIndexFormat: dateSummary.format, dateIndexShards: dateSummary.shards.length } : {}),
          alreadyPublished: Boolean(existing) });
      } catch (error) {
        // Never return thrown messages, stack/cause, response bodies or the credential.
        const safeCodes = ['aborted', 'invalid-source', 'invalid-summary', 'partition-too-large', 'network-failed',
          'sync-rejected', 'readback-rejected', 'invalid-response', 'generation-conflict', 'credential-unavailable',
          'invalid-upload-receipt', 'incomplete-upload', 'invalid-activation-receipt', 'readback-manifest-mismatch',
          'readback-failed', 'readback-hash-mismatch', 'readback-cutoff-mismatch'];
        return report({ status: 'failed', code: operationSignal.aborted ? 'aborted'
          : safeCodes.includes(error?.code) ? error.code : 'sync-failed', activated: checkpoint?.activated === true,
          activationState: checkpoint?.activated ? 'confirmed' : state.activationAttempted ? 'unknown' : 'not-attempted',
          ...(transportFailures.has(error) ? { transportFailure: transportFailures.get(error) } : {}) });
      }
    })();
    processFlight = flight;
    return flight.finally(() => { if (processFlight === flight) processFlight = null; controller = null; });
  }
  return Object.freeze({ sync, snapshot, abort: () => controller?.abort() });
}
