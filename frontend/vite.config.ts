import {defineConfig,loadConfigFromFile} from 'vite';
import vinext from 'vinext';
import {fileURLToPath} from 'node:url';
import {frontendRuntime} from './scripts/frontend-runtime.mjs';

export default defineConfig(async context=>{
 const root=fileURLToPath(new URL('.',import.meta.url));
 if(frontendRuntime(root)==='sites'){
  const result=await loadConfigFromFile(context,root+'vite.hosted.config.mjs');
  if(!result)throw Error('Sites configuration could not be loaded');
  return result.config;
 }
 return {
  plugins:[vinext()],
  resolve:{alias:{'cloudflare:workers':root+'lib/standalone-env.mjs'}},
  server:{host:'127.0.0.1',...(process.env.CODEX_SANDBOX==='seatbelt'?{watch:{useFsEvents:false,usePolling:true}}:{})},
 };
});
