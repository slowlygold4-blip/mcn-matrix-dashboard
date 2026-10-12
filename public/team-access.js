import { preferredShareOrigin, shareEntryHint, isPrivateHostname } from './access-sharing.js?v=20261004-share-policy-1';

const ROLE_LABELS = Object.freeze({ admin: '管理员', editor: '编辑者', viewer: '查看者' });
const CODE_RE = /^[a-f0-9]{4}(?:-[a-f0-9]{4}){7}$/i;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

function validId(value) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 1) throw new Error('成员或邀请码编号无效');
  return id;
}

function checkedAccess(value) {
  if (!value || !Array.isArray(value.members) || !Array.isArray(value.invites)) throw new Error('服务器返回的成员清单格式无效');
  return value;
}

function inviteState(invite, now) {
  if (invite.revoked) return 'revoked';
  const expiresAt = Date.parse(invite.expiresAt || '');
  if (invite.expired || Number.isFinite(expiresAt) && expiresAt <= now) return 'expired';
  const maxUses = Number(invite.maxUses), useCount = Number(invite.useCount);
  if (!Number.isFinite(expiresAt) || !Number.isSafeInteger(maxUses) || maxUses < 1 || !Number.isSafeInteger(useCount) || useCount < 0) return 'unknown';
  if (useCount >= maxUses) return 'exhausted';
  return 'active';
}

export function countUsableInvites(invites, now = Date.now()) {
  return Array.isArray(invites) ? invites.reduce((count, invite) => count + Number(inviteState(invite, now) === 'active'), 0) : 0;
}

export function resolveTeamShareOrigin({ access, currentOrigin, now = Date.now() } = {}) {
  const origin = preferredShareOrigin({
    currentOrigin,
    publicBaseUrl: access?.publicBaseUrl,
    publicEntry: access?.publicEntry,
    lanUrls: access?.lanUrls,
    now,
  });
  if (!origin) return { origin: null, kind: 'missing', hint: shareEntryHint({ origin: null, publicEntry: access?.publicEntry }) };
  let url;
  try { url = new URL(origin); } catch { return { origin: null, kind: 'missing', hint: '没有可验证的分享地址；请先配置 HTTPS 公网入口。' }; }
  if (LOCAL_HOSTS.has(url.hostname.toLowerCase())) {
    return { origin: null, kind: 'loopback', hint: '当前只有本机地址，发给他人无法打开；请配置 HTTPS 公网入口，或确认局域网地址已提供。' };
  }
  const privateHost = isPrivateHostname(url.hostname);
  if (!privateHost && url.protocol !== 'https:') {
    return { origin: null, kind: 'insecure', hint: '公网分享仅接受 HTTPS 地址；当前没有安全可分享入口。' };
  }
  const kind = privateHost ? 'lan' : 'https';
  return { origin: url.origin, kind, hint: shareEntryHint({ origin: url.origin, publicEntry: access?.publicEntry }) };
}

export function buildTeamInviteLink(origin, code) {
  if (!CODE_RE.test(String(code || ''))) throw new Error('服务器返回的邀请码格式无效');
  const base = new URL(origin);
  if (!['https:', 'http:'].includes(base.protocol) || base.username || base.password || base.search) throw new Error('邀请地址无效');
  base.pathname = '/';
  base.hash = `invite=${encodeURIComponent(String(code).toUpperCase())}`;
  return base.href;
}

export function renderTeamMembers(members) {
  if (!Array.isArray(members) || members.length === 0) return '<p class="team-access-empty">暂无成员。</p>';
  return `<ul class="team-access-list">${members.map(member => {
    const id = Number(member.id), valid = Number.isSafeInteger(id) && id > 0;
    const role = ['viewer', 'editor'].includes(member.role) ? member.role : 'viewer';
    const owner = member.authSource === 'local-owner' || !valid;
    const name = escapeHtml(member.displayName || '未命名成员');
    const enabled = Boolean(member.enabled);
    const sessions = Number.isFinite(Number(member.activeSessionCount)) ? Math.max(0, Number(member.activeSessionCount)) : 0;
    return `<li class="team-access-row"><div class="team-access-row-title"><strong>${name}</strong><span class="team-access-state ${enabled ? 'is-active' : 'is-disabled'}">${enabled ? '可用' : '已停用'}</span></div><p class="team-access-meta">${owner ? '本机管理员不可修改' : `最近活跃会话 ${sessions} 个 · ${escapeHtml(ROLE_LABELS[member.role] || '未知权限')}`}</p>${owner ? '' : `<div class="team-access-actions"><label>权限<select data-member-role="${id}" aria-label="${name}的权限"><option value="viewer"${role === 'viewer' ? ' selected' : ''}>查看者</option><option value="editor"${role === 'editor' ? ' selected' : ''}>编辑者</option></select></label><button class="secondary-btn" type="button" data-member-save="${id}">保存权限</button><button class="secondary-btn" type="button" data-member-toggle="${id}" data-enabled="${enabled ? 'true' : 'false'}">${enabled ? '停用成员' : '恢复成员'}</button></div>`}</li>`;
  }).join('')}</ul>`;
}

export function renderTeamInvites(invites, now = Date.now()) {
  if (!Array.isArray(invites) || invites.length === 0) return '<p class="team-access-empty">暂无邀请码。</p>';
  return `<ul class="team-access-list">${invites.map(invite => {
    const id = Number(invite.id), valid = Number.isSafeInteger(id) && id > 0;
    const stateKey = inviteState(invite, now);
    const revoked = stateKey === 'revoked';
    const state = ({ active: '有效', expired: '已过期', revoked: '已撤销', exhausted: '次数已用完', unknown: '状态需核对' })[stateKey];
    const role = escapeHtml(ROLE_LABELS[invite.role] || '未知权限');
    const label = escapeHtml(invite.label || '未命名邀请');
    const maxUses = Number(invite.maxUses), used = Number(invite.useCount);
    const uses = `${Number.isFinite(used) ? Math.max(0, used) : 0}/${Number.isFinite(maxUses) ? Math.max(0, maxUses) : '—'} 次`;
    const until = Number.isFinite(Date.parse(invite.expiresAt)) ? new Date(invite.expiresAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) : '有效期未知';
    return `<li class="team-access-row"><div class="team-access-row-title"><strong>${label}</strong><span class="team-access-state ${state === '有效' ? 'is-active' : 'is-disabled'}">${state}</span></div><p class="team-access-meta">${role} · ${escapeHtml(uses)} · 截止 ${escapeHtml(until)}</p>${!revoked && valid ? `<button class="secondary-btn" type="button" data-invite-revoke="${id}">撤销邀请码</button>` : ''}</li>`;
  }).join('')}</ul>`;
}

export function createTeamAccessWorkflow({ api, canManage, getCurrentOrigin = () => globalThis.location?.origin || '', now = () => Date.now() } = {}) {
  if (typeof api !== 'function' || typeof canManage !== 'function') throw new TypeError('团队权限工作流缺少请求函数或管理员校验');
  let access = null, submissionState = 'ready';
  const requireAdmin = () => { if (!canManage()) throw new Error('只有管理员可以管理团队成员'); };
  async function readAccess() {
    requireAdmin();
    access = checkedAccess(await api('/api/access'));
    return access;
  }
  function validateInvite(input) {
    const role = String(input?.role || '');
    if (!['viewer', 'editor'].includes(role)) throw new Error('邀请码只能授予查看者或编辑者权限');
    const hours = Number(input.hours), maxUses = Number(input.maxUses);
    if (!Number.isInteger(hours) || hours < 1 || hours > 168) throw new Error('有效期需为 1–168 小时');
    if (!Number.isInteger(maxUses) || maxUses < 1 || maxUses > 20) throw new Error('可使用次数需为 1–20 次');
    return { role, label: String(input.label || '').trim().slice(0, 80), hours, maxUses };
  }
  return {
    get access() { return access; },
    get submissionState() { return submissionState; },
    refresh: readAccess,
    async createInvite(input) {
      requireAdmin();
      if (submissionState !== 'ready') throw new Error('上次邀请结果尚未核对；请先刷新成员清单并确认后再创建。');
      let body, currentAccess;
      try { body = validateInvite(input); }
      catch (error) { error.createWasNotSent = true; throw error; }
      try { currentAccess = await readAccess(); }
      catch (error) { error.createWasNotSent = true; throw error; }
      const share = resolveTeamShareOrigin({ access: currentAccess, currentOrigin: getCurrentOrigin(), now: now() });
      if (!share.origin) { const error = new Error(share.hint); error.createWasNotSent = true; throw error; }
      submissionState = 'submitting';
      let receipt;
      try {
        receipt = await api('/api/access/invites', { method: 'POST', body: JSON.stringify(body) });
      } catch (error) {
        const definitivelyRejected = Number(error?.status) >= 400 && Number(error?.status) < 500;
        submissionState = definitivelyRejected ? 'ready' : 'needs-reconcile';
        if (definitivelyRejected) error.definiteRejection = true;
        throw error;
      }
      const id = Number(receipt?.id);
      if (!Number.isSafeInteger(id) || id < 1 || receipt.role !== body.role
        || Number(receipt.hours) !== body.hours || Number(receipt.maxUses) !== body.maxUses
        || !CODE_RE.test(String(receipt.code || ''))) {
        submissionState = 'needs-reconcile';
        throw new Error('服务器已返回响应，但邀请码回执不完整；为防重复创建，请先核对邀请列表。');
      }
      submissionState = 'ready';
      return { ...receipt, origin: share.origin, originKind: share.kind, reachabilityHint: share.hint, link: buildTeamInviteLink(share.origin, receipt.code) };
    },
    async reconcileInvite() {
      requireAdmin();
      if (submissionState !== 'needs-reconcile' && submissionState !== 'needs-ack') throw new Error('当前没有待核对的邀请请求');
      const result = await readAccess();
      submissionState = 'needs-ack';
      return result;
    },
    acknowledgePossibleDuplicate() {
      requireAdmin();
      if (submissionState !== 'needs-ack') throw new Error('请先成功刷新并查看邀请列表');
      submissionState = 'ready';
      return true;
    },
    async updateMember(idValue, patch) {
      requireAdmin();
      const id = validId(idValue);
      const member = access?.members.find(candidate => Number(candidate.id) === id);
      if (!member) throw new Error('请先刷新成员清单；目标成员不存在或未加载');
      if (member.authSource === 'local-owner') throw new Error('本机管理员不可修改');
      const body = {};
      if (patch?.role !== undefined) {
        if (!['viewer', 'editor'].includes(patch.role)) throw new Error('成员权限只能设置为查看者或编辑者');
        body.role = patch.role;
      }
      if (patch?.enabled !== undefined) {
        if (typeof patch.enabled !== 'boolean') throw new Error('成员启停状态无效');
        body.enabled = patch.enabled;
      }
      if (!Object.keys(body).length) throw new Error('没有需要保存的成员变更');
      const updated = await api(`/api/access/members/${id}`, { method: 'PATCH', body: JSON.stringify(body) });
      await readAccess();
      return updated;
    },
    async revokeInvite(idValue) {
      requireAdmin();
      const id = validId(idValue);
      const invite = access?.invites.find(candidate => Number(candidate.id) === id);
      if (!invite) throw new Error('请先刷新邀请码列表；目标邀请码不存在或未加载');
      if (invite.revoked) throw new Error('该邀请码已撤销');
      await api(`/api/access/invites/${id}`, { method: 'DELETE' });
      await readAccess();
      return true;
    },
  };
}

export function createTeamAccessController({ api, canManage, document: doc = document, getCurrentOrigin, now } = {}) {
  const byId = id => doc.getElementById(id);
  const opener = byId('teamAccessButton'), dialog = byId('teamAccessDialog');
  if (!opener || !dialog) return { syncRole() {} };
  const workflow = createTeamAccessWorkflow({ api, canManage, getCurrentOrigin, now });
  const closeButton = byId('teamAccessClose');
  const status = byId('teamAccessStatus'), memberList = byId('teamMemberList'), inviteList = byId('teamInviteList');
  const refreshButton = byId('teamAccessRefresh'), form = byId('teamInviteForm'), submitButton = byId('teamInviteSubmit');
  const reconcileButton = byId('teamInviteReconcile'), acknowledgeRow = byId('teamInviteAcknowledgeRow');
  const acknowledgeBox = byId('teamInviteAcknowledgeCheck'), acknowledgeButton = byId('teamInviteAcknowledge');
  const result = byId('teamInviteResult'), resultCode = byId('teamInviteCode'), resultLink = byId('teamInviteLink'), copyButton = byId('teamInviteCopy');
  let busy = false, openRequest = 0;
  const message = (text, error = false) => { status.textContent = text; status.dataset.state = error ? 'error' : 'normal'; };
  function clearResult() { result.hidden = true; resultCode.textContent = ''; resultLink.value = ''; }
  function syncState() {
    const canAdmin = canManage(), state = workflow.submissionState;
    opener.hidden = !canAdmin;
    if (!canAdmin && dialog.open) dialog.close();
    closeButton.disabled = state === 'submitting';
    for (const control of form.querySelectorAll('input,select,button')) control.disabled = !canAdmin || busy || state !== 'ready';
    refreshButton.disabled = !canAdmin || busy;
    reconcileButton.hidden = state !== 'needs-reconcile'; reconcileButton.disabled = !canAdmin || busy;
    acknowledgeRow.hidden = state !== 'needs-ack';
    acknowledgeButton.disabled = !canAdmin || busy || !acknowledgeBox.checked;
    if (state === 'needs-reconcile') message('创建请求结果不确定；系统不会自动重试。请先刷新上方邀请码清单，确认是否已有新记录。', true);
    else if (state === 'needs-ack') message('已刷新邀请码清单。请核对有效记录；如果上次邀请已创建但你仍要新建，请勾选确认后继续。', true);
  }
  function syncRole() { syncState(); }
  function renderAccess(value) {
    const online = Number.isFinite(Number(value.onlineCount)) ? Math.max(0, Number(value.onlineCount)) : 0;
    const origin = resolveTeamShareOrigin({ access: value, currentOrigin: getCurrentOrigin?.() || globalThis.location?.origin || '', now: now?.() ?? Date.now() });
    byId('teamAccessSummary').textContent = `${value.members.length} 位成员 · ${online} 位近 5 分钟活跃 · ${countUsableInvites(value.invites, now?.() ?? Date.now())} 个当前可用邀请码。${origin.hint}`;
    memberList.innerHTML = renderTeamMembers(value.members);
    inviteList.innerHTML = renderTeamInvites(value.invites, now?.() ?? Date.now());
  }
  async function refresh({ reconciliation = false } = {}) {
    if (!canManage() || busy) return;
    busy = true; syncState(); message(reconciliation ? '正在核对上次请求并刷新邀请码清单…' : '正在读取团队成员与邀请码…');
    try {
      const value = reconciliation ? await workflow.reconcileInvite() : await workflow.refresh();
      renderAccess(value);
      if (workflow.submissionState === 'needs-ack') syncState();
      else message('已读取最新成员与邀请码清单。');
    } catch (error) { message(`读取失败：${error.message}。未创建或修改任何成员。`, true); }
    finally { busy = false; syncState(); }
  }
  opener.addEventListener('click', () => {
    if (!canManage() || dialog.open) return;
    dialog.showModal(); clearResult(); const request = ++openRequest;
    void (async () => {
      busy = true; syncState(); message('正在读取团队成员与邀请码…');
      try { const value = await workflow.refresh(); if (request !== openRequest || !dialog.open) return; renderAccess(value); message('已读取最新成员与邀请码清单。'); }
      catch (error) { if (request === openRequest && dialog.open) message(`读取失败：${error.message}。未更改成员或邀请码。`, true); }
      finally { if (request === openRequest) { busy = false; syncState(); } }
    })();
  });
  closeButton.addEventListener('click', () => dialog.close());
  dialog.addEventListener('cancel', event => {
    if (workflow.submissionState === 'submitting') {
      event.preventDefault();
      message('邀请码请求尚未得到结果，请等待回执；系统不会重复提交。', true);
    }
  });
  dialog.addEventListener('close', () => { openRequest++; busy = false; clearResult(); acknowledgeBox.checked = false; if (canManage()) opener.focus({ preventScroll: true }); });
  refreshButton.addEventListener('click', () => void refresh());
  reconcileButton.addEventListener('click', () => { acknowledgeBox.checked = false; void refresh({ reconciliation: true }); });
  acknowledgeBox.addEventListener('change', syncState);
  acknowledgeButton.addEventListener('click', () => {
    if (!canManage() || !acknowledgeBox.checked) return;
    try { workflow.acknowledgePossibleDuplicate(); acknowledgeRow.hidden = true; acknowledgeBox.checked = false; message('已确认。新建前仍会重新读取当前分享地址；如果发现疑似重复邀请码，请先撤销旧记录。'); syncState(); }
    catch (error) { message(error.message, true); }
  });
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (!canManage() || busy || workflow.submissionState !== 'ready') return;
    busy = true; syncState(); clearResult();
    const body = { role: byId('teamInviteRole').value, label: byId('teamInviteLabel').value, hours: Number(byId('teamInviteHours').value), maxUses: Number(byId('teamInviteMaxUses').value) };
    try {
      const receipt = await workflow.createInvite(body);
      resultCode.textContent = receipt.code.toUpperCase(); resultLink.value = receipt.link; result.hidden = false;
      message(`邀请码已创建（${receipt.originKind === 'lan' ? '仅同一局域网' : '公网入口可达性待验证'}）。${receipt.reachabilityHint} 请只把下方链接发给预期成员；完整邀请码只在本次显示。`, true);
      try { renderAccess(await workflow.refresh()); }
      catch (error) { message(`邀请码已创建并已显示；成员清单刷新失败：${error.message}。点击「刷新清单」核对记录。邀请码只显示一次。`, true); }
    } catch (error) {
      if (workflow.submissionState === 'needs-reconcile') { acknowledgeBox.checked = false; }
      const outcome = error?.createWasNotSent ? '未发送创建请求' : error?.definiteRejection ? '请求被服务器明确拒绝，未创建' : '未确认创建成功';
      message(`${outcome}：${error.message}`, true);
    } finally { busy = false; syncState(); }
  });
  copyButton.addEventListener('click', async () => {
    if (!resultLink.value || !canManage()) return;
    try { await globalThis.navigator.clipboard.writeText(resultLink.value); message('邀请链接已复制。发给对方前，请在目标网络确认页面可以打开。', true); }
    catch { resultLink.focus(); resultLink.select(); message('浏览器未允许自动复制；链接已选中，请手动复制。', true); }
  });
  dialog.addEventListener('click', async event => {
    const button = event.target.closest?.('button');
    if (!button || !canManage() || busy) return;
    const memberSave = button.dataset.memberSave, memberToggle = button.dataset.memberToggle, inviteRevoke = button.dataset.inviteRevoke;
    if (memberSave) {
      const select = dialog.querySelector(`[data-member-role="${Number(memberSave)}"]`);
      if (!select) return;
      busy = true; syncState();
      try { await workflow.updateMember(memberSave, { role: select.value }); renderAccess(workflow.access); message('成员权限已保存。'); }
      catch (error) { message(`权限未确认保存：${error.message}。请刷新清单核对。`, true); }
      finally { busy = false; syncState(); }
    } else if (memberToggle) {
      busy = true; syncState();
      try { await workflow.updateMember(memberToggle, { enabled: button.dataset.enabled !== 'true' }); renderAccess(workflow.access); message(button.dataset.enabled === 'true' ? '成员已停用。' : '成员已恢复。'); }
      catch (error) { message(`成员状态未确认更新：${error.message}。请刷新清单核对。`, true); }
      finally { busy = false; syncState(); }
    } else if (inviteRevoke) {
      const invite = workflow.access?.invites.find(item => Number(item.id) === Number(inviteRevoke));
      if (!invite || !globalThis.confirm(`撤销「${String(invite.label || '未命名邀请')}」？此邀请码之后不能再登录。`)) return;
      busy = true; syncState();
      try { await workflow.revokeInvite(inviteRevoke); renderAccess(workflow.access); message('邀请码已撤销；撤销无法恢复。'); }
      catch (error) { message(`撤销未确认完成：${error.message}。请刷新清单核对。`, true); }
      finally { busy = false; syncState(); }
    }
  });
  syncRole();
  return { syncRole };
}

if (typeof document !== 'undefined') {
  let controller = null;
  document.addEventListener('mcn:team-access-bind', event => {
    if (controller || typeof event.detail?.api !== 'function' || typeof event.detail?.canManage !== 'function') return;
    controller = createTeamAccessController(event.detail);
  });
  document.addEventListener('mcn:works-settings-session', () => controller?.syncRole());
}
