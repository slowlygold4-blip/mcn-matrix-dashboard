import {existsSync,readFileSync,writeFileSync,renameSync,mkdirSync} from 'node:fs';
import {dirname} from 'node:path';
// Runtime checkpoint only: observations retain their real sampling timestamps.
export class ContinuousCollectionRound {
  constructor(path,initialStart){
    this.path=path;
    this.state=existsSync(path)?JSON.parse(readFileSync(path,'utf8')):{version:1,round:1,startedAt:initialStart};
    if(this.state.version!==1||!Number.isSafeInteger(this.state.round)||this.state.round<1||!Number.isFinite(Date.parse(this.state.startedAt)))throw Error('持续采集检查点无效');
    if(!existsSync(path))this.save();
  }
  save(){mkdirSync(dirname(this.path),{recursive:true});writeFileSync(this.path+'.tmp',JSON.stringify(this.state)+'\n',{mode:0o600});renameSync(this.path+'.tmp',this.path);}
  window(now=new Date()){
    return {key:`continuous:${this.state.round}:${this.state.startedAt}`,startsAt:this.state.startedAt,endsAt:'9999-12-31T23:59:59.999Z',asOf:now.toISOString(),intervalHours:null,timeZone:'Asia/Shanghai',slotTimes:[]};
  }
  advance(expectedKey,now=new Date()){
    if(this.window(now).key!==expectedKey||now.getTime()-Date.parse(this.state.startedAt)<60_000)return false;
    const old=this.state;this.state={version:1,round:old.round+1,startedAt:now.toISOString()};
    try{this.save();}catch(error){this.state=old;throw error;}return true;
  }
}
