const STATUS = { enabled: '启用监控', paused: '已暂停', pending: '待核对' };
let instance = 0;
const text = value => typeof value === 'string' ? value : '';
const count = value => Number.isSafeInteger(value) && value >= 0;
const list = value => Array.isArray(value) ? value.filter(item => typeof item === 'string') : [];
const jobIdValid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const supplementJobStates = { queued: '等待身份核对', running: '正在核对身份', completed: '任务处理完成，请查看结果', failed: '任务未完成，请查看原因', interrupted: '任务已中断，请查看原因' };
const supplementStates = { ...supplementJobStates, 'awaiting-verification': '等待作品身份核对', 'review-required': '补充资料仍需处理', conflict: '补充身份存在冲突', linked: '已按补充资料建档（采样状态另查）' };
const supplementBlocked = item => ['queued', 'running', 'awaiting-verification', 'conflict'].includes(item.supplement?.status);
export const canSupplementRosterEntry = item => item?.monitorStatus === 'pending' && item.targetId === null && item.liveSource !== true && item.readOnly !== true;
const submittedIdentity = value => typeof value === 'string' ? value.normalize('NFKC').replace(/\s+/g, ' ').trim().replace(/^@/, '').toLowerCase() : '';
const validCorrectedId = value => typeof value === 'string' && /^[a-z0-9_.-]{1,100}$/.test(value) && /[a-z0-9]/.test(value) && value !== '0';
const correctionConflict = item => list(item?.reviewReasons).some(reason => /身份.{0,12}(?:冲突|不一致)|作者.{0,32}(?:不一致|不符)|发布者.{0,40}不一致|多个不同作者|不同.*(?:sec_uid|UID)/i.test(reason));
// UI hint only: the server rechecks the frozen entry and current bindings.
export const canCorrectRosterAccountId = item => canSupplementRosterEntry(item) && item.platform === 'douyin'
  && Array.isArray(item.accountIds) && item.accountIds.length === 1 && Boolean(item.accountIds[0])
  && !list(item.profileLinks).length && !list(item.locators).length && !String(item.key || '').startsWith('target:')
  && !supplementBlocked(item) && item.supplement?.status !== 'linked' && item.identityCorrection?.status !== 'verified' && !correctionConflict(item);
function correctionInputError(message, field = 'correctedAccountId') { return Object.assign(new Error(message), { field }); }
function correctionFields(entry, value, evidence) {
  if (!canCorrectRosterAccountId(entry)) throw correctionInputError('此条目不能更正账号 ID；已绑定、暂停或冲突的资料请先人工核对。');
  const correctedAccountId = submittedIdentity(value);
  if (/[\u0000-\u001f\u007f-\u009f]/.test(value) || !validCorrectedId(correctedAccountId)) throw correctionInputError('请填写正确的抖音号（1–100 位字母、数字、点、横线或下划线），不要填写昵称、UID 或主页链接。');
  if (correctedAccountId === submittedIdentity(entry.accountIds[0])) throw correctionInputError('新账号 ID 与原账号相同；若只补作品证据，请关闭更正模式。');
  let url; try { url = new URL(evidence); } catch { /* The check below handles malformed links. */ }
  if (!url || url.protocol !== 'https:' || url.username || url.password || url.port || !safeRosterLink(evidence)
    || !(url.hostname === 'v.douyin.com' && /^\/[A-Za-z0-9_-]+\/?$/.test(url.pathname)
      || ['douyin.com', 'www.douyin.com'].includes(url.hostname) && /^\/(?:video|note)\/\d{15,25}\/?$/.test(url.pathname))) {
    throw correctionInputError('更正账号 ID 还需填写该作者的一条官方公开作品或分享链接；仅主页或新 ID 不能确认归属。', 'evidence');
  }
  return { correctedAccountId };
}
/** A backend capability is rechecked against the latest exact original entry,
 * never resolved through names, search ranking, or numeric ID coercion. */
export function resolveRosterSupplementEntry(snapshot, { entryKey, platform, submittedId } = {}) {
  if (typeof entryKey !== 'string' || !entryKey || typeof platform !== 'string' || !submittedIdentity(submittedId)
    || !/^[a-f\d]{64}$/.test(snapshot?.workbook?.sha256 || '') || !Array.isArray(snapshot?.items)) return null;
  const matches = snapshot.items.filter(item => item.key === entryKey);
  if (matches.length !== 1) return null;
  const item = matches[0];
  return item.platform === platform && canSupplementRosterEntry(item) && !supplementBlocked(item)
    && Array.isArray(item.accountIds) && item.accountIds.some(value => submittedIdentity(value) === submittedIdentity(submittedId)) ? item : null;
}
const liveBindingKinds = new Set(['strict-public-account-proof', 'completed-job-canonical-target']);
const validLiveBinding = item => item?.liveSourceBinding && liveBindingKinds.has(item.liveSourceBinding.kind)
  && Number.isSafeInteger(item.liveSourceBinding.targetId) && item.liveSourceBinding.targetId > 0
  && item.liveSourceBinding.targetId === item.targetId && jobIdValid(item.liveSourceBinding.jobId);

/** Mutations only use the authenticated API bridge; viewing a roster never submits it. */
export function createRosterSupplementWorkflow({ api, canEdit = () => false, randomUUID = () => globalThis.crypto.randomUUID() } = {}) {
  if (typeof api !== 'function' || typeof canEdit !== 'function') throw new TypeError('补充资料需要有效的会话连接');
  let context = null, evidence = '', correctionMode = false, correctedAccountId = '', preview = null, job = null, busy = null, revision = 0;
  const attempts = new Map();
  const editable = () => canEdit() === true;
  const requireEditable = () => { if (!editable()) throw new Error('你当前为只读成员，补充资料需要编辑权限。'); };
  const fields = () => ({ workbookSha256: context.workbookSha256, entryKey: context.entry.key, evidence: evidence.trim(),
    ...(correctionMode ? correctionFields(context.entry, correctedAccountId, evidence.trim()) : {}) });
  return {
    get state() { return { context, evidence, correctionMode, correctedAccountId, preview, job, busy, canEdit: editable(), canSubmit: editable() && !busy && !job && preview?.review.canSubmit === true }; },
    open(snapshot, entry) {
      if (busy === 'submit') throw new Error('补充任务正在提交，请等待回执。');
      if (!canSupplementRosterEntry(entry) || !/^[a-f\d]{64}$/.test(snapshot?.workbook?.sha256 || '')) throw new Error('只有待核对的原总表资料可以在此补充身份；最新来源条目请查看来源核对进度。');
      ++revision; context = { workbookSha256: snapshot.workbook.sha256, entry }; evidence = ''; correctionMode = false; correctedAccountId = ''; preview = null; job = null; busy = null;
    },
    edit(value) {
      if (!context || busy === 'submit') return false;
      ++revision; evidence = String(value); preview = null; job = null; busy = null; return true;
    },
    setCorrectionMode(enabled) {
      if (!context || busy === 'submit' || !editable() || enabled === true && !canCorrectRosterAccountId(context.entry)) return false;
      ++revision; correctionMode = enabled === true; preview = null; job = null; busy = null; return true;
    },
    editCorrectedAccountId(value) {
      if (!context || busy === 'submit' || !editable() || !correctionMode) return false;
      ++revision; correctedAccountId = String(value); preview = null; job = null; busy = null; return true;
    },
    close() { ++revision; preview = null; if (busy !== 'submit') busy = null; },
    async preview() {
      requireEditable();
      if (!context || busy) return null;
      const payload = fields();
      if (!payload.evidence || payload.evidence.length > 1000 || /[\r\n]/.test(payload.evidence)) throw new Error('请只填写一个账号 ID、官方主页链接或作品分享链接（最多 1000 字）。');
      if (job || supplementBlocked(context.entry)) throw new Error('此资料已有待核对或冲突的任务，请先查看任务结果。');
      const current = ++revision; busy = 'preview'; preview = null;
      try {
        const result = await api('/api/master-roster/supplement/preview', { method: 'POST', body: JSON.stringify(payload) });
        if (current !== revision || !editable()) return null;
        if (!/^[a-f\d]{64}$/.test(result?.previewSha256 || '') || result?.entry?.key !== payload.entryKey || result.entry.platform !== context.entry.platform
          || typeof result.evidence !== 'string' || !result.evidence || typeof result.review?.status !== 'string' || typeof result.review?.reason !== 'string' || typeof result.review?.canSubmit !== 'boolean') throw new Error('预览回执不完整或与原资料不一致，请重新预览。');
        if (payload.correctedAccountId
          ? result.requiresCorrectionConfirmation !== true || result.correction?.originalAccountId !== context.entry.accountIds[0]
            || result.correction?.correctedAccountId !== payload.correctedAccountId
          : result.correction != null || result.requiresCorrectionConfirmation === true) throw new Error('账号更正预览与本次输入不一致，未允许提交；请读取最新名册后重新预览。');
        preview = { ...result, payload }; return preview;
      } finally { if (current === revision) busy = null; }
    },
    async submit() {
      requireEditable();
      if (!context || busy) return null;
      if (!preview?.review.canSubmit || job) throw new Error('请先预览并通过资料检查，再确认提交。');
      const approved = preview, payload = { ...approved.payload, previewSha256: approved.previewSha256,
        ...(approved.payload.correctedAccountId ? { correctionConfirmed: true } : {}) };
      const identity = JSON.stringify(payload);
      if (!attempts.has(identity)) {
        const key = randomUUID(); if (!jobIdValid(key)) throw new Error('无法生成安全的任务编号，请刷新页面后重试。');
        attempts.set(identity, key);
      }
      const current = ++revision; busy = 'submit';
      try {
        const result = await api('/api/master-roster/supplement', { method: 'POST', headers: { 'Idempotency-Key': attempts.get(identity) }, body: JSON.stringify(payload) });
        if (!editable()) return null;
        if (!jobIdValid(result?.job?.id) || !Object.hasOwn(supplementJobStates, result.job.status)) throw new Error('提交回执不完整，结果尚未确认。请查看最近任务或重试原请求。');
        // Closing the dialog must not discard a durable accepted receipt.
        // The modal operation guard still prevents repainting a closed draft.
        if (current !== revision) return result.job;
        job = result.job; preview = null; return job;
      } catch (error) {
        if (current === revision && [400, 403, 404, 409].includes(error?.status)) preview = null;
        throw error;
      } finally { if (current === revision) busy = null; else if (busy === 'submit') busy = null; }
    },
  };
}

export function rosterImportJobHref(jobId, currentUrl = globalThis.location?.href) {
  if (!jobIdValid(jobId)) return null;
  const url = new URL(currentUrl); url.searchParams.set('importJob', jobId); url.hash = 'import'; return url.href;
}

/** One visible, non-interacting read at a time; periodic hints are not extra polling loops. */
export function createRosterRefreshCoordinator({ read, isVisible = () => true, isBusy = () => false,
  now = Date.now, minimumIntervalMs = 60_000, schedule = setTimeout, cancel = clearTimeout } = {}) {
  if (typeof read !== 'function' || !Number.isFinite(minimumIntervalMs) || minimumIntervalMs < 1) throw new TypeError('名册刷新参数无效');
  let destroyed = false, pending = false, forced = false, active = null, timer = null, lastStartedAt = null;
  function flush() {
    if (destroyed) return Promise.resolve(false);
    if (active) { pending = false; forced = false; return active; }
    if (!pending || !isVisible() || isBusy()) return Promise.resolve(false);
    const remaining = lastStartedAt === null ? 0 : minimumIntervalMs - (now() - lastStartedAt);
    if (!forced && remaining > 0) {
      if (timer === null) timer = schedule(() => { timer = null; void flush(); }, remaining);
      return Promise.resolve(false);
    }
    if (timer !== null) { cancel(timer); timer = null; }
    pending = false; forced = false; lastStartedAt = now();
    active = Promise.resolve().then(() => destroyed ? false : read()).finally(() => { active = null; });
    return active;
  }
  return {
    request({ force = false } = {}) { if (destroyed) return Promise.resolve(false); pending = true; forced ||= force === true; return flush(); },
    flush,
    destroy() { destroyed = true; pending = false; if (timer !== null) cancel(timer); timer = null; },
  };
}

export function safeRosterLink(value) {
  if (typeof value !== 'string' || value.length > 3000) return null;
  try {
    const url = new URL(value);
    const sensitive = [...url.searchParams.keys()].some(key => /token|cookie|api[_-]?key|password|secret|authorization|session|(?:^|_)auth(?:_|$)|signature|^(?:sig|credential|a_bogus|x-bogus)$/i.test(key));
    const host = url.hostname.toLowerCase();
    if (/^(?:localhost|0\.0\.0\.0|127\.|10\.|192\.168\.|169\.254\.|172\.(?:1[6-9]|2\d|3[01])\.|\[::1\])/.test(host) || /\.(?:local|internal)$/.test(host) || host.includes(':')) return null;
    url.hash = '';
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !sensitive ? url.href : null;
  } catch { return null; }
}

export function validateMasterRoster(value) {
  const summary = value?.summary;
  if (!summary || !['total', 'registered', 'enabled', 'paused', 'pending'].every(key => count(summary[key]))
      || summary.total !== summary.registered + summary.pending
      || summary.registered !== summary.enabled + summary.paused
      || !Array.isArray(value.items) || value.items.length !== summary.total
      || typeof value.snapshotAt !== 'string' || !Number.isFinite(Date.parse(value.snapshotAt))
      || !value.workbook || typeof value.workbook.fileName !== 'string' || !/^[a-f\d]{64}$/.test(value.workbook.sha256 || '')) {
    throw new Error('名册快照格式或数量未对齐');
  }
  const keys = new Set(), actual = { enabled: 0, paused: 0, pending: 0 };
  const items = value.items.map(item => {
    if (!item || typeof item.key !== 'string' || !item.key || keys.has(item.key)
        || !Object.hasOwn(STATUS, item.monitorStatus)
        || (item.monitorStatus === 'pending' ? item.targetId !== null : !Number.isSafeInteger(item.targetId) || item.targetId <= 0)
        || typeof item.name !== 'string' || typeof item.platform !== 'string'
        || typeof item.theme?.key !== 'string' || typeof item.theme?.label !== 'string'
        || item.liveSource != null && typeof item.liveSource !== 'boolean'
        || item.readOnly != null && typeof item.readOnly !== 'boolean'
        || item.liveSource === true && (item.readOnly !== true
          || (item.monitorStatus === 'pending' ? item.liveSourceBinding != null : !validLiveBinding(item)))
        || !['accountIds','profileLinks','sourceLinks','sourceTitles','reviewReasons'].every(key => Array.isArray(item[key]) && item[key].every(value => typeof value === 'string'))
        || !Array.isArray(item.classifications) || !item.classifications.every(label => typeof label?.key === 'string' && typeof label?.label === 'string')
        || item.supplement != null && (!jobIdValid(item.supplement.jobId) || !Object.hasOwn(supplementStates, item.supplement.status)
          || typeof item.supplement.submittedAt !== 'string' || !Number.isFinite(Date.parse(item.supplement.submittedAt))
          || item.supplement.reason != null && typeof item.supplement.reason !== 'string')) {
      throw new Error('名册身份或状态字段未对齐');
    }
    keys.add(item.key); actual[item.monitorStatus]++;
    if (item.identityCorrection != null && (item.platform !== 'douyin' || item.accountIds.length !== 1
      || item.identityCorrection.originalAccountId !== item.accountIds[0] || !validCorrectedId(item.identityCorrection.correctedAccountId)
      || !['pending', 'verified'].includes(item.identityCorrection.status))) throw new Error('账号 ID 更正回执与原名册不一致');
    return { ...item, accountIds: list(item.accountIds), sourceTitles: list(item.sourceTitles), reviewReasons: list(item.reviewReasons),
      identityStatus: text(item.identityStatus), originalNames: list(item.originalNames), profileLinks: list(item.profileLinks).map(safeRosterLink).filter(Boolean),
      sourceLinks: list(item.sourceLinks).map(safeRosterLink).filter(Boolean), supplement: item.supplement ? {
        jobId: item.supplement.jobId, status: item.supplement.status, submittedAt: item.supplement.submittedAt, reason: text(item.supplement.reason),
      } : null, ...(item.identityCorrection ? { identityCorrection: { originalAccountId: item.identityCorrection.originalAccountId,
        correctedAccountId: item.identityCorrection.correctedAccountId, status: item.identityCorrection.status } } : {}) };
  });
  if (!['enabled', 'paused', 'pending'].every(key => actual[key] === summary[key])) throw new Error('名册状态数量未对齐');
  let liveSources = null;
  if (value.liveSources != null) {
    const live = value.liveSources;
    if (!['sourceJobCount', 'sourceRowCount', 'addedEntryCount', 'aliasedEntryCount'].every(key => count(live[key]))
        || live.addedEntryCount !== items.filter(item => item.liveSource === true).length
        || live.aliasedEntryCount > items.length
        || live.latestSourceAt != null && (typeof live.latestSourceAt !== 'string' || !Number.isFinite(Date.parse(live.latestSourceAt)))) throw new Error('名册最新来源数量未对齐');
    liveSources = { sourceJobCount: live.sourceJobCount, sourceRowCount: live.sourceRowCount, addedEntryCount: live.addedEntryCount,
      aliasedEntryCount: live.aliasedEntryCount, latestSourceAt: live.latestSourceAt || null };
  }
  return { snapshotAt: value.snapshotAt, workbook: { fileName: value.workbook.fileName, sha256: value.workbook.sha256 }, summary: { ...summary }, items, ...(liveSources ? { liveSources } : {}) };
}

export function rosterSummaryCaption(snapshot) {
  const s = snapshot.summary;
  return snapshot.liveSources
    ? `完整名册 ${s.total} 条 · 启用监控 ${s.enabled} · 已暂停 ${s.paused} · 待接入 / 核对 ${s.pending}`
    : `总表 ${s.total} 条 · 已建档资料 ${s.registered}（启用 ${s.enabled} / 暂停 ${s.paused}）· 待核对资料 ${s.pending}`;
}

export function filterMasterRoster(items, { query = '', status = 'all', theme = 'all', classification = 'all' } = {}) {
  const search = String(query).trim().toLocaleLowerCase();
  return items.filter(item => (status === 'all' || item.monitorStatus === status || status === 'registered' && item.targetId !== null)
    && (theme === 'all' || item.theme.key === theme)
    && (classification === 'all'
      || classification === '__roster_unclassified__' && !item.classifications.some(label => label.key && label.label)
      || classification.startsWith('label:') && item.classifications.some(label => label.key === classification.slice(6)))
    && (!search || [item.name, ...list(item.originalNames), ...item.accountIds, text(item.identityCorrection?.correctedAccountId), item.theme.label, ...item.sourceTitles,
      ...list(item.sourceLinks), ...item.classifications.map(label => label.label)]
      .some(value => value.toLocaleLowerCase().includes(search))));
}

function csvCell(value, forceText = false) {
  let result = String(value ?? '');
  if (forceText && result || /^[\s\u0000-\u001f]*[=+@-]/.test(result)) result = "'" + result;
  return '"' + result.replace(/"/g, '""') + '"';
}
export function masterRosterCsv(snapshot, items = snapshot.items) {
  const header = ['作者名称', '平台', '提交账号ID（文本）', '监控状态', '身份核对状态', '总表来源大主题（不覆盖经营归属）', '总表来源分类', '主页链接', '来源标题', '来源链接', '核对说明', '名册快照UTC', '原总表文件', '原总表SHA256', '资料层级', '原表名称 / 别名'];
  const rows = items.map(item => [item.name, item.platform, item.accountIds.join('；'), STATUS[item.monitorStatus], item.identityStatus,
    item.theme.label, item.classifications.map(label => label.label).join('；'), item.profileLinks.join('；'),
    item.sourceTitles.join('；'), item.sourceLinks.join('；'), item.reviewReasons.join('；'), item.liveSource ? '' : snapshot.snapshotAt,
    item.liveSource ? '' : snapshot.workbook.fileName, item.liveSource ? '' : snapshot.workbook.sha256,
    item.liveSource ? `最新来源资料（非原总表行，${item.monitorStatus === 'pending' ? '待接入' : `已建档 / ${STATUS[item.monitorStatus]}`}）` : '原总表资料（含最新同ID别名 / 来源）', list(item.originalNames).join('；')]);
  return '\ufeff' + [header, ...rows].map((row, index) => row.map((value, column) => csvCell(value, index > 0 && column === 2)).join(',')).join('\r\n');
}

function element(tag, className, value) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (value !== undefined) node.textContent = value;
  return node;
}
function beijingTime(value) {
  return new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(value));
}
const platforms = { douyin: '抖音', bilibili: 'B站', xiaohongshu: '小红书', kuaishou: '快手' };

export function mountRosterSupplementDialog({ host, api, canEdit, onSettled, onClose, focusFallback } = {}) {
  const workflow = createRosterSupplementWorkflow({ api, canEdit });
  const id = `roster-supplement-${++instance}`, dialog = element('dialog', 'master-roster-supplement');
  dialog.setAttribute('aria-labelledby', `${id}-title`);
  const heading = element('h2', '', '补充身份资料'); heading.id = `${id}-title`;
  const closeButton = element('button', 'master-roster-supplement-close', '关闭'); closeButton.type = 'button';
  const header = element('div', 'master-roster-supplement-heading'); header.append(heading, closeButton);
  const metadata = element('dl', 'master-roster-supplement-metadata');
  const policy = element('p', 'master-roster-policy', '仅补充一个身份线索；原名称、来源、分类和暂停状态不会被这里改写。提交后仍需核对，不等于已接入监控或已采集。');
  const label = element('label', '', '账号 ID、官方主页链接或作品分享链接'); label.htmlFor = `${id}-evidence`;
  const input = element('input'); input.id = `${id}-evidence`; input.type = 'text'; input.maxLength = 1000; input.autocomplete = 'off'; input.spellcheck = false;
  const help = element('p', 'master-roster-policy', '只填一项，不要填姓名、登录信息或整份名单。已有账号 ID 的条目可能需要公开视频来核对归属；无法核对时会说明原因。'); help.id = `${id}-help`;
  const correctionToggle = element('input'); correctionToggle.type = 'checkbox'; correctionToggle.id = `${id}-correction-mode`; correctionToggle.checked = false;
  // Keep the ordinary evidence field first, including its existing focus path.
  const correctionLabel = element('label', '', '原账号 ID 填错，我要更正'); correctionLabel.htmlFor = correctionToggle.id;
  const correctionOption = element('div', 'master-roster-correction-option'); correctionOption.append(correctionToggle, correctionLabel); correctionOption.hidden = true;
  const correctionFieldsPanel = element('div', 'master-roster-correction-fields'); correctionFieldsPanel.hidden = true;
  const correctedLabel = element('label', '', '正确的抖音号（必填）'); correctedLabel.htmlFor = `${id}-corrected-id`;
  const correctedInput = element('input'); correctedInput.type = 'text'; correctedInput.id = correctedLabel.htmlFor; correctedInput.maxLength = 100; correctedInput.autocomplete = 'off'; correctedInput.spellcheck = false;
  correctedInput.setAttribute('aria-required', 'true');
  const correctionHelp = element('p', 'master-roster-policy', '只填写你已核实的抖音号，并在上方提供该作者的一条官方公开作品或分享链接；主页、昵称或平台内部 UID 不能代替核验。原名单、来源、分类和暂停状态不变。'); correctionHelp.id = `${id}-correction-help`;
  correctedInput.setAttribute('aria-describedby', `${correctionHelp.id} ${id}-error`);
  correctionToggle.setAttribute('aria-describedby', correctionHelp.id);
  correctionFieldsPanel.append(correctedLabel, correctedInput, correctionHelp);
  const error = element('p', 'master-roster-supplement-error'); error.id = `${id}-error`; error.setAttribute('role', 'alert');
  input.setAttribute('aria-describedby', `${help.id} ${error.id}`);
  const review = element('div', 'master-roster-supplement-review'); review.hidden = true; review.tabIndex = -1;
  const status = element('p', 'master-roster-read-status'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  const previewButton = element('button', '', '预览补充资料'), submitButton = element('button', 'master-roster-supplement-confirm', '确认提交核对');
  previewButton.type = 'button'; submitButton.type = 'button'; submitButton.hidden = true;
  const actions = element('div', 'master-roster-actions'); actions.append(previewButton, submitButton);
  const taskLink = element('a', 'master-roster-link', '查看任务结果'); taskLink.hidden = true;
  dialog.append(header, metadata, policy, label, input, help, correctionOption, correctionFieldsPanel, error, review, status, actions, taskLink); host.append(dialog);
  let trigger = null, operation = 0, destroyed = false;
  function syncRole() {
    const state = workflow.state;
    input.disabled = !state.canEdit || state.busy === 'submit' || Boolean(state.job);
    correctionToggle.disabled = input.disabled || !canCorrectRosterAccountId(state.context?.entry);
    correctedInput.disabled = input.disabled || !state.correctionMode;
    correctionToggle.checked = state.correctionMode;
    correctionFieldsPanel.hidden = !state.correctionMode;
    label.textContent = state.correctionMode ? '正确账号的一条官方公开作品或分享链接（必填）' : '账号 ID、官方主页链接或作品分享链接';
    input.setAttribute('aria-required', 'true');
    previewButton.disabled = !state.canEdit || Boolean(state.busy) || Boolean(state.job);
    previewButton.textContent = state.busy === 'preview' ? '正在检查资料…' : state.correctionMode ? '预览账号 ID 更正' : '预览补充资料';
    submitButton.disabled = !state.canSubmit;
    submitButton.textContent = state.busy === 'submit' ? '正在提交…' : state.correctionMode ? '确认更正 ID 并提交核验' : '确认提交核对';
    if (!state.canEdit) {
      ++operation; workflow.close(); review.hidden = true; submitButton.hidden = true; taskLink.hidden = true;
      status.textContent = '你当前为只读成员，补充资料需要编辑权限。';
    }
  }
  function clearError() { error.textContent = ''; input.removeAttribute('aria-invalid'); correctedInput.removeAttribute('aria-invalid'); }
  function showError(cause, submitting = false) {
    const message = typeof cause?.message === 'string' ? cause.message.slice(0, 600) : '请求未完成，请重试。';
    error.textContent = `${message}${submitting && ![400, 403, 404, 409].includes(cause?.status) ? ' 提交结果未确认；先查看最近任务，若重试会复用本次任务编号，不要重复补录。' : ''}`;
    const field = cause?.field === 'correctedAccountId' ? correctedInput : input;
    field.setAttribute('aria-invalid', 'true');
    if (cause?.status === 409) error.textContent += ' 原名册或预览已变化，请关闭弹窗后读取最新名册，再重新预览。';
    field.focus?.({ preventScroll: true });
  }
  function finishClose() {
    ++operation; workflow.close();
    const restore = trigger?.isConnected ? trigger : focusFallback;
    if (restore?.isConnected) restore.focus?.({ preventScroll: true });
    trigger = null;
    onClose?.();
  }
  function close() { if (dialog.open) dialog.close(); else finishClose(); }
  function onCancel(event) { event.preventDefault(); close(); }
  function invalidateReview() {
    ++operation; clearError(); review.hidden = true; review.replaceChildren(); submitButton.hidden = true; taskLink.hidden = true;
    status.textContent = '资料已修改，请重新预览；尚未提交。'; syncRole();
  }
  function onInput() { if (workflow.edit(input.value)) invalidateReview(); }
  function onCorrectionChange() {
    if (!workflow.setCorrectionMode(correctionToggle.checked)) { syncRole(); return; }
    invalidateReview();
    if (workflow.state.correctionMode && !correctedInput.disabled) correctedInput.focus?.({ preventScroll: true });
    else if (!input.disabled) input.focus?.({ preventScroll: true });
  }
  function onCorrectedInput() { if (workflow.editCorrectedAccountId(correctedInput.value)) invalidateReview(); }
  async function onPreview() {
    if (previewButton.disabled || destroyed) return;
    clearError(); const current = ++operation;
    const pending = workflow.preview(); syncRole(); status.textContent = '正在检查身份线索，不会在预览时创建监控账号。';
    try {
      const value = await pending;
      if (destroyed || current !== operation || !dialog.open || !value) return;
      review.replaceChildren(element('strong', '', value.review.canSubmit ? '资料可提交核对（非已核验）' : '本次资料暂不能提交'), element('p', '', value.review.reason), element('small', '', `本次补充：${value.evidence}`));
      if (value.correction) review.append(element('p', '', `原账号 ID：${value.correction.originalAccountId}`),
        element('p', '', `拟更正为：${value.correction.correctedAccountId}`), element('p', 'master-roster-policy', '这是另存的身份更正申请，原名单文字与历史导入不会改写；须通过作品发布者核验才会关联。已有账号的暂停状态保持不变。'));
      review.hidden = false; submitButton.hidden = !value.review.canSubmit;
      status.textContent = value.review.canSubmit ? value.correction ? '请核对原 ID、新 ID 与作品，再点击“确认更正 ID 并提交核验”；这不是已更正或已接入通知。' : '请核对上述资料，再点击“确认提交核对”。' : '未提交；请按说明补充有效资料后重新预览。';
      review.focus?.({ preventScroll: true });
    } catch (cause) { if (!destroyed && current === operation && dialog.open) { showError(cause); status.textContent = '预览未完成，未提交资料。'; } }
    finally { if (!destroyed && current === operation) syncRole(); }
  }
  async function onSubmit() {
    if (submitButton.disabled || destroyed) return;
    clearError(); const current = ++operation, submittedContext = workflow.state.context;
    let acceptedJob = null;
    const pending = workflow.submit(); syncRole(); status.textContent = '正在提交核对任务；关闭弹窗不会取消已发出的请求。';
    try {
      const job = await pending;
      acceptedJob = job;
      if (destroyed || current !== operation || !dialog.open || !job) return;
      submitButton.hidden = true; review.hidden = true;
      status.textContent = `已收到任务回执：${supplementJobStates[job.status]}。这不是采集成功通知；只有身份核对通过后，名册才会显示已接入。`;
      taskLink.href = rosterImportJobHref(job.id); taskLink.hidden = false; taskLink.focus?.({ preventScroll: true });
    } catch (cause) { if (!destroyed && current === operation && dialog.open) { showError(cause, true); status.textContent = '尚未确认接入监控；原名册与历史数据保持不变。'; } }
    finally { if (!destroyed) { if (current === operation) syncRole(); void onSettled?.({ context: submittedContext, job: acceptedJob }); } }
  }
  closeButton.addEventListener('click', close); input.addEventListener('input', onInput);
  correctionToggle.addEventListener('change', onCorrectionChange); correctedInput.addEventListener('input', onCorrectedInput);
  previewButton.addEventListener('click', onPreview); submitButton.addEventListener('click', onSubmit);
  dialog.addEventListener('cancel', onCancel); dialog.addEventListener('close', finishClose);
  return {
    get isOpen() { return dialog.open; },
    open(snapshot, entry, opener) {
      if (destroyed) return;
      workflow.open(snapshot, entry); ++operation; trigger = opener;
      metadata.replaceChildren();
      for (const [title, value] of [['原作者', entry.name || '名称未提供'], ['平台 / 原账号 ID', `${platforms[entry.platform] || entry.platform} · ${entry.accountIds.join('；') || '未提供'}`], ['来源主题 / 分类', `${entry.theme.label || '待归属'} / ${entry.classifications.map(item => item.label).join('；') || '未细分'}`], ['原资料来源', entry.sourceTitles.join('；') || '未提供来源标题'], ['原核对说明', entry.reviewReasons.join('；') || entry.identityStatus || '身份尚未确认']]) metadata.append(element('dt', '', title), element('dd', '', value));
      input.value = ''; correctedInput.value = ''; correctionToggle.checked = false; correctionOption.hidden = !canCorrectRosterAccountId(entry);
      clearError(); review.hidden = true; review.replaceChildren(); submitButton.hidden = true; taskLink.hidden = true;
      status.textContent = '先预览，再确认提交；不会自动提交你填写的内容。';
      syncRole(); dialog.showModal(); if (!input.disabled) input.focus(); else closeButton.focus();
    },
    syncRole,
    destroy() { destroyed = true; ++operation; workflow.close(); dialog.removeEventListener('close', finishClose); dialog.removeEventListener('cancel', onCancel); dialog.remove(); },
  };
}

/** The roster remains separate from insights.accounts; supplements require explicit preview and confirmation. */
export function mountMasterRoster({ host, endpoint = '/api/master-roster', fetcher = globalThis.fetch, onOpenAccount, api, canEdit = () => false, isVisible = () => true, pageSize = 20 } = {}) {
  if (!host?.append || typeof fetcher !== 'function' || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100) throw new TypeError('名册挂载参数无效');
  const id = `master-roster-${++instance}`;
  const root = element('section', 'master-roster');
  root.setAttribute('aria-label', '总表名册（独立于经营统计）');
  root.innerHTML = `<details class="master-roster-disclosure"><summary><span class="master-roster-title">总表名册</span><span class="master-roster-counts">尚未读取</span><span class="master-roster-expand">展开名单</span></summary><div class="master-roster-body"><div class="master-roster-toolbar"><label for="${id}-search">搜索名字、账号或来源<input id="${id}-search" type="search" autocomplete="off" placeholder="搜索名字、账号或来源"></label><label for="${id}-status">监控状态<select id="${id}-status"><option value="all">全部名单</option><option value="registered">已建号（含暂停）</option><option value="enabled">启用监控</option><option value="paused">已暂停</option><option value="pending">待核对</option></select></label><label for="${id}-theme">大主题<select id="${id}-theme"><option value="all">全部主题</option></select></label><label for="${id}-classification">内容分类（标签可重叠）<select id="${id}-classification"><option value="all">全部分类</option></select></label><div class="master-roster-actions"><button type="button" data-roster-action="reload">读取最新名册</button><button type="button" data-roster-action="export" disabled>导出筛选名单</button></div></div><p class="master-roster-filter-count" tabindex="-1"></p><div class="master-roster-table-scroll" tabindex="0" role="region" aria-label="来源名册，包含待核对账号"><table><thead><tr><th scope="col">作者与账号</th><th scope="col">监控与身份状态</th><th scope="col">大主题与分类</th><th scope="col">来源与核对说明</th></tr></thead><tbody></tbody></table></div><div class="master-roster-pagination"><span></span><div><button type="button" data-roster-page="prev" disabled>上一页</button><button type="button" data-roster-page="next" disabled>下一页</button></div></div></div></details><p class="master-roster-policy">来源名单不等于已核验账号；待核对不纳入粉丝、获赞、作品等经营统计，暂停状态保持不变。</p><p class="master-roster-read-status" role="status" aria-live="polite">正在读取名册…</p>`;
  root.querySelector(`label[for="${id}-theme"]`).firstChild.textContent = '总表来源大主题';
  root.querySelector(`label[for="${id}-classification"]`).firstChild.textContent = '总表来源内容分类（标签可重叠）';
  root.querySelector('thead th:nth-child(3)').textContent = '总表来源主题与分类';
  root.querySelector('option[value="registered"]').textContent = '已建档资料（含暂停）';
  root.querySelector('.master-roster-policy').textContent = '来源名单不等于已核验账号；总表来源分类是可重叠标签，不覆盖当前经营归属。待核对不纳入经营统计，现有暂停状态保持不变。';
  root.querySelector('[data-roster-action="export"]').textContent = '导出归档名单';
  const archiveNotice = element('p', 'master-roster-policy', '归档导出用于查阅与留存，不是导入模板，不可直接回导。原总表待核对条目可补充身份资料；最新来源条目只展示来源核对进度，不会自动进入经营统计。');
  root.querySelector('.master-roster-body').append(archiveNotice);
  host.append(root);
  const find = selector => root.querySelector(selector);
  const search = find('input'), status = find(`#${id}-status`), theme = find(`#${id}-theme`), classification = find(`#${id}-classification`), disclosure = find('details');
  status.setAttribute('aria-label', '监控状态');
  theme.setAttribute('aria-label', '总表来源大主题');
  classification.setAttribute('aria-label', '总表来源内容分类');
  const body = find('tbody'), resultCount = find('.master-roster-filter-count'), readStatus = find('.master-roster-read-status');
  const previous = find('[data-roster-page="prev"]'), next = find('[data-roster-page="next"]'), exportButton = find('[data-roster-action="export"]');
  const reloadButton = find('[data-roster-action="reload"]');
  const state = { snapshot: null, snapshotSignature: '', pendingSnapshot: null, query: '', status: 'all', theme: 'all', classification: 'all', page: 1, request: 0, destroyed: false, controller: null };
  const submittedReceipts = new Map();
  let settledReadRequested = false, openRequest = 0;
  const supplement = typeof api === 'function' ? mountRosterSupplementDialog({ host: root, api, canEdit, onSettled: onSupplementSettled, onClose: () => queueMicrotask(flushRefresh), focusFallback: resultCount }) : null;
  const isInteracting = () => supplement?.isOpen === true || Boolean(root.contains(document.activeElement) && document.activeElement !== reloadButton);
  // A confirmed submission needs readback even while focus stays in its row.
  // Network eligibility is separate from the DOM-replacement/draft guard.
  const refreshCoordinator = createRosterRefreshCoordinator({ read: () => reload({ deferForInteraction: true }), isVisible,
    isBusy: () => isInteracting() && !settledReadRequested && submittedReceipts.size === 0 });
  const filtered = () => state.snapshot ? filterMasterRoster(state.snapshot.items, state) : [];
  function onSupplementSettled({ context, job } = {}) {
    if (state.destroyed) return;
    if (context?.workbookSha256 === state.snapshot?.workbook.sha256 && typeof context.entry?.key === 'string'
        && jobIdValid(job?.id) && Object.hasOwn(supplementJobStates, job.status)) {
      submittedReceipts.set(context.entry.key, { workbookSha256: context.workbookSha256, job: { id: job.id, status: job.status }, observed: null });
      patchSubmittedRows();
    }
    settledReadRequested = true;
    return requestRefresh({ force: true });
  }
  function patchSubmittedRows() {
    for (const row of body.children) {
      const receipt = submittedReceipts.get(row.dataset.rosterKey);
      if (!receipt || receipt.workbookSha256 !== state.snapshot?.workbook.sha256) continue;
      const identity = row.children[1];
      const button = [...identity.children].find(node => node.dataset?.rosterSupplement === row.dataset.rosterKey);
      if (button) {
        // Keep the same focusable node; activation now reads the durable task
        // rather than reopening an obsolete supplement form.
        button.dataset.rosterReceipt = receipt.job.id;
        button.textContent = '查看已提交任务'; button.disabled = canEdit() !== true;
        button.title = '已收到持久任务回执；查看任务不会重复补录';
      }
      let caption = identity.querySelector('.master-roster-submitted-receipt');
      if (!caption) { caption = element('small', 'master-roster-submitted-receipt'); caption.setAttribute('role', 'status'); identity.append(caption); }
      const observed = receipt.observed;
      caption.textContent = observed
        ? `最新名册回读：${STATUS[observed.monitorStatus]} · ${supplementStates[observed.supplement.status]}${observed.supplement.reason ? `；${observed.supplement.reason}` : ''}。列表筛选与汇总在离开当前操作后更新。`
        : `已收到提交回执：${supplementJobStates[receipt.job.status]}；尚未读回名册终态，不代表已建档或已采样。`;
    }
  }
  function observeSubmittedReceipts(snapshot) {
    if (!submittedReceipts.size) return;
    const items = new Map(snapshot.items.map(item => [item.key, item]));
    for (const [key, receipt] of submittedReceipts) {
      const item = items.get(key);
      if (snapshot.workbook.sha256 === receipt.workbookSha256 && item?.supplement?.jobId === receipt.job.id) receipt.observed = item;
    }
    patchSubmittedRows();
  }
  function draw() {
    const items = filtered(), pages = Math.max(1, Math.ceil(items.length / pageSize));
    state.page = Math.max(1, Math.min(state.page, pages));
    const start = (state.page - 1) * pageSize;
    body.replaceChildren();
    for (const item of items.slice(start, start + pageSize)) {
      const tr = element('tr'); tr.dataset.rosterKey = item.key;
      const account = element('td');
      const title = element('strong', 'master-roster-name', item.name || '名称未提供');
      account.append(title, element('small', '', `${platforms[item.platform] || item.platform} · ${item.accountIds.join('；') || '未提供唯一账号ID'}`));
      if (item.identityCorrection) account.append(element('small', 'master-roster-id-correction',
        `原账号 ID 保留：${item.identityCorrection.originalAccountId}；${item.identityCorrection.status === 'verified' ? '核验后的更正 ID' : '申请更正为（尚待核验）'}：${item.identityCorrection.correctedAccountId}。监控启停与采样状态另查。`));
      const aliases = item.originalNames.filter(name => name !== item.name);
      if (aliases.length) account.append(element('small', '', `原表名称：${aliases.join('；')}`));
      if (item.targetId !== null && typeof onOpenAccount === 'function') {
        const button = element('button', 'master-roster-account-action', '查看经营详情');
        button.type = 'button'; button.dataset.rosterTarget = String(item.targetId); account.append(button);
      }
      for (const [index, url] of item.profileLinks.entries()) {
        const link = element('a', 'master-roster-link', item.profileLinks.length > 1 ? `主页 ${index + 1}` : '主页');
        link.href = url; link.target = '_blank'; link.rel = 'noopener noreferrer'; account.append(link);
      }
      const identity = element('td'); identity.append(element('span', `master-roster-badge master-roster-${item.monitorStatus}`, STATUS[item.monitorStatus]), element('small', '', item.identityStatus || (item.targetId === null ? '身份与归属尚未核对' : '已建号；以经营账号页状态为准')));
      if (item.liveSource === true && item.monitorStatus !== 'pending') {
        identity.append(element('small', 'master-roster-live-linked', '最新来源已建档 · 采样状态另查'));
        identity.append(element('small', '', '来源已关联现有账号；保留真实启停状态，不表示刚完成数据采集。'));
      }
      if (item.monitorStatus === 'pending') {
        identity.append(element('small', 'master-roster-unverified', '不计入经营统计'));
        if (item.liveSource === true) {
          identity.append(element('small', 'master-roster-live-source', '最新来源已读取 · 待接入监控'));
          identity.append(element('small', '', '保留原来源，不使用旧总表的补充入口；身份尚未确认不是账号已丢失。'));
        }
        if (supplement && canSupplementRosterEntry(item)) {
          const button = element('button', 'master-roster-account-action', '补充身份资料'); button.type = 'button'; button.dataset.rosterSupplement = item.key;
          button.disabled = canEdit() !== true || supplementBlocked(item);
          button.title = canEdit() !== true ? '只读成员不能补充资料' : button.disabled ? '已有待核对或冲突的任务，请先查看结果' : '保留原来源与分类，先预览后确认';
          identity.append(button);
        }
      }
      if (item.supplement) {
        identity.append(element('small', '', supplementStates[item.supplement.status]));
        if (item.supplement.reason) identity.append(element('small', '', item.supplement.reason));
        if (canEdit() === true) {
          const link = element('a', 'master-roster-link', '查看补充任务'); link.href = rosterImportJobHref(item.supplement.jobId); identity.append(link);
        }
      }
      const labels = element('td'); labels.append(element('strong', '', item.theme.label || '待归属'), element('small', '', item.classifications.map(label => label.label).join('；') || '未细分'));
      const source = element('td');
      source.append(element('span', '', item.sourceTitles.join('；') || '来源标题未提供'));
      if (item.sourceLinks.length) {
        const links = element('details', 'master-roster-sources'); links.append(element('summary', '', item.sourceLinks.length > 3 ? `来源链接（显示前 3 / ${item.sourceLinks.length} 个）` : `查看 ${item.sourceLinks.length} 个来源链接`));
        for (const [index, url] of item.sourceLinks.slice(0, 3).entries()) {
          const link = element('a', 'master-roster-link', `来源 ${index + 1}`); link.href = url; link.target = '_blank'; link.rel = 'noopener noreferrer'; links.append(link);
        }
        source.append(links);
      }
      if (item.reviewReasons.length) source.append(element('small', 'master-roster-reasons', item.reviewReasons.join('；')));
      else if (item.monitorStatus === 'pending') source.append(element('small', '', '尚未核对，不表示已完成采集；以来源和身份审查结果为准。'));
      tr.append(account, identity, labels, source); body.append(tr);
    }
    if (!items.length) {
      const tr = element('tr'), td = element('td', 'master-roster-empty', state.snapshot ? '没有符合条件的名单。调整搜索、监控状态、大主题或内容分类即可继续查看。' : '尚未取得有效名册。');
      td.colSpan = 4; tr.append(td); body.append(tr);
    }
    resultCount.textContent = state.snapshot ? `筛选结果 ${items.length} / ${state.snapshot.liveSources ? '完整名册' : '总表'} ${state.snapshot.summary.total} 条；与下方经营账号表独立。` : '尚未取得有效名册';
    find('.master-roster-pagination > span').textContent = `${items.length ? start + 1 : 0}–${Math.min(start + pageSize, items.length)} / ${items.length} 条 · 第 ${state.page} / ${pages} 页`;
    previous.disabled = state.page <= 1; next.disabled = state.page >= pages; exportButton.disabled = !state.snapshot || !items.length;
    patchSubmittedRows();
  }
  function populateThemes() {
    const selected = state.theme;
    theme.replaceChildren(new Option('全部主题', 'all'));
    const themes = new Map(state.snapshot.items.map(item => [item.theme.key, item.theme.label]));
    for (const [key, label] of themes) theme.append(new Option(label || '待归属', key));
    if (selected !== 'all' && !themes.has(selected)) theme.append(new Option(`此快照无该主题：${selected}`, selected));
    theme.value = selected;
  }
  function populateClassifications() {
    const selected = state.classification;
    const counts = new Map(); let unclassified = 0;
    for (const item of state.snapshot.items) {
      const labels = item.classifications.filter(tag => tag.key && tag.label);
      if (!labels.length) unclassified++;
      for (const key of new Set(labels.map(tag => tag.key))) {
        const current = counts.get(key);
        counts.set(key, { label: current?.label || labels.find(tag => tag.key === key).label, count: (current?.count || 0) + 1 });
      }
    }
    classification.replaceChildren(new Option('全部分类', 'all'));
    if (unclassified) classification.append(new Option(`未细分 / 待分类（${unclassified}）`, '__roster_unclassified__'));
    for (const [key, value] of counts) classification.append(new Option(`${value.label}（${value.count}）`, `label:${key}`));
    if (selected !== 'all' && ![...classification.options].some(option => option.value === selected)) {
      const missing = selected === '__roster_unclassified__' ? '未细分 / 待分类' : selected.startsWith('label:') ? selected.slice(6) : selected;
      classification.append(new Option(`此快照无该分类：${missing}`, selected));
    }
    classification.value = selected;
  }
  function applySnapshot(snapshot, checkedAt) {
    const signature = JSON.stringify(snapshot), changed = signature !== state.snapshotSignature;
    state.pendingSnapshot = null;
    if (changed) {
      state.snapshot = snapshot; state.snapshotSignature = signature;
      const itemsByKey = new Map(snapshot.items.map(item => [item.key, item]));
      for (const [key, receipt] of submittedReceipts) {
        const item = itemsByKey.get(key);
        if (snapshot.workbook.sha256 !== receipt.workbookSha256 || !item || item.monitorStatus !== 'pending'
            || item.supplement?.jobId === receipt.job.id && !['queued', 'running', 'awaiting-verification'].includes(item.supplement.status)) submittedReceipts.delete(key);
      }
      find('.master-roster-counts').textContent = rosterSummaryCaption(snapshot);
      find('.master-roster-title').textContent = snapshot.liveSources ? '完整来源名册' : '总表名册';
      populateThemes(); populateClassifications(); draw();
      if (typeof CustomEvent === 'function' && typeof document.dispatchEvent === 'function') {
        document.dispatchEvent(new CustomEvent('mcn:master-roster-loaded', { detail: { items: snapshot.items.map(item => ({
          targetId: item.targetId, name: item.name, originalNames: [...item.originalNames], accountIds: [...item.accountIds],
        })) } }));
      }
    }
    readStatus.textContent = `名册快照 ${beijingTime(snapshot.snapshotAt)}（北京时间）· ${snapshot.workbook.fileName}；状态检查 ${beijingTime(checkedAt)}，读取不触发平台采集。`;
    if (snapshot.liveSources) {
      const live = snapshot.liveSources;
      readStatus.textContent += ` 最新来源${live.latestSourceAt ? `采样 ${beijingTime(live.latestSourceAt)}（北京时间）` : '采样时间未提供'}，读取 ${live.sourceRowCount} 行来源记录，补入 ${live.addedEntryCount} 条资料、补充 ${live.aliasedEntryCount} 条原表别名 / 来源；原总表归档保持不变，来源行数不等于作者人数。`;
    }
    return changed;
  }
  function flushRefresh() {
    if (state.destroyed) return Promise.resolve(false);
    if (state.pendingSnapshot && isVisible() && !isInteracting()) applySnapshot(state.pendingSnapshot.snapshot, state.pendingSnapshot.checkedAt);
    return refreshCoordinator.flush();
  }
  function requestRefresh(options = {}) {
    if (state.destroyed) return Promise.resolve(false);
    if (state.pendingSnapshot && isVisible() && !isInteracting()) applySnapshot(state.pendingSnapshot.snapshot, state.pendingSnapshot.checkedAt);
    if (isInteracting()) readStatus.textContent = '自动状态检查已暂缓，保留正在操作的名册与补充草稿；离开当前操作后继续，不会重复提交资料。';
    return refreshCoordinator.request(options);
  }
  async function reload({ deferForInteraction = false } = {}) {
    if (state.destroyed) return false;
    settledReadRequested = false;
    const request = ++state.request; state.controller?.abort(); const controller = new AbortController(); state.controller = controller;
    const timer = setTimeout(() => controller.abort(), 10000);
    readStatus.textContent = state.snapshot ? '正在读取最新名册；当前保留上次成功快照。' : '正在读取名册…';
    root.setAttribute('aria-busy', 'true');
    try {
      const response = await fetcher(endpoint, { method: 'GET', headers: { Accept: 'application/json' }, credentials: 'same-origin', signal: controller.signal });
      if (!response.ok) throw new Error(`名册读取失败（HTTP ${response.status}）`);
      const snapshot = validateMasterRoster(await response.json());
      if (state.destroyed || request !== state.request) return false;
      const checkedAt = new Date();
      observeSubmittedReceipts(snapshot);
      if (deferForInteraction && (!isVisible() || isInteracting())) {
        state.pendingSnapshot = { snapshot, checkedAt };
        readStatus.textContent = '已读到名册状态，保留正在操作的内容；提交回执就地更新，列表筛选与汇总在离开当前操作后更新。';
      } else applySnapshot(snapshot, checkedAt);
      return true;
    } catch (error) {
      if (state.destroyed || request !== state.request) return false;
      const message = error?.message || '';
      const label = controller.signal.aborted ? '名册读取超时'
        : ['名册快照格式或数量未对齐', '名册身份或状态字段未对齐', '名册状态数量未对齐', '名册最新来源数量未对齐'].includes(message) ? message
          : message === '名册读取失败（HTTP 404）' ? '总表名册尚未导入'
            : /^名册读取失败（HTTP \d+）$/.test(message) ? message : '名册读取失败';
      readStatus.textContent = `${label}。${state.snapshot ? `保留 ${beijingTime(state.snapshot.snapshotAt)} 的已读快照。` : '未取得名单，不以 0 代替。'}请点击“读取最新名册”重试。`;
      if (!state.snapshot) draw(); return false;
    } finally { clearTimeout(timer); if (!state.destroyed && request === state.request) root.removeAttribute('aria-busy'); }
  }
  function onChange(event) {
    if (event.target === search) { if (state.query === search.value) return; state.query = search.value; }
    else if (event.target === status) { if (state.status === status.value) return; state.status = status.value; }
    else if (event.target === theme) { if (state.theme === theme.value) return; state.theme = theme.value; }
    else if (event.target === classification) { if (state.classification === classification.value) return; state.classification = classification.value; }
    else return;
    ++openRequest; state.page = 1; draw();
  }
  function onClick(event) {
    const button = event.target.closest('button'); if (!button || !root.contains(button)) return;
    ++openRequest;
    if (button.dataset.rosterAction === 'reload') { void requestRefresh({ force: true }); return; }
    if (button.dataset.rosterReceipt) {
      if (!button.disabled && canEdit() === true) {
        const href = rosterImportJobHref(button.dataset.rosterReceipt);
        if (href) globalThis.location.href = href;
      }
      return;
    }
    if (button.dataset.rosterSupplement && supplement && !button.disabled && canEdit() === true) {
      const item = state.snapshot?.items.find(value => value.key === button.dataset.rosterSupplement && canSupplementRosterEntry(value));
      if (item) {
        try { supplement.open(state.snapshot, item, button); }
        catch (error) { readStatus.textContent = error.message || '补充资料暂不能打开，请稍后重试。'; }
      }
      return;
    }
    if (button.dataset.rosterAction === 'export' && state.snapshot) {
      const url = URL.createObjectURL(new Blob([masterRosterCsv(state.snapshot, filtered())], { type: 'text/csv;charset=utf-8' }));
      const anchor = element('a'); anchor.href = url; anchor.download = '总表名册_筛选结果.csv'; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 0); return;
    }
    if (button.dataset.rosterTarget && typeof onOpenAccount === 'function') {
      const id = Number(button.dataset.rosterTarget), item = state.snapshot?.items.find(value => value.targetId === id && value.monitorStatus !== 'pending');
      if (item) onOpenAccount(id, { trigger: button }); return;
    }
    if (button.dataset.rosterPage && !button.disabled) {
      const ownedFocus = document.activeElement === button;
      state.page += button.dataset.rosterPage === 'next' ? 1 : -1; draw();
      if (ownedFocus && button.disabled && [button, document.body].includes(document.activeElement)) {
        const reverse = button === next ? previous : next;
        if (!reverse.disabled) reverse.focus({ preventScroll: true });
      }
    }
  }
  function onToggle() { find('.master-roster-expand').textContent = disclosure.open ? '收起名单' : '展开名单'; }
  async function openSearch({ query = '', theme: themeKey = 'all', entryKey, platform, submittedId } = {}) {
    const requested = ++openRequest, wantsSupplement = entryKey !== undefined;
    if (state.destroyed) return false;
    if (supplement?.isOpen) { readStatus.textContent = '请先完成或关闭正在编辑的补充资料；当前草稿已保留。'; return false; }
    const mayOpen = () => !state.destroyed && requested === openRequest && !supplement?.isOpen
      && (!wantsSupplement || supplement && canEdit() === true && isVisible());
    if (!mayOpen()) return false;
    await ready;
    if (!mayOpen()) return false;
    if (wantsSupplement) {
      // A visible explicit action gets a fresh read, not a cached eligibility
      // decision. A draft opened while it is pending must remain untouched.
      if (!await reload({ deferForInteraction: true }) || !mayOpen()) return false;
      const snapshot = state.pendingSnapshot?.snapshot || state.snapshot;
      const item = resolveRosterSupplementEntry(snapshot, { entryKey, platform, submittedId });
      if (!item || submittedReceipts.has(entryKey)) {
        readStatus.textContent = '此原资料已变化、已有任务或不能唯一核对，未打开补充表单。请读取当前名册并查看任务结果；不会按名字选择其他资料。';
        return false;
      }
      if (state.pendingSnapshot) applySnapshot(snapshot, state.pendingSnapshot.checkedAt);
      disclosure.open = true; onToggle();
      try { supplement.open(snapshot, item, resultCount); return true; }
      catch { readStatus.textContent = '补充资料暂不能打开，请读取当前名册后重试。'; return false; }
    }
    state.query = typeof query === 'string' ? query : '';
    state.theme = typeof themeKey === 'string' && themeKey ? themeKey : 'all';
    state.status = 'all'; state.classification = 'all'; state.page = 1;
    search.value = state.query; status.value = 'all'; classification.value = 'all';
    if (state.snapshot) populateThemes();
    disclosure.open = true; onToggle(); draw();
    root.scrollIntoView?.({ block: 'start', behavior: 'instant' }); search.focus?.({ preventScroll: true });
    return true;
  }
  async function activate({ focusSearch = false } = {}) {
    if (state.destroyed) return false;
    await ready;
    if (state.destroyed) return false;
    disclosure.open = true; onToggle();
    if (focusSearch) search.focus?.({ preventScroll: true });
    return true;
  }
  function onFocusOut() { queueMicrotask(flushRefresh); }
  root.addEventListener('input', onChange); root.addEventListener('change', onChange); root.addEventListener('click', onClick); disclosure.addEventListener('toggle', onToggle);
  root.addEventListener('focusout', onFocusOut);
  const ready = refreshCoordinator.request({ force: true });
  return { ready, reload, requestRefresh, openSearch, activate, syncRole() { if (canEdit() !== true) ++openRequest; draw(); supplement?.syncRole(); }, destroy() { state.destroyed = true; ++openRequest; ++state.request; refreshCoordinator.destroy(); state.controller?.abort(); supplement?.destroy(); root.removeEventListener('input', onChange); root.removeEventListener('change', onChange); root.removeEventListener('click', onClick); root.removeEventListener('focusout', onFocusOut); disclosure.removeEventListener('toggle', onToggle); root.remove(); } };
}
