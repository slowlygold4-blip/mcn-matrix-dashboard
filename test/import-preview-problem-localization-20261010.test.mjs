import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ExcelJS from 'exceljs';

const secUid = index => `MS4wLjABAAAA${index.toString(36).padStart(20, '0')}`;

async function workbookWithLateProblems({ healthyRows, problemRows }) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('作者名单');
  sheet.addRow(['作者名称', 'sec_uid']);
  for (let index = 1; index <= healthyRows; index += 1) sheet.addRow([`正常作者${index}`, secUid(index)]);
  for (let index = 1; index <= problemRows; index += 1) sheet.addRow([`后段缺身份${index}`, '']);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

test('batch-preview locates a problem after row 50 and returns a bounded, explicitly truncated problem projection', { timeout: 20_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'mcn-import-problem-preview-'));
  process.env.DATA_DIR = directory;
  process.env.NODE_ENV = 'test';
  const { server } = await import('../server.mjs');
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    if (server.listening) await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });

  const origin = `http://127.0.0.1:${server.address().port}`;
  const sessionResponse = await fetch(`${origin}/api/auth/session`);
  const session = await sessionResponse.json();
  const cookie = sessionResponse.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
  const preview = async (fileName, bytes) => {
    const response = await fetch(`${origin}/api/author-spreadsheet/batch-preview`, {
      method: 'POST',
      headers: { Cookie: cookie, 'X-CSRF-Token': session.csrfToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileName, contentBase64: bytes.toString('base64') }),
    });
    assert.equal(response.status, 200);
    return (await response.json()).sheets[0];
  };

  // Source row 999 is outside the ordinary first-50 preview, but must still be
  // actionable before submission.
  const late = await preview('第999行问题.xlsx', await workbookWithLateProblems({ healthyRows: 997, problemRows: 1 }));
  assert.equal(late.summary.needsLocatorRows, 1);
  assert.equal(late.sampleRows.length, 50);
  assert.ok(late.sampleRows.every(row => row.status === 'ready'));

  // A large problem set must not turn the preview API into an unbounded echo of
  // the uploaded workbook. It must state exactly how many rows were omitted.
  const many = await preview('大量后段问题.xlsx', await workbookWithLateProblems({ healthyRows: 50, problemRows: 260 }));
  assert.equal(many.summary.needsLocatorRows, 260);

  const contractProblems = [];
  if (late.problemRowCount !== 1) contractProblems.push(`late problemRowCount=${String(late.problemRowCount)}`);
  if (late.problemRowsTruncated !== 0) contractProblems.push(`late problemRowsTruncated=${String(late.problemRowsTruncated)}`);
  if (!Array.isArray(late.problemRows) || late.problemRows.length !== 1) contractProblems.push(`late problemRows length=${String(late.problemRows?.length)}`);
  else {
    const row = late.problemRows[0];
    if (row.sourceRow !== 999 || row.status !== 'needs_locator' || row.name !== '后段缺身份1') {
      contractProblems.push(`late row=${JSON.stringify({ sourceRow: row.sourceRow, status: row.status, name: row.name })}`);
    }
  }
  if (many.problemRowCount !== 260) contractProblems.push(`many problemRowCount=${String(many.problemRowCount)}`);
  if (!Array.isArray(many.problemRows) || many.problemRows.length < 1 || many.problemRows.length > 200) {
    contractProblems.push(`many bounded length=${String(many.problemRows?.length)}`);
  } else {
    if (many.problemRowsTruncated !== 260 - many.problemRows.length) {
      contractProblems.push(`many truncation=${String(many.problemRowsTruncated)} for ${many.problemRows.length} returned`);
    }
    if (many.problemRows[0].sourceRow !== 52 || many.problemRows.at(-1).sourceRow !== 51 + many.problemRows.length) {
      contractProblems.push(`many source range=${many.problemRows[0].sourceRow}-${many.problemRows.at(-1).sourceRow}`);
    }
  }
  assert.deepEqual(contractProblems, [], 'batch preview must return a bounded full-sheet problem projection with exact omission count');
});
