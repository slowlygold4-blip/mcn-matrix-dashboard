#!/usr/bin/env python3
"""Lossless, bounded backup compaction. No production DB or automatic restore points touched."""
import argparse,gzip,hashlib,json,os,time
from pathlib import Path
P=argparse.ArgumentParser();P.add_argument('--apply',action='store_true');a=P.parse_args()
root=Path(__file__).resolve().parents[1]/'data/backups';journal=root.parent/'maintenance-journal/2026-10-26-storage';journal.mkdir(exist_ok=True,parents=True)
items=[]
for p in root.rglob('*'):
 if not p.is_file() or p.is_symlink() or 'automatic' in p.relative_to(root).parts:continue
 if p.suffix not in ['.sqlite','.db'] or p.stat().st_size<10*1024*1024 or time.time()-p.stat().st_mtime<48*3600:continue
 if any(Path(str(p)+s).exists() for s in ['-wal','-journal']):continue
 if any(x.is_symlink() for x in p.parents if x!=root.parent):continue
 items.append(p)
plan={'count':len(items),'bytes':sum(p.stat().st_size for p in items),'paths':[str(p.relative_to(root)) for p in items]}
(journal/'backup-compression-plan.json').write_text(json.dumps(plan,indent=2));print(json.dumps({k:v for k,v in plan.items() if k!='paths'}),flush=True)
if not a.apply:raise SystemExit()
for p in sorted(items,key=lambda p:p.stat().st_size):
 st=p.stat();dest=Path(str(p)+'.gz');part=Path(str(dest)+'.partial')
 if dest.exists() or part.exists():continue
 digest=hashlib.sha256()
 with p.open('rb') as source,part.open('xb') as target:
  os.chmod(part,st.st_mode&0o777)
  with gzip.GzipFile(filename=p.name,mode='wb',fileobj=target,compresslevel=1,mtime=int(st.st_mtime)) as zipped:
   for block in iter(lambda:source.read(4*1024*1024),b''):digest.update(block);zipped.write(block)
  target.flush();os.fsync(target.fileno())
 recovered=hashlib.sha256();count=0
 with gzip.open(part,'rb') as f:
  for block in iter(lambda:f.read(4*1024*1024),b''):recovered.update(block);count+=len(block)
 current=p.stat()
 if recovered.digest()!=digest.digest() or count!=st.st_size or (current.st_mtime_ns,current.st_size)!=(st.st_mtime_ns,st.st_size):
  raise RuntimeError('Verification failed; original preserved: '+str(p))
 os.replace(part,dest);os.utime(dest,ns=(st.st_atime_ns,st.st_mtime_ns))
 record={'path':str(p.relative_to(root)),'original_bytes':st.st_size,'compressed_bytes':dest.stat().st_size,'sha256_uncompressed':digest.hexdigest(),'verified':True,'at':time.time()}
 # Durable verification receipt before the representation switch.
 with (journal/'backup-compression.jsonl').open('a') as f:f.write(json.dumps(record)+'\n');f.flush();os.fsync(f.fileno())
 p.unlink()
 print(json.dumps({k:v for k,v in record.items() if k not in ['sha256_uncompressed']}),flush=True)
