import {mkdir,writeFile} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {auditPublishedCoverageDirectory} from '../lib/publication-coverage-audit.mjs';
export {auditPublishedCoverageDirectory};
const fail=code=>{throw Object.assign(new Error(code),{code});};
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{
    const args=process.argv.slice(2),directory=args.shift();let output,startDate;
    while(args.length){const flag=args.shift(),value=args.shift();if(!value||!['--out','--start'].includes(flag))fail('invalid-audit-arguments');if(flag==='--out')output=resolve(value);else startDate=value;}
    if(!directory)fail('missing-audit-directory');
    const report=await auditPublishedCoverageDirectory(directory,{startDate});
    if(output){await mkdir(dirname(output),{recursive:true});await writeFile(output,JSON.stringify(report,null,2)+'\n',{mode:0o600});}
    const {mismatches,unresolvedIdentities,...summary}=report;
    console.log(JSON.stringify(summary));process.exitCode=report.status==='passed'?0:report.status==='incomplete'?2:1;
  }catch(error){
    const code=['invalid-audit-arguments','missing-audit-directory','invalid-audit-partition-path','unsafe-audit-partition-path','invalid-audit-partition-size','invalid-audit-partition-hash','invalid-publication-audit-input'].includes(error.code)?error.code:'publication-audit-unavailable';
    console.error(JSON.stringify({status:'failed',code,runtimeAI:false}));process.exitCode=1;
  }
}
