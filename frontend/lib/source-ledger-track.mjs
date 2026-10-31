import {sourceContentClassifications,sourceWorkClassificationKeys} from './source-work-classification.mjs';
const authorTrackFields = Object.freeze({
  '切片激励': 'slicePosts',
  '创作激励': 'creationPosts',
  '即梦二创': 'aiPosts',
  '#小团团杯S1二创大赛': 'cupPosts',
});
const registeredTrackKeys=Object.freeze({'切片激励':'slice','创作激励':'original','即梦二创':'ai-remix'});
const authorHasTrack=(row,track)=>Number(row[authorTrackFields[track]])>0
 ||Array.isArray(row.registeredClassifications)&&row.registeredClassifications.includes(registeredTrackKeys[track]);

export function sourceTrackMemberships(row) {
  const primary = String(row.track ?? '').trim();
  const detailed = String(row.tracks ?? '').split(/\s+\/\s+/).map(value => value.trim()).filter(Boolean);
  const memberships = [...new Set([primary, ...detailed].filter(Boolean))];
  return memberships.length ? memberships : ['未明确分类'];
}

/** Source-table category membership, not a mutually exclusive partition. */
export function belongsToSourceTrack(row, track, view) {
  if (track === 'all') return true;
  if(typeof track==='string'&&track.startsWith('content:')){
    const key=track.slice('content:'.length);
    return sourceWorkClassificationKeys.includes(key)&&sourceContentClassifications(row,view).includes(key);
  }
  if (view === 'authors') {
    if (track === '__unclassified__') {
      return Object.keys(authorTrackFields).every(track => !authorHasTrack(row,track));
    }
    const field = authorTrackFields[track];
    return Boolean(field && authorHasTrack(row,track));
  }
  if (track === '__unclassified__') return row.sourceSupplement === true || !row.track;
  return sourceTrackMemberships(row).includes(track);
}

/** Identity links require the complete registered ID, not a name or substring. */
export function sameSourceDouyinId(row, douyinId) {
  const wanted = String(douyinId ?? '').trim();
  return Boolean(wanted) && String(row.douyinId ?? '').trim() === wanted;
}

/** A stored target-ID link is evidence of linkage, not of a successful sample. */
export function belongsToSourceLinkage(row, linkage) {
  if (linkage === 'all') return true;
  const linked = Array.isArray(row.targetIds) && row.targetIds.length > 0;
  if (linkage === 'linked') return linked;
  if (linkage === 'sourceOnly') return !linked;
  return false;
}
