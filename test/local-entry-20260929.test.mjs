import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const publicFile = name => new URL(`../public/${name}`, import.meta.url);
const entryPath = publicFile('local-entry.js');
const entrySource = () => {
  assert.ok(existsSync(entryPath), 'a file-safe classic entry script must exist');
  return readFileSync(entryPath, 'utf8');
};

for (const file of ['rebuild.html', 'index.html']) test(`${file} installs a file-safe classic entry before application assets`, () => {
  const html = readFileSync(publicFile(file), 'utf8');
  const entry = [...html.matchAll(/<script\b([^>]*)\bsrc=["']([^"']*local-entry\.js(?:\?[^"']*)?)["']([^>]*)>/g)][0];
  assert.ok(entry, `${file} has no file:// entry; its root assets resolve outside public/`);
  assert.ok(!entry[2].startsWith('/'), 'file entry must resolve beside the HTML, never file:///local-entry.js');
  assert.doesNotMatch(entry[1] + entry[3], /\b(?:type=["']module|async|defer)\b/);
  assert.ok(entry.index < html.indexOf('<link'), 'file guard must run before application resource tags');
});

for (const protocol of ['http:', 'https:']) test(`${protocol} entry is a no-op and preserves the existing route and authorization flow`, () => {
  const location = new URL(`${protocol}//example.test/?theme=tuantuan#accounts`);
  const original = location.href;
  runInNewContext(entrySource(), { location, URL,
    document: new Proxy({}, { get() { throw new Error('HTTP must not alter document or load any entry UI'); } }),
    fetch() { throw new Error('entry must not probe or collect'); } });
  assert.equal(location.href, original);
});

function localFixture(query = '?theme=tuantuan&period=custom&start=2026-09-20&end=2026-09-28#topics') {
  const nodes = [];
  const createElement = tag => {
    const node = { tagName: tag.toUpperCase(), children: [], style: {}, dataset: {}, attributes: {}, textContent: '', innerHTML: '',
      setAttribute(name, value) { this.attributes[name] = value; },
      append(...children) { this.children.push(...children); }, appendChild(child) { this.children.push(child); return child; },
      prepend(...children) { this.children.unshift(...children); } };
    nodes.push(node); return node;
  };
  const document = { readyState: 'complete', createElement,
    documentElement: { dataset: {}, classList: { add() {} } }, head: createElement('head'), body: createElement('body'),
    addEventListener(_event, callback) { callback(); } };
  const location = new URL(`file:///workspace/public/rebuild.html${query}`);
  runInNewContext(entrySource(), { location, URL, document,
    fetch() { throw new Error('file launcher must not request service or platform data'); } });
  return { nodes, location, document, text: nodes.map(node => node.textContent + node.innerHTML).join('\n') };
}

test('file entry preserves the complete query/hash in a fixed loopback link without automatic navigation', () => {
  const f = localFixture();
  const link = f.nodes.find(node => node.tagName === 'A' && String(node.href || '').startsWith('http://127.0.0.1:4188/'));
  assert.ok(link, 'local entry must offer the real HTTP service explicitly');
  assert.equal(link.href, 'http://127.0.0.1:4188/?theme=tuantuan&period=custom&start=2026-09-20&end=2026-09-28#topics');
  assert.equal(link.target, '_blank', 'keep fallback guidance available if the service is stopped');
  assert.match(link.rel, /noopener/); assert.match(link.rel, /noreferrer/);
  assert.equal(f.location.protocol, 'file:', 'do not strand users on a connection-refused page automatically');
});

test('file entry is self-contained and clearly explains stopped-service recovery, without claiming connectivity', () => {
  const f = localFixture();
  assert.ok(f.nodes.some(node => node.tagName === 'STYLE' && node.textContent), 'file view must not depend on root stylesheet paths');
  assert.match(f.text, /本地文件/); assert.match(f.text, /无法打开|未启动|不可达/);
  assert.match(f.text, /启动抖音监控台\.command/);
  assert.doesNotMatch(f.text, /服务已连接|服务正常|已完成采集/);
});

test('query parameters cannot choose an external redirect destination or execute markup', () => {
  const f = localFixture('?next=https%3A%2F%2Fevil.example&x=%3Cscript%3E#topics');
  const links = f.nodes.filter(node => node.tagName === 'A');
  assert.ok(links.length);
  for (const link of links) assert.equal(new URL(link.href).origin, 'http://127.0.0.1:4188');
  assert.doesNotMatch(f.text, /<script>/);
});
