import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {retainClientAssets} from '../scripts/retained-client-assets.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'retained-assets-test-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const old = path.join(root, 'old');
  const current = path.join(root, 'dist/client');
  const asset = (base, name, text) => {const full=path.join(base, '_next/static/chunks', name);fs.mkdirSync(path.dirname(full),{recursive:true});fs.writeFileSync(full,text);return full;};
  return {root, old, current, asset, run: (mode, base=current) => retainClientAssets({projectRoot:root,clientRoot:base,mode})};
}

test('old dynamic chart and its static/preload dependencies survive current-only rebuild', t => {
  const f=fixture(t);
  f.asset(f.old,'chart-12345678.js','import {x} from "./runtime-12345678.js"; export const v=x;');
  f.asset(f.old,'runtime-12345678.js','export const x=1;');
  f.asset(f.old,'page-12345678.js','const deps=["_next/static/chunks/chart-12345678.js"];export const load=()=>import(`./chart-12345678.js`);');
  assert.equal(f.run('capture',f.old).retained,3);
  f.asset(f.current,'chart-ABCDEFGH.js','export const v=2;');
  assert.equal(f.run('merge').retained,4);
  assert.equal(fs.readFileSync(path.join(f.current,'_next/static/chunks/chart-12345678.js'),'utf8'),'import {x} from "./runtime-12345678.js"; export const v=x;');
  assert.equal(fs.readFileSync(path.join(f.current,'_next/static/chunks/chart-ABCDEFGH.js'),'utf8'),'export const v=2;');
});

test('reviewed 260-file union preserves every archived byte and the current build', t => {
  const f=fixture(t);
  const oldAssets=new Map();
  const newAssets=new Map();
  for(let i=0;i<253;i++) {
    const name=`old${i}-12345678.js`;
    const bytes=i===0?'export const load=()=>import("./old1-12345678.js");':`export const version=${i};`;
    oldAssets.set(name,bytes);
    f.asset(f.old,name,bytes);
  }
  assert.equal(f.run('capture',f.old).retained,253);
  const archive=path.join(f.root,'build/retained-client-assets');
  const manifestBefore=fs.readFileSync(path.join(archive,'manifest.json'));
  for(let i=0;i<7;i++) {
    const name=`new${i}-ABCDEFGH.js`;
    const bytes=`export const nextVersion=${i};`;
    newAssets.set(name,bytes);
    f.asset(f.current,name,bytes);
  }
  const totalBytes=[...oldAssets.values(),...newAssets.values()].reduce((sum,bytes)=>sum+Buffer.byteLength(bytes),0);
  assert.deepEqual(f.run('merge'),{mode:'merge',archived:253,current:7,retained:260,bytes:totalBytes});
  assert.equal(fs.readdirSync(path.join(f.current,'_next/static/chunks')).length,260);
  for(const [name,bytes] of oldAssets) {
    assert.equal(fs.readFileSync(path.join(archive,'_next/static/chunks',name),'utf8'),bytes);
    assert.equal(fs.readFileSync(path.join(f.current,'_next/static/chunks',name),'utf8'),bytes);
  }
  for(const [name,bytes] of newAssets) {
    assert.equal(fs.readFileSync(path.join(f.current,'_next/static/chunks',name),'utf8'),bytes);
  }
  assert.deepEqual(fs.readFileSync(path.join(archive,'manifest.json')),manifestBefore);
  assert.equal(f.run('merge').retained,260);
});

test('769-file union is rejected before merge writes without evicting the 768-file archive', t => {
  const f=fixture(t);
  for(let i=0;i<768;i++)f.asset(f.old,`old${i}-12345678.js`,`export const version=${i};`);
  assert.equal(f.run('capture',f.old).retained,768);
  const archive=path.join(f.root,'build/retained-client-assets');
  const manifestBefore=fs.readFileSync(path.join(archive,'manifest.json'));
  const current=f.asset(f.current,'new-ABCDEFGH.js','export const nextVersion=1;');
  assert.throws(()=>f.run('merge'),/file limit/);
  assert.deepEqual(fs.readdirSync(path.join(f.current,'_next/static/chunks')),['new-ABCDEFGH.js']);
  assert.equal(fs.readFileSync(current,'utf8'),'export const nextVersion=1;');
  assert.equal(fs.readdirSync(path.join(archive,'_next/static/chunks')).length,768);
  assert.deepEqual(fs.readFileSync(path.join(archive,'manifest.json')),manifestBefore);
  for(let i=0;i<768;i++) {
    assert.equal(fs.readFileSync(path.join(archive,'_next/static/chunks',`old${i}-12345678.js`),'utf8'),`export const version=${i};`);
  }
});

test('capture and merge are byte-idempotent and retain no source/server/environment files', t => {
  const f=fixture(t); f.asset(f.old,'chart-12345678.js','export const x=1;');
  fs.writeFileSync(path.join(f.old,'.env'),'not-public');
  f.run('capture',f.old); const manifest=path.join(f.root,'build/retained-client-assets/manifest.json');
  const before=fs.readFileSync(manifest); f.run('capture',f.old);assert.deepEqual(fs.readFileSync(manifest),before);
  f.asset(f.current,'chart-ABCDEFGH.js','export const x=2;');f.run('merge');f.run('merge');
  assert.equal(fs.existsSync(path.join(f.current,'.env')),false);
});

test('current same hash/different bytes is rejected before writes and never overwritten', t => {
  const f=fixture(t);f.asset(f.old,'chart-12345678.js','old');f.run('capture',f.old);
  const current=f.asset(f.current,'chart-12345678.js','current');
  assert.throws(()=>f.run('merge'),/Conflicting immutable asset/);assert.equal(fs.readFileSync(current,'utf8'),'current');
});

test('missing static and dynamic/preload dependencies fail closed', t => {
  const f=fixture(t);f.asset(f.old,'chart-12345678.js','export const load=()=>import("./absent-12345678.js");');
  assert.throws(()=>f.run('capture',f.old),/Missing compiled dependency/);
  assert.equal(fs.existsSync(path.join(f.root,'build/retained-client-assets')),false);
  f.asset(f.old,'chart-12345678.js','export const load=x=>import(x);');
  assert.throws(()=>f.run('capture',f.old),/Non-literal compiled import/);
});

test('unallowlisted files and traversal dependencies are rejected', t => {
  const f=fixture(t);f.asset(f.old,'chart-12345678.js','import "../../../../server.js";');
  assert.throws(()=>f.run('capture',f.old),/Missing compiled dependency/);
  f.asset(f.old,'chart-12345678.js','export const ok=1;');f.asset(f.old,'.env','private');
  assert.throws(()=>f.run('capture',f.old),/Unexpected static asset/);
});

test('file and nested directory symlinks cannot enter retention or output', t => {
  const f=fixture(t);const full=f.asset(f.old,'chart-12345678.js','export const ok=1;');
  fs.symlinkSync(full,path.join(f.old,'_next/static/chunks/other-12345678.js'));
  assert.throws(()=>f.run('capture',f.old),/symlink rejected/i);
  fs.unlinkSync(path.join(f.old,'_next/static/chunks/other-12345678.js'));
  fs.symlinkSync(path.join(f.old,'_next/static/chunks'),path.join(f.old,'_next/static/alias'));
  assert.throws(()=>f.run('capture',f.old),/symlink rejected/i);
  fs.unlinkSync(path.join(f.old,'_next/static/alias'));
  fs.symlinkSync(f.old,path.join(f.root,'build'));
  assert.throws(()=>f.run('capture',f.old),/ancestor symlink rejected/i);
});

test('corrupt archive bytes or manifest paths are rejected instead of silently trusted', t => {
  const f=fixture(t);f.asset(f.old,'chart-12345678.js','original');f.run('capture',f.old);
  const archive=path.join(f.root,'build/retained-client-assets');
  fs.writeFileSync(path.join(archive,'_next/static/chunks/chart-12345678.js'),'modified');
  assert.throws(()=>f.run('capture',f.old),/digest mismatch|size mismatch/);
  const manifest=path.join(archive,'manifest.json');const json=JSON.parse(fs.readFileSync(manifest));json.assets[0].path='../secret.js';fs.writeFileSync(manifest,JSON.stringify(json));
  assert.throws(()=>f.run('capture',f.old),/not allowlisted/);
});

test('bounded storage refuses oversize and file count overflow without eviction', t => {
  const f=fixture(t);f.asset(f.old,'chart-12345678.js','x'.repeat(64*1024*1024+1));
  assert.throws(()=>f.run('capture',f.old),/byte limit/);assert.equal(fs.existsSync(path.join(f.root,'build/retained-client-assets')),false);
  fs.unlinkSync(path.join(f.old,'_next/static/chunks/chart-12345678.js'));
  for(let i=0;i<769;i++)f.asset(f.old,`chart${i}-12345678.js`,'x');
  assert.throws(()=>f.run('capture',f.old),/file limit/);
});

test('over-limit union rejects before merge writes and preserves archived bytes', t => {
  const f=fixture(t);
  const old=f.asset(f.old,'archive-12345678.js','x'.repeat(63*1024*1024));
  f.run('capture',f.old);
  const archive=path.join(f.root,'build/retained-client-assets');
  const manifest=fs.readFileSync(path.join(archive,'manifest.json'));
  const current=f.asset(f.current,'current-ABCDEFGH.js','y'.repeat(1024*1024+1));
  assert.throws(()=>f.run('merge'),/byte limit/);
  assert.equal(fs.existsSync(path.join(f.current,'_next/static/chunks/archive-12345678.js')),false);
  assert.equal(fs.statSync(current).size,1024*1024+1);
  assert.equal(fs.statSync(old).size,63*1024*1024);
  assert.deepEqual(fs.readFileSync(path.join(archive,'manifest.json')),manifest);
});
