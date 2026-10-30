import {fileURLToPath} from 'node:url';
import {frontendRuntime} from './frontend-runtime.mjs';
const root=fileURLToPath(new URL('../',import.meta.url));
if(frontendRuntime(root)==='sites'){
 await import('./sites-env.mjs');
 process.argv=[process.execPath,root+'node_modules/wrangler/bin/wrangler.js','dev','--config','dist/server/wrangler.json','--local','--persist-to','.wrangler/state','--ip','127.0.0.1','--inspector-port','0',...process.argv.slice(2)];
 await import(new URL('../node_modules/wrangler/bin/wrangler.js',import.meta.url));
}else{
 process.chdir(root);process.argv=[process.execPath,root+'node_modules/vinext/dist/cli.js','start','--hostname','127.0.0.1','--port','5173',...process.argv.slice(2)];
 await import(new URL('../node_modules/vinext/dist/cli.js',import.meta.url));
}
