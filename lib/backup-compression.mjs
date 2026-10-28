import {createReadStream,createWriteStream} from 'node:fs';
import {lstat,readFile,rename,unlink,utimes,mkdtemp,copyFile,rm,open} from 'node:fs/promises';
import {pipeline} from 'node:stream/promises';
import {createGzip,createGunzip} from 'node:zlib';
import {createHash,randomUUID} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join,basename} from 'node:path';
async function uncompressedHash(path){const hash=createHash('sha256');const source=createReadStream(path),unzip=createGunzip();source.on('error',e=>unzip.destroy(e));source.pipe(unzip);let bytes=0;for await(const block of unzip){hash.update(block);bytes+=block.length;}return {sha256:hash.digest('hex'),bytes};}
export async function compressVerifiedBackup(path){
 const before=await lstat(path);if(!before.isFile()||before.isSymbolicLink())throw Error('unsafe-backup-file');
 const manifest=JSON.parse(await readFile(path+'.manifest.json','utf8'));
 if(manifest.bytes!==before.size||!manifest.validation||manifest.validation.integrityCheck!=='ok'||!/^[a-f0-9]{64}$/.test(manifest.sha256))throw Error('unverified-backup');
 const destination=path+'.gz',temporary=destination+'.'+randomUUID()+'.partial';
 try{await lstat(destination);throw Error('compressed-backup-already-exists');}catch(e){if(e.code!=='ENOENT')throw e;}
 try{
  await pipeline(createReadStream(path),createGzip({level:1}),createWriteStream(temporary,{flags:'wx',mode:before.mode&0o777}));
  const h=await open(temporary,'r');try{await h.sync();}finally{await h.close();}
  const verified=await uncompressedHash(temporary),after=await lstat(path);
  if(verified.bytes!==manifest.bytes||verified.sha256!==manifest.sha256||after.size!==before.size||after.mtimeMs!==before.mtimeMs)throw Error('backup-compression-verification-failed');
  await rename(temporary,destination);await utimes(destination,before.atime,before.mtime);await unlink(path);
  return {path:destination,originalBytes:before.size,compressedBytes:(await lstat(destination)).size,sha256:verified.sha256};
 }catch(e){await unlink(temporary).catch(()=>{});throw e;}
}
export async function withReadableBackup(path,operation){
 if(!path.endsWith('.sqlite.gz'))return operation(path);
 const s=await lstat(path);if(!s.isFile()||s.isSymbolicLink())throw Error('unsafe-compressed-backup');
 const directory=await mkdtemp(join(tmpdir(),'mcn-backup-restore-')),plain=join(directory,basename(path).slice(0,-3));
 try{await pipeline(createReadStream(path),createGunzip(),createWriteStream(plain,{flags:'wx',mode:0o600}));await copyFile(path.slice(0,-3)+'.manifest.json',plain+'.manifest.json');return await operation(plain);}finally{await rm(directory,{recursive:true,force:true});}
}
