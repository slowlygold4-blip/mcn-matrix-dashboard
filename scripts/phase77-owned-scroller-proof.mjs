#!/usr/bin/env node
// Offline production-consumer counterexample. No browser, network or storage.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { collectOne } from './douyin_browser_collector.mjs';

const secUid = 'MS4wLjABAAAAPhase77SyntheticScrollerOnly';
const otherSecUid = 'MS4wLjABAAAAOtherPhase77SyntheticOnly';
const profile = `https://www.douyin.com/user/${secUid}`;
const endpoint = cursor => `https://www.douyin.com/aweme/v1/web/aweme/post/?sec_user_id=${secUid}&max_cursor=${cursor}`;
class OfflinePage extends EventEmitter {
  constructor({ viewport, nextCursor = 100, nextAuthor = secUid, nextStatus = 200 }) {
    super(); this.address = 'about:blank'; this.frame = { url: () => this.address };
    this.viewport = viewport; this.nextCursor = nextCursor; this.nextAuthor = nextAuthor;
    this.nextStatus = nextStatus; this.moves = []; this.wheels = 0; this.insideWheels = 0;
    this.mouse = { move: async (x, y) => { this.point = { x, y }; this.moves.push(this.point); },
      wheel: async () => {
        this.wheels++;
        // A normal nested works pane, not the entire viewport. No actual DOM claim.
        if (!this.point || this.point.x < 100 || this.point.x >= 800 || this.point.y < 100 || this.point.y >= 600) return;
        this.insideWheels++;
        const request = this.request(endpoint(this.nextCursor));
        this.respond(request, this.nextStatus, this.body(2, this.nextAuthor));
      } };
  }
  mainFrame() { return this.frame; }
  url() { return this.address; }
  viewportSize() { return this.viewport; }
  request(url, navigation = false) {
    const request = { url: () => url, frame: () => this.frame,
      method: () => 'GET', isNavigationRequest: () => navigation };
    this.emit('request', request); return request;
  }
  respond(request, status, body) {
    this.emit('response', { request: () => request, url: request.url, status: () => status,
      json: async () => body });
  }
  body(page, author = secUid) {
    return { status_code: 0, has_more: page === 1, max_cursor: page === 1 ? 100 : 200,
      aweme_list: [{ aweme_id: page === 1 ? '7200000000000000001' : '7200000000000000002',
        author: { sec_uid: author, uid: '1234567890' }, statistics: { digg_count: page * 10 } }] };
  }
  async goto() {
    const document = this.request(profile, true); this.address = profile;
    this.respond(document, 200); this.emit('framenavigated', this.frame);
    this.respond(this.request(endpoint(0)), 200, this.body(1));
  }
  async evaluate() { return { observation: 'observed', readyState: 'interactive' }; }
}
async function run(options) {
  const page = new OfflinePage(options);
  const result = await collectOne(page, { key: 'synthetic-only', secUid, limit: 30 },
    { timeoutMs: 180, bodyTimeoutMs: 60, pageWaitMs: 30, maxPages: 3 });
  return { page, result };
}
const outside = await run({ viewport: { width: 1280, height: 720 } });
assert.equal(outside.page.moves[0].x, 960); assert.equal(outside.page.moves[0].y, 576);
assert.equal(outside.page.insideWheels, 0);
assert.equal(outside.result.posts.length, 1);
assert.equal(outside.result.pagination.stopReason, 'page-timeout');
assert.equal(outside.result.errorCode, 'collector_error');
assert.equal(outside.result.failureDiagnostics.requests.candidate, 1);

// Positive control changes only synthetic viewport geometry. Not a production fix.
const inside = await run({ viewport: { width: 800, height: 625 } });
assert.equal(inside.page.moves[0].x, 600); assert.equal(inside.page.moves[0].y, 500);
assert.equal(inside.page.insideWheels, 1);
assert.equal(inside.result.posts.length, 2);
assert.equal(inside.result.pagination.stopReason, 'end-of-list');
assert.deepEqual(inside.result.pagination.pages.map(p => p.requestCursor), [0, 100]);
assert.equal(inside.result.posts[1].statistics.digg_count, 20);

const wrongCursor = await run({ viewport: { width: 800, height: 625 }, nextCursor: 101 });
assert.equal(wrongCursor.result.posts.length, 1);
assert.ok(wrongCursor.result.failureDiagnostics.requests.rejected.firstCursor >= 1);
const wrongAuthor = await run({ viewport: { width: 800, height: 625 }, nextAuthor: otherSecUid });
assert.equal(wrongAuthor.result.posts.length, 1);
assert.notEqual(wrongAuthor.result.pagination.stopReason, 'end-of-list');
const refused = await run({ viewport: { width: 800, height: 625 }, nextStatus: 403 });
assert.equal(refused.result.posts.length, 1);
assert.equal(refused.result.pagination.stopReason, 'http-rejection');
assert.equal(refused.result.errorCode, 'blocked');
console.log(JSON.stringify({ kind: 'phase77-actual-consumer-offline-counterexample', browserLaunched: false,
  syntheticDomNotLiveEvidence: true, productionPatched: false,
  outside: { point: outside.page.moves[0], insideWheels: outside.page.insideWheels,
    posts: outside.result.posts.length, stop: outside.result.pagination.stopReason },
  insideControl: { point: inside.page.moves[0], insideWheels: inside.page.insideWheels,
    posts: inside.result.posts.length, cursors: inside.result.pagination.pages.map(p => p.requestCursor), stop: inside.result.pagination.stopReason },
  wrongCursorRefused: true, wrongAuthorExcluded: true, http403StopsPaging: true }));
