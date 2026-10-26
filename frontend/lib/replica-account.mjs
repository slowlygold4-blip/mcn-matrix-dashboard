import {validDate} from './replica-model.mjs';
import {summaryPointValid} from './replica-summary.mjs';
const fields=['targetId','date','capturedAt','followers','followersAt','likes','likesAt','posts','postsAt'];
const idValid=id=>Number.isSafeInteger(id)&&id>0&&id<=99_999_999;
const generationValid=g=>typeof g==='string'&&Number.isFinite(Date.parse(g))&&new Date(g).toISOString()===g;
function validateRange(start,end){if((start===null)!==(end===null)||start!==null&&(!validDate(start)||!validDate(end)||start>end))throw Error('账号日期链接不完整或无效，请重新选择两个日期');}
function validateComparison(comparison){
 if(!comparison||typeof comparison.compare!=='boolean')throw Error('账号比较状态无效');
 if(comparison.compare&&(!validDate(comparison.otherStart)||!validDate(comparison.otherEnd)||comparison.otherStart>comparison.otherEnd))throw Error('账号比较日期不完整或无效，请选择两个有序日期');
}
export function parseAccountRequest(search){
 const params=new URLSearchParams(search);
 for(const key of ['account','start','end','generation','compareStart','compareEnd'])if(params.getAll(key).length>1)throw Error('账号链接包含重复参数');
 if(!params.has('account')){if(['start','end','generation','compareStart','compareEnd'].some(k=>params.has(k)))throw Error('账号链接缺少账号编号');return null;}
 const raw=params.get('account'),id=Number(raw),start=params.get('start'),end=params.get('end'),generation=params.get('generation');
 if(!idValid(id)||String(id)!==raw)throw Error('账号链接编号无效');
 validateRange(start,end);if(generation!==null&&!generationValid(generation))throw Error('账号链接数据版本无效');
 const otherStart=params.get('compareStart'),otherEnd=params.get('compareEnd');
 if(otherStart===null&&otherEnd===null)return {id,start,end,generation};
 const comparison={compare:true,otherStart,otherEnd};validateComparison(comparison);
 return {id,start,end,generation,comparison};
}
export function accountShareQuery({id,start,end,generation,comparison}){
 if(!idValid(id)||!generationValid(generation)||start===null||end===null)throw Error('未取得可分享的账号和日期');validateRange(start,end);
 const params=new URLSearchParams({account:String(id),start,end,generation});
 if(comparison!==undefined){validateComparison(comparison);if(comparison.compare){params.set('compareStart',comparison.otherStart);params.set('compareEnd',comparison.otherEnd);}}
 return '?'+params;
}
export function personalPoints(items,id,asOf){
 if(!idValid(id)||!Array.isArray(items))throw Error('账号历史无效');
 const dates=new Set();return items.map(item=>{const p=Object.fromEntries(fields.map(k=>[k,item[k]]));if(p.targetId!==id||!summaryPointValid(p,asOf)||dates.has(p.date))throw Error('账号历史日期或采样来源不一致');dates.add(p.date);return p;});
}
export function personalWindow(points,asOf){
 if(!generationValid(asOf)||points.some(p=>!summaryPointValid(p,asOf)))throw Error('账号采样窗口无效');
 const dates=points.map(p=>p.date).sort();return {start:dates[0]||null,end:dates.at(-1)||null};
}
