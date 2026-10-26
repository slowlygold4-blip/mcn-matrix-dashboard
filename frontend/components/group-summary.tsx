"use client";
import {useEffect,useMemo,useState} from 'react';
import {Button} from '@/components/ui/button';
import {TableBody,TableCell,TableHead,TableHeader,TableRow} from '@/components/ui/table';
import {ScrollableTable as Table} from '@/components/scrollable-table';
import {groupEndpointRows,orderEndpointGroups} from '@/lib/replica-groups.mjs';
type Row=Record<string,any>;
const number=(n:any)=>n==null?'—':Number(n).toLocaleString('zh-CN');
const change=(n:any)=>n==null?'—':(n>0?'+':'')+number(n);

export function GroupSummary({rows,start,end,onSelect,tuantuanRosterCount}:{rows:Row[];start:string;end:string;onSelect:(dimension:string,key:string)=>void;tuantuanRosterCount?:number}){
 const [dimension,setDimension]=useState('theme'),[sort,setSort]=useState('followers.delta'),[order,setOrder]=useState('desc'),[page,setPage]=useState(1);
 const groups=useMemo(()=>orderEndpointGroups(groupEndpointRows(rows,dimension),sort,order),[rows,dimension,sort,order]);
 const members=rows.map(r=>r.id).join('/');
 useEffect(()=>{setPage(1);},[members,start,end,dimension,sort,order]);
 const pages=Math.max(1,Math.ceil(groups.length/8));
 useEffect(()=>{setPage(p=>Math.min(p,pages));},[pages]);
 const classified=rows.filter(r=>dimension==='theme'||r.classification.labels.length>0).length;
 function rank(key:string){if(sort===key)setOrder(order==='desc'?'asc':'desc');else{setSort(key);setOrder('desc');}}
 return <section className="panel group-summary" aria-label="大主题与内容分类数据">
  <div className="panel-head"><div><h2>矩阵分类经营</h2><p className="meta">{start} → {end} · 与上方经营数据使用同一范围和真实端点</p></div><div className="group-switch" role="group" aria-label="分类层级"><Button variant={dimension==='theme'?'secondary':'ghost'} aria-pressed={dimension==='theme'} onClick={()=>setDimension('theme')}>大主题</Button><Button variant={dimension==='content'?'secondary':'ghost'} aria-pressed={dimension==='content'} onClick={()=>setDimension('content')}>内容分类</Button></div></div>
  <p className="group-note">点击名称看对应账号，点击列名切换排名。{dimension==='theme'?'“启用账号”仅统计有主页采样的监控账号；团团全部作者请看同页统一名册。':`内容标签可重叠，不能把各分类相加当全局；${classified}/${rows.length} 个账号有确认标签。`}</p>
  <Table><TableHeader><TableRow><TableHead aria-sort={sort==='label'?(order==='asc'?'ascending':'descending'):'none'}><Button variant="ghost" onClick={()=>rank('label')}>分类{sort==='label'?(order==='asc'?' ↑':' ↓'):''}</Button></TableHead><TableHead aria-sort={sort==='count'?(order==='asc'?'ascending':'descending'):'none'}><Button variant="ghost" onClick={()=>rank('count')}>启用监控账号{sort==='count'?(order==='desc'?' ↓':' ↑'):''}</Button></TableHead>{[['followers','粉丝'],['likes','点赞'],['posts','作品存量']].map(([key,label])=><TableHead key={key} aria-sort={sort===key+'.delta'?(order==='asc'?'ascending':'descending'):'none'}><Button variant="ghost" onClick={()=>rank(key+'.delta')}>{label}净变{sort===key+'.delta'?(order==='desc'?' ↓':' ↑'):''}</Button></TableHead>)}</TableRow></TableHeader>
  <TableBody>{groups.slice((page-1)*8,page*8).map(g=><TableRow key={g.key}><TableCell><Button className="author" variant="link" onClick={()=>onSelect(dimension,g.key)}>{g.label}</Button>{dimension==='theme'&&g.key==='tuantuan'&&tuantuanRosterCount!=null&&<small>团团全部作者名册 {number(tuantuanRosterCount)} 位（去重）</small>}</TableCell><TableCell>{g.count}<small>有主页采样 · 非全部作者</small></TableCell>{['followers','likes','posts'].map(k=><TableCell key={k} className={g.metrics[k].delta<0?'negative':g.metrics[k].delta>0?'positive':''}>{change(g.metrics[k].delta)}<small>{g.metrics[k].comparableCount}/{g.count} 可比 · 终点已采 {number(g.metrics[k].value)}</small></TableCell>)}</TableRow>)}</TableBody></Table>
  {!groups.length&&<p className="empty">当前范围暂无确认分类，未凭昵称猜归属。</p>}
  <div className="pager" aria-label="分类翻页"><span>共 {groups.length} 类 · 第 {page}/{pages} 页</span><Button variant="outline" disabled={page<=1} onClick={()=>setPage(p=>p-1)}>上一页分类</Button><Button variant="outline" disabled={page>=pages} onClick={()=>setPage(p=>p+1)}>下一页分类</Button></div>
 </section>;
}
