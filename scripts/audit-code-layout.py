"""Conservative import/reference inventory. Read-only; never deletes candidates."""
from pathlib import Path
import json,re
ROOT=Path(__file__).resolve().parent.parent
FILES={p.resolve() for folder in ['lib','scripts'] for p in (ROOT/folder).rglob('*') if p.is_file() and p.suffix in ['.mjs','.js','.py']}
FILES.add((ROOT/'server.mjs').resolve())
REFERENCE=re.compile(r'''["'`]((?:\.{1,2}/)[^"'`\n]+\.(?:mjs|js|py))["'`]''')
edges={}
for p in FILES:
 edges[p]={ (p.parent/relative).resolve() for relative in REFERENCE.findall(p.read_text(errors='replace')) if (p.parent/relative).resolve() in FILES }
pkg=json.loads((ROOT/'package.json').read_text())
roots={ROOT/'server.mjs',ROOT/'scripts/source-poller.mjs',ROOT/'scripts/public-replica-publisher.mjs',ROOT/'scripts/sync-creator-library.mjs'}
for command in pkg['scripts'].values():
 for name in re.findall(r'(scripts/[\w.-]+\.mjs)',command):roots.add(ROOT/name)
seen=set();stack=[p.resolve() for p in roots if p.resolve() in FILES]
while stack:
 p=stack.pop()
 if p in seen:continue
 seen.add(p);stack.extend(edges.get(p,set())-seen)
largest=sorted(FILES,key=lambda p:p.stat().st_size,reverse=True)[:12]
report={'runtime_files':len(FILES),'reachable':len(seen),'declared_roots':sorted(str(p.relative_to(ROOT)) for p in roots),'largest_files':[{'path':str(p.relative_to(ROOT)),'bytes':p.stat().st_size,'lines':len(p.read_text(errors='replace').splitlines())} for p in largest],'unreachable_candidates':sorted(str(p.relative_to(ROOT)) for p in FILES-seen),'warning':'Candidates may be manual tools or dynamically referenced. Review usage and preserve data before removal.'}
print(json.dumps(report,ensure_ascii=False,indent=2))
