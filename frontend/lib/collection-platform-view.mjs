const platforms=['douyin','bilibili','xiaohongshu','kuaishou','unknown'];
const counter=n=>Number.isSafeInteger(n)&&n>=0;
const instant=s=>typeof s==='string'&&Number.isFinite(Date.parse(s))&&new Date(s).toISOString()===s;
const keys=(row,names)=>row&&names.every(name=>counter(row[name]));
function projectRows(value,fields,valid){
 if(!Array.isArray(value)||value.length>platforms.length)return null;
 const seen=new Set(),rows=[];
 for(const row of value){
  if(!row||!platforms.includes(row.platform)||seen.has(row.platform)||!keys(row,fields)||!valid(row))return null;
  seen.add(row.platform);rows.push({platform:row.platform,...Object.fromEntries(fields.map(key=>[key,row[key]]))});
 }
 return rows.sort((a,b)=>platforms.indexOf(a.platform)-platforms.indexOf(b.platform));
}
export function projectCollectionPlatforms(status){
 const rolling=projectRows(status?.rolling?.platforms,['accounts','profiles','worksComplete','worksLimited','workIssues'],
  row=>row.profiles<=row.accounts&&row.worksComplete+row.worksLimited<=row.accounts&&row.workIssues<=row.accounts);
 const raw=status?.dailyWorkLikes;
 /** @type {null|{date:string,since:string,asOf:string,basis:string,platforms:any[],comparability?:{version:number,previousDate:string,platforms:any[]}}} */
 let daily=null;
 if(raw?.basis==='stored-work-like-observations'&&instant(raw.asOf)&&raw.asOf===status?.observedAt
  &&raw.date===new Date(Date.parse(raw.asOf)+8*3600000).toISOString().slice(0,10)
  &&raw.since===new Date(Date.parse(raw.date+'T00:00:00.000Z')-8*3600000).toISOString()){
  const rows=projectRows(raw.platforms,['storedWorks','observedWorks','observedAccounts'],row=>row.observedWorks<=row.storedWorks
   &&(row.observedWorks>0||row.observedAccounts===0)&&(!rolling||rolling.some(item=>item.platform===row.platform&&row.observedAccounts<=item.accounts)));
  if(rows&&(!rolling||rows.length===rolling.length)){
   daily={date:raw.date,since:raw.since,asOf:raw.asOf,basis:raw.basis,platforms:rows};
   const change=raw.comparability,previousDate=new Date(Date.parse(raw.date+'T00:00:00.000Z')-86400000).toISOString().slice(0,10);
   if(change?.version===1&&change.previousDate===previousDate){
    const changes=projectRows(change.platforms,['knownTodayWorks','comparableWorks','missingBaselineWorks','conflictingWorks'],row=>{
     const source=rows.find(item=>item.platform===row.platform);
     return !!source&&row.comparableWorks+row.missingBaselineWorks===row.knownTodayWorks
      &&row.knownTodayWorks<=source.observedWorks&&row.knownTodayWorks+row.conflictingWorks<=source.storedWorks;
    });
    if(changes&&changes.length===rows.length)daily.comparability={version:1,previousDate,platforms:changes};
   }
  }
 }
 const profile=status?.dailyProfiles;
 let dailyProfiles=null;
 if(rolling&&profile?.version===1&&profile.basis==='accepted-profile-day-ends'
  &&instant(profile.asOf)&&profile.asOf===status?.observedAt
  &&profile.date===new Date(Date.parse(profile.asOf)+8*3600000).toISOString().slice(0,10)
  &&profile.since===new Date(Date.parse(profile.date+'T00:00:00.000Z')-8*3600000).toISOString()
  &&profile.previousDate===new Date(Date.parse(profile.date+'T00:00:00.000Z')-86400000).toISOString().slice(0,10)){
  const metricNames=['observed','comparable','missingBaseline','conflicting'];
  const rows=projectRows(profile.platforms,['accounts'],row=>{
   const original=rolling.find(item=>item.platform===row.platform);
   return original?.accounts===row.accounts&&['followers','totalLikes'].every(name=>{
    const metric=row[name];return keys(metric,metricNames)&&metric.comparable+metric.missingBaseline===metric.observed
     &&metric.observed+metric.conflicting<=row.accounts;
   });
  });
  if(rows&&rows.length===rolling.length){
   const clean=rows.map(row=>{
    const original=profile.platforms.find(item=>item.platform===row.platform);
    return {...row,...Object.fromEntries(['followers','totalLikes'].map(name=>[name,Object.fromEntries(metricNames.map(key=>[key,original[name][key]]))]))};
   });
   dailyProfiles={version:1,basis:profile.basis,date:profile.date,since:profile.since,previousDate:profile.previousDate,asOf:profile.asOf,platforms:clean};
  }
 }
 return {rolling,daily,dailyProfiles};
}
