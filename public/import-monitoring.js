const SCOPE = 'current-import-account-monitoring';
const LABELS = { enabled: '启用监控', paused: '已暂停', pending: '尚未接入', conflict: '关联冲突', unknown: '无法确认' };
const RESOLUTION_LABELS = {
  retrying: '后台正在按计划重试身份核验',
  evidence_exhausted: '现有作品证据已重试完毕，需补充有效证据',
  evidence_missing: '缺少可核验主页或作品证据，需补充资料',
};
const PROFILE_LABELS = { fresh: '近 8 小时主页三项有效', stale: '主页三项已过期', missing: '尚无有效主页三项', invalid: '主页三项记录无效', not_enabled: '未启用，不计入新鲜覆盖' };
const PLATFORMS = { douyin: '抖音', bilibili: 'B站', xiaohongshu: '小红书', kuaishou: '快手' };
const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const integer = value => Number.isSafeInteger(value) && value >= 0;
const timestamp = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T.+(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value));
const dateFormat = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
const time = value => timestamp(value) ? dateFormat.format(new Date(value)) : '尚无有效采样时间';
const number = value => new Intl.NumberFormat('zh-CN').format(value);
const validStatus = value => value === 'all' || Object.hasOwn(LABELS, value);
const validEntryKey = value => typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\u0000-\u001f\u007f]/.test(value);
function validMatrixScope(value) {
  if (value == null) return true;
  if (!value || typeof value !== 'object' || typeof value.available !== 'boolean'
    || !Array.isArray(value.boardNames) || value.boardNames.some(name => typeof name !== 'string' || !name || name.length > 120)
    || !integer(value.boardCount) || value.boardCount < value.boardNames.length) return false;
  if (!value.available) return typeof value.reason === 'string' && value.reason.length > 0;
  return ['totalAccounts', 'enabledAccounts', 'pausedAccounts'].every(key => integer(value[key]))
    && value.enabledAccounts + value.pausedAccounts === value.totalAccounts
    && value.scope === 'current-union-of-submitted-board-account-memberships-not-this-job-only';
}
const canOfferSupplement = item => item.status === 'pending' && item.targetId === null
  && ['evidence_exhausted', 'evidence_missing'].includes(item.resolutionState) && validEntryKey(item.rosterEntryKey);
function validIdentityCorrection(item) {
  const value = item.identityCorrection;
  if (value == null) return true;
  const id = text => typeof text === 'string' && text.length > 0 && text.length <= 120 && !/[\u0000-\u001f\u007f]/.test(text);
  const normalize = text => text.normalize('NFKC').trim().replace(/^@/, '').toLowerCase();
  return item.platform === 'douyin' && id(value.originalAccountId) && id(value.correctedAccountId)
    && normalize(value.originalAccountId) === normalize(item.submittedId)
    && normalize(value.originalAccountId) !== normalize(value.correctedAccountId)
    && (value.status === 'pending' && item.status === 'pending'
      || value.status === 'verified' && ['enabled', 'paused'].includes(item.status));
}
function validResolutionAttempt(value) {
  return value == null || typeof value === 'object' && ['unavailable', 'not_admitted'].includes(value.status)
    && value.origin === 'authorised-work' && typeof value.reason === 'string' && value.reason.length > 0
    && typeof value.errorCode === 'string' && /^[a-z][a-z0-9_]{0,79}$/.test(value.errorCode)
    && integer(value.sourceRow) && value.sourceRow > 0
    && [value.startedAt, value.finishedAt, value.recordedAt].every(timestamp)
    && Date.parse(value.finishedAt) >= Date.parse(value.startedAt);
}

export function validateImportMonitoring(data, jobId, status = 'all') {
  const counts = data?.counts, resolutionCounts = data?.resolutionCounts, page = data?.pagination, identity = data?.identitySummary;
  const countKeys = ['submittedIdentities', ...Object.keys(LABELS), 'freshProfiles', 'staleProfiles', 'missingProfiles', 'invalidProfiles'];
  if (data?.jobId !== jobId || data.scope !== SCOPE || !timestamp(data.checkedAt)
    || typeof data.sourceAvailable !== 'boolean' || !(data.sourceReason === null || typeof data.sourceReason === 'string')
    || !integer(data.inputRows) || !validMatrixScope(data.matrixScope) || !counts || countKeys.some(key => !integer(counts[key]))
    || !resolutionCounts || Object.keys(RESOLUTION_LABELS).some(key => !integer(resolutionCounts[key]))
    || Object.keys(RESOLUTION_LABELS).reduce((total, key) => total + resolutionCounts[key], 0) !== counts.pending
    || Object.keys(LABELS).reduce((total, key) => total + counts[key], 0) !== counts.submittedIdentities
    || counts.freshProfiles + counts.staleProfiles + counts.missingProfiles + counts.invalidProfiles !== counts.enabled
    || !identity || !integer(identity.unknownIdentityItemCount) || !integer(identity.ambiguousIdentityItemCount)
    || identity.ambiguousIdentityItemCount > identity.unknownIdentityItemCount || identity.unknownIdentityItemCount > data.inputRows
    || !page || !integer(page.offset) || page.limit !== 20 || !integer(page.total) || typeof page.hasMore !== 'boolean'
    || page.total !== (status === 'all' ? counts.submittedIdentities : counts[status])
    || !Array.isArray(data.items) || data.items.length > page.limit || page.offset + data.items.length > page.total
    || page.hasMore !== (page.offset + data.items.length < page.total)
    || !Array.isArray(data.notes) || data.notes.some(note => typeof note !== 'string')
    || !data.sourceAvailable && (counts.unknown !== counts.submittedIdentities || counts.enabled !== 0)) {
    throw new Error('当前接入回执格式或统计范围不完整，未替换上次结果');
  }
  const seen = new Set();
  for (const item of data.items) {
    if (!item || typeof item.key !== 'string' || !item.key || seen.has(item.key)
      || typeof item.platform !== 'string' || typeof item.submittedId !== 'string' || !item.submittedId
      || typeof item.name !== 'string' || !integer(item.sourceRows) || item.sourceRows < 1
      || !Object.hasOwn(LABELS, item.status) || status !== 'all' && item.status !== status
      || !(item.targetId === null || Number.isSafeInteger(item.targetId) && item.targetId > 0)
      || ['enabled', 'paused'].includes(item.status) && item.targetId === null
      || !['enabled', 'paused'].includes(item.status) && item.targetId !== null
      || item.status === 'pending' && !Object.hasOwn(RESOLUTION_LABELS, item.resolutionState)
      || item.status !== 'pending' && item.resolutionState != null
      || typeof item.reason !== 'string' || !(item.sampledAt === null || timestamp(item.sampledAt))
      || !validResolutionAttempt(item.resolutionAttempt)
      || !validIdentityCorrection(item)
      || !(item.rosterEntryKey == null || validEntryKey(item.rosterEntryKey))
      || item.rosterEntryKey != null && (item.status !== 'pending' || !data.sourceAvailable)
      || !Object.hasOwn(PROFILE_LABELS, item.profileStatus)
      || (item.status === 'enabled') === (item.profileStatus === 'not_enabled')) {
      throw new Error('当前逐账号接入记录无效，未替换上次结果');
    }
    seen.add(item.key);
  }
  return data;
}

function summaryMarkup(data) {
  const c = data.counts;
  const connected = c.enabled + c.paused;
  const unresolved = c.pending + c.conflict + c.unknown;
  const matrix = data.matrixScope;
  const boardLabel = matrix?.available
    ? matrix.boardCount === 1 ? `“${escape(matrix.boardNames[0])}”` : `${number(matrix.boardCount)} 个提交板块的账号并集`
    : '';
  const conclusion = data.sourceAvailable
    ? `<strong>本表 ${number(c.submittedIdentities)} 个去重提交账号：${number(connected)} 个已建档，${number(unresolved)} 个仍待处理</strong><span>${number(c.enabled)} 启用 · ${number(c.paused)} 暂停 · ${number(c.pending)} 尚未接入${c.conflict || c.unknown ? ` · ${number(c.conflict + c.unknown)} 个冲突或无法确认` : ''}</span>`
    : `<strong>本表 ${number(c.submittedIdentities)} 个去重提交账号；当前接入状态尚不能确认</strong><span>保留历史任务与来源记录，不用零代替未知状态。</span>`;
  const matrixLine = matrix?.available
    ? `<p>${boardLabel}当前共 <strong>${number(matrix.totalAccounts)}</strong> 个经营账号（${number(matrix.enabledAccounts)} 启用 · ${number(matrix.pausedAccounts)} 暂停）。这是全部已证实来源的当前去重并集，不是本任务新增数；不会用 ${number(c.submittedIdentities)} 覆盖它。</p>`
    : matrix?.reason ? `<p>${escape(matrix.reason)}</p>` : '';
  const cards = [['提交身份', c.submittedIdentities], ['启用监控', c.enabled], ['已暂停', c.paused], ['尚未接入', c.pending]];
  return `<section class="import-business-conclusion" aria-label="导入接入对账结论"><p class="eyebrow">IMPORT RECONCILIATION</p><div>${conclusion}</div>${matrixLine}</section>`
    + `<dl class="import-outcome-grid">${cards.map(([label, count]) => `<div><dt>${label}</dt><dd>${number(count)}<small>个提交账号身份</small></dd></div>`).join('')}</dl>`
    + `<p class="import-unit-note">本任务原始 ${number(data.inputRows)} 行，按平台与明确提交 ID 去重；关联冲突 ${number(c.conflict)}，无法确认 ${number(c.unknown)}。另有 ${number(data.identitySummary.unknownIdentityItemCount)} 行缺少可唯一计数的身份（含冲突 ${number(data.identitySummary.ambiguousIdentityItemCount)} 行），未混入去重分母。</p>`
    + `<p class="import-unit-note">尚未接入的身份：后台自动重试 ${number(data.resolutionCounts.retrying)} 个 · 现有证据已耗尽 ${number(data.resolutionCounts.evidence_exhausted)} 个 · 缺少可核验证据 ${number(data.resolutionCounts.evidence_missing)} 个。后两类需要补充资料；不会伪装成仍在自动处理。</p>`
    + `<p class="import-unit-note">已启用身份的主页三项：近 8 小时有效 ${number(c.freshProfiles)} / ${number(c.enabled)}，过期 ${number(c.staleProfiles)}，无记录 ${number(c.missingProfiles)}，记录无效 ${number(c.invalidProfiles)}。主页三项指粉丝、获赞、作品存量，不代表作品明细或全部采集完成。</p>`
    + (!data.sourceAvailable ? `<p class="notice error">当前来源关联不可用：${escape(data.sourceReason || '未取得本任务的可靠当前来源关联')}。这些身份暂列“无法确认”，不据此判为未接入或已完成。</p>` : '')
    + data.notes.map(note => `<p class="import-unit-note">${escape(note)}</p>`).join('');
}
function resolutionMarkup(item) {
  const attempt = item.resolutionAttempt;
  const state = item.status === 'pending'
    ? `<small><strong>${escape(RESOLUTION_LABELS[item.resolutionState])}</strong></small>` : '';
  const detail = attempt
    ? `<small>最近单项作品核验：${escape(attempt.reason)}</small><small>原表第 ${number(attempt.sourceRow)} 行 · ${escape(time(attempt.finishedAt))} 北京时间</small><small>仅说明该次作品核验，不代表整个作者不存在或全部作品不可用。</small>`
    : '<small>暂无近期单项作品核验记录；当前说明不冒充最近核验结果。</small>';
  const action = canOfferSupplement(item)
    ? `<button type="button" class="master-roster-account-action" data-monitoring-supplement="${escape(item.key)}">补充身份资料</button><small>进入原资料预览，核对后再确认提交。</small>`
    : item.status === 'pending' && item.resolutionState === 'retrying'
      ? '<small>当前仍有同源证据在自动重试，无需重复上传；失败上限后会明确转为需补资料。</small>'
      : item.status === 'pending' ? '<small>暂无可唯一定位的原表补充入口；请先核对原始身份资料，不按名字关联。</small>' : '';
  const correction = item.identityCorrection;
  const corrected = correction ? `<small>原表 ID：${escape(correction.originalAccountId)} → ${correction.status === 'verified' ? '已核验更正 ID' : '申请更正 ID'}：${escape(correction.correctedAccountId)}</small><small>${correction.status === 'verified' ? '本次作品身份核验已通过；原始表格记录保留。' : '更正申请仍待核验，不代表已接入监控。'}</small>` : '';
  return `当前接入核对：${escape(item.reason || '未提供核对说明')}${state}${corrected}${detail}${action}`;
}
function rowsMarkup(data) {
  return data.items.length ? data.items.map((item, index) => `<tr><td>${data.pagination.offset + index + 1}</td><td>${escape(PLATFORMS[item.platform] || item.platform)}<small>${escape(item.submittedId)}</small></td><td>${escape(item.name || '未填写名称')}<small>${number(item.sourceRows)} 行原始记录</small></td><td>${LABELS[item.status]}</td><td>${item.targetId ? `监控账号 #${item.targetId}` : '尚无可确认关联'}<small>${PROFILE_LABELS[item.profileStatus]}</small>${item.sampledAt ? `<small>采样：${escape(time(item.sampledAt))} 北京时间</small>` : ''}</td><td>${resolutionMarkup(item)}</td></tr>`).join('')
    : '<tr><td colspan="6">没有符合当前已应用接入状态的提交身份。</td></tr>';
}

// Reuses the shell's status hints; it never creates a background timer or writes.
export function createImportMonitoring({ root, api, canRead, isVisible, now = Date.now }) {
  const get = key => root.querySelector(`[data-monitoring="${key}"]`);
  const doc = root.ownerDocument || globalThis.document;
  let jobId = null, result = null, appliedStatus = 'all', generation = 0, flight = null, lastReadAt = null, disposed = false;
  const hasDraft = () => get('filter').value !== appliedStatus;
  function controls() {
    const unavailable = disposed || !jobId || !canRead() || !isVisible();
    get('refresh').disabled = unavailable || Boolean(flight);
    get('search').disabled = unavailable || Boolean(flight);
    get('previous').disabled = unavailable || Boolean(flight) || !result || result.pagination.offset === 0;
    get('next').disabled = unavailable || Boolean(flight) || !result?.pagination.hasMore;
    for (const button of get('rows').querySelectorAll?.('[data-monitoring-supplement]') || []) button.disabled = unavailable || Boolean(flight);
  }
  function cancel() {
    generation++; flight?.controller.abort(); flight = null; root.setAttribute('aria-busy', 'false'); controls();
  }
  function clear() {
    cancel(); jobId = null; result = null; appliedStatus = 'all'; lastReadAt = null; root.hidden = true;
    for (const name of ['summary', 'rows']) get(name).innerHTML = '';
    for (const name of ['status', 'checkedAt']) get(name).textContent = '';
    get('filter').value = 'all'; controls();
  }
  function eligible() {
    if (disposed) return false;
    if (!canRead()) { clear(); return false; }
    if (!isVisible()) { if (flight) { cancel(); lastReadAt = null; } controls(); return false; }
    return Boolean(jobId);
  }
  function read({ force = false, status = appliedStatus, offset = result?.pagination.offset || 0, trigger = null } = {}) {
    if (!eligible() || !validStatus(status)) return Promise.resolve();
    if (flight) return flight.promise;
    if (!force && lastReadAt !== null && now() - lastReadAt < 30_000) return Promise.resolve();
    const requestedJob = jobId, version = ++generation;
    const run = { controller: new AbortController(), promise: null }; flight = run; lastReadAt = now();
    const ownedFocus = trigger && doc.activeElement === trigger;
    let focusMoved = false;
    const noteFocus = event => { if (event.target !== trigger && event.target !== doc.body && event.target !== doc.documentElement) focusMoved = true; };
    const notePointer = event => { if (event.target !== trigger && !trigger?.contains?.(event.target)) focusMoved = true; };
    if (ownedFocus) { doc.addEventListener?.('focusin', noteFocus, true); doc.addEventListener?.('pointerdown', notePointer, true); }
    root.hidden = false; root.setAttribute('aria-busy', 'true'); controls();
    get('status').textContent = `正在读取本任务当前监控接入；不重新提交名单。${result ? '保留上次已读结果，查询时间尚未更新。' : ''}`;
    run.promise = (async () => {
      try {
        const query = new URLSearchParams({ status, offset: String(offset), limit: '20' });
        const data = await api(`/api/author-spreadsheet/jobs/${encodeURIComponent(requestedJob)}/monitoring?${query}`, { signal: run.controller.signal });
        if (disposed || version !== generation || requestedJob !== jobId) return;
        if (!canRead()) { clear(); return; }
        if (!isVisible()) { cancel(); lastReadAt = null; return; }
        validateImportMonitoring(data, requestedJob, status);
        result = data; appliedStatus = status;
        get('summary').innerHTML = summaryMarkup(data); get('rows').innerHTML = rowsMarkup(data);
        get('checkedAt').textContent = `当前接入核对时间：${time(data.checkedAt)}（北京时间）。历史处理回执保持原样。`;
        const p = data.pagination;
        get('status').textContent = `已应用：${LABELS[appliedStatus] || '全部状态'} · 第 ${Math.floor(p.offset / p.limit) + 1} / ${Math.max(1, Math.ceil(p.total / p.limit))} 页，显示 ${p.total ? p.offset + 1 : 0}–${p.offset + data.items.length} / ${number(p.total)} 个提交身份。${hasDraft() ? '下拉框中的新状态尚未应用。' : ''}`;
      } catch (error) {
        if (disposed || version !== generation || requestedJob !== jobId) return;
        if (!canRead() || [401, 403].includes(error.status)) { clear(); return; }
        if (!isVisible()) { cancel(); lastReadAt = null; return; }
        get('status').textContent = `当前接入读取失败：${error.message}。${result ? '保留上次已读名单与查询时间，不能视为本次已更新。' : '尚无有效当前结果，不以零或空名单代替。'}可只读重试，不要重复提交名单。`;
      } finally {
        if (ownedFocus) { doc.removeEventListener?.('focusin', noteFocus, true); doc.removeEventListener?.('pointerdown', notePointer, true); }
        if (flight === run) { flight = null; root.setAttribute('aria-busy', 'false'); controls(); }
        if (ownedFocus && !focusMoved && version === generation && !disposed && canRead() && isVisible()
          && doc.hasFocus?.() !== false && [doc.body, doc.documentElement].includes(doc.activeElement)) {
          const target = !trigger.disabled ? trigger : get('refresh');
          if (!target.disabled) target.focus?.({ preventScroll: true });
        }
      }
    })();
    return run.promise;
  }
  get('refresh').onclick = () => read({ force: true, trigger: get('refresh') });
  get('rows').onclick = event => {
    const button = event.target.closest?.('[data-monitoring-supplement]');
    if (!button || !get('rows').contains(button) || button.disabled || flight || !eligible() || !result?.sourceAvailable || result.jobId !== jobId) return;
    const item = result.items.find(value => value.key === button.dataset.monitoringSupplement);
    if (!item || !canOfferSupplement(item)) return;
    // Only a capability returned for this exact current item can enter the
    // existing form. The roster will re-read and recheck it before opening.
    doc.dispatchEvent(new CustomEvent('mcn:import-monitoring-supplement', { detail: {
      jobId, entryKey: item.rosterEntryKey, platform: item.platform, submittedId: item.submittedId,
    } }));
  };
  get('form').onsubmit = event => { event.preventDefault(); return read({ force: true, status: get('filter').value, offset: 0, trigger: get('search') }); };
  for (const [key, direction] of [['previous', -1], ['next', 1]]) get(key).onclick = () => {
    if (get(key).disabled || !result) return Promise.resolve();
    return read({ force: true, offset: Math.max(0, result.pagination.offset + direction * 20), trigger: get(key) });
  };
  clear();
  return { clear, hint: () => read(), refresh: () => read({ force: true }),
    setJob(job) {
      if (disposed) return Promise.resolve();
      if (!canRead() || job?.status !== 'completed' || !/^[0-9a-f-]{36}$/i.test(job.id || '')) { clear(); return Promise.resolve(); }
      if (jobId !== job.id) { clear(); jobId = job.id; root.hidden = false; controls(); }
      return read();
    },
    dispose() { clear(); disposed = true; controls(); },
  };
}

if (typeof document !== 'undefined') {
  let bridge = null, controller = null;
  document.addEventListener('mcn:import-monitoring', event => {
    const root = document.getElementById('importMonitoring'), detail = event.detail;
    if (!root || typeof detail?.api !== 'function' || typeof detail?.canRead !== 'function' || typeof detail?.isVisible !== 'function') return;
    bridge = detail;
    controller ??= createImportMonitoring({ root, api: (...args) => bridge.api(...args),
      canRead: () => bridge.canRead(), isVisible: () => bridge.isVisible() });
    void controller.setJob(detail.job);
  });
  document.addEventListener('visibilitychange', () => void controller?.hint());
  document.addEventListener('mcn:import-review-session', () => controller?.clear());
}
