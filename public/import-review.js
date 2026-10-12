const labels = { needs_locator: '缺少账号定位', identity_conflict: '身份冲突', unresolved: '尚未确认身份', duplicate: '重复记录', existing: '已有账号', skipped: '未接入', deferred: '当时等待后续核验', unknown: '未记录状态' };
const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const resolutionScope = 'current-source-bound-evidence-resolution-not-account-monitoring';
const resolutionLabels = { resolved: '证据核验通过', pending: '等待证据核验', retry: '等待重试核验', processing: '正在核验证据', rejected: '证据核验未通过', mixed: '多条证据状态不同', conflict: '证据关联冲突', unlinked: '未关联核验证据', unknown: '当前状态无法确认', unavailable: '当前状态读取失败' };
const beijingFormatter = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
function beijingTime(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T.+(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) return null;
  return beijingFormatter.format(new Date(value));
}
function resolutionCell(item, data) {
  if (data.currentResolutionScope !== resolutionScope || !beijingTime(data.checkedAt)) return '<strong>当前状态未提供</strong><small>尚未取得带查询时间的当前核验结果；不能从历史状态推断。</small>';
  const current = item.currentResolution;
  if (!current || typeof current !== 'object' || Array.isArray(current)) return '<strong>当前状态无法确认</strong><small>此行没有提供当前证据关联结果。</small>';
  const status = Object.hasOwn(resolutionLabels, current.status) ? current.status : 'unknown';
  const updated = beijingTime(current.updatedAt), retry = beijingTime(current.nextRetryAt);
  const counts = current.counts;
  const breakdown = counts && Number.isSafeInteger(counts.total) && counts.total > 0
    ? ['pending', 'retry', 'processing', 'rejected', 'resolved', 'unknown'].filter(key => Number.isSafeInteger(counts[key]) && counts[key] > 0).map(key => `${resolutionLabels[key]} ${counts[key]} 条`).join(' · ') : '';
  return `<strong class="import-review-resolution-label" data-resolution="${status}">${resolutionLabels[status]}</strong><span class="import-review-resolution-reason">${escape(typeof current.reason === 'string' && current.reason.trim() ? current.reason : '未提供当前核验原因；不据此推断已建档或监控。')}</span>${breakdown && ['mixed', 'conflict'].includes(status) ? `<small>${escape(breakdown)}</small>` : ''}${updated ? `<small>状态更新：${escape(updated)} 北京时间</small>` : ''}${retry && ['retry', 'pending', 'mixed'].includes(status) ? `<small>下次重试计划：${escape(retry)} 北京时间；不保证届时完成</small>` : ''}${status === 'resolved' ? '<small>仅代表证据核验通过，不代表已建档、启用监控或首次采样完成。</small>' : ''}`;
}
export function createImportReview({ root, api, canRead }) {
  const get = key => root.querySelector(`[data-review="${key}"]`);
  const doc = root.ownerDocument || globalThis.document;
  const normalized = value => String(value ?? '').normalize('NFKC').trim().toLowerCase();
  let jobId = null, requestVersion = 0, active = null, result = null, applied = null;
  const criteriaCaption = value => `${value.query ? `搜索“${value.query}”` : '全部关键词'} / ${labels[value.status] || value.status || '全部原因状态'}`;
  const pageCaption = value => `第 ${Math.floor(value.offset / 20) + 1} / ${Math.max(1, Math.ceil(value.total / 20))} 页`;
  const hasDraft = () => applied && (normalized(get('query').value) !== normalized(applied.query) || get('filter').value !== applied.status);
  function syncPager() {
    get('previous').disabled = Boolean(active) || !result || result.offset === 0;
    get('next').disabled = Boolean(active) || !result || result.offset + result.items.length >= result.total;
    if (get('refresh')) get('refresh').disabled = Boolean(active) || !result;
  }
  function clear() {
    requestVersion++; active?.abort(); active = null; result = null; applied = null; jobId = null; root.hidden = true;
    get('rows').innerHTML = ''; get('status').textContent = '';
    if (get('checkedAt')) get('checkedAt').textContent = '';
    root.setAttribute('aria-busy', 'false'); syncPager();
  }
  async function load(offset = 0, { criteria, pagerTrigger } = {}) {
    if (!jobId || !canRead()) { clear(); return; }
    const version = ++requestVersion, requestedJob = jobId;
    const requestedCriteria = criteria ? { ...criteria } : { query: get('query').value, status: get('filter').value };
    const ownedFocus = pagerTrigger && doc?.activeElement === pagerTrigger;
    let focusMoved = false;
    const noteFocus = event => { if (event.target !== pagerTrigger && event.target !== doc?.body && event.target !== doc?.documentElement) focusMoved = true; };
    const notePointer = event => { if (event.target !== pagerTrigger && !pagerTrigger?.contains?.(event.target)) focusMoved = true; };
    if (ownedFocus) { doc.addEventListener?.('focusin', noteFocus, true); doc.addEventListener?.('pointerdown', notePointer, true); }
    active?.abort(); active = new AbortController();
    syncPager();
    root.setAttribute('aria-busy', 'true');
    get('status').textContent = `正在读取历史审查记录及当前证据状态，不重新提交名单…${result && applied ? `当前保留：${criteriaCaption(applied)} · ${pageCaption(result)}；显示的核验时间尚未刷新。` : ''}`;
    const query = new URLSearchParams({ offset: String(offset), limit: '20', q: requestedCriteria.query, status: requestedCriteria.status });
    try {
      const data = await api(`/api/author-spreadsheet/jobs/${encodeURIComponent(requestedJob)}/skipped?${query}`, { signal: active.signal });
      if (version !== requestVersion || requestedJob !== jobId) return;
      if (!canRead()) { clear(); return; }
      if (data?.version !== 1 || data.jobId !== jobId || data.scope !== 'historical-job-review-not-live-queue'
        || !Number.isSafeInteger(data.total) || data.total < 0 || !Number.isSafeInteger(data.originalTotal) || data.originalTotal < data.total
        || !Number.isSafeInteger(data.offset) || data.offset < 0 || data.limit !== 20 || !Array.isArray(data.items) || data.items.length > 20
        || !Array.isArray(data.statuses) || data.items.some(item => !item || typeof item !== 'object' || Array.isArray(item))) throw new Error('审查清单格式不完整，请更新服务后重试');
      const selection = get('filter').value;
      const options = '<option value="">全部原因状态</option>' + data.statuses.map(item => `<option value="${escape(item.status)}">${escape(labels[item.status] || item.status)} · ${escape(item.count)}</option>`).join('');
      const rows = data.items.length ? data.items.map(item => `<tr><td>${escape(item.sourceRow ?? '—')}</td><td><strong>${escape(item.name || '未填写')}</strong><small>${escape(item.platform || '平台未记录')} · ${escape(item.douyinId || item.bilibiliId || item.xiaohongshuId || 'ID未填写')}</small></td><td>${escape(item.board || '未分板块')}</td><td>${escape(labels[item.status] || item.status || '未记录状态')}</td><td>${escape(item.reason || item.identityConflict || '未记录原因')}</td><td class="import-review-resolution">${resolutionCell(item, data)}</td></tr>`).join('') : '<tr><td colspan="6">没有符合筛选的历史审查记录。</td></tr>';
      result = data; applied = { query: typeof data.query === 'string' ? data.query : requestedCriteria.query, status: typeof data.status === 'string' ? data.status : requestedCriteria.status };
      get('filter').innerHTML = options;
      get('filter').value = selection;
      get('rows').innerHTML = rows;
      if (get('checkedAt')) get('checkedAt').textContent = data.currentResolutionScope === resolutionScope && beijingTime(data.checkedAt)
        ? `当前核验查询于 ${beijingTime(data.checkedAt)}（北京时间），仅对应本页 ${data.items.length} 条历史记录的证据。不代表已建档、已启用监控或已完成采样。`
        : '当前状态未提供：服务未返回明确范围与有效查询时间。下方历史记录仍可查阅，不能据其判断现在是否在核验。';
      get('status').textContent = `显示 ${data.total ? data.offset + 1 : 0}–${data.offset + data.items.length} / 筛选 ${data.total} 项，任务原记录 ${data.originalTotal} 项。已应用：${criteriaCaption(applied)} · ${pageCaption(data)}。${hasDraft() ? '输入框中的新条件尚未应用，点击“搜索 / 重试”后生效。' : ''}不是当前待处理人数。`;
    } catch (error) {
      if (version !== requestVersion) return;
      if (!canRead() || [401, 403].includes(error.status)) { clear(); return; }
      get('status').textContent = `读取失败：${error.message}。${result && applied ? `保留上次已应用结果：${criteriaCaption(applied)} · ${pageCaption(result)}，显示 ${result.total ? result.offset + 1 : 0}–${result.offset + result.items.length} / ${result.total} 项；${hasDraft() ? '输入框中的新条件未应用。' : '本次读取未改变清单。'}当前核验结果及查询时间未刷新。` : '尚未取得有效审查清单，不以空名单代替。'}未提交任何名单，可重试读取。`;
    } finally {
      if (ownedFocus) { doc.removeEventListener?.('focusin', noteFocus, true); doc.removeEventListener?.('pointerdown', notePointer, true); }
      if (version === requestVersion) {
        active = null; root.setAttribute('aria-busy', 'false'); syncPager();
        if (ownedFocus && !focusMoved && !root.hidden && canRead() && doc.hasFocus?.() !== false
          && [pagerTrigger, doc.body, doc.documentElement].includes(doc.activeElement)) {
          const reverse = pagerTrigger === get('next') ? get('previous') : get('next');
          const target = !pagerTrigger.disabled ? pagerTrigger : !reverse.disabled ? reverse : get('status');
          if (target === get('status')) target.setAttribute?.('tabindex', '-1');
          target.focus?.({ preventScroll: true });
        }
      }
    }
  }
  function changePage(direction) {
    const trigger = get(direction > 0 ? 'next' : 'previous');
    if (!result || !applied || active || trigger.disabled) return Promise.resolve();
    return load(Math.max(0, result.offset + direction * 20), { criteria: applied, pagerTrigger: trigger });
  }
  get('form').onsubmit = event => { event.preventDefault(); return load(0); };
  get('filter').onchange = () => load(0);
  get('previous').onclick = () => changePage(-1);
  get('next').onclick = () => changePage(1);
  if (get('refresh')) get('refresh').onclick = () => {
    if (!result || !applied || active || get('refresh').disabled) return Promise.resolve();
    return load(result.offset, { criteria: applied, pagerTrigger: get('refresh') });
  };
  return { clear, load, setJob(job) {
    if (!canRead() || job?.status !== 'completed' || !/^[0-9a-f-]{36}$/i.test(job.id || '')) { clear(); return Promise.resolve(); }
    if (jobId === job.id) return Promise.resolve();
    clear(); jobId = job.id; root.hidden = false;
    get('query').value = ''; get('filter').innerHTML = '<option value="">全部原因状态</option>'; get('filter').value = '';
    get('previous').disabled = true; get('next').disabled = true;
    return load(0);
  } };
}

if (typeof document !== 'undefined') {
  let controller;
  document.addEventListener('mcn:import-review-job', event => {
    const root = document.getElementById('importReviewList');
    if (!root || typeof event.detail?.api !== 'function' || typeof event.detail?.canRead !== 'function') return;
    controller ??= createImportReview({ root, api: event.detail.api, canRead: event.detail.canRead });
    void controller.setJob(event.detail.job);
  });
  document.addEventListener('mcn:import-review-session', () => controller?.clear());
}
