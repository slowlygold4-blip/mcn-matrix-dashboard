const count=value=>Number.isSafeInteger(value)&&value>=0;

/** Accept older sealed analyses without undatedWorks, but never drop undated records from the total. */
export function validateCreatorInsights(items,index){
 if(!Array.isArray(items)||items.length!==1||!items[0]?.counts)throw Error('表格分析分区格式无效');
 const insight=items[0],c=insight.counts,s=index?.stats;
 const undated=c.undatedWorks??0;
 if(!s||!count(c.tableWorks)||!count(c.tableAuthors)||!count(c.datedWorks)||!count(undated)
  ||c.tableWorks!==s.works||c.tableAuthors!==s.authors||c.datedWorks+undated!==c.tableWorks)
  throw Error('表格分析与原始来源条数不符');
 for(const [key,value]of [['datedWorks',c.datedWorks],['undatedWorks',undated]]){
  if(s[key]!==undefined&&s[key]!==value)throw Error('表格分析发布日期统计与来源不符');
 }
 return insight;
}
