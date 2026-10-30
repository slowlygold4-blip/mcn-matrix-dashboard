// Entirely synthetic identities and counters. Never reads the operator's data.
import {createHash} from 'node:crypto';
import {buildCreatorIntelligence} from '../../lib/creator-intelligence.mjs';
const revision='synthetic-fixture',generatedAt='2026-10-23T03:00:00.000Z';
const author=(row,name,douyinId,targetIds=[])=>({row,name,douyinId,posts:0,slicePosts:0,creationPosts:0,aiPosts:0,cupPosts:0,plays:null,likes:null,followers:null,targetIds});
const work=(row,id,tracks,plays,likes,date='2026-10-12')=>({row,contentId:id,author:'合成作者甲',douyinId:'fixture_a',publishDate:date,type:'切片',track:tracks.split(' / ')[0],tracks,plays,likes,title:'合成作品 '+row,url:'https://www.douyin.com/video/'+id});
export function publishedFixture(){
 const authors=[author(2,'合成作者甲','fixture_a',[1]),author(3,'合成作者乙','fixture_b',[2]),author(4,'合成作者丙','fixture_c'),author(5,'合成作者丁','fixture_d'),author(6,'合成作者戊','fixture_e')];
 authors[0]={...authors[0],posts:3,slicePosts:3,creationPosts:1,plays:100,likes:5,followers:10};
 const works=[work(2,'7300000000000000000','切片激励 / 创作激励',100,5),work(3,'7300000000000000001','切片激励',0,0,'2026-10-11'),work(4,'7300000000000000002','切片激励',null,null,null)];
 const insights=buildCreatorIntelligence(authors,works),parts=new Map();
 const seal=(section,path,items)=>{const body={version:1,revision,items},text=JSON.stringify(body)+'\n',meta={path,count:items.length,bytes:Buffer.byteLength(text),sha256:createHash('sha256').update(text).digest('hex')};parts.set(section+'/'+path,{body,text});return meta;};
 const source={version:1,revision,generatedAt,stats:{authors:5,rawAuthorRows:5,reciprocalDuplicates:0,works:3,datedWorks:2,undatedWorks:1,linkedAuthors:2,worksWithPlays:2,worksWithLikes:2,cumulativePlays:100,cumulativeLikes:5},tracks:insights.tracks.map(t=>({name:t.track,works:t.works,cumulativePlays:t.cumulativePlays})),files:[seal('creator-source','authors.json',authors),seal('creator-source','works-001.json',works),seal('creator-source','insights.json',[insights])]};
 const supplement=[{name:'合成作者甲',douyinId:'fixture_a_alias',targetIds:[1],posts:null,plays:null,likes:null,followers:null,slicePosts:null},{name:'合成作者乙',douyinId:'fixture_b_alias',targetIds:[2],posts:null,plays:null,likes:null,followers:null,slicePosts:null},{name:'合成作者己',douyinId:'fixture_f',targetIds:[3],posts:null,plays:null,likes:null,followers:null,slicePosts:null}];
 const observations=[{contentId:'7300000000000000000',author:'合成作者甲',observedAt:'2026-10-20T03:00:00Z',plays:100,likes:5},{contentId:'7300000000000000000',author:'合成作者甲',observedAt:'2026-10-21T03:00:00Z',plays:110,likes:5},{contentId:'7300000000000000001',author:'合成作者甲',observedAt:null,plays:0,likes:null}];
 const foundationParts={'authors.json':supplement,'works.json':[{contentId:'7300000000000000003',douyinId:'fixture_f',author:'合成作者己',plays:null,likes:null}],'sources.json':[{id:'fixture-source',title:'合成来源'}],'observations.json':observations,'other-authors.json':[],'other-works.json':[],'pending-authors.json':[{rowKey:'roster:'+'a'.repeat(64),douyinId:'',name:'合成未关联作者',sourceOnly:true,targetIds:[],sourceRows:[{sheet:'synthetic',row:1}],posts:null,plays:null,likes:null,followers:null}]};
 const stats=Object.fromEntries(['sourceDocuments','sourceRows','tuantuanRows','acceptedRows','unkeyedRows','ambiguousRows','invalidIdentityRows','baseAuthorEvidence','baseWorkEvidence','additionalAuthors','additionalWorks','otherAuthors','otherWorks','sourceMetricObservations','sourceMetricWorkIds','baseAuthorRows','reciprocalDuplicates','baseAuthors','baseWorks','sheets'].map(k=>[k,0]));
 Object.assign(stats,{sourceDocuments:1,additionalAuthors:3,additionalWorks:1,sourceMetricObservations:3,sourceMetricWorkIds:2,baseAuthorRows:5,baseAuthors:5,baseWorks:3,sheets:3,pendingAuthors:1});
 const foundation={version:1,revision,generatedAt,stats,sheetCoverage:[1,2,3].map(id=>({id:String(id),name:'合成表 '+id,rows:2,restricted:false})),files:Object.entries(foundationParts).map(([path,items])=>seal('table-foundation',path,items))};
 parts.set('creator-source/index.json',{body:source,text:JSON.stringify(source)+'\n'});parts.set('table-foundation/index.json',{body:foundation,text:JSON.stringify(foundation)+'\n'});
 return {authors,works,source,insights,foundation,observations,supplement,
  read(section,path){const part=parts.get(section+'/'+path);if(!part)throw Error('missing synthetic part '+path);return structuredClone(part.body);},
  bytes(section,path){return Buffer.from(parts.get(section+'/'+path).text);},
 };
}
