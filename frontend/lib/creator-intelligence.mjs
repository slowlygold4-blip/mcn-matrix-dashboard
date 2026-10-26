import {sourceTrackMemberships} from './source-ledger-track.mjs';

const key = value => String(value ?? '').normalize('NFKC').trim().toLocaleLowerCase('en-US');
const metric = value => Number.isSafeInteger(value) && value >= 0 ? value : null;

export function canonicalSourceAuthors(rows) {
  const byId = new Map(rows.map(row => [key(row.douyinId), row]));
  const collapsed = [];
  const authors = rows.filter(row => {
    if (row.posts !== 0 || row.plays !== 0 || row.likes !== 0 || row.targetIds?.length) return true;
    const counterpart = byId.get(key(row.name));
    if (!counterpart || counterpart === row || key(counterpart.name) !== key(row.douyinId) || !(counterpart.posts > 0)) return true;
    collapsed.push({row:row.row,canonicalRow:counterpart.row});
    return false;
  });
  return {authors,collapsed};
}

export function summarizeSourceObservations(rows) {
  if (!Array.isArray(rows)) throw Error('Source observations require rows');
  const grouped = new Map();
  let latestAt = null;
  for (const row of rows) {
    const contentId = String(row.contentId ?? '').trim();
    const observedAt = String(row.observedAt ?? '');
    if (!/^\d{16,22}$/.test(contentId) || !Number.isFinite(Date.parse(observedAt))) continue;
    const entry = {contentId, observedAt, author: String(row.author ?? ''), plays: metric(row.plays), likes: metric(row.likes)};
    const previous = grouped.get(contentId) ?? [];
    previous.push(entry);
    grouped.set(contentId, previous);
    if (latestAt === null || observedAt > latestAt) latestAt = observedAt;
  }
  const usable = [];
  let ambiguous = 0;
  for (const observations of grouped.values()) {
    const lastAt = observations.reduce((at, row) => row.observedAt > at ? row.observedAt : at, observations[0].observedAt);
    const last = observations.filter(row => row.observedAt === lastAt);
    if (new Set(last.map(row => `${row.plays}:${row.likes}`)).size > 1) { ambiguous++; continue; }
    usable.push(last[0]);
  }
  return {
    rows: rows.length, uniqueWorks: grouped.size, usableWorks: usable.length,
    ambiguousWorks: ambiguous, latestAt,
    topWorks: usable.filter(row => row.plays !== null).sort((a, b) => b.plays - a.plays || a.contentId.localeCompare(b.contentId)).slice(0, 8),
  };
}

function dayBefore(iso, offset) {
  const date = new Date(`${iso}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() - offset);
  return date.toISOString().slice(0, 10);
}

export function buildCreatorIntelligence(authors, works, supplement = {}) {
  if (!Array.isArray(authors) || !Array.isArray(works)) throw Error('Creator intelligence requires source rows');
  const names = new Map(authors.map(author => [key(author.douyinId), author.name]));
  const seenWorks = new Set();
  const days = new Map();
  const groups = new Map();
  const workRows = [];
  const validDates = [];
  let playsKnown = 0, likesKnown = 0, totalPlays = 0, totalLikes = 0;
  const allPlayValues = [];

  for (const work of works) {
    const contentId = String(work.contentId ?? '').trim();
    if (!/^\d{16,22}$/.test(contentId) || seenWorks.has(contentId)) throw Error(`Duplicate or invalid source work ID: ${contentId}`);
    seenWorks.add(contentId);
    const date = String(work.publishDate ?? '').trim() || null;
    if (date !== null) {
      const timestamp = new Date(`${date}T00:00:00Z`);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(timestamp.getTime()) || timestamp.toISOString().slice(0, 10) !== date) {
        throw Error(`Invalid publication date: ${contentId}`);
      }
      validDates.push(date);
    }
    const memberships = sourceTrackMemberships(work);
    const authorKey = key(work.douyinId);
    const plays = metric(work.plays), likes = metric(work.likes);
    if (plays !== null) { playsKnown++; totalPlays += plays; allPlayValues.push(plays); }
    if (likes !== null) { likesKnown++; totalLikes += likes; }
    const item = { contentId, date, memberships, author: names.get(authorKey) || work.author || '未署名', douyinId: work.douyinId || '', title: work.title || '', url: work.url || null, plays, likes };
    workRows.push(item);
    let day = null;
    if (date !== null) {
      day = days.get(date) ?? { date, works: 0, authors: new Set(), tracks: {} };
      day.works++;
      if (authorKey) day.authors.add(authorKey);
      days.set(date, day);
    }
    for (const track of memberships) {
      if (day) day.tracks[track] = (day.tracks[track] ?? 0) + 1;
      const group = groups.get(track) ?? { track, works: 0, authors: new Set(), playsKnown: 0, likesKnown: 0, cumulativePlays: 0, cumulativeLikes: 0 };
      group.works++;
      if (authorKey) group.authors.add(authorKey);
      if (plays !== null) { group.playsKnown++; group.cumulativePlays += plays; }
      if (likes !== null) { group.likesKnown++; group.cumulativeLikes += likes; }
      groups.set(track, group);
    }
  }
  validDates.sort();
  const firstDate = validDates[0] ?? null, lastDate = validDates.at(-1) ?? null;
  const sevenDayStart = lastDate ? dayBefore(lastDate, 6) : null;
  const leaderboards = {};
  for (const selected of ['all', ...groups.keys()]) {
    const selectedWorks = selected === 'all' ? workRows : workRows.filter(work => work.memberships.includes(selected));
    const byAuthor = new Map();
    for (const work of selectedWorks) {
      const authorKey = key(work.douyinId);
      if (!authorKey) continue;
      const item = byAuthor.get(authorKey) ?? { douyinId: work.douyinId, name: work.author, works: 0, playsKnown: 0, likesKnown: 0, cumulativePlays: 0, cumulativeLikes: 0 };
      item.works++;
      if (work.plays !== null) { item.playsKnown++; item.cumulativePlays += work.plays; }
      if (work.likes !== null) { item.likesKnown++; item.cumulativeLikes += work.likes; }
      byAuthor.set(authorKey, item);
    }
    leaderboards[selected] = {
      authors: [...byAuthor.values()].filter(item => item.playsKnown > 0)
        .map(({ likesKnown, ...item }) => ({ ...item, cumulativeLikes: likesKnown ? item.cumulativeLikes : null }))
        .sort((a, b) => b.cumulativePlays - a.cumulativePlays || b.works - a.works).slice(0, 15),
      works: selectedWorks.filter(work => work.plays !== null).sort((a, b) => b.plays - a.plays).slice(0, 15),
    };
  }
  allPlayValues.sort((a, b) => a - b);
  const supplementalAuthors = supplement.additionalAuthors ?? 0, supplementalWorks = supplement.additionalWorks ?? 0;
  return {
    basis: '原表作品发布日期与来源表的累计成绩；不是平台每日采样，也不是区间新增播放',
    firstDate, lastDate, sevenDayStart,
    counts: {
      tableAuthors: authors.length + supplementalAuthors,
      tableWorks: works.length + supplementalWorks,
      datedWorks: validDates.length,
      undatedWorks: works.length - validDates.length,
      activeWorkAuthors: new Set(workRows.map(work => key(work.douyinId)).filter(Boolean)).size,
      datedWorkAuthors: new Set(workRows.filter(work => work.date !== null).map(work => key(work.douyinId)).filter(Boolean)).size,
      sevenDayWorks: sevenDayStart ? workRows.filter(work => work.date !== null && work.date >= sevenDayStart).length : 0,
      playsKnown, likesKnown, cumulativePlays: playsKnown ? totalPlays : null, cumulativeLikes: likesKnown ? totalLikes : null,
      medianWorkPlays: allPlayValues.length ? allPlayValues[Math.floor((allPlayValues.length - 1) / 2)] : null,
      worksOver100kPlays: allPlayValues.filter(value => value >= 100000).length,
      authorFollowersKnown: authors.filter(author => metric(author.followers) !== null).length,
      supplementalAuthors, supplementalWorks,
    },
    tracks: [...groups.values()].map(({ authors: members, ...group }) => ({ ...group,
      cumulativePlays: group.playsKnown ? group.cumulativePlays : null,
      cumulativeLikes: group.likesKnown ? group.cumulativeLikes : null,
      authors: members.size })).sort((a, b) => b.works - a.works),
    days: [...days.values()].map(({ authors: members, ...day }) => ({ ...day, authors: members.size })).sort((a, b) => a.date.localeCompare(b.date)),
    leaderboards,
  };
}
