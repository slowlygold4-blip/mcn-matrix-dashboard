export function changeState(value:number|null|undefined){
 if(typeof value!=='number'||!Number.isFinite(value))return {kind:'missing',icon:'?',label:'缺少可比数据'};
 if(value>0)return {kind:'positive',icon:'↗',label:'增长'};
 if(value<0)return {kind:'negative',icon:'↘',label:'减少'};
 return {kind:'neutral',icon:'→',label:'持平'};
}

export function ChangeIndicator({value}:{value:number|null|undefined}){
 const state=changeState(value);
 return <span className="change-indicator" data-change={state.kind}><span aria-hidden="true">{state.icon}</span>{state.label}</span>;
}

export function ChangeLegend(){
 return <p className="change-legend" aria-label="变化图例"><ChangeIndicator value={1}/><ChangeIndicator value={-1}/><ChangeIndicator value={0}/><ChangeIndicator value={null}/></p>;
}
