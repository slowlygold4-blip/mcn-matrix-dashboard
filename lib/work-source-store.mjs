/** Immutable source editions with content-addressed rows. No network/model. */
import { createHash } from 'node:crypto';
import * as XLSX from '@e965/xlsx';
import { normalizeLarkSheetUrl } from './lark-sheet-source.mjs';
import { readWorkSourceWorkbook } from './work-source-workbook.mjs';
import {ensureWorkLinkReceiptSchema} from './work-source-link-receipts.mjs';
export { WORK_SOURCE_TABLES } from './work-source-tables.mjs';
const hash = value => createHash('sha256').update(value).digest('hex');
const iso = value => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) throw new Error('invalid-source-clock');
  const ms = Date.parse(value), expected = value.includes('.') ? value : value.replace('Z', '.000Z');
  if (!Number.isFinite(ms) || new Date(ms).toISOString() !== expected) throw new Error('invalid-source-clock');
  return expected;
};
const tableExists = (db, name) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
function readSnapshot(db,callback) {
  if(db.isTransaction)return callback();
  db.exec('BEGIN');
  try{const result=callback();db.exec('COMMIT');return result;}
  catch(error){db.exec('ROLLBACK');throw error;}
}

function metadata(value) {
  const url = new URL(value?.url);
  if (url.username || url.password || url.port) throw new Error('invalid-source-authority');
  const canonical = new URL(normalizeLarkSheetUrl(url.toString())); canonical.search = '';
  if (!Number.isSafeInteger(value.revision) || value.revision < 0 || !Array.isArray(value.sheets) || !value.sheets.length)
    throw new Error('invalid-source-metadata');
  const sheets = value.sheets.map(row => {
    if (typeof row.id !== 'string' || !row.id || typeof row.name !== 'string' || !row.name || !Object.hasOwn(row, 'region'))
      throw new Error('incomplete-source-sheet-metadata');
    if (row.region !== null && (typeof row.region !== 'string' || !/^[A-Z]+[1-9]\d*(?::[A-Z]+[1-9]\d*)?$/.test(row.region)))
      throw new Error('invalid-source-used-region');
    const range = row.region === null ? null : XLSX.utils.decode_range(row.region);
    if (range && (range.s.r > range.e.r || range.s.c > range.e.c)) throw new Error('invalid-source-used-region');
    return { id: row.id, name: row.name, region: range ? XLSX.utils.encode_range(range) : null };
  });
  if (new Set(sheets.map(s => s.id)).size !== sheets.length || new Set(sheets.map(s => s.name)).size !== sheets.length)
    throw new Error('ambiguous-source-sheets');
  return { url: canonical.toString(), revision: value.revision, modifiedAt: iso(value.modifiedAt),
    title: String(value.title ?? '').trim(), sheets };
}

/** Requires whole-export plus explicit used regions, stable before/after.
 * A read clock is retained as a read clock, never a metric observation date.
 */
export function prepareWorkSourceEdition({ buffer, before, after, readAt }, { now = Date.now } = {}) {
  const start = metadata(before), end = metadata(after), observed = iso(readAt);
  if (JSON.stringify(start) !== JSON.stringify(end)) throw new Error('source-changed-during-read');
  if (Date.parse(start.modifiedAt) > Date.parse(observed) || Date.parse(observed) > now()) throw new Error('source-clock-order-invalid');
  const source = readWorkSourceWorkbook(buffer);
  if (source.sheets.length !== start.sheets.length) throw new Error('source-export-sheet-count-mismatch');
  const actual = new Map(source.sheets.map(sheet => [sheet.name, sheet]));
  for (const sheet of start.sheets) {
    const got = actual.get(sheet.name);
    if (!got) throw new Error('source-export-sheet-missing');
    if (sheet.region === null) {
      if (got.populatedRows || got.facts || got.rejected) throw new Error('source-export-empty-region-mismatch');
      continue;
    }
    const expected = XLSX.utils.decode_range(sheet.region), range = XLSX.utils.decode_range(got.range);
    if (range.s.r > expected.s.r || range.s.c > expected.s.c || range.e.r < expected.e.r || range.e.c < expected.e.c)
      throw new Error('source-export-truncated');
  }
  // Keep raw source facts immutable. Derived source-ID bindings are projections
  // and must not change this edition when a later account import arrives.
  const blobs = source.facts.map((fact, ordinal) => {
    const json = JSON.stringify(fact);
    const workKey = fact.contentId || `url:${hash(JSON.stringify([...fact.evidenceUrls].sort()))}`;
    return { ordinal, sha: hash(json), json, workKey, fact };
  });
  if (new Set(blobs.map(row => `${row.fact.sheet}\u0000${row.fact.row}`)).size !== blobs.length)
    throw new Error('duplicate-source-physical-rows');
  const report = JSON.stringify({ source: start, sheets: source.sheets, summary: source.summary, rejected: source.rejected });
  return { metadata: start, readAt: observed, buffer, sourceSha256: source.sourceSha256,
    factsSha256: hash(JSON.stringify(blobs.map(row => row.sha))), reportSha256: hash(report), report, blobs };
}

function schema(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS work_source_artifacts(sha256 TEXT PRIMARY KEY,content BLOB NOT NULL);
    CREATE TABLE IF NOT EXISTS work_source_versions(
    id INTEGER PRIMARY KEY, source_url TEXT NOT NULL, source_revision INTEGER NOT NULL,
    source_modified_at TEXT NOT NULL, source_read_at TEXT NOT NULL, committed_at TEXT NOT NULL,
    source_sha256 TEXT NOT NULL REFERENCES work_source_artifacts(sha256), facts_sha256 TEXT NOT NULL, report_sha256 TEXT NOT NULL,
    fact_count INTEGER NOT NULL CHECK(fact_count>=0), report_json TEXT NOT NULL,
    UNIQUE(source_url,source_revision), UNIQUE(source_url,id));
    CREATE TABLE IF NOT EXISTS work_source_fact_blobs(
      sha256 TEXT PRIMARY KEY, fact_json TEXT NOT NULL, content_id TEXT,
      sheet_name TEXT NOT NULL, work_key TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS work_source_version_facts(
      version_id INTEGER NOT NULL REFERENCES work_source_versions(id), ordinal INTEGER NOT NULL,
      fact_sha256 TEXT NOT NULL REFERENCES work_source_fact_blobs(sha256),
      PRIMARY KEY(version_id,ordinal), UNIQUE(version_id,fact_sha256));
    CREATE TABLE IF NOT EXISTS work_source_heads(
      source_url TEXT PRIMARY KEY, version_id INTEGER NOT NULL,
      FOREIGN KEY(source_url,version_id) REFERENCES work_source_versions(source_url,id));
    CREATE INDEX IF NOT EXISTS idx_work_source_versions_cutoff ON work_source_versions(source_url,committed_at,id);
    CREATE INDEX IF NOT EXISTS idx_work_source_fact_content ON work_source_fact_blobs(content_id);
    CREATE INDEX IF NOT EXISTS idx_work_source_membership_blob ON work_source_version_facts(fact_sha256,version_id);`);
  ensureWorkLinkReceiptSchema(db);
}

function priorVersion(db, sourceUrl, revision) {
  if (!tableExists(db, 'work_source_versions')) return null;
  return db.prepare('SELECT * FROM work_source_versions WHERE source_url=? AND source_revision=?').get(sourceUrl, revision);
}

function currentHead(db, url) {
  if (!tableExists(db, 'work_source_heads')) return null;
  return db.prepare(`SELECT v.* FROM work_source_heads h JOIN work_source_versions v ON v.id=h.version_id
    WHERE h.source_url=?`).get(url);
}

function assertForward(head, edition) {
  if (head && (edition.metadata.revision < head.source_revision
    || Date.parse(edition.metadata.modifiedAt) < Date.parse(head.source_modified_at))) throw new Error('source-version-regression');
}

function assertStoredEdition(db, prior, edition) {
  if (prior.source_modified_at !== edition.metadata.modifiedAt) throw new Error('same-source-revision-clock-drift');
  if (prior.facts_sha256 !== edition.factsSha256 || prior.report_sha256 !== edition.reportSha256)
    throw new Error('same-source-revision-content-drift');
  verifyWorkSourceEdition(db,prior.id);
  if(prior.fact_count!==edition.blobs.length)throw new Error('stored-source-edition-incomplete-or-corrupt');
}

export function verifyWorkSourceEdition(db,versionId) {
  return readSnapshot(db,()=>verifyStored(db,versionId));
}
function verifyStored(db,versionId) {
  const row=db.prepare('SELECT * FROM work_source_versions WHERE id=?').get(versionId);
  if(!row)throw new Error('stored-source-edition-missing');
  if(hash(row.report_json)!==row.report_sha256)throw new Error('stored-source-report-corrupt');
  const artifact=db.prepare('SELECT content FROM work_source_artifacts WHERE sha256=?').get(row.source_sha256);
  if(!artifact || hash(artifact.content)!==row.source_sha256)throw new Error('stored-source-artifact-corrupt');
  const members=db.prepare(`SELECT m.ordinal,m.fact_sha256,b.fact_json FROM work_source_version_facts m
    JOIN work_source_fact_blobs b ON b.sha256=m.fact_sha256 WHERE m.version_id=? ORDER BY m.ordinal`).all(row.id);
  if(members.length!==row.fact_count || members.some((m,i)=>m.ordinal!==i || hash(m.fact_json)!==m.fact_sha256)
    || hash(JSON.stringify(members.map(m=>m.fact_sha256)))!==row.facts_sha256)throw new Error('stored-source-edition-incomplete-or-corrupt');
  return {versionId:row.id,factCount:row.fact_count,sourceSha256:row.source_sha256,validated:true};
}

/** One reservation covers schema, blobs, membership and head. No deletions,
 * replacement writes or changes to platform snapshots/author identities.
 */
export function commitWorkSourceEdition(db, input, { now = Date.now, dryRun = false } = {}) {
  const edition = prepareWorkSourceEdition(input, { now });
  const { url, revision, modifiedAt } = edition.metadata;
  if (dryRun) {
    return readSnapshot(db,()=>{
      const inspected=priorVersion(db,url,revision);
      assertForward(currentHead(db,url),edition);
      if(inspected)assertStoredEdition(db,inspected,edition);
      return {status:inspected?'unchanged':'would-import',sourceUrl:url,sourceRevision:revision,
        factCount:edition.blobs.length,factsSha256:edition.factsSha256,databaseWrites:0};
    });
  }
  if (Number(db.prepare('PRAGMA foreign_keys').get().foreign_keys) !== 1) throw new Error('source-foreign-key-checks-required');
  let started = false;
  try {
    db.exec('BEGIN IMMEDIATE'); started = true;
    schema(db);
    const prior = priorVersion(db, url, revision);
    const head = currentHead(db, url);
    assertForward(head, edition);
    if (prior) {
      assertStoredEdition(db, prior, edition);
      db.exec('COMMIT'); started = false;
      return { status: 'unchanged', versionId: prior.id, sourceUrl: url, sourceRevision: revision,
        factCount: prior.fact_count, factsSha256: prior.facts_sha256, artifactByteMatch: prior.source_sha256 === edition.sourceSha256,
        databaseWrites: 0 };
    }
    const committedAt = new Date(now()).toISOString();
    if (Date.parse(committedAt) < Date.parse(edition.readAt)
      || head && (committedAt < head.committed_at || edition.readAt < head.source_read_at)) throw new Error('source-clock-order-invalid');
    db.prepare('INSERT OR IGNORE INTO work_source_artifacts VALUES(?,?)').run(edition.sourceSha256,edition.buffer);
    const artifact = db.prepare('SELECT content FROM work_source_artifacts WHERE sha256=?').get(edition.sourceSha256);
    if (!artifact || hash(artifact.content) !== edition.sourceSha256) throw new Error('source-artifact-hash-conflict');
    const versionId = Number(db.prepare(`INSERT INTO work_source_versions(source_url,source_revision,source_modified_at,
      source_read_at,committed_at,source_sha256,facts_sha256,report_sha256,fact_count,report_json)
      VALUES(?,?,?,?,?,?,?,?,?,?)`).run(url,revision,modifiedAt,edition.readAt,committedAt,edition.sourceSha256,
        edition.factsSha256,edition.reportSha256,edition.blobs.length,edition.report).lastInsertRowid);
    const insertBlob = db.prepare('INSERT OR IGNORE INTO work_source_fact_blobs VALUES(?,?,?,?,?)');
    const blob = db.prepare('SELECT fact_json FROM work_source_fact_blobs WHERE sha256=?');
    const insertMember = db.prepare('INSERT INTO work_source_version_facts VALUES(?,?,?)');
    let newBlobs = 0;
    for (const row of edition.blobs) {
      newBlobs += Number(insertBlob.run(row.sha,row.json,row.fact.contentId,row.fact.sheet,row.workKey).changes);
      if (blob.get(row.sha)?.fact_json !== row.json) throw new Error('source-blob-hash-conflict');
      insertMember.run(versionId,row.ordinal,row.sha);
    }
    db.prepare(`INSERT INTO work_source_heads VALUES(?,?) ON CONFLICT(source_url)
      DO UPDATE SET version_id=excluded.version_id`).run(url,versionId);
    db.exec('COMMIT'); started = false;
    return { status: 'imported', versionId, sourceUrl: url, sourceRevision: revision,
      factCount: edition.blobs.length, newBlobs, reusedBlobs: edition.blobs.length-newBlobs,
      factsSha256: edition.factsSha256, committedAt };
  } catch (error) {
    if (started) db.exec('ROLLBACK');
    throw error;
  }
}

/** Latest editions as known at the requested real read cutoff. Past queries
 * do not follow today's mutable head. No edition read after cutoff leaks in.
 */
export function readWorkSourceEditions(db, { asOf = new Date().toISOString() } = {}) {
  const cutoff = iso(asOf);
  if (!tableExists(db, 'work_source_versions')) return [];
  return db.prepare(`SELECT v.* FROM work_source_versions v WHERE v.committed_at<=? AND NOT EXISTS(
    SELECT 1 FROM work_source_versions n WHERE n.source_url=v.source_url AND n.id>v.id AND n.committed_at<=?)
    ORDER BY v.source_url`).all(cutoff,cutoff).map(row => ({ id:row.id,sourceUrl:row.source_url,
      revision:row.source_revision,sourceModifiedAt:row.source_modified_at,readAt:row.source_read_at,
      committedAt:row.committed_at,factCount:row.fact_count,sourceSha256:row.source_sha256,
      factsSha256:row.facts_sha256,report:JSON.parse(row.report_json) }));
}

/** Retain the last observed facts for a work even if removed from a later
 * source edition. Absence from a spreadsheet is not deletion on Douyin.
 */
export function readKnownWorkSourceFacts(db, { asOf = new Date().toISOString() } = {}) {
  return readSnapshot(db,()=>readKnownFactsSnapshot(db,asOf));
}
function readKnownFactsSnapshot(db,asOf) {
  const cutoff = iso(asOf), heads = readWorkSourceEditions(db, {asOf:cutoff});
  if (!heads.length) return { versions:[],facts:[],fingerprint:hash('[]') };
  for(const head of heads)verifyStored(db,head.id);
  const latest = new Map(heads.map(row=>[row.sourceUrl,row.id]));
  const rows = db.prepare(`WITH observed AS (
    SELECT v.id version_id,v.source_url,v.source_revision,v.source_modified_at,v.source_read_at,v.committed_at,
      b.sha256,b.fact_json,b.sheet_name,m.ordinal,
      MAX(v.id) OVER(PARTITION BY v.source_url,b.sheet_name,b.work_key) last_version
    FROM work_source_versions v JOIN work_source_version_facts m ON m.version_id=v.id
      JOIN work_source_fact_blobs b ON b.sha256=m.fact_sha256 WHERE v.committed_at<=?
  ) SELECT * FROM observed WHERE version_id=last_version
    ORDER BY source_url,sheet_name,ordinal`).all(cutoff);
  if (rows.some(row=>hash(row.fact_json)!==row.sha256)) throw new Error('stored-source-fact-corrupt');
  return { versions:heads, fingerprint:hash(JSON.stringify(heads.map(row=>[row.id,row.factsSha256]))),
    facts:rows.map(row=>({...JSON.parse(row.fact_json),sourceVersionId:row.version_id,
      sourceUrl:row.source_url,sourceRevision:row.source_revision,sourceModifiedAt:row.source_modified_at,
      sourceReadAt:row.source_read_at,committedAt:row.committed_at,presentInLatestEdition:latest.get(row.source_url)===row.version_id})) };
}
