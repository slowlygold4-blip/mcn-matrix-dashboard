import { readNavigationState, rangeFor, beijingToday, formatNumber } from './console-model.js?v=20261005-daily-workflow-1';

const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
const num = value => formatNumber(value, true);
const time = value => value && Number.isFinite(Date.parse(value)) ? new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai', dateStyle: 'short', timeStyle: 'short',
}).format(new Date(value)) : '未提供';
const safeUrl = value => {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password) return null;
    for (const key of [...url.searchParams.keys()]) if (/token|secret|password|authorization|credential/i.test(key)) url.searchParams.delete(key);
    return url.href;
  } catch { return null; }
};
const link = (url, label) => safeUrl(url) ? `<a href="${esc(safeUrl(url))}" target="_blank" rel="noopener noreferrer">${esc(label)} ↗</a>` : esc(label);

export function operatingQuery(scope, controls = {}) {
  const query = new URLSearchParams({ board: scope.board || '', theme: scope.theme || 'all', classification: scope.classification || 'all',
    view: controls.view === 'authors' ? 'authors' : 'works', q: controls.q || '', authorKey: controls.authorKey || '',
    sort: controls.sort || 'plays', direction: controls.direction === 'asc' ? 'asc' : 'desc', page: String(controls.page || 1), pageSize: '30' });
  if (!controls.allDates) { query.set('start', scope.start || ''); query.set('end', scope.end || ''); }
  if (['slice', 'original', 'ai-remix', 'contest'].includes(controls.primaryTrack)) query.set('primaryTrack', controls.primaryTrack);
  return query;
}

export function operatingSummaryMarkup(data, { allDates = false } = {}) {
  const s = data.summary, range = data.query.start || data.query.end ? `${data.query.start || '最早'} → ${data.query.end || '最新'}` : '全部已入库日期';
  const inTuanTuan = ['', 'all', 'tuantuan', '团团'].includes(data.query.theme || 'all')
    && ['', 'all', 'tuantuan', '团团', '一条小团团切片矩阵'].includes(data.query.board || '');
  if (!inTuanTuan) return '<div class="operating-heading"><div><p class="operating-kicker">团团表格资料</p><h2>当前主题没有这批来源作品</h2><p>切换至团团或全部主题查看；不会将团团作品混入其他矩阵。</p></div></div>';
  const allowedTracks = new Set(['slice', 'original', 'ai-remix', 'contest']);
  const tracks = (data.tracks || []).filter(track => allowedTracks.has(track.key));
  const trackMarkup = tracks.length ? `<div class="operating-tracks" aria-label="团团内容分类">${tracks.map(track => `<button type="button" data-operating-track="${esc(track.key)}" aria-label="查看${esc(track.name)}的作者和作品"><span>${esc(track.name)}</span><strong>${num(track.works)} 条作品</strong><small>${num(track.authors)} 位作者 · 原表累计播放 ${num(track.cumulativePlays)} · 原表累计赞 ${num(track.cumulativeLikes)}</small></button>`).join('')}</div><p class="operating-caption">仅按明确的原表赛道归类；平台新增但尚无明确分类的作品仍在“全部作品”中。同一作者可跨赛道，作者数不可直接相加。</p>` : '';
  const sourceWorks = s.sourceWorks ?? s.works, platformOnlyWorks = s.platformOnlyWorks ?? 0;
  return `<div class="operating-heading"><div><p class="operating-kicker">团团矩阵 · 原表与已存平台采样去重合并</p><h2>作者与作品经营数据</h2><p>${esc(range)} · 按作品发布日${allDates ? '（查看全部作品日期）' : '，跟随上方范围'}</p></div><button class="secondary-btn" type="button" data-operating-open>查看作者和作品 →</button></div>
    <div class="operating-totals"><div><span>${allDates ? '已入库来源作者' : '本期作品涉及作者'}</span><strong>${num(s.authors)}</strong></div><div><span>已去重合并作品</span><strong>${num(s.works)}</strong><small>原表 ${num(sourceWorks)} · 平台新增 ${num(platformOnlyWorks)}</small></div><div><span>原表累计播放</span><strong>${num(s.cumulativePlays)}</strong><small>${num(s.playsKnown)} / ${num(sourceWorks)} 条原表作品有值</small></div><div><span>原表累计点赞</span><strong>${num(s.cumulativeLikes)}</strong><small>${num(s.likesKnown)} / ${num(sourceWorks)} 条原表作品有值</small></div></div>
    ${trackMarkup}<p class="operating-caption">原表累计成绩不是区间新增；平台新增作品只显示有真实采样时间的指标，不混入原表累计。${data.classificationCoverage ? `全量来源作者分类证据：${num(data.classificationCoverage.withWorkCategory)} 位有作品赛道、${num(data.classificationCoverage.registrationOnly)} 位仅有登记类型、${num(data.classificationCoverage.withoutExplicitCategory)} 位原表无明确分类。` : ''}原表更新 ${esc(time(data.source.refreshedAt))}（北京）；发布日不等于成绩采样日。粉丝、获赞的每日净变化仍以实际采样为准。<a href="/creator-library.html">核对原表逐行证据 ↗</a></p>
    ${!s.works ? `<div class="operating-empty">此范围没有已入库作品，不表示历史数据丢失。全库保留 ${num(data.globalSummary.authors)} 位来源作者、${num(data.globalSummary.works)} 条已去重合并作品。<button type="button" class="link-btn" data-operating-all>查看全部作品日期</button></div>` : ''}`;
}

export function operatingSyncMarkup(sync) {
  if (!sync) return '';
  const descriptions = { unchanged: '已检查，云表无新版本', 'unchanged-content': '已检查，新版本内容与已入库数据相同',
    imported: '新版本已审查并入库', deferred: '检查暂缓，将在下一轮重试', failed: '同步失败，保留上一版数据',
    'not-checked': '自动同步尚未完成第一次检查' };
  const label = descriptions[sync.status] || descriptions['not-checked'];
  return `<p class="operating-caption" role="status">表格自动同步：${esc(label)}${sync.checkedAt ? ` · 最近检查 ${esc(time(sync.checkedAt))}（北京）` : ''}${sync.status === 'failed' && sync.reason ? ` · ${esc(sync.reason)}` : ''}</p>`;
}

const tags = item => (item.tracks || item.classifications || []).map(value => {
  const label = ({ slice:'切片激励', original:'创作激励', 'ai-remix':'即梦二创', contest:'二创赛事' })[value] || value;
  const registrationOnly = Array.isArray(item.workClassifications) && !item.workClassifications.includes(value)
    && item.registeredClassifications?.includes(value);
  return `<span class="operating-tag"${registrationOnly ? ' title="登记表明确分类，尚无该类已入库作品"' : ''}>${esc(label)}${registrationOnly ? ' · 登记' : ''}</span>`;
}).join('');
function header(label, sort, data) {
  const selected = data.query.sort === sort;
  return `<th scope="col" aria-sort="${selected ? data.query.direction === 'asc' ? 'ascending' : 'descending' : 'none'}"><button type="button" class="sort-button" data-operating-sort="${sort}">${label}${selected ? data.query.direction === 'asc' ? ' ↑' : ' ↓' : ' ↕'}</button></th>`;
}
function evidence(item, source) {
  if (item.sourceRow == null) return `<details class="operating-evidence"><summary>查看平台采样依据</summary><p>作品 ID ${esc(item.contentId || '未知')} · 严格关联监控账号 · 不在当前原表作品行中</p><p>首次记录 ${esc(time(item.firstSeenAt))} · 最近有效指标 ${esc(time(item.latestObservedAt))}；发布日期与指标采样时间不同。</p></details>`;
  return `<details class="operating-evidence"><summary>查看来源与合并依据</summary><p>作品 ID ${esc(item.contentId || '未知')} · 总表第 ${num(item.sourceRow)} 行 · 版本 ${esc(source.revision)}</p><p>${link(item.sourceUrl, '总表原记录')} · 来源更新 ${esc(time(source.refreshedAt))}（非作品发布日期）</p><ul>${(item.sourceReferences || []).map(ref => `<li>${link(ref.url, ref.reference)}</li>`).join('')}</ul></details>`;
}
function platformCell(item) {
  const current = item.platformLatest;
  return current ? `赞 ${num(current.likes)}<small>播放 ${num(current.plays)} · ${esc(time(current.capturedAt))}</small>`
    : item.sourceRow == null ? '—<small>作品已识别，指标尚无有效平台观测</small>' : '—<small>暂无匹配平台观测，保留原表值</small>';
}
function comparisonCell(item) {
  const change = item.comparison?.likes;
  const recorded = change ? `${change.delta > 0 ? '+' : ''}${num(change.delta)}<small>${esc(time(change.from))} → ${esc(time(change.to))}</small><small>同作品两次平台观测差，不冒充日增</small>` : '—<small>不足两次可比平台观测</small>';
  const difference = item.sourceComparison?.likes;
  return recorded + (difference ? `<small>平台与表格赞差 ${difference.difference > 0 ? '+' : ''}${num(difference.difference)}（仅核对，非增长）</small>` : '');
}
export function operatingTableMarkup(data) {
  if (!data.items.length) return '<div class="operating-empty">没有符合条件的记录。可清除关键词、查看全部来源日期，或调整上方主题与内容标签。未知值显示 —，不填 0。</div>';
  const authors = data.view === 'authors';
  const headings = authors ? `${header('作者 / 账号', 'name', data)}${header('作品', 'works', data)}${header('原表累计播放', 'plays', data)}${header('原表累计点赞', 'likes', data)}<th>赛道标签</th><th>监控关联</th>`
    : `<th>作品 / 数据依据</th>${header('作者', 'name', data)}${header('发布日', 'date', data)}${header('播放（采用值）', 'plays', data)}${header('点赞（采用值）', 'likes', data)}<th>平台最近记录</th><th>点赞变化 / 对账</th><th>赛道标签</th>`;
  const rows = data.items.map(item => authors
    ? `<tr><td><button class="row-btn" type="button" data-operating-author="${esc(item.key)}"><strong>${esc(item.name)}</strong><small>${esc(item.accountId || '未提供账号 ID')}</small></button></td><td>${num(item.works)}</td><td>${num(item.cumulativePlays)}</td><td>${num(item.cumulativeLikes)}</td><td>${tags(item)}</td><td>${Number.isSafeInteger(item.targetId) && item.targetId > 0 ? `<button class="link-btn" type="button" data-account-id="${item.targetId}">查看监控变化</button>` : '仅来源资料，未确认监控身份'}</td></tr>`
    : `<tr><td class="operating-work-title">${link(item.url, item.title || item.contentId || '未提供标题')}<small>ID ${esc(item.contentId || '未知')} · ${item.sourceRow == null ? '平台新增' : '原表收录'}</small>${evidence(item, data.source)}</td><td>${item.authorKey ? `<button class="row-btn" type="button" data-operating-author="${esc(item.authorKey)}">${esc(item.authorName)}</button>` : esc(item.authorName)}<small>${esc(item.accountId)}</small>${Number.isSafeInteger(item.targetId) && item.targetId > 0 ? `<button class="link-btn" type="button" data-account-id="${item.targetId}">监控变化</button>` : ''}</td><td>${esc(item.publishedOn || '—')}<small>${item.dateSource === 'platform-published-at' ? '平台发布时间 · 北京' : item.dateSource === 'unknown' ? '发布日期未提供' : '原表推算日期'}</small></td><td>${num(item.latestPlays ?? item.cumulativePlays)}<small>${esc(item.metricOrigin?.plays === 'platform' ? '平台实测' : item.metricOrigin?.plays === 'source' || item.cumulativePlays != null ? '原表累计' : '缺测')}</small></td><td>${num(item.latestLikes ?? item.cumulativeLikes)}<small>${esc(item.metricOrigin?.likes === 'platform' ? '平台实测' : item.metricOrigin?.likes === 'source' || item.cumulativeLikes != null ? '原表累计' : '缺测')}</small></td><td>${platformCell(item)}</td><td>${comparisonCell(item)}</td><td>${tags(item)}</td></tr>`).join('');
  return `<div class="operating-table-scroll" role="region" aria-label="${authors ? '来源作者' : '去重作品'}台账，可横向滚动" tabindex="0"><table class="table"><thead><tr>${headings}</tr></thead><tbody>${rows}</tbody></table></div>`;
}

function mount() {
  const host = document.getElementById('creatorOperatingHost'), summaryHost = document.getElementById('creatorOperatingSummary');
  if (!host || !summaryHost) return;
  const initial = new URL(location.href), navigation = readNavigationState(initial, { today: beijingToday() });
  let scope = { ...navigation, ...(navigation.period === 'custom' ? {} : rangeFor(navigation.period)), view: initial.hash.slice(1) || 'overview' };
  const controls = { view: initial.searchParams.get('workView') === 'authors' ? 'authors' : 'works', q: initial.searchParams.get('workQ') || '',
    authorKey: initial.searchParams.get('workAuthor') || '', primaryTrack: initial.searchParams.get('workTrack') || '', sort: initial.searchParams.get('workSort') || 'plays',
    direction: initial.searchParams.get('workDirection') === 'asc' ? 'asc' : 'desc', page: Number(initial.searchParams.get('workPage')) || 1,
    allDates: initial.searchParams.get('workDates') !== 'scope' };
  let current = null, sequence = 0, controller = null, lastKey = '', pendingKey = '', appliedScopeKey = '';
  function remember() {
    const url = new URL(location.href);
    for (const [name, value] of Object.entries({ workView: controls.view, workQ: controls.q, workAuthor: controls.authorKey, workTrack: controls.primaryTrack,
      workSort: controls.sort, workDirection: controls.direction, workPage: controls.page > 1 ? controls.page : '', workDates: controls.allDates ? 'all' : '' })) {
      if (value) url.searchParams.set(name, String(value)); else url.searchParams.delete(name);
    }
    history.replaceState(history.state, '', url);
  }
  function render(data, sync) {
    if (scope.view === 'overview') summaryHost.innerHTML = operatingSummaryMarkup(data, { allDates: true }) + operatingSyncMarkup(sync);
    const selectedAuthor = data.items.find(item => item.authorKey === controls.authorKey);
    host.innerHTML = `${operatingSummaryMarkup(data, controls)}${operatingSyncMarkup(sync)}<div class="operating-toolbar">
      <div class="operating-modes" role="group" aria-label="台账维度"><button type="button" data-operating-mode="works" aria-pressed="${controls.view === 'works'}">按作品</button><button type="button" data-operating-mode="authors" aria-pressed="${controls.view === 'authors'}">按作者</button></div>
      <form data-operating-search><label>查找<input type="search" id="operatingSearch" maxlength="120" value="${esc(controls.q)}" placeholder="作者、账号 ID、作品 ID、标题"></label><button class="secondary-btn" type="submit">搜索</button></form>
      <label>作品日期<select id="operatingDates"><option value="scope" ${!controls.allDates ? 'selected' : ''}>跟随上方日期</option><option value="all" ${controls.allDates ? 'selected' : ''}>全部来源日期</option></select></label>
      <button class="link-btn" type="button" data-operating-clear>清除作品筛选</button></div>
      <p class="operating-caption">团团为大主题；赛道标签按原表保留，跨表同一作品只算一条。${controls.primaryTrack ? `当前按来源主赛道筛选：${esc(({ slice:'切片激励', original:'创作激励', 'ai-remix':'即梦二创', contest:'#小团团杯S1二创大赛' })[controls.primaryTrack] || controls.primaryTrack)}。` : ''}共 ${num(data.total)} ${data.view === 'authors' ? '位作者' : '条作品'}。${data.view === 'authors' ? '作者分类同时包含原表明确登记类型；“· 登记”不代表已有该类作品。' : ''}${controls.authorKey ? `当前作者：${esc(selectedAuthor?.authorName || controls.authorKey)}（精确匹配）` : ''}${controls.allDates ? ` 全日期名册含没有作品日期的作者；全库 ${num(data.globalSummary.authors)} 位，不等于全部已完成监控。` : ' 日期内无作品的作者不计入本期，可切换全部来源日期找全名单。'}</p>
      <p id="operatingReadStatus" class="operating-caption" role="status">已读取 · ${esc(data.query.start || '全部日期')}${data.query.end ? ` 至 ${esc(data.query.end)}` : ''}</p>
      ${operatingTableMarkup(data)}<div class="pager"><button class="secondary-btn" type="button" data-operating-page="${data.page - 1}" ${data.page <= 1 ? 'disabled' : ''}>上一页</button><span>第 ${data.pages ? data.page : 0} / ${data.pages} 页 · ${num(data.total)} 条 · 每页 ${data.pageSize} 条</span><button class="secondary-btn" type="button" data-operating-page="${data.page + 1}" ${data.page >= data.pages ? 'disabled' : ''}>下一页</button></div>
      <details class="operating-evidence"><summary>查看按发布日统计</summary><p>每行是当天发布的一批作品及其来源累计成绩，不是这一天新增播放。</p><div class="operating-table-scroll"><table class="table"><thead><tr><th>推算发布日</th><th>作品</th><th>来源累计播放</th><th>来源累计点赞</th></tr></thead><tbody>${data.daily.map(day => `<tr><td><button class="link-btn" data-operating-day="${esc(day.day)}" type="button">${esc(day.day)}</button></td><td>${num(day.works)}</td><td>${num(day.cumulativePlays)}</td><td>${num(day.cumulativeLikes)}</td></tr>`).join('')}</tbody></table></div></details>`;
    host.querySelector('[data-operating-open]')?.remove();
    host.querySelector('[data-operating-search]').onsubmit = event => { event.preventDefault(); controls.q = host.querySelector('#operatingSearch').value.trim(); controls.page = 1; void read(true); };
    host.querySelector('#operatingDates').onchange = event => { controls.allDates = event.target.value === 'all'; controls.page = 1; void read(true); };
  }
  async function read(force = false) {
    if (!['overview', 'works'].includes(scope.view)) return;
    const query = operatingQuery(scope, scope.view === 'works' ? controls : { view: 'works', allDates: true });
    const key = `${scope.view}:${query}`;
    if (key === pendingKey) return;
    if (!force && key === lastKey) return;
    lastKey = key; pendingKey = key; const id = ++sequence;
    controller?.abort(); controller = new AbortController(); const ownController = controller;
    const active = document.activeElement;
    const focusKey = active?.id || '', sortKey = active?.dataset?.operatingSort;
    host.setAttribute('aria-busy', 'true');
    const status = host.querySelector('#operatingReadStatus'); if (status) status.textContent = '正在读取；下方保留上次成功范围的数据…';
    const deadline = setTimeout(() => ownController.abort(), 20000);
    try {
      const syncRequest = fetch('/api/creator-source/sync-status', { credentials: 'same-origin', signal: ownController.signal })
        .then(response => response.ok ? response.json() : null).catch(() => null);
      const response = await fetch(`/api/creator-operating-view?${query}`, { credentials: 'same-origin', signal: ownController.signal });
      if (!response.ok) throw new Error(`读取失败（${response.status}）`);
      const data = await response.json();
      if (id !== sequence) return;
      if (!data.available) throw new Error('尚未找到已入库来源');
      if (!Array.isArray(data.items) || !data.summary || !data.globalSummary) throw new Error('数据响应不完整');
      const sync = await syncRequest;
      if (id !== sequence) return;
      current = data; controls.page = data.page; render(data, sync);
      if (scope.view === 'works') remember();
      if (active && document.activeElement === document.body && !active.isConnected) {
        const target = focusKey ? document.getElementById(focusKey) : sortKey ? [...host.querySelectorAll('[data-operating-sort]')].find(el => el.dataset.operatingSort === sortKey) : null;
        target?.focus({ preventScroll: true });
      }
    } catch (error) {
      if (id !== sequence) return;
      lastKey = '';
      const message = error.name === 'AbortError' ? '读取超时，请重试。' : error.message;
      if (scope.view === 'overview') summaryHost.innerHTML = `<p>${esc(message)}</p><button class="secondary-btn" type="button" data-operating-retry>重新读取作品台账</button>`;
      else {
        const note = `<p class="operating-error">${esc(message)}${current ? ' 下方保留的是上次成功结果，不代表当前筛选。' : ''}</p><button type="button" class="secondary-btn" data-operating-retry>重试</button>`;
        if (status) status.innerHTML = note; else host.innerHTML = note;
      }
    } finally { clearTimeout(deadline); if (id === sequence) { pendingKey = ''; host.setAttribute('aria-busy', 'false'); } }
  }
  function open() { document.querySelector('.nav-item[data-view="works"]')?.click(); }
  function click(event) {
    const button = event.target.closest('button'); if (!button) return;
    if (button.hasAttribute('data-operating-track')) {
      const category = button.dataset.operatingTrack;
      if (!['slice', 'original', 'ai-remix', 'contest'].includes(category)) return;
      const url = new URL(location.href);
      url.searchParams.delete('board');
      url.searchParams.set('theme', 'tuantuan');
      url.searchParams.set('classification', category);
      url.searchParams.set('workTrack', category);
      url.searchParams.set('workDates', 'all');
      url.searchParams.set('workView', 'works');
      url.searchParams.delete('workAuthor');
      url.searchParams.delete('workPage');
      url.hash = '#works';
      location.assign(url);
      return;
    }
    if (button.hasAttribute('data-operating-open')) { open(); return; }
    if (button.hasAttribute('data-operating-all')) { controls.allDates = true; controls.page = 1; open(); void read(true); return; }
    if (button.hasAttribute('data-operating-retry')) { void read(true); return; }
    if (button.hasAttribute('data-operating-mode')) {
      controls.view = button.dataset.operatingMode; controls.page = 1; controls.authorKey = '';
      if (controls.view === 'authors') controls.primaryTrack = '';
      void read(true);
    }
    if (button.hasAttribute('data-operating-sort')) { const key = button.dataset.operatingSort; controls.direction = controls.sort === key && controls.direction === 'desc' ? 'asc' : 'desc'; controls.sort = key; controls.page = 1; void read(true); }
    if (button.hasAttribute('data-operating-author')) { controls.view = 'works'; controls.authorKey = button.dataset.operatingAuthor; controls.page = 1; void read(true); }
    if (button.hasAttribute('data-operating-page')) { controls.page = Number(button.dataset.operatingPage); void read(true); }
    if (button.hasAttribute('data-operating-clear')) { controls.q = ''; controls.authorKey = ''; controls.primaryTrack = ''; controls.page = 1; void read(true); }
    if (button.hasAttribute('data-operating-day')) { controls.allDates = false; document.dispatchEvent(new CustomEvent('mcn:source-date-range', { detail: { start: button.dataset.operatingDay, end: button.dataset.operatingDay } })); }
  }
  host.addEventListener('click', click); summaryHost.addEventListener('click', click);
  document.addEventListener('mcn:scope-applied', event => {
    const next = event.detail, key = JSON.stringify([next.board, next.theme, next.classification, next.start, next.end]);
    if (appliedScopeKey && appliedScopeKey !== key) { controls.page = 1; controls.allDates = false; controls.primaryTrack = ''; }
    appliedScopeKey = key; scope = next; void read();
  });
  document.addEventListener('mcn:master-roster-refresh', () => { void read(true); });
  document.addEventListener('mcn:operating-data-updated', () => { void read(true); });
  void read();
}
if (typeof document !== 'undefined') mount();
