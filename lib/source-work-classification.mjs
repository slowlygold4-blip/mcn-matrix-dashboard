/** Content membership is distinct from admission to a named incentive track. */
export const sourceWorkClassificationKeys=Object.freeze(['slice','original','ai-remix','contest']);
const labels=Object.freeze({slice:'切片',original:'原创','ai-remix':'AI二创',contest:'赛事收录'});
const trackKeys=Object.freeze({'切片激励':'slice','创作激励':'original','即梦二创':'ai-remix','#小团团杯S1二创大赛':'contest'});
export const sourceContentFilterOptions=Object.freeze(sourceWorkClassificationKeys.map(key=>Object.freeze({key:'content:'+key,label:labels[key]})));
export const sourceWorkClassificationsValid=value=>Array.isArray(value)&&value.length<=4
  &&value.every(key=>sourceWorkClassificationKeys.includes(key))&&new Set(value).size===value.length;
export function sourceContentClassifications(row,view='works'){
  const explicit=view==='authors'?row.registeredClassifications:row.classifications;
  const result=sourceWorkClassificationsValid(explicit)?[...explicit]:[];
  if(view==='authors'){
    for(const [key,field] of [['slice','slicePosts'],['original','creationPosts'],['ai-remix','aiPosts'],['contest','cupPosts']])
      if(Number(row[field])>0)result.push(key);
  }else{
    for(const name of [row.track,...String(row.tracks??'').split(/\s+\/\s+/)])if(trackKeys[name])result.push(trackKeys[name]);
  }
  return [...new Set(result)];
}
export const sourceWorkClassificationLabel=row=>sourceContentClassifications(row).map(key=>labels[key]).join(' / ');
