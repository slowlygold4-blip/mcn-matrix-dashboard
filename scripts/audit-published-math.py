"""Independent arithmetic replay of sealed daily partitions; never fills gaps."""
from pathlib import Path
from datetime import date,timedelta
import json,argparse,collections
p=argparse.ArgumentParser();p.add_argument('directory',type=Path);p.add_argument('--out',type=Path);args=p.parse_args()
manifest=json.loads((args.directory/'manifest.json').read_text())
fields=['followers','likes','posts'];mismatches=[];daily=collections.defaultdict(lambda:{k:{'net':0,'comparable':0} for k in fields});points=0
for meta in manifest['files']:
 if meta['kind']!='daily':continue
 rows=json.loads((args.directory/meta['path']).read_text())['items']
 index={row['date']:row for row in rows}
 if len(index)!=len(rows):raise ValueError('duplicate account day')
 for row in rows:
  points+=1;previous=index.get((date.fromisoformat(row['date'])-timedelta(days=1)).isoformat())
  for field in fields:
   current=row[field];base=None if previous is None else previous[field]
   expected=None if current is None or base is None else current-base
   if row[field+'Delta']!=expected:mismatches.append({'targetId':row['targetId'],'date':row['date'],'field':field})
   if expected is not None:daily[row['date']][field]['net']+=expected;daily[row['date']][field]['comparable']+=1
  expected_estimate=None if row['likesDelta'] is None else row['likesDelta']*100
  if row['estimatedPlaysDelta']!=expected_estimate:mismatches.append({'targetId':row['targetId'],'date':row['date'],'field':'estimatedPlaysDelta'})
result={'asOf':manifest['asOf'],'pointsChecked':points,'metricComparisons':points*4,'mismatchCount':len(mismatches),'mismatches':mismatches[:50],'daily':dict(sorted(daily.items())),'limits':['Arithmetic replay only; source identity and field attribution require separate validation.','Daily cohorts vary. Summing daily values does not prove a full-matrix period total.','Estimated plays are like change times 100, never actual platform plays.']}
if args.out:
 args.out.parent.mkdir(parents=True,exist_ok=True)
 args.out.write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
print(json.dumps({k:v for k,v in result.items() if k!='daily'},ensure_ascii=False))

raise SystemExit(1 if mismatches else 0)
