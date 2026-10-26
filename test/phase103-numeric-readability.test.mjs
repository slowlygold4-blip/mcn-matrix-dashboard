import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { numeric, formatNumber } from '../public/console-model.js';
const css=readFileSync(new URL('../public/rebuild.css',import.meta.url),'utf8');
const js=readFileSync(new URL('../public/rebuild.js',import.meta.url),'utf8');
const metric=css.match(/\.metric\{([^}]*)\}/)?.[1];
const dark=css.match(/:root\s*\{color-scheme:dark;([^}]*)\}/)?.[1];
const token=name=>dark.match(new RegExp(`--${name}:([^;]+)`))?.[1];
const lum=hex=>{const s=hex.replace('#',''),h=s.length===3?s.split('').map(c=>c+c).join(''):s;assert.match(h,/^[0-9a-f]{6}$/i);const rgb=[0,2,4].map(i=>parseInt(h.slice(i,i+2),16)/255).map(c=>c<=.04045?c/12.92:((c+.055)/1.055)**2.4);return rgb[0]*.2126+rgb[1]*.7152+rgb[2]*.0722;};
const contrast=(fg,bg)=>{const a=lum(fg),b=lum(bg);return (Math.max(a,b)+.05)/(Math.min(a,b)+.05);};
test('account stock metrics follow the existing ink theme token instead of a legacy light-theme literal',()=>{
 assert.ok(metric);assert.match(metric,/(?:^|;)color:var\(--ink\)(?:;|$)/);assert.doesNotMatch(metric,/!important/);
 assert.match(metric,/font-size:12px/);assert.match(metric,/font-weight:650/);
});
test('stock palette has at least normal-text contrast in normal, hover and focused dark rows',()=>{
 assert.equal(contrast('#fff','#000'),21);assert.ok(contrast('#293a54','#111')<4.5,'historical screenshot defect remains a proven negative control');
 const color=metric.includes('color:var(--ink)')?token('ink'):metric.match(/color:([^;]+)/)?.[1];
 for(const surface of ['#111','#1b1b1b','#222b12'])assert.ok(contrast(color,surface)>=4.5,`${color} on ${surface}`);
});
test('semantic signs retain the existing positive, negative and flat palette independently from totals',()=>{
 for(const [name,key]of [['up','green'],['down','red'],['flat','muted']]){assert.match(css,new RegExp(`\\.${name}\\{color:var\\(--${key}\\)\\}`));assert.ok(contrast(token(key),'#111')>=4.5);}
 assert.notEqual(token('green'),token('red'));
});
test('actual signed rendering keeps unknown, exact zero, positive and negative visibly distinct',()=>{
 const line=js.split('\n').find(value=>value.startsWith('const signed = '));assert.ok(line);
 const signed=runInNewContext(`${line}\nsigned`,{numeric,fmt:formatNumber,esc:value=>String(value)});
 assert.match(signed(null),/class="flat">—<\/span>/);assert.match(signed(0),/class="flat"[^>]*>0<\/span>/);
 assert.match(signed(12),/class="up"[^>]*>\+12<\/span>/);assert.match(signed(-12),/class="down"[^>]*>-12<\/span>/);
});
test('neutral totals inherit the print ink instead of keeping the screen ink literal',()=>{
 assert.match(metric,/color:var\(--ink\)/);assert.match(css,/@media print\s*\{:root\s*\{--bg:#fff;--panel:#fff;--ink:#111/);
 assert.ok(contrast('#111','#fff')>=4.5);
});
