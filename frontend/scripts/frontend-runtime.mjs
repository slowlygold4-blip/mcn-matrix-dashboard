import {existsSync} from 'node:fs';
import {resolve} from 'node:path';
const required=['.openai/hosting.json','build/sites-vite-plugin.ts','build/sites-worker.ts','build/connector-preview-plugin.mjs','build/connector-preview-worker.mjs'];
export function frontendRuntime(root,requested=process.env.MCN_FRONTEND_RUNTIME||'auto'){
 if(!['auto','sites','standalone'].includes(requested))throw Error('MCN_FRONTEND_RUNTIME must be auto, sites or standalone');
 if(requested==='standalone')return 'standalone';
 const hasHosting=existsSync(resolve(root,required[0]));
 if(requested==='sites'||hasHosting){
  if(required.some(path=>!existsSync(resolve(root,path))))throw Error('Sites runtime files are incomplete. Restore the Sites scaffold, or explicitly select MCN_FRONTEND_RUNTIME=standalone for local read-only development.');
  return 'sites';
 }
 return 'standalone';
}
