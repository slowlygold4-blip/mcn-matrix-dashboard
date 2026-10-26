// Synchronous transport for existing semantic tests after the chart-only split.
// Executes the actual extracted TSX. Not proof of browser chunk loading; Phase73
// independently executes the real installed lazy/error/retry implementation.
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import vm from 'node:vm';
const site=new URL('../../../mcn-public-site/',import.meta.url);
const requireSite=createRequire(new URL('package.json',site));
const ts=requireSite('typescript');
const baseJsx=(type,props,key)=>({type,props:props||{},key});
const renderer={};
const compiled=ts.transpileModule(readFileSync(new URL('components/growth-chart.tsx',site),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;
vm.runInNewContext(compiled,{exports:renderer,console,require(spec){
 if(spec==='react/jsx-runtime')return{jsx:baseJsx,jsxs:baseJsx,Fragment:'Fragment'};
 if(spec==='recharts'||spec.startsWith('@/components/'))return new Proxy({},{get:(_t,key)=>String(key)});
 if(spec.startsWith('@/lib/'))return requireSite(new URL(spec.slice(2),site).pathname);
 return requireSite(spec);
}});
export const synchronousGrowthDynamic=()=>renderer.default;
export const rendererJsx=(type,props,key)=>type===renderer.default?type(props):baseJsx(type,props,key);
