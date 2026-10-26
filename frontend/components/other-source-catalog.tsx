"use client";
import {useMemo,useState} from 'react';
import {Button} from '@/components/ui/button';
import {Input} from '@/components/ui/input';
import {TableScrollFrame} from '@/components/table-scroll-frame';

type Row=Record<string,any>;
const fmt=(value:number)=>value.toLocaleString('zh-CN');
const search=(value:unknown)=>String(value??'').normalize('NFKC').toLocaleLowerCase();
export function OtherSourceCatalog({foundation,accounts,board='all',onOpenAccount}:{foundation:Row|null;accounts:Row[];board?:string;onOpenAccount:(account:Row,trigger:HTMLButtonElement)=>void}){
 const [view,setView]=useState<'authors'|'works'>('authors'),[query,setQuery]=useState(''),[chosenBoard,setChosenBoard]=useState('all'),[page,setPage]=useState(1);
 const boards=useMemo(()=>[...new Set((foundation?.otherAuthors||[]).map((row:Row)=>row.board))].sort() as string[],[foundation]);
 const effectiveBoard=board!=='all'?board:chosenBoard;
 const list=useMemo(()=>{const rows=(view==='authors'?foundation?.otherAuthors:foundation?.otherWorks)||[],q=search(query).trim();return rows.filter((row:Row)=>(effectiveBoard==='all'||row.board===effectiveBoard)&&(!q||[row.name,row.author,row.platformId,row.contentId,row.board].some(value=>search(value).includes(q))));},[foundation,view,effectiveBoard,query]);
 const pages=Math.max(1,Math.ceil(list.length/30)),current=Math.min(page,pages),shown=list.slice((current-1)*30,current*30);
 const byId=useMemo(()=>new Map(accounts.map(account=>[account.id,account])),[accounts]);
 if(!foundation)return null;
 return <section className="panel other-source-catalog" aria-label="其他板块表格来源索引"><div className="panel-head"><div><p className="eyebrow">OTHER TABLE SOURCES</p><h2>其他板块与未分板块来源</h2></div><span className="meta">作者身份 {fmt(foundation.index.stats.otherAuthors)} · 作品 ID {fmt(foundation.index.stats.otherWorks)}</span></div>
 <p className="meta">仅根据原表明确板块归类；空白板块保留“未分板块”。作者按平台账号 ID 去重，作品按明确作品 ID 去重；这里只是来源记录，不自动算入主页增长。</p>
 <div className="source-controls"><div role="group" aria-label="其他来源类型"><Button variant={view==='authors'?'secondary':'outline'} onClick={()=>{setView('authors');setPage(1);}}>作者</Button><Button variant={view==='works'?'secondary':'outline'} onClick={()=>{setView('works');setPage(1);}}>作品</Button></div>{board==='all'&&<label>原表板块<select value={chosenBoard} onChange={event=>{setChosenBoard(event.target.value);setPage(1);}}><option value="all">全部板块</option>{boards.map(name=><option key={name} value={name}>{name}</option>)}</select></label>}<Input aria-label="搜索其他板块来源" placeholder="搜索作者、账号 ID 或作品 ID" value={query} onChange={event=>{setQuery(event.target.value);setPage(1);}}/></div>
 <div className="source-pager"><span>符合条件 {fmt(list.length)} 条 · 第 {current}/{pages} 页</span><Button variant="outline" disabled={current<=1} onClick={()=>setPage(current-1)}>上一页</Button><Button variant="outline" disabled={current>=pages} onClick={()=>setPage(current+1)}>下一页</Button></div>
 <TableScrollFrame scrollLabel={view==='authors'?'其他来源作者数据表':'其他来源作品数据表'} scrollSelector=".source-table-wrap"><div className="source-table-wrap"><table className="source-table"><thead><tr><th>原表板块</th><th>{view==='authors'?'作者 / 平台账号 ID':'作品 ID / 作者'}</th><th>平台关联</th><th>来源证据</th></tr></thead><tbody>{shown.map((row:Row,index:number)=><tr key={`${row.board}:${row.platformId||row.contentId}:${index}`}><td>{row.board}</td><td><strong>{row.name||row.contentId||'未命名'}</strong><small>{row.platform==='bilibili'?'B站 · ':row.platform==='xiaohongshu'?'小红书 · ':''}{row.platformId||row.contentId||'未记录'}</small>{view==='works'&&<small>{row.author||'作者未记录'}</small>}</td><td>{row.targetIds?.length?row.targetIds.map((id:number)=>{const account=byId.get(id);return account?<Button key={id} variant="link" onClick={event=>onOpenAccount(account,event.currentTarget)}>{account.label} · 主页采样</Button>:null;}):'仅表格来源'}</td><td>{row.evidenceRows} 行<small>{row.sourceTitles?.join('、')}</small></td></tr>)}</tbody></table></div></TableScrollFrame>{!shown.length&&<p className="empty">当前范围暂无可严格索引的来源记录。</p>}
 <p className="meta">只有链接、没有可核验账号或作品 ID 的行保留在本机原始表；不会凭昵称猜归属或补造平台指标。</p></section>;
}
