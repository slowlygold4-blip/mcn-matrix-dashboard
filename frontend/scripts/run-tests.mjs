import {readFile,readdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
const root=fileURLToPath(new URL('../',import.meta.url));
const args=process.argv.slice(2),browser=args.includes('--browser');
if(args.some(arg=>arg!=='--browser'))throw Error('Only --browser is supported');
const selected=[],excluded=[];
for(const name of (await readdir(root+'test')).filter(n=>n.endsWith('.test.mjs')).sort()){
 const text=await readFile(root+'test/'+name,'utf8');
 const launchesBrowser=/playwright|chromium|puppeteer|browser.*launch|launch.*browser|MCN_TEST_CHROME/i.test(text);
 (launchesBrowser===browser?selected:excluded).push('test/'+name);
}
console.log(JSON.stringify({mode:browser?'explicit-browser':'source-only',files:selected.length,separateFiles:excluded.length}));
if(!selected.length)throw Error('No tests selected');
const child=spawn(process.execPath,['--test','--test-concurrency=2',...selected],{cwd:root,stdio:'inherit',env:{...process.env,MCN_MAIN_ROOT:process.env.MCN_MAIN_ROOT||fileURLToPath(new URL('../../',import.meta.url)),MCN_SITE_ROOT:root}});
for(const signal of ['SIGTERM','SIGINT'])process.once(signal,()=>child.kill(signal));
child.once('error',()=>{process.exitCode=1;});
child.once('exit',(code,signal)=>{process.exitCode=signal?1:code??1;});
