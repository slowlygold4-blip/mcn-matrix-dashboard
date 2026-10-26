const $ = id => document.getElementById(id);
const esc = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
const number = value => typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString('zh-CN') : '—';
const sourceDate = value => {
  if (!value) return '未记录';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(date);
};
const groups = [
  { label: '经营与赛道', ids: ['01', '03', '04', '05', '06', '07', '19'] },
  { label: '作者与作品', ids: ['08', '09', '16', '20'] },
  { label: '原始来源与核验', ids: ['02', '10', '11', '17', '18'] },
  { label: '公示与候选', ids: ['12', '13', '14', '15'] },
];
const descriptions = {
  '01': '来源总览：区分统计期、刷新时间与各指标口径。',
  '03': '按推算发布日期和主赛道统计，不能当作平台每日真实新增播放。',
  '04': '日期由作品 ID 推算；是作品来源分布，不是账号每日采集曲线。',
  '05': '按全局唯一主赛道归属；同一作品不会在四个赛道重复计入。',
  '08': '4,481 个来源作者，别名已按来源证据合并。监控关联仅靠可核验抖音号，不凭昵称。',
  '09': '18,179 条作品按作品 ID 唯一去重；累计播放来自来源表，不是期间增长。',
  '10': '收集表原始记录，保留原始值、填报与关联状态。',
  '11': '授权登记记录，状态以来源记录为准，不自动代表经营监控身份已核验。',
  '12': '当前公示作者汇总；公示金额不是实际付款。',
  '13': '当前公示奖项明细；同作品跨赛道记录需看原表与去重依据。',
  '14': '历史候选作者汇总；资格待复核，不是应付或实付。',
  '15': '历史候选作品明细；与公示记录分别保留。',
  '16': '账号别名合并证据；不能把相似昵称直接视为同一人。',
  '17': '未解析链接、归属冲突与日期异常等待核，不做静默合并。',
  '18': '来源表计算与缺测口径，便于核对每项数字。',
  '19': '跨赛道重复播放的总账：收录合计减去多计部分等于全局去重值。',
  '20': '逐条查看跨赛道重复作品及多计贡献。',
};
const state = { summary: null, sheet: new URL(location.href).searchParams.get('sheet') || '08',
  query: new URL(location.href).searchParams.get('q') || '', track: new URL(location.href).searchParams.get('track') || '',
  linkStatus: new URL(location.href).searchParams.get('linkStatus') || 'all', page: 1, request: 0 };

async function get(path) {
  const response = await fetch(path, { credentials: 'same-origin', headers: { Accept: 'application/json' } });
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new Error(payload?.error || `读取失败（${response.status}）`);
  return payload;
}
function updateAddress() {
  const url = new URL(location.href);
  url.searchParams.set('sheet', state.sheet);
  if (state.query) url.searchParams.set('q', state.query); else url.searchParams.delete('q');
  if (state.sheet === '09' && state.track) url.searchParams.set('track', state.track); else url.searchParams.delete('track');
  if (state.sheet === '08' && state.linkStatus !== 'all') url.searchParams.set('linkStatus', state.linkStatus); else url.searchParams.delete('linkStatus');
  history.replaceState(null, '', url);
}
function activeSheet() { return state.summary?.sheets.find(sheet => sheet.id === state.sheet); }
function groupName(id) { return groups.find(group => group.ids.includes(id))?.label || '其他来源'; }
function setStatus(message, error = false) {
  $('status').textContent = message;
  $('status').className = `status${error ? ' error' : ''}`;
}
function renderSummary(data) {
  $('summary').hidden = false;
  $('sourceSheetTotal').textContent = `${data.sheets.length} 张`;
  $('sheetCount').textContent = `${data.sheets.length} 张工作表 · ${number(data.sheets.reduce((total, sheet) => total + sheet.rowCount, 0))} 行来源记录`;
  $('sourceLink').href = data.sourceUrl;
  $('sourceMeta').innerHTML = `<span>数据期 ${esc(data.sourcePeriod.start)} — ${esc(data.sourcePeriod.end)}</span><span>原表刷新 ${esc(sourceDate(data.dataRefreshedAt))}（北京）</span><span>导入 ${esc(sourceDate(data.importedAt))}（北京）</span><span>版本 ${esc(data.sourceRevision || '未记录')}</span>`;
  const cards = [
    { label: '来源作者', value: data.audit.authorCount, note: '账号别名已归并；不是当前启用监控账号' },
    { label: '去重作品', value: data.audit.workCount, note: '作品 ID 全局唯一；跨赛道仅计一次' },
    { label: '已知累计播放', value: data.audit.knownCumulativePlays, note: '来源填报/汇总值；非区间新增或实时平台值', blue: true },
    { label: '已关联监控账号', value: data.audit.matchedTargets, note: '仅按抖音号与已核验主页确定关联' },
  ];
  $('kpis').innerHTML = cards.map(card => `<article class="kpi${card.blue ? ' blue' : ''}"><span class="label">${esc(card.label)}</span><strong>${number(card.value)}</strong><small>${esc(card.note)}</small></article>`).join('');
  $('boundary').innerHTML = `<strong>数字边界</strong> · ${esc(data.semantics.plays)}。${number(data.audit.missingPlays)} 条缺播放、${number(data.audit.missingLikes)} 条缺点赞保留为空；${number(data.audit.overlapWorkCount)} 条作品跨赛道收录，多计累计播放 ${number(data.audit.overlapExcessPlays)} 已在全局去重总数中扣除。公示与候选奖金不当成实付。`;
  $('tracks').innerHTML = data.tracks.map(track => `<button class="track" type="button" data-track="${esc(track.name)}" aria-label="查看${esc(track.name)}赛道的去重作品"><h3 title="${esc(track.name)}">${esc(track.name)}</h3><dl><div><dt>归属作品</dt><dd>${number(track.works)}</dd></div><div><dt>作者</dt><dd>${number(track.authors)}</dd></div><div><dt>已知累计播放</dt><dd>${number(track.plays)}</dd></div><div><dt>万赞作品</dt><dd>${number(track.highLikeWorks)}</dd></div></dl><small>查看归属作品 → · 来源累计值</small></button>`).join('');
}
function renderSheetList() {
  $('sheetList').innerHTML = groups.map(group => `<div class="sheet-sidebar-group">${esc(group.label)}</div>${group.ids.map(id => {
    const sheet = state.summary.sheets.find(item => item.id === id);
    if (!sheet) return '';
    return `<button class="sheet-button${id === state.sheet ? ' active' : ''}" type="button" data-sheet="${esc(id)}" aria-current="${id === state.sheet ? 'true' : 'false'}"><span>${esc(sheet.name)}${sheet.restricted ? ' 🔒' : ''}</span><span>${number(sheet.rowCount)}</span></button>`;
  }).join('')}`).join('');
}
function safeExternalLink(value) {
  try {
    const url = new URL(String(value));
    if (url.protocol !== 'https:' || url.username || url.password) return null;
    return url.href;
  } catch { return null; }
}
function cellMarkup(value, header) {
  if (header.includes('仅管理员')) return '<span class="muted-cell">仅管理员</span>';
  if (value == null || value === '') return '<span class="muted-cell">—</span>';
  const text = String(value);
  if (/^=/.test(text)) return `<span class="muted-cell" title="${esc(text)}">公式（导出无缓存）</span>`;
  const href = safeExternalLink(text);
  if (href) return `<a class="cell-link" href="${esc(href)}" target="_blank" rel="noopener noreferrer" title="${esc(text)}">打开来源 ↗</a>`;
  if (typeof value === 'number' && !/(?:ID|Token|抖音号|微信号|账号|行号)/i.test(header)) return number(value);
  return `<span title="${esc(text)}">${esc(text)}</span>`;
}
function renderRows(data) {
  const headers = data.sheet.headers;
  $('sheetGroup').textContent = groupName(state.sheet);
  $('activeSheetTitle').textContent = data.sheet.name;
  $('sheetDescription').textContent = descriptions[state.sheet] || '保留源表字段和原始行号；数值遵循源表口径。';
  $('sheetTotal').textContent = `${number(data.sheet.rowCount)} 行`;
  $('tableStatus').textContent = data.query || data.track || data.linkStatus !== 'all'
    ? `${data.track ? `归属赛道「${data.track}」 · ` : ''}${data.linkStatus === 'linked' ? '已关联监控 · ' : data.linkStatus === 'unlinked' ? '未确定关联 · ' : ''}筛选到 ${number(data.total)} 行；原始来源共 ${number(data.sheet.rowCount)} 行。`
    : `显示原表第 ${data.rows[0]?.sourceRow || '—'} 行起的记录；横向滚动可看全列。`;
  $('tableHead').innerHTML = `<tr><th scope="col">原表行</th>${headers.map(header => `<th scope="col">${esc(header ?? '')}</th>`).join('')}${state.sheet === '08' ? '<th scope="col">监控关联</th>' : ''}</tr>`;
  $('tableBody').innerHTML = data.rows.length ? data.rows.map(row => `<tr><td class="row-number">${row.sourceRow}</td>${headers.map((header, index) => `<td class="${typeof row.values[index] === 'number' && !/(?:ID|Token|账号|抖音号|行号)/i.test(header) ? 'number-cell' : ''}">${cellMarkup(row.values[index], String(header ?? ''))}</td>`).join('')}${state.sheet === '08' ? `<td>${row.monitorMatches?.length ? `<a class="monitor-link" href="/?q=${encodeURIComponent(String(row.monitorMatches[0].matchedId))}#accounts" title="按已匹配的抖音号在监控账号中查找">查监控账号 ↗</a>` : '<span class="muted-cell">未确定关联</span>'}</td>` : ''}</tr>`).join('') : `<tr><td colspan="${headers.length + 2}" class="muted-cell">没有符合条件的记录。</td></tr>`;
  $('pageStatus').textContent = `${number(data.total)} 行 · 第 ${data.page} / ${data.pages || 1} 页`;
  $('previousPage').disabled = data.page <= 1;
  $('nextPage').disabled = data.page >= data.pages;
  $('sheetSearch').value = state.query;
  $('linkStatus').hidden = state.sheet !== '08';
  $('linkStatus').value = state.linkStatus;
}
async function loadRows() {
  const request = ++state.request;
  updateAddress(); renderSheetList();
  $('tableStatus').textContent = '读取来源行…';
  $('linkStatus').hidden = state.sheet !== '08';
  const params = new URLSearchParams({ sheet: state.sheet, q: state.query, track: state.track,
    linkStatus: state.linkStatus, page: String(state.page), pageSize: '30' });
  try {
    const data = await get(`/api/creator-library/rows?${params}`);
    if (request !== state.request) return;
    renderRows(data);
  } catch (error) {
    if (request !== state.request) return;
    const sheet = activeSheet();
    $('activeSheetTitle').textContent = sheet?.name || '未找到来源子表';
    $('sheetGroup').textContent = groupName(state.sheet);
    $('sheetDescription').textContent = descriptions[state.sheet] || '';
    $('tableStatus').textContent = error.message;
    $('tableHead').innerHTML = '';
    $('tableBody').innerHTML = '';
    $('pageStatus').textContent = '—';
    $('previousPage').disabled = true; $('nextPage').disabled = true;
  }
}
async function searchAll(event) {
  event.preventDefault();
  const q = $('globalSearch').value.trim();
  if (q.length < 2) { $('globalResults').hidden = false; $('globalResults').textContent = '至少输入两个字符再搜索。'; return; }
  $('globalResults').hidden = false; $('globalResults').textContent = '正在跨表搜索…';
  try {
    const data = await get(`/api/creator-library/search?q=${encodeURIComponent(q)}`);
    $('globalResults').innerHTML = `<p>共找到 ${number(data.total)} 行${data.total > data.shown ? `，先显示前 ${number(data.shown)} 行` : ''}；点击后进入对应子表继续筛选。</p><div class="global-results-list">${data.matches.map(match => `<button type="button" data-open-sheet="${esc(match.sheetId)}" data-query="${esc(q)}"><b>${esc(match.sheetName)} · 第 ${match.sourceRow} 行</b>${esc(match.preview.join(' · '))}</button>`).join('') || '<p>没有匹配结果。</p>'}</div>`;
  } catch (error) { $('globalResults').textContent = error.message; }
}

async function start() {
  try {
    const summary = await get('/api/creator-library/summary');
    if (!summary.available) throw new Error(summary.error || '来源数据尚未导入');
    state.summary = summary;
    if (!summary.sheets.some(sheet => sheet.id === state.sheet)) state.sheet = '08';
    renderSummary(summary);
    setStatus('来源数据已核对 · 可按作者、作品 ID 与原表行号查找');
    await loadRows();
  } catch (error) {
    setStatus(`${error.message}。如需登录，请先返回经营总览。`, true);
  }
}

$('globalSearchForm').addEventListener('submit', searchAll);
$('tracks').addEventListener('click', event => {
  const button = event.target.closest('[data-track]');
  if (!button || !state.summary) return;
  state.sheet = '09'; state.query = ''; state.track = button.dataset.track; state.linkStatus = 'all'; state.page = 1;
  void loadRows();
  $('activeSheetTitle').scrollIntoView({ block: 'start', behavior: 'smooth' });
});
$('globalResults').addEventListener('click', event => {
  const button = event.target.closest('[data-open-sheet]');
  if (!button || !state.summary) return;
  state.sheet = button.dataset.openSheet;
  state.query = button.dataset.query;
  state.track = ''; state.linkStatus = 'all';
  state.page = 1;
  void loadRows();
  $('activeSheetTitle').scrollIntoView({ block: 'start', behavior: 'smooth' });
});
$('sheetList').addEventListener('click', event => {
  const button = event.target.closest('[data-sheet]');
  if (!button || !state.summary) return;
  state.sheet = button.dataset.sheet; state.query = ''; state.track = ''; state.linkStatus = 'all'; state.page = 1;
  void loadRows();
});
$('applySheetSearch').addEventListener('click', () => { state.query = $('sheetSearch').value.trim(); state.page = 1; void loadRows(); });
$('sheetSearch').addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); $('applySheetSearch').click(); } });
$('clearSheetSearch').addEventListener('click', () => { state.query = ''; state.track = ''; state.linkStatus = 'all'; state.page = 1; void loadRows(); });
$('linkStatus').addEventListener('change', () => { state.linkStatus = $('linkStatus').value; state.page = 1; void loadRows(); });
$('previousPage').addEventListener('click', () => { if (state.page > 1) { state.page--; void loadRows(); } });
$('nextPage').addEventListener('click', () => { state.page++; void loadRows(); });
void start();
