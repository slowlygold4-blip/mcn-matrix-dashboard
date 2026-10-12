import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  buildTeamInviteLink,
  countUsableInvites,
  createTeamAccessController,
  createTeamAccessWorkflow,
  renderTeamInvites,
  renderTeamMembers,
  resolveTeamShareOrigin,
} from '../public/team-access.js';

const NOW = 200_000;
const freshTunnel = 'https://team-live.trycloudflare.com';
const inviteReceipt = (id = 17) => ({ id, role: 'viewer', code: 'ABCD-1234-ABCD-1234-ABCD-1234-ABCD-1234', hours: 24, maxUses: 1 });
const baseAccess = () => ({
  members: [
    { id: 1, displayName: 'Local owner', role: 'admin', enabled: true, authSource: 'local-owner', activeSessionCount: 1 },
    { id: 2, displayName: '运营', role: 'editor', enabled: true, authSource: 'invite', activeSessionCount: 0 },
  ],
  invites: [],
  onlineCount: 1,
  publicBaseUrl: freshTunnel,
  publicEntry: { url: freshTunnel, status: 'running', updatedAt: new Date(NOW - 10_000).toISOString() },
  lanUrls: ['http://192.168.1.18:4188'],
});

class FakeElement {
  constructor(id) { this.id = id; this.hidden = false; this.disabled = false; this.open = false; this.value = ''; this.checked = false; this.textContent = ''; this.innerHTML = ''; this.dataset = {}; this.listeners = new Map(); this.children = []; }
  addEventListener(type, listener) { const listeners = this.listeners.get(type) || []; listeners.push(listener); this.listeners.set(type, listeners); }
  async emit(type, event = {}) { for (const listener of this.listeners.get(type) || []) await listener({ target: this, preventDefault() {}, ...event }); }
  querySelectorAll() { return this.children; }
  querySelector(selector) { const match = selector.match(/^\[data-member-role="(\d+)"\]$/); return match ? this.owner.elements.get(`member-role-${match[1]}`) || null : null; }
  showModal() { this.open = true; }
  close() { this.open = false; void this.emit('close'); }
  focus() {}
}

class FakeDocument {
  constructor() { this.elements = new Map(); }
  getElementById(id) { if (!this.elements.has(id)) { const element = new FakeElement(id); element.owner = this; this.elements.set(id, element); } return this.elements.get(id); }
}

function fakeTeamAccessDocument() {
  const doc = new FakeDocument();
  const form = doc.getElementById('teamInviteForm');
  form.children = ['teamInviteRole', 'teamInviteLabel', 'teamInviteHours', 'teamInviteMaxUses', 'teamInviteSubmit'].map(id => doc.getElementById(id));
  doc.getElementById('teamInviteRole').value = 'viewer';
  doc.getElementById('teamInviteLabel').value = '测试邀请';
  doc.getElementById('teamInviteHours').value = '24';
  doc.getElementById('teamInviteMaxUses').value = '1';
  return doc;
}

test('团队权限面板接入实际首页 rebuild.html，而非未路由旧页面', async () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const [server, html, shell] = await Promise.all([
    readFile(resolve(root, 'server.mjs'), 'utf8'),
    readFile(resolve(root, 'public/rebuild.html'), 'utf8'),
    readFile(resolve(root, 'public/rebuild.js'), 'utf8'),
  ]);
  assert.match(server, /pathname === "\/" \|\| pathname === "\/index\.html" \? "rebuild\.html"/);
  assert.match(html, /id="teamAccessButton"[^>]*hidden/);
  assert.match(html, /id="teamAccessDialog"/);
  assert.match(html, /href="\/team-access\.css\?v=[^"]+"/);
  const accessScriptIndex = html.indexOf('/team-access.js?');
  const appScriptIndex = html.indexOf('/rebuild.js?');
  assert.ok(accessScriptIndex >= 0, 'team-access controller must be loaded');
  assert.ok(appScriptIndex >= 0, 'rebuild application must be loaded');
  assert.ok(accessScriptIndex < appScriptIndex, 'team-access controller must load before the rebuild application');
  assert.match(shell, /mcn:team-access-bind/);
});

test('真实面板控制器仅管理员打开，读取成员，并显示一次性邀请回执', async () => {
  const doc = fakeTeamAccessDocument(), access = baseAccess(), calls = [];
  const api = async (path, options = {}) => {
    calls.push([path, options.method || 'GET']);
    if (path === '/api/access/invites' && options.method === 'POST') {
      const body = JSON.parse(options.body);
      return { ...inviteReceipt(), role: body.role, hours: body.hours, maxUses: body.maxUses };
    }
    return access;
  };
  let isAdmin = false;
  createTeamAccessController({ api, canManage: () => isAdmin, document: doc, getCurrentOrigin: () => 'http://localhost:4188', now: () => NOW });
  const opener = doc.getElementById('teamAccessButton'), dialog = doc.getElementById('teamAccessDialog');
  assert.equal(opener.hidden, true);
  await opener.emit('click');
  assert.equal(dialog.open, false);
  assert.equal(calls.length, 0, 'a hidden non-admin control cannot read the admin roster even when synthetically activated');

  isAdmin = true;
  doc.getElementById('teamAccessButton').listeners.get('click')[0]();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(opener.hidden, false);
  assert.equal(dialog.open, true);
  assert.match(doc.getElementById('teamMemberList').innerHTML, /运营/);
  assert.equal(calls.filter(([path]) => path === '/api/access').length, 1);
  await doc.getElementById('teamInviteForm').emit('submit');
  assert.equal(doc.getElementById('teamInviteResult').hidden, false);
  assert.match(doc.getElementById('teamInviteCode').textContent, /^ABCD-1234/);
  assert.match(doc.getElementById('teamInviteLink').value, /#invite=ABCD-1234/);
  assert.equal(calls.filter(([path, method]) => path === '/api/access/invites' && method === 'POST').length, 1);
});

test('只允许管理员读取；成员角色、编号与邀请码范围严格校验', async () => {
  let calls = 0;
  const workflow = createTeamAccessWorkflow({ api: async () => { calls++; }, canManage: () => false, now: () => NOW });
  await assert.rejects(workflow.refresh(), /只有管理员/);
  await assert.rejects(workflow.createInvite({ role: 'admin', hours: 24, maxUses: 1 }), /只有管理员/);
  assert.equal(calls, 0);

  const admin = createTeamAccessWorkflow({ api: async () => baseAccess(), canManage: () => true, now: () => NOW });
  await assert.rejects(admin.createInvite({ role: 'admin', hours: 24, maxUses: 1 }), /只能授予查看者或编辑者/);
  await assert.rejects(admin.createInvite({ role: 'viewer', hours: 169, maxUses: 1 }), /1–168 小时/);
  await admin.refresh();
  await assert.rejects(admin.updateMember(1, { role: 'viewer' }), /本机管理员不可修改/);
  await assert.rejects(admin.updateMember(2, { role: 'admin' }), /只能设置为查看者或编辑者/);
  await assert.rejects(admin.revokeInvite('../1'), /编号无效/);
});

test('创建前刷新入口，拒绝 loopback，并对局域网邀请明确标注同网限制', async () => {
  let posts = 0;
  const access = baseAccess();
  const workflow = createTeamAccessWorkflow({ api: async (path, options = {}) => {
    if (options.method === 'POST') { posts++; const body = JSON.parse(options.body); return { ...inviteReceipt(), role: body.role, maxUses: body.maxUses, hours: body.hours }; }
    return access;
  }, canManage: () => true, getCurrentOrigin: () => 'http://localhost:4188', now: () => NOW });
  const result = await workflow.createInvite({ role: 'editor', label: '运营 <一区>', hours: 72, maxUses: 5 });
  assert.equal(posts, 1);
  assert.equal(result.origin, freshTunnel);
  assert.match(result.reachabilityHint, /临时公网入口|临时/);
  assert.match(result.link, /^https:\/\/team-live\.trycloudflare\.com\/#invite=ABCD/);
  assert.equal(result.maxUses, 5);

  const noLan = { ...access, publicBaseUrl: null, publicEntry: null, lanUrls: [] };
  const blocked = createTeamAccessWorkflow({ api: async path => { if (path.includes('/invites')) posts++; return noLan; }, canManage: () => true, getCurrentOrigin: () => 'http://localhost:4188', now: () => NOW });
  await assert.rejects(blocked.createInvite({ role: 'viewer', hours: 24, maxUses: 1 }), error => error.createWasNotSent === true && /只有本机地址/.test(error.message));
  assert.equal(posts, 1, 'no invitation is created for a localhost-only origin');

  const lanOnly = { ...noLan, lanUrls: ['http://192.168.1.22:4188'] };
  const lan = resolveTeamShareOrigin({ access: lanOnly, currentOrigin: 'http://localhost:4188', now: NOW });
  assert.equal(lan.kind, 'lan');
  assert.match(lan.hint, /仅同一网络/);
});

test('过期或不匹配的 Quick Tunnel 不允许建邀请', async () => {
  const access = baseAccess();
  access.publicEntry = { ...access.publicEntry, updatedAt: new Date(NOW - 120_000).toISOString() };
  access.lanUrls = [];
  let posts = 0;
  const workflow = createTeamAccessWorkflow({ api: async path => { if (path.includes('/invites')) posts++; return access; }, canManage: () => true, getCurrentOrigin: () => freshTunnel, now: () => NOW });
  await assert.rejects(workflow.createInvite({ role: 'viewer', hours: 24, maxUses: 1 }), /本机没有可分享地址|没有可验证的分享地址/);
  assert.equal(posts, 0);
  assert.throws(() => buildTeamInviteLink('http://localhost:4188', 'bad-code'), /邀请码格式无效/);
});

test('邀请 POST 网络歧义会锁定；读列表并明确确认后才允许另一条 POST', async () => {
  const access = baseAccess();
  let posts = 0;
  let postShouldFail = true;
  const calls = [];
  const api = async (path, options = {}) => {
    calls.push([path, options.method || 'GET']);
    if (path === '/api/access/invites' && options.method === 'POST') {
      posts++;
      if (postShouldFail) throw new Error('连接在收到响应前中断');
      access.invites.unshift({ id: 18, role: 'viewer', label: '新建', createdAt: '2026-10-04T08:00:00Z', expiresAt: new Date(NOW + 86400_000).toISOString(), maxUses: 1, useCount: 0, revoked: false, expired: false });
      return inviteReceipt(18);
    }
    return access;
  };
  const workflow = createTeamAccessWorkflow({ api, canManage: () => true, getCurrentOrigin: () => freshTunnel, now: () => NOW });
  const input = { role: 'viewer', hours: 24, maxUses: 1 };
  await assert.rejects(workflow.createInvite(input), /连接在收到响应前中断/);
  assert.equal(workflow.submissionState, 'needs-reconcile');
  await assert.rejects(workflow.createInvite(input), /先刷新成员清单/);
  assert.equal(posts, 1);
  assert.equal(calls.filter(([, method]) => method === 'POST').length, 1);

  const reconciled = await workflow.reconcileInvite();
  assert.equal(workflow.submissionState, 'needs-ack');
  assert.ok(Array.isArray(reconciled.invites));
  assert.equal(workflow.acknowledgePossibleDuplicate(), true);
  postShouldFail = false;
  const created = await workflow.createInvite(input);
  assert.equal(posts, 2);
  assert.equal(created.id, 18);
  assert.equal(created.link, buildTeamInviteLink(freshTunnel, inviteReceipt(18).code));
});

test('4xx 明确拒绝可以修正；格式不完整的成功回执仍需先核对', async () => {
  const access = baseAccess();
  let mode = 'rejected';
  const api = async path => {
    if (path === '/api/access/invites') {
      if (mode === 'rejected') { const error = new Error('权限拒绝'); error.status = 403; throw error; }
      return { id: 19, role: 'viewer', code: '不完整' };
    }
    return access;
  };
  const workflow = createTeamAccessWorkflow({ api, canManage: () => true, getCurrentOrigin: () => freshTunnel, now: () => NOW });
  const input = { role: 'viewer', hours: 24, maxUses: 1 };
  await assert.rejects(workflow.createInvite(input), error => error.definiteRejection === true && /权限拒绝/.test(error.message));
  assert.equal(workflow.submissionState, 'ready');
  mode = 'invalid-success';
  await assert.rejects(workflow.createInvite(input), /回执不完整/);
  assert.equal(workflow.submissionState, 'needs-reconcile');
});

test('成员权限 PATCH 和邀请码撤销走既有受保护 API 后重新读取列表', async () => {
  const access = baseAccess();
  access.invites = [{ id: 8, role: 'viewer', label: '临时运营', createdAt: new Date(NOW - 1_000).toISOString(), expiresAt: new Date(NOW + 60_000).toISOString(), maxUses: 1, useCount: 0, revoked: false, expired: false }];
  const calls = [];
  const api = async (path, options = {}) => {
    calls.push([path, options]);
    if (path === '/api/access/members/2' && options.method === 'PATCH') {
      const body = JSON.parse(options.body); Object.assign(access.members[1], body); return access.members[1];
    }
    if (path === '/api/access/invites/8' && options.method === 'DELETE') { access.invites[0].revoked = true; return { ok: true }; }
    return access;
  };
  const workflow = createTeamAccessWorkflow({ api, canManage: () => true, now: () => NOW });
  await workflow.refresh();
  await workflow.updateMember(2, { role: 'viewer', enabled: false });
  await workflow.revokeInvite(8);
  assert.equal(access.members[1].role, 'viewer');
  assert.equal(access.members[1].enabled, false);
  assert.equal(access.invites[0].revoked, true);
  assert.ok(calls.some(([path, options]) => path === '/api/access/members/2' && options.method === 'PATCH'));
  assert.ok(calls.some(([path, options]) => path === '/api/access/invites/8' && options.method === 'DELETE'));
  assert.equal(calls.filter(([path]) => path === '/api/access').length, 3);
});

test('成员与邀请清单对用户提供值进行 HTML 转义且不展示邀请码正文', () => {
  const memberHtml = renderTeamMembers([{ id: 2, displayName: '<img src=x onerror=alert(1)>', role: 'editor', enabled: true, authSource: 'invite', activeSessionCount: 1 }]);
  assert.doesNotMatch(memberHtml, /<img/);
  assert.match(memberHtml, /&lt;img/);
  const inviteHtml = renderTeamInvites([{ id: 4, label: '<script>alert(1)</script>', role: 'viewer', createdAt: new Date(NOW).toISOString(), expiresAt: new Date(NOW + 60_000).toISOString(), maxUses: 1, useCount: 0, revoked: false }], NOW);
  assert.doesNotMatch(inviteHtml, /<script>/);
  assert.match(inviteHtml, /&lt;script&gt;/);
  assert.doesNotMatch(inviteHtml, /ABCD-1234/);
});

test('权限面板的有效邀请码计数排除已用尽、过期、撤销和状态不明记录', () => {
  const invites = [
    { expiresAt: new Date(NOW + 60_000).toISOString(), maxUses: 2, useCount: 1 },
    { expiresAt: new Date(NOW + 60_000).toISOString(), maxUses: 1, useCount: 1 },
    { expiresAt: new Date(NOW - 1).toISOString(), maxUses: 2, useCount: 0 },
    { expiresAt: new Date(NOW + 60_000).toISOString(), maxUses: 2, useCount: 0, revoked: true },
    { expiresAt: 'not-a-date', maxUses: 2, useCount: 0 },
  ];
  assert.equal(countUsableInvites(invites, NOW), 1);
  const html = renderTeamInvites(invites, NOW);
  assert.match(html, /次数已用完/);
  assert.match(html, /已过期/);
  assert.match(html, /已撤销/);
  assert.match(html, /状态需核对/);
});
