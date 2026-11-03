import {constants} from 'node:fs';
import {open,lstat} from 'node:fs/promises';
import {resolve,join,dirname,sep} from 'node:path';

const PARTITION=/^(catalog|topics|summary|publishing)\.json$|^publishing\/\d{6}\.json$|^creator\/(index|authors|insights|works-\d{3})\.json$|^foundation\/(index|authors|works|sources|observations|other-authors|other-works|pending-authors)\.json$|^(daily|works|work-metrics)\/[1-9]\d{0,7}\.json$/;
const fail=code=>{throw Object.assign(new Error(code),{code});};

/** Read the original staged bytes, without following file/directory symlinks.
 * Reading is not validation; the caller must still run the complete verifier. */
export async function readPublicReplicaStaging(directory,{dataDir}={}){
  const staging=join(resolve(dataDir),'public-replica-staging');
  directory=resolve(directory);
  if(!directory.startsWith(staging+sep))fail('invalid-staging-directory');
  const components=directory.slice(staging.length+1).split(sep);
  const parents=[staging,...components.map((_,index)=>join(staging,...components.slice(0,index+1)))];
  const readPart=async relative=>{
    for(const path of [...parents,...(relative.includes('/')?[join(directory,dirname(relative))]:[])]){
      const stat=await lstat(path);
      if(!stat.isDirectory()||stat.isSymbolicLink())fail('unsafe-staging-path');
    }
    const fd=await open(join(directory,relative),constants.O_RDONLY|constants.O_NOFOLLOW);
    try{if(!(await fd.stat()).isFile())fail('unsafe-staging-path');return await fd.readFile('utf8');}
    finally{await fd.close();}
  };
  const manifest=JSON.parse(await readPart('manifest.json'));
  if(!Array.isArray(manifest.files))fail('invalid-staging-directory');
  const files=[];
  for(const meta of manifest.files){
    if(typeof meta?.path!=='string'||!PARTITION.test(meta.path))fail('invalid-partition-path');
    files.push({...meta,content:await readPart(meta.path)});
  }
  return {manifest,files};
}
