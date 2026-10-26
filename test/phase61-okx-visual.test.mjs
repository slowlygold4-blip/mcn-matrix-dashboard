// Source and numerical contrast evidence. Does not claim browser or screenshot validation.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import vm from 'node:vm';
import {rendererJsx,synchronousGrowthDynamic} from './helpers/growth-renderer-transport.mjs';
const site=new URL('../../mcn-public-site/',import.meta.url),requireSite=createRequire(new URL('package.json',site));
const postcss=requireSite('postcss'),ts=requireSite('typescript');
const [publicCss,localCss,growth]=await Promise.all([readFile(new URL('app/replica.css',site),'utf8'),readFile(new URL('../public/rebuild.css',import.meta.url),'utf8'),readFile(new URL('components/growth-panel.tsx',site),'utf8')]);
function stylesheet(source){const ast=postcss.parse(source),rules=[],tokens={};ast.walkRules(rule=>{for(let p=rule.parent;p;p=p.parent)if(p.type==='atrule')return;rules.push(rule);if(rule.selectors.includes(':root'))rule.walkDecls(d=>{if(d.prop.startsWith('--'))tokens[d.prop]=d.value;});});
 const resolve=value=>{assert.equal(typeof value,'string','missing actual CSS value');for(let n=0;n<12&&value.includes('var(');n++)value=value.replace(/var\((--[\w-]+)\)/g,(_m,key)=>{assert.ok(tokens[key],'missing token '+key);return tokens[key];});return value;};
 const normalize=selector=>selector.replace(/\s*([>+~])\s*/g,'$1').replace(/["']/g,'');
 const style=selector=>{const out={},target=normalize(selector);for(const rule of rules)if(rule.selectors.some(raw=>{const s=normalize(raw);return target===s||target.endsWith(' '+s);}))rule.walkDecls(d=>out[d.prop]=d.value);return out;};return{tokens,resolve,style};}
const pub=stylesheet(publicCss),local=stylesheet(localCss);
function rgb(value){const raw=value.trim().replace(/^#/,'');assert.match(raw,/^(?:[\da-f]{3}|[\da-f]{6})$/i,'expected opaque authored color: '+value);const hex=raw.length===3?[...raw].map(x=>x+x).join(''):raw;return hex.match(/../g).map(v=>parseInt(v,16)/255);}
const luminance=value=>rgb(value).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4).reduce((sum,v,i)=>sum+v*[.2126,.7152,.0722][i],0);
const contrast=(a,b)=>(Math.max(luminance(a),luminance(b))+.05)/(Math.min(luminance(a),luminance(b))+.05);
const pair=(sheet,foreground,background,minimum,label)=>{const ratio=contrast(sheet.resolve(foreground),sheet.resolve(background));assert.ok(ratio>=minimum,label+': '+ratio.toFixed(2)+' < '+minimum);return ratio;};
function surface(sheet,selector,foreground){const s=sheet.style(selector),bg=s.background||s['background-color'];assert.ok(bg,'missing background '+selector);assert.ok(luminance(sheet.resolve(bg))<.08,selector+' retains a light screen surface');pair(sheet,s.color||foreground,bg,4.5,selector+' text');return bg;}

test('phase61 public portal and local Jupiter shell independently retain readable dark palettes',()=>{
 for(const [sheet,bg,ink,muted,accent] of [[pub,'--mcn-canvas','--mcn-ink','--mcn-muted','--chart-1'],[local,'--bg','--ink','--muted','--blue']]){assert.ok(luminance(sheet.tokens[bg])<.01);pair(sheet,sheet.tokens[ink],sheet.tokens[bg],4.5,'main text');pair(sheet,sheet.tokens[muted],sheet.tokens[bg],4.5,'muted text');const [r,g,b]=rgb(sheet.tokens[accent]);assert.ok(g>r&&g>b*2,'accent should remain the user-selected lime');}
 assert.equal(local.tokens['--bg'],'#090d10');
 assert.equal(local.tokens['--panel'],'#11171c');
 assert.equal(local.tokens['--surface'],'#1a2229');
 assert.equal(local.tokens['--blue'],'#c7ef6b');
 assert.notEqual(local.tokens['--bg'],local.tokens['--panel'],'local shell needs a distinct panel layer');
 assert.notEqual(local.tokens['--panel'],local.tokens['--surface'],'local shell needs a distinct nested surface layer');
 pair(local,'var(--ink)','var(--panel)',4.5,'local panel text');
 pair(local,'var(--muted)','var(--panel)',4.5,'local panel muted text');
 pair(local,'var(--accent-ink)','var(--blue)',4.5,'local lime action label');
});
test('phase61 OKX portal surfaces are globally dark and body-independent',()=>{
 assert.equal(pub.style(':root')['color-scheme'],'dark');assert.equal(local.style(':root')['color-scheme'],'dark');surface(pub,'.history-dialog','var(--mcn-ink)');surface(local,'.account-dialog','var(--ink)');surface(local,'.auth-dialog','var(--ink)');pair(pub,'var(--popover-foreground)','var(--popover)',4.5,'public portal token');
});
test('phase61 OKX final local source, theme and work surfaces never regress to white after the theme block',()=>{
 for(const selector of ['#themeGrid .theme-card','#classificationGrid .classification-card','.works-evidence','.classification-sources','.source-list li','.classification-source-tag'])surface(local,selector,'var(--ink)');
 for(const selector of ['.theme-card strong','.classification-card strong'])pair(local,local.style(selector).color,'var(--panel)',4.5,selector);
 for(const selector of ['.theme-name','.classification-name','.works-evidence p'])pair(local,local.style(selector).color||'var(--muted)','var(--panel)',4.5,selector);
});
test('phase61 OKX normal, hover and error controls retain readable labels',()=>{
 for(const [sheet,selector] of [[local,'.primary-btn'],[local,'.primary-btn:hover'],[local,'.secondary-btn'],[local,'.notice'],[local,'.notice.error'],[local,'.notice.success'],[pub,'.error']]){const s=sheet.style(selector);pair(sheet,s.color,s.background,4.5,selector);}
 pair(pub,'var(--primary-foreground)','var(--primary)',4.5,'public primary');pair(pub,'var(--secondary-foreground)','var(--secondary)',4.5,'public secondary');pair(pub,'var(--mcn-positive)','var(--mcn-surface)',4.5,'public positive');pair(pub,'var(--mcn-negative)','var(--mcn-surface)',4.5,'public negative');
});
test('phase61 OKX focus and input boundaries remain distinguishable from dark surfaces',()=>{
 pair(pub,'var(--ring)','var(--mcn-surface)',3,'public focus');pair(pub,'var(--input)','var(--mcn-surface)',3,'public input edge');const s=local.style('.date-controls input');pair(local,s['border-color'],s.background,3,'local input edge');
});
test('phase61 OKX local portal header and interactive tab states do not restore unreadable light surfaces',()=>{
 surface(local,'#accountDialog .dialog-head','var(--ink)');
 for(const selector of ['.metric-tabs button:hover','.metric-tabs button[aria-selected=true]','.metric-tabs button[aria-pressed=true]','.table th[data-sort]:hover','.upload-icon','.status.paused','.status.deleted','.status.stale','.status.pending','.status.identity-review','.status.retry'])surface(local,selector,'var(--ink)');
});
function nodes(value,out=[]){if(!value||typeof value!=='object')return out;if(Array.isArray(value))value.forEach(v=>nodes(v,out));else{out.push(value);nodes(value.props.children,out);}return out;}
function chart(){const exports={},jsx=rendererJsx,react={useId:()=>"phase114-test-reading",useState:x=>[typeof x==='function'?x():x,()=>{}],useMemo:fn=>fn()};const source=ts.transpileModule(growth,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;
 vm.runInNewContext(source,{exports,URL,URLSearchParams,Blob,Date,Map,Set,console,require(spec){if(spec==='next/dynamic')return {default:synchronousGrowthDynamic};if(spec==='react')return react;if(spec==='react/jsx-runtime')return{jsx,jsxs:jsx,Fragment:'Fragment'};if(spec==='recharts'||spec.startsWith('@/components/'))return new Proxy({},{get:(_o,k)=>String(k)});if(spec.startsWith('@/lib/'))return requireSite(new URL(spec.slice(2),site).pathname);return requireSite(spec);}});
 const account={id:1,enabled:true,label:'Synthetic'},points=['2026-09-12','2026-09-13','2026-09-14'].map((date,i)=>({targetId:1,date,capturedAt:date+'T03:00:00.000Z',followers:10-i,likes:0,posts:0}));return nodes(exports.GrowthPanel({accounts:[account],points,manifest:{asOf:'2026-10-01T07:00:00.000Z'},start:'2026-09-12',end:'2026-09-14',comparison:{compare:true,otherStart:'2026-09-12',otherEnd:'2026-09-14'}}));}
test('phase61 OKX actual chart uses readable colored lines, honest gaps and a distinct comparison pattern',()=>{
 const rendered=chart(),lines=rendered.filter(n=>n.type==='Line');assert.equal(lines.length,2);for(const line of lines){pair(pub,line.props.stroke,'var(--mcn-surface)',3,line.props.dataKey+' chart line');assert.equal(line.props.connectNulls,false);assert.equal(line.props.isAnimationActive,false);assert.equal(line.props.type,'linear');}assert.ok(lines.find(n=>n.props.dataKey==='comparison').props.strokeDasharray);assert.equal(rendered.find(n=>n.type==='ReferenceLine').props.y,0);pair(pub,pub.style('.growth-chart .recharts-text').fill,'var(--mcn-surface)',4.5,'chart axis text');
});
