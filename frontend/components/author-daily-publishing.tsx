"use client";
import {Button} from '@/components/ui/button';
import {Input} from '@/components/ui/input';
type Model={date:string;end:string;status:string;knownWorks:number;undatedWorks:number;futureDatedWorks:number;ownershipClaimWorks?:number;currentDay:boolean};
export function AuthorDailyPublishing({model,onlyDay,onDate,onFilter}:{model:Model;onlyDay:boolean;onDate:(date:string)=>void;onFilter:(enabled:boolean)=>void}){
 return <section aria-label="此作者每日发布情况">
  <div className="panel-head"><h3>每日发布情况</h3><label>北京日期<Input type="date" aria-label="查看此作者哪一天的发布情况" min="2026-09-12" max={model.end} value={model.date} onChange={event=>onDate(event.target.value)}/></label></div>
  <p role="status" aria-live="polite">{model.date} · {model.status==='published'?<strong className="positive">已有发布记录 · 至少 {model.knownWorks.toLocaleString('zh-CN')} 条</strong>:<strong>发布情况待确认</strong>}{model.currentDay?' · 当日尚未结束':''}</p>
  <p className="meta">按已保存的作品发布日期去重统计。作品覆盖尚未齐全，已有条数是下限；无记录不能判断为未发布。{model.undatedWorks>0?`另有 ${model.undatedWorks.toLocaleString('zh-CN')} 条作品未记录有效发布日期。`:''}{model.futureDatedWorks>0?`另有 ${model.futureDatedWorks.toLocaleString('zh-CN')} 条晚于版本截止日，未计入当天。`:''}</p>
  {!!model.ownershipClaimWorks&&<p className="notice">另有 {model.ownershipClaimWorks.toLocaleString('zh-CN')} 条原登记声明的发布者属于其他账号，保留在全部日期，未计入本作者的每日发布数。</p>}
  <div className="period-toolbar"><Button variant={onlyDay?'secondary':'outline'} aria-pressed={onlyDay} disabled={model.status!=='published'} onClick={()=>onFilter(true)}>仅看这一天的作品</Button><Button variant={!onlyDay?'secondary':'outline'} aria-pressed={!onlyDay} onClick={()=>onFilter(false)}>查看全部日期</Button></div>
 </section>;
}
