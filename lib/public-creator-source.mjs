/** Public source corpus, shared by the existing immutable replica publisher. */
import {createHash} from 'node:crypto';
import {readUnifiedCreatorSourceCorpus} from './creator-source-operating-view.mjs';
import {buildCreatorIntelligence,canonicalSourceAuthors} from './creator-intelligence.mjs';
import {creatorEditionIdentityPayload} from './replica-creator.mjs';
const hash=value=>createHash('sha256').update(value).digest('hex');
const integer=value=>Number.isSafeInteger(value)&&value>=0?value:null;
const norm=value=>String(value??'').normalize('NFKC').trim().toLowerCase();
const safeText=(value,limit=300)=>String(value??'').replace(/[\u0000-\u001f\u007f<>]/g,' ').trim().slice(0,limit);

export function creatorSourcePartitions(db,asOf,{sanitize:redact=safeText}={}){
  // The injected privacy redactor may retain literal/unmatched angle brackets.
  // Apply the publication contract after redaction too, without editing sources.
  const sanitize=(value,limit)=>safeText(redact(value,limit),limit);
  const corpus=readUnifiedCreatorSourceCorpus(db,asOf);if(!corpus)return [];
  const {imported,source}=corpus,byRow=new Map(source.authors.map(a=>[a.sourceRow,a]));
  const rawAuthors=db.prepare("SELECT row_number,values_json FROM creator_source_rows WHERE import_id=? AND sheet_id='08' ORDER BY row_number").all(imported.id).map(({row_number,values_json})=>{
    const row=JSON.parse(values_json);return {row:row_number,name:sanitize(row[0],160),douyinId:sanitize(row[1],120),
      posts:integer(row[6]),slicePosts:integer(row[7]),creationPosts:integer(row[8]),aiPosts:integer(row[9]),cupPosts:integer(row[10]),
      plays:integer(row[11]),likes:integer(row[12]),followers:integer(row[14]),targetIds:byRow.get(row_number)?.targetIds??[]};
  });
  const works=source.works.map(work=>({row:work.sourceRow,contentId:work.contentId,author:sanitize(work.authorName,160),
    douyinId:sanitize(work.accountId,120),publishDate:work.publishedOn||'',type:sanitize(work.contentType,80),
    track:sanitize(work.primaryTrack,100),tracks:sanitize(work.tracks.join(' / '),180),plays:integer(work.cumulativePlays),
    likes:integer(work.cumulativeLikes),title:sanitize(work.title,300),url:/^\d{16,22}$/.test(work.contentId??'')?`https://www.douyin.com/video/${work.contentId}`:null}));
  const authorWorks=new Map();for(const work of works){const key=norm(work.douyinId);if(!key)continue;
    if(!authorWorks.has(key))authorWorks.set(key,[]);authorWorks.get(key).push(work);}
  const multiplicity=new Map();for(const author of rawAuthors){const key=norm(author.douyinId);if(key)multiplicity.set(key,(multiplicity.get(key)||0)+1);}
  for(const author of rawAuthors){const key=norm(author.douyinId),items=authorWorks.get(key)||[];
    if(multiplicity.get(key)!==1||!items.length||items.length<(author.posts??0))continue;
    author.posts=items.length;
    for(const [field,metric]of [['plays','plays'],['likes','likes']]){
      const known=items.filter(w=>w[metric]!==null);if(known.length===items.length)author[field]=known.reduce((sum,w)=>sum+w[metric],0);
    }
    for(const [track,field]of [['切片激励','slicePosts'],['创作激励','creationPosts'],['即梦二创','aiPosts'],['#小团团杯S1二创大赛','cupPosts']])
      author[field]=Math.max(author[field]??0,items.filter(w=>[w.track,...w.tracks.split(' / ')].includes(track)).length);
  }
  const {authors,collapsed}=canonicalSourceAuthors(rawAuthors),insights=buildCreatorIntelligence(authors,works);
  const stats={authors:authors.length,rawAuthorRows:rawAuthors.length,reciprocalDuplicates:collapsed.length,works:works.length,
    datedWorks:insights.counts.datedWorks,undatedWorks:insights.counts.undatedWorks,linkedAuthors:authors.filter(a=>a.targetIds.length).length,
    worksWithPlays:insights.counts.playsKnown,worksWithLikes:insights.counts.likesKnown,
    cumulativePlays:insights.counts.cumulativePlays,cumulativeLikes:insights.counts.cumulativeLikes};
  const revision=String(imported.source_revision),parts=[],files=[];
  function add(name,kind,items){const payload={revision,items},content=JSON.stringify({version:1,asOf,timeZone:'Asia/Shanghai',...payload})+'\n';
    parts.push({path:'creator/'+name,kind,count:items.length,...payload});files.push({path:name,count:items.length,bytes:Buffer.byteLength(content),sha256:hash(content),generation:asOf});}
  add('authors.json','creatorAuthors',authors);
  for(let i=0;i<works.length;i+=1000)add(`works-${String(i/1000+1).padStart(3,'0')}.json`,'creatorWorks',works.slice(i,i+1000));
  add('insights.json','creatorInsights',[insights]);
  const editionFingerprint=hash(creatorEditionIdentityPayload({revision,linkFingerprint:source.currentLinks.fingerprint,
    sourceModifiedAt:imported.source_modified_at,importedAt:imported.imported_at},authors,works));
  parts.unshift({path:'creator/index.json',kind:'creatorIndex',count:works.length,revision,
    sourceModifiedAt:imported.source_modified_at,importedAt:imported.imported_at,sourceRows:imported.source_row_count??0,
    linkMode:'current-strict',linkFingerprint:source.currentLinks.fingerprint,editionFingerprint,stats,
    tracks:insights.tracks.map(t=>({name:t.track,works:t.works,cumulativePlays:t.cumulativePlays,cumulativeLikes:t.cumulativeLikes,authors:t.authors})),files,
    semantics:{plays:'已保存来源中的作品累计播放，非每日新增，非点赞估算',likes:'已保存来源中的作品累计点赞，非账号主页获赞',missing:'缺测不补零',privacy:'仅发布必要作者与作品字段'}});
  return parts;
}
