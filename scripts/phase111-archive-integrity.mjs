import assert from 'node:assert/strict';
import { readFile, writeFile, copyFile, mkdir, chmod, constants, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
const root = fileURLToPath(new URL('../', import.meta.url));
const source = '/tmp/phase111-integrity-ypuoc4';
const archive = join(root, 'docs/phase111-evidence/integrity');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
async function fileSHA(path) { const hash = createHash('sha256'); for await (const bytes of createReadStream(path)) hash.update(bytes); return hash.digest('hex'); }
const signed = JSON.parse(await readFile(join(source, 'signed-receipt.json'), 'utf8'));
const originals = [];
for (const item of signed.originals) {
  assert.equal(sha(await readFile(join(root, `data/ingestion-reviews/run-${item.runId}.json`))), item.sha256);
  assert.equal(item.originalUnchanged, true); originals.push(item);
}
assert.deepEqual(signed.fixedRunIds, Array.from({length:20},(_,i)=>2787+i));
await mkdir(archive, { recursive: true });
const evidence = [];
for (const name of [...Object.keys(signed.files), 'signed-receipt.json', 'count-wording-clarification.md']) {
  assert.ok(!name.includes('/')); const bytes = await readFile(join(source, name));
  if (signed.files[name]) assert.equal(sha(bytes), signed.files[name]);
  await writeFile(join(archive, name), bytes, { flag: 'wx', mode: 0o400 });
  assert.equal(sha(await readFile(join(archive, name))), sha(bytes));
  evidence.push({ file: join(archive, name), bytes: bytes.length, sha256: sha(bytes) });
}
const receipt = JSON.parse(await readFile(join(source, 'backup.json'), 'utf8'));
const persistentBackup = join(root, 'data/backups/phase111-consistent-20261002T091006.sqlite');
assert.equal(await fileSHA(receipt.backupPath), receipt.sha256);
await mkdir(join(root, 'data/backups'), { recursive: true });
await copyFile(receipt.backupPath, persistentBackup, constants.COPYFILE_EXCL); await chmod(persistentBackup, 0o400);
assert.equal(await fileSHA(persistentBackup), receipt.sha256); assert.equal((await stat(persistentBackup)).size, receipt.bytes);
const db = new DatabaseSync(persistentBackup, { readOnly: true });
const restore = {};
try {
  db.exec('PRAGMA query_only=ON;BEGIN');
  assert.equal(db.prepare('SELECT total_changes() n').get().n, 0);
  restore.quickCheck = db.prepare('PRAGMA quick_check').get().quick_check; assert.equal(restore.quickCheck, 'ok');
  restore.integrityCheck = db.prepare('PRAGMA integrity_check').get().integrity_check; assert.equal(restore.integrityCheck, 'ok');
  restore.foreignKeyViolations = db.prepare('PRAGMA foreign_key_check').all().length; assert.equal(restore.foreignKeyViolations, 0);
  restore.counts = Object.fromEntries(Object.keys(receipt.validation.counts).map(table => [table, db.prepare(`SELECT count(*) n FROM ${table}`).get().n]));
  assert.deepEqual(restore.counts, receipt.validation.counts); assert.equal(db.prepare('SELECT total_changes() n').get().n, 0);
  db.exec('ROLLBACK');
} finally { db.close(); }
assert.equal(await fileSHA(persistentBackup), receipt.sha256);
const result = { checkedAt: new Date().toISOString(), evidence, originals, persistentBackup, backupSHA256: receipt.sha256,
  bytes: receipt.bytes, restore, mainDatabaseWrites: false, originalEventsEdited: false };
await writeFile(join(root, 'data/maintenance-journal/2026-10-02-phase111-integrity-archive.json'), JSON.stringify(result,null,2)+'\n', {flag:'wx',mode:0o400});
console.log(JSON.stringify({checkedAt:result.checkedAt,evidenceFiles:evidence.length,originals:originals.length,persistentBackup,bytes:receipt.bytes,tables:Object.keys(restore.counts).length}));
