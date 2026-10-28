"""Conservative import/reference inventory. Read-only; never deletes candidates."""
from pathlib import Path
import json,re,collections
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
# Reference cycles are candidates, not proof of an ES module initialization bug.
# Worker script URLs/manual fixture references can legitimately form a cycle.
def cyclic_components(graph):
 stack=[];on_stack=set();indices={};low={};components=[]
 def visit(node):
  indices[node]=low[node]=len(indices);stack.append(node);on_stack.add(node)
  for target in sorted(graph.get(node,set())):
   if target not in indices:
    visit(target);low[node]=min(low[node],low[target])
   elif target in on_stack:low[node]=min(low[node],indices[target])
  if low[node]==indices[node]:
   group=[]
   while True:
    target=stack.pop();on_stack.remove(target);group.append(target)
    if target==node:break
   if len(group)>1 or node in graph.get(node,set()):components.append(sorted(group))
 for node in sorted(graph):
  if node not in indices:visit(node)
 return sorted(components)

largest=sorted(FILES,key=lambda p:p.stat().st_size,reverse=True)[:12]
incoming=collections.Counter(target for targets in edges.values() for target in targets)
report={'runtime_files':len(FILES),'reachable':len(seen),'declared_roots':sorted(str(p.relative_to(ROOT)) for p in roots),'largest_files':[{'path':str(p.relative_to(ROOT)),'bytes':p.stat().st_size,'lines':len(p.read_text(errors='replace').splitlines())} for p in largest],'literal_reference_cycle_candidates':[[str(p.relative_to(ROOT)) for p in group] for group in cyclic_components(edges)],'most_referenced':[{'path':str(p.relative_to(ROOT)),'inbound':n,'outbound':len(edges[p])} for p,n in incoming.most_common(15)],'unreachable_candidates':sorted(str(p.relative_to(ROOT)) for p in FILES-seen),'warning':'Candidates/cycles may include manual tools, dynamic entrypoints or worker URLs. They are not automatically unused code or initialization bugs. Review usage and preserve data before removal.'}
print(json.dumps(report,ensure_ascii=False,indent=2))
