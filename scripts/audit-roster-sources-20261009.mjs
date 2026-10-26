// Read-only cloud reread. Writes evidence files only, never operating data.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { parseAuthorSpreadsheet } from '../lib/author-spreadsheet.mjs';
import { readBitable } from './source-poller.mjs';

const root = resolve(import.meta.dirname, '..');
const dir = resolve(root, 'data/maintenance-journal/20261009-roster-reread');
await mkdir(dir, { recursive: true, mode: 0o700 });
const run = promisify(execFile), startedAt = new Date().toISOString();
const registry = JSON.parse(await readFile(resolve(root, 'data/source-poll/registry.json'), 'utf8')).sources;
const db = new DatabaseSync(resolve(root, 'data/douyin-monitor.sqlite'), { readOnly: true });
const saved = db.prepare('SELECT payload_json FROM master_roster_entries WHERE import_id=(SELECT MAX(id) FROM master_roster_imports)').all().map(x => JSON.parse(x.payload_json));
const ids = new Set(saved.flatMap(x => x.accountIds).map(x => String(x).trim().toLowerCase()));
const names = new Set(saved.flatMap(x => [x.name, ...x.originalNames]).map(x => String(x).normalize('NFKC').toLowerCase()));
db.close();
const report = { startedAt, readOnly: true, workbookResults: [], tableResults: [], failures: [], beforeRoster: saved.length };
async function save(name, data) { await writeFile(resolve(dir, name), JSON.stringify(data, null, 2) + '\n', { mode: 0o600 }); }
async function cli(args) {
  const { stdout } = await run('/Users/tyke/.local/bin/lark-cli', args, { timeout: 90_000, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, LARK_CLI_NO_PROXY: '1' } });
  const result = JSON.parse(stdout);
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result;
}
function col(n) { let out=''; while(n>0){n--;out=String.fromCharCode(65+n%26)+out;n=Math.floor(n/26);} return out; }
function compare(rows) {
  return rows.filter(r => r.douyinId ? !ids.has(r.douyinId.toLowerCase()) : !names.has(String(r.name).normalize('NFKC').toLowerCase()))
    .map(r => ({ name:r.name, douyinId:r.douyinId, sourceRow:r.sourceRow, locator:r.locator, videoLinks:r.videoLinks, contentIds:r.contentIds, platform:r.platform }));
}
const books = [...new Map(registry.filter(x => /\/sheets\//.test(x.sourceUrl)).map(x=>[new URL(x.sourceUrl).pathname.split('/').pop(), x])).entries()];
for (const [token, source] of books) {
  try {
    const url = source.sourceUrl.split('?')[0];
    const info = await cli(['sheets','+workbook-info','--url',url,'--as','user','--json']);
    await save(`${token}-info.json`, info);
    const book = { url, title:info.data.title, revision:info.data.revision, sheets:[] };
    report.workbookResults.push(book);
    for(const sheet of info.data.sheets) {
      const title = sheet.title || sheet.sheet_name;
      const result = { sheetId:sheet.sheet_id, title, physicalRows:sheet.row_count, readRows:0, nonEmptyRows:0, parsedRows:0, rows:[] };
      book.sheets.push(result);
      try {
        if(sheet.row_count > 10000 || sheet.column_count > 100) throw new Error('Range exceeds bounded audit size');
        const rows = [];
        for(let start=1;start<=sheet.row_count;start+=300){
          const end=Math.min(sheet.row_count,start+299);
          const range=`A${start}:${col(sheet.column_count)}${end}`;
          const page = await cli(['sheets','+csv-get','--url',url,'--sheet-id',sheet.sheet_id,'--range',range,'--rows-json','--max-chars','4000000','--as','user','--json']);
          const data = page.data;
          if (data.has_more !== false || data.revision !== info.data.revision || data.rows.length !== end-start+1) throw new Error('Incomplete or changed range');
          for(let i=0;i<data.rows.length;i++) if(data.rows[i].row_number!==start+i) throw new Error('Non-contiguous row positions');
          await save(`${token}-${sheet.sheet_id}-${start}.json`,page);
          rows.push(...data.rows);
        }
        result.readRows=rows.length;
        result.nonEmptyRows=rows.filter(x=>Object.values(x.values).some(v=>String(v??'').trim())).length;
        const csv = rows.map(r => Array.from({length:sheet.column_count},(_,i)=>'"'+String(r.values[col(i+1)]??'').replaceAll('"','""')+'"').join(',')).join('\n');
        try {
          const parsed=await parseAuthorSpreadsheet({buffer:Buffer.from(csv),fileName:`${title}.csv`});
          result.parsedRows=parsed.rows.length; result.summary=parsed.summary; result.rows=parsed.rows;
          result.notInFrozenRoster=compare(parsed.rows);
        } catch(e) { result.parseIssue=e.message; }
        console.log(JSON.stringify({book:book.title,sheet:title,read:result.readRows,nonEmpty:result.nonEmptyRows,parsed:result.parsedRows,notInFrozenRoster:result.notInFrozenRoster?.length,parseIssue:result.parseIssue}));
      } catch(e) {result.error=e.message; report.failures.push({url,sheet:title,error:e.message});}
      await save('report.json',report);
    }
    const after=await cli(['sheets','+workbook-info','--url',url,'--as','user','--json']);
    book.revisionStable=after.data.revision===info.data.revision;
    if(!book.revisionStable) report.failures.push({url,error:'Workbook changed during read'});
  }catch(e){report.failures.push({url:source.sourceUrl,error:e.message}); console.log(JSON.stringify({error:e.message,url:source.sourceUrl}));}
}
for (const source of registry.filter(x=>x.sourceType==='lark-bitable')) {
  try {
    let page=0;
    const commandRunner = async (command,args,options) => {
      const result=await run(command,args,{...options,timeout:90_000});
      await save(`${source.tableId}-page${++page}.json`,JSON.parse(result.stdout));
      return result;
    };
    const parsed=await readBitable(source,{commandRunner});
    const result={url:source.sourceUrl,title:source.sourceTitle,tableId:source.tableId,revision:parsed.revision,rawRows:parsed.count,parsedRows:parsed.rows.length,rows:parsed.rows,notInFrozenRoster:compare(parsed.rows),sourceSha256:parsed.sourceSha256,pages:page};
    report.tableResults.push(result);
    console.log(JSON.stringify({...result, rows:undefined,notInFrozenRoster:result.notInFrozenRoster.length}));
  }catch(e){report.failures.push({url:source.sourceUrl,error:e.message});console.log(JSON.stringify({url:source.sourceUrl,error:e.message}));}
  await save('report.json',report);
}
report.finishedAt=new Date().toISOString();
report.unreadFormAliases=registry.filter(x=>x.readPolicy==='unresolved-alias').map(x=>({url:x.sourceUrl,reason:x.blockedReason}));
await save('report.json',report);
console.log(JSON.stringify({finishedAt:report.finishedAt,books:report.workbookResults.length,bitables:report.tableResults.length,failures:report.failures,artifact:resolve(dir,'report.json')}));
