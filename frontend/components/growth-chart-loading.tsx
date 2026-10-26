"use client";
import {Button} from '@/components/ui/button';

export function GrowthChartLoading({error,retry}:{error?:Error|null;retry?:()=>void}){
 return <div className="growth-chart chart-loading" role={error?'alert':'status'} aria-busy={!error}>
  <p>{error?'图表未能加载':'正在加载图表'}</p>
  <p className="meta">上方读数、逐日表和导出仍可使用。</p>
  {error&&retry&&<Button variant="outline" onClick={retry}>重新加载图表</Button>}
 </div>;
}
