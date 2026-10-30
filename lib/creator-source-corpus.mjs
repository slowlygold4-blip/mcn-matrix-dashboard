/** Base source edition only; independent of platform/foundation projections. */
import {readCurrentCreatorSourceLinks} from './creator-source-current-links.mjs';
import {readWorkSourceOverlay,workSourceFingerprint} from './work-source-overlay.mjs';
import {readCreatorAuthorRows} from './creator-author-field-order.mjs';
const text=value=>String(value??'').trim();
const norm=value=>text(value).normalize('NFKC').toLowerCase();
const parse=value=>JSON.parse(value||'{}');
const knownCount=value=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0?value:null;
const date=value=>{const v=text(value);if(!/^\d{4}-\d{2}-\d{2}$/.test(v))return '';const ms=Date.parse(v+'T00:00:00Z');return Number.isFinite(ms)&&new Date(ms).toISOString().slice(0,10)===v?v:'';};
const trackKeys={'切片激励':'slice','创作激励':'original','即梦二创':'ai-remix','#小团团杯S1二创大赛':'contest'};
const split=value=>text(value).split(/\s*\/\s*/).filter(Boolean);
const tableExists=(db,name)=>!!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
const cached=new WeakMap();
/** Registration labels are explicit source fields, not guesses from a nickname. */
export function registeredContentTypes(sourceKey, contentType) {
  const source = text(sourceKey), value = text(contentType);
  if (source === 'ai_registry') return ['ai-remix'];
  if (source !== 'slice_registry') return [];
  const result = [];
  if (value.includes('切片')) result.push('slice');
  if (/创作|手书|绘画|meme/i.test(value)) result.push('original');
  if (/\bAI\b|即梦/i.test(value)) result.push('ai-remix');
  return result;
}
/** Shared full corpus for publication counting; no pagination or metric guesses. */
export function readUnifiedCreatorSourceCorpus(db,asOf){
  if(!tableExists(db,'creator_source_imports'))return null;
  const imported=db.prepare('SELECT * FROM creator_source_imports WHERE julianday(imported_at)<=julianday(?) ORDER BY id DESC LIMIT 1').get(asOf);
  return imported?{imported,source:corpus(db,imported,{reference:asOf})}:null;
}

export function corpus(db, imported, { reference = new Date() } = {}) {
  const cutoff = new Date(reference).toISOString();
  const editionFingerprint = workSourceFingerprint(db, cutoff);
  const currentLinks = readCurrentCreatorSourceLinks(db, { imported, reference });
  const identities = readCreatorAuthorRows(db,imported);
  const previous = cached.get(db);
  if (previous?.id === imported.id && previous.sha === imported.source_sha256
    && previous.editionFingerprint === editionFingerprint
    && previous.authorIdentityFingerprint === identities.fingerprint
    && previous.currentLinks.fingerprint === currentLinks.fingerprint) return previous;
  const rows = sheet => db.prepare('SELECT row_number,values_json FROM creator_source_rows WHERE import_id=? AND sheet_id=? ORDER BY row_number').all(imported.id, sheet);
  const accountLinks = new Map();
  for (const row of currentLinks.accountLinks) {
    if (!accountLinks.has(row.author_row)) accountLinks.set(row.author_row, []);
    accountLinks.get(row.author_row).push(row.target_id);
  }
  const workLinks = new Map(currentLinks.workLinks.map(row => [row.work_row, row.target_id]));
  const sourceLinks = new Map(rows('02').map(row => { const v = parse(row.values_json); return [text(v[0]), { title: text(v[1]), url: text(v[5]) }]; }));
  const registrations = new Map();
  for (const row of rows('11')) {
    const v = parse(row.values_json), accountId = norm(v[3]);
    const classifications = registeredContentTypes(v[1], v[6]);
    if (!accountId || !classifications.length) continue;
    if (!registrations.has(accountId)) registrations.set(accountId, []);
    registrations.get(accountId).push({ sourceRow: row.row_number, sourceKey: text(v[1]),
      recordId: text(v[0]), classifications });
  }
  const authors = identities.rows.filter(row=>row.canonicalAuthorRow==null||row.canonicalAuthorRow===row.row_number).map(row => {
    const v = row.values, targetIds = [...new Set(accountLinks.get(row.row_number) || [])];
    const tracks = [[7, 'slice'], [8, 'original'], [9, 'ai-remix'], [10, 'contest']].filter(([i]) => Number(v[i]) > 0).map(([, key]) => key);
    return { key: `source-author:${imported.id}:${row.row_number}`, sourceRow: row.row_number,
      name: text(v[0]), accountId: text(v[1]), aliases: split(v[2]), theme: 'tuantuan',
      classifications: tracks, workClassifications: tracks, registeredClassifications: [], registrationEvidence: [],
      targetId: targetIds.length === 1 ? targetIds[0] : null, targetIds,
      monitoringLink: targetIds.length === 1 ? 'linked' : targetIds.length > 1 ? 'ambiguous' : 'unlinked',
      // Screenshot/OCR counts without a measurement date are not current fans.
      sourceFollowers: knownCount(v[14]), sourceFollowersNote: text(v[15]),
      sourceUrl: imported.source_url, _search: norm([v[0], v[1], v[2]].join(' ')) };
  });
  const primaryAuthors=new Map(authors.map(author=>[author.sourceRow,author]));
  for(const row of identities.rows){
    if(row.canonicalAuthorRow==null||row.canonicalAuthorRow===row.row_number)continue;
    const primary=primaryAuthors.get(row.canonicalAuthorRow);if(!primary)throw Error('source-field-repair-primary-missing');
    const v=row.values;
    primary.sourceAliases=[...(primary.sourceAliases||[]),{row:row.row_number,key:`source-author:${imported.id}:${row.row_number}`,
      name:text(v[0]),accountId:text(v[1]),sourceFollowers:knownCount(v[14]),sourceFollowersNote:text(v[15]),
      identityFieldRepair:row.identityFieldRepair}];
    primary.aliases=[...new Set([...primary.aliases,...split(v[2])])];
    primary._search+=' '+norm([row.identityFieldRepair.original.name,row.identityFieldRepair.original.accountId].join(' '));
  }
  const authorIds = new Map();
  for (const author of authors) {
    const id = norm(author.accountId);
    if (!id) continue;
    if (!authorIds.has(id)) authorIds.set(id, []);
    authorIds.get(id).push(author);
  }
  for (const [id, candidates] of authorIds) {
    // A duplicate public account ID is not enough evidence to assign a
    // registration to one of several source author rows.
    if (candidates.length !== 1) continue;
    const author = candidates[0], evidence = registrations.get(id) || [];
    author.registrationEvidence = evidence;
    author.registeredClassifications = [...new Set(evidence.flatMap(row => row.classifications))];
    author.classifications = [...new Set([...author.workClassifications, ...author.registeredClassifications])];
  }
  const worksById = new Map();
  let duplicateWorkRows = 0;
  for (const row of rows('09')) {
    const v = parse(row.values_json), contentId = text(v[0]);
    // No nickname matching. A nonunique handle leaves this work unassigned.
    const candidates = authorIds.get(norm(v[2])) || [], author = candidates.length === 1 ? candidates[0] : null;
    const allTracks = [...new Set([...split(v[6]), text(v[5])].filter(Boolean))];
    const references = text(v[13]).split(/\s*[;；]\s*|\s*\|\s*/).filter(Boolean).map(reference => {
      const match = reference.match(/^([^:]+):([^:]+)$/), source = match ? sourceLinks.get(match[1]) : null;
      return { reference, key: match?.[1] ?? null, row: /^\d+$/.test(match?.[2] || '') ? Number(match[2]) : null,
        recordId: match?.[2]?.startsWith('rec') ? match[2] : null, url: source?.url || null };
    });
    const key = contentId || `source-row:${row.row_number}`;
    if (worksById.has(key)) { duplicateWorkRows++; continue; }
    worksById.set(key, { key, contentId: contentId || null, sourceRow: row.row_number,
      authorKey: author?.key ?? null, authorName: text(v[1]), accountId: text(v[2]),
      targetId: workLinks.get(row.row_number) ?? null, publishedOn: date(v[3]), dateSource: 'source_inferred_publication_date',
      contentType: text(v[4]), primaryTrack: text(v[5]), tracks: allTracks,
      classifications: allTracks.map(track => trackKeys[track]).filter(Boolean),
      cumulativePlays: knownCount(v[7]), cumulativeLikes: knownCount(v[8]),
      title: text(v[10]), url: text(v[11]), sourceRecordCount: knownCount(v[12]), sourceReferences: references,
      sourceUrl: imported.source_url, recordOrigin: 'source-only', _search: norm([v[0], v[1], v[2], v[10]].join(' ')) });
  }
  const merged = readWorkSourceOverlay(db, { imported, authors, works: [...worksById.values()], asOf: cutoff });
  const byRow=new Map(authors.map(a=>[a.sourceRow,a])),aliases=new Map();
  for(const link of currentLinks.accountLinks){
    if(link.canonicalAuthorRow==null||link.canonicalAuthorRow===link.author_row)continue;
    const author=byRow.get(link.author_row),canonical=byRow.get(link.canonicalAuthorRow);
    if(!author||!canonical||author.targetId!==canonical.targetId||author.targetId!==link.target_id)continue;
    aliases.set(author.key,canonical);
    canonical.sourceAliases=[...(canonical.sourceAliases||[]),{row:author.sourceRow,key:author.key,name:author.name,
      accountId:author.accountId,sourceFollowers:author.sourceFollowers,sourceFollowersNote:author.sourceFollowersNote}];
    canonical.aliases=[...new Set([...canonical.aliases,author.accountId,...author.aliases])];
    for(const field of ['classifications','workClassifications','registeredClassifications'])canonical[field]=[...new Set([...canonical[field],...author[field]])];
    canonical.registrationEvidence=[...canonical.registrationEvidence,...author.registrationEvidence];
    canonical._search+=' '+author._search;
  }
  const unifiedWorks=merged.works.map(work=>{const author=aliases.get(work.authorKey);return author?{...work,
    sourceAccountIds:[...new Set([...(work.sourceAccountIds||[]),work.accountId])],sourceAuthorKey:work.authorKey,
    sourceAuthorName:work.authorName,authorKey:author.key,authorName:author.name,accountId:author.accountId,
    _search:work._search+' '+author._search}:work;});
  const result = { id: imported.id, sha: imported.source_sha256, currentLinks, editionFingerprint,authorIdentityFingerprint:identities.fingerprint,
    authors:authors.filter(a=>!aliases.has(a.key)), works:unifiedWorks, sourceEditions: merged.summary, duplicateWorkRows };
  cached.set(db, result);
  return result;
}
