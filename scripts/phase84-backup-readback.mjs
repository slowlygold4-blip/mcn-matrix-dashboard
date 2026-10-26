// Recheck the existing immutable backup/copy; do not copy the live database.
import assert from 'node:assert/strict';
import {readFile,writeFile,stat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
const root='/Users/tyke/Documents/Codex/2026-08-31/bi-a/outputs/douyin-monitor-workbench';
const backup=root+'/data/backups/phase81-20261002/douyin-monitor-auto-20261001T210009270Z-phase81-before-runtime-release-d3b3230c.sqlite';
const restored='/var/folders/bf/j1_z4gd95szd7by48xbzql5r0000gn/T/mcn-phase81-restore-IrirZa/restored.sqlite';
const expected='6362eea58606483a28d08f23c6a7f2c5bb65f89be3a8ab5ba4cb60aaf432a62f';
const sha=b=>createHash('sha256').update(b).digest('hex');
const records=[];
for(const path of [backup,restored]){
  const info=await stat(path);assert.equal(info.size,822730752);
  const hash=sha(await readFile(path));assert.equal(hash,expected);
  const db=new DatabaseSync(path,{readOnly:true});
  try{db.exec('PRAGMA query_only=ON');assert.equal(db.prepare('PRAGMA quick_check').get().quick_check,'ok');
    assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');assert.equal(db.prepare('PRAGMA foreign_key_check').all().length,0);
    const maxRun=db.prepare('SELECT max(id) n FROM runs').get().n;assert.equal(maxRun,2383);
    records.push({kind:path===backup?'existing-consistent-backup':'existing-private-restored-copy',bytes:info.size,sha256:hash,maxRun,
      integrity:'ok',quickCheck:'ok',foreignKeyErrors:0,queryOnly:db.prepare('PRAGMA query_only').get().query_only,totalChanges:db.prepare('SELECT total_changes() n').get().n});
  }finally{db.close();}
}
const result={checkedAt:new Date().toISOString(),records,noLiveDbCopy:true,noHistoricalRewrite:true,cutoffRunId:2383,doesNotContainLaterRuns:true};
await writeFile(root+'/data/maintenance-journal/2026-10-02-phase84-backup-readback.json',JSON.stringify(result,null,2)+'\n',{flag:'wx',mode:0o600});
console.log(JSON.stringify(result));
