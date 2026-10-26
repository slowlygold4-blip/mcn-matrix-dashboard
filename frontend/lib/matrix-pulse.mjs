// Compare only numeric endpoint deltas already validated by the shared date engine.
// Unknown is neither zero nor a loss. Stable account IDs prevent duplicate contribution.
export function matrixPulse(roster,metricRows,key='followers'){
 if(!['followers','likes','posts'].includes(key))throw Error('unknown metric');
 const ids=new Set((roster?.rows??[]).flatMap(r=>r.accounts??[]).filter(a=>a.enabled).map(a=>a.id));
 const unique=new Map(metricRows.filter(r=>ids.has(r.id)&&r.enabled).map(r=>[r.id,r]));
 const known=[...unique.values()].filter(r=>typeof r.metrics?.[key]?.delta==='number'&&Number.isFinite(r.metrics[key].delta));
 const asc=(a,b)=>a.metrics[key].delta-b.metrics[key].delta||a.id-b.id;
 const gains=known.filter(r=>r.metrics[key].delta>0).sort((a,b)=>-asc(a,b));
 const losses=known.filter(r=>r.metrics[key].delta<0).sort(asc);
 const positive=gains.reduce((s,r)=>s+r.metrics[key].delta,0),negative=losses.reduce((s,r)=>s+r.metrics[key].delta,0);
 return {total:ids.size,known:known.length,missing:ids.size-known.length,growing:gains.length,falling:losses.length,flat:known.length-gains.length-losses.length,
 net:known.length?positive+negative:null,positive:known.length?positive:null,negative:known.length?negative:null,gains:gains.slice(0,5),losses:losses.slice(0,5),
 topFiveShare:positive>0?gains.slice(0,5).reduce((s,r)=>s+r.metrics[key].delta,0)/positive:null};
}
