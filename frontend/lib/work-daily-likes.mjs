// Derived only from a verified, fixed account work-metrics partition.
// Daily endpoint differences are not the platform's gross count of new likes.
const DAY = 86400000;
const fail = () => { throw Error('作品点赞历史身份、时间或计数无效，已停止计算'); };
const id = n => Number.isSafeInteger(n) && n > 0;
const count = n => Number.isSafeInteger(n) && n >= 0;
const instant = n => typeof n === 'string' && Number.isFinite(Date.parse(n)) && new Date(n).toISOString() === n;
const day = n => new Date(Date.parse(n) + 8 * 3600000).toISOString().slice(0, 10);
const dateAdd = (date, n) => new Date(Date.parse(date + 'T00:00:00.000Z') + n * DAY).toISOString().slice(0, 10);

export function buildWorkDailyLikes(records, { targetId, workId, asOf } = {}) {
  if (!Array.isArray(records) || !id(targetId) || !id(workId) || !instant(asOf)) fail();
  const seen = new Set(), byDay = new Map(), byTime = new Map(), samples = [];
  let externalId = null;
  for (const row of records) {
    if (!row || row.targetId !== targetId || !id(row.workId)) fail();
    if (row.workId !== workId) continue;
    if (!id(row.id) || seen.has(row.id) || !instant(row.capturedAt) || row.capturedAt > asOf
      || typeof row.externalId !== 'string' || !row.externalId || row.externalId.length > 128
      || /[\x00-\x1f\x7f]/.test(row.externalId) || !(row.likes === null || count(row.likes))) fail();
    if (externalId !== null && externalId !== row.externalId) fail();
    externalId = row.externalId; seen.add(row.id);
    // A timestamp with contradictory known values is not a new observation.
    const atValue = byTime.get(row.capturedAt);
    if (row.likes !== null && atValue !== undefined && atValue !== row.likes) fail();
    if (row.likes !== null) byTime.set(row.capturedAt, row.likes);
    samples.push({ ...row });
    const date = day(row.capturedAt), entry = byDay.get(date) ?? { date, likes: null, likesAt: null, sampleCount: 0 };
    entry.sampleCount++;
    if (row.likes !== null && (entry.likesAt === null || row.capturedAt > entry.likesAt)) {
      entry.likes = row.likes; entry.likesAt = row.capturedAt;
    }
    byDay.set(date, entry);
  }
  const end = day(asOf), dates = [...byDay.keys()].sort();
  // Explicit current-day missing row. Historical gaps are compact date ranges,
  // never fake zero rows and never a multi-year per-day allocation.
  if (!byDay.has(end)) byDay.set(end, { date: end, likes: null, likesAt: null, sampleCount: 0 });
  const rows = [...byDay.values()].sort((a, b) => a.date.localeCompare(b.date)).map(row => {
    const baselineDate = dateAdd(row.date, -1), baseline = byDay.get(baselineDate);
    const reason = row.likes === null ? 'missing-current' : baseline?.likes == null ? 'missing-baseline' : 'comparable';
    return { ...row, baselineDate, baselineLikes: baseline?.likes ?? null, baselineAt: baseline?.likesAt ?? null,
      likesDelta: reason === 'comparable' ? row.likes - baseline.likes : null, reason };
  });
  const start = dates[0] ?? end, known = rows.filter(row => row.likes !== null), gaps = [];
  let cursor = start;
  for (const row of known) {
    if (cursor < row.date) gaps.push({ start: cursor, end: dateAdd(row.date, -1),
      days: Math.round((Date.parse(row.date) - Date.parse(cursor)) / DAY) });
    cursor = dateAdd(row.date, 1);
  }
  if (cursor <= end) gaps.push({ start: cursor, end,
    days: Math.round((Date.parse(end) - Date.parse(cursor)) / DAY) + 1 });
  return { targetId, workId, externalId, asOf, start, end, rows,
    samples: samples.sort((a, b) => b.capturedAt.localeCompare(a.capturedAt) || b.id - a.id),
    observedDays: known.length, missingDays: gaps.reduce((sum, gap) => sum + gap.days, 0), gaps,
    latest: known.at(-1) ?? null, current: rows.at(-1), modelCalls: 0 };
}

export function dailyWorkLikesExport(model, { account, manifest } = {}) {
  const files = manifest?.files?.filter(file => file.path === `work-metrics/${model.targetId}.json`) ?? [];
  if (!account || account.id !== model.targetId || manifest?.asOf !== model.asOf || files.length !== 1
    || files[0].kind !== 'workMetrics' || files[0].targetId !== model.targetId
    || !/^[a-f0-9]{64}$/.test(files[0].sha256) || files[0].count < model.samples.length) fail();
  const header = ['账号编号','作者','作品编号','公开作品ID','北京日期','作品点赞','指标采样UTC','前日日期','前日点赞','前日指标采样UTC','日净变化','状态','本日采样次数','版本截止UTC','历史分区SHA256'];
  return [header, ...model.rows.map(row => [model.targetId, account.label, model.workId, model.externalId,
    row.date, row.likes, row.likesAt, row.baselineDate, row.baselineLikes, row.baselineAt, row.likesDelta,
    row.reason, row.sampleCount, model.asOf, files[0].sha256])];
}
