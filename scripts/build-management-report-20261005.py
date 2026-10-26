from pathlib import Path
import json, csv, zipfile, html
from reportlab.pdfgen import canvas
from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import Paragraph, Table, TableStyle
from reportlab.lib.styles import ParagraphStyle

ROOT=Path(__file__).resolve().parents[1]
DIR=ROOT/'reports/2026-10-05'
OUT=ROOT/'output/pdf'
OUT.mkdir(parents=True,exist_ok=True)
E=DIR/'evidence'
load=lambda k:json.loads((E/(k+'.json')).read_text())
A=load('analysis'); W=load('week'); M=load('month'); P=load('priorWeek'); T=load('today'); C=load('accumulated')
PDF=OUT/'MCN矩阵经营数据报告_2026-10-05.pdf'
pdfmetrics.registerFont(TTFont('CN','/System/Library/Fonts/Supplemental/Arial Unicode.ttf'))
WID,HEI=A4; LEFT=42; RIGHT=WID-42; WIDTH=RIGHT-LEFT
BLUE=colors.HexColor('#002FA7'); INK=colors.HexColor('#172230'); MUTED=colors.HexColor('#5B6778'); LIGHT=colors.HexColor('#EEF3FA'); LINE=colors.HexColor('#D9E0EA'); RED=colors.HexColor('#AC3543')
c=canvas.Canvas(str(PDF),pagesize=A4)
c.setTitle('MCN矩阵经营数据报告 2026年10月5日');c.setAuthor('MCN 矩阵数据台')
md=[];checks=[]
def num(n,sign=False):
    if n is None:return '缺测'
    return ('+' if sign and n>0 else '')+f'{n:,.0f}'
def compact(n,sign=False):
    if n is None:return '缺测'
    prefix='+' if sign and n>0 else ''
    if abs(n)>=100000000:return prefix+f'{n/100000000:.2f}亿'
    if abs(n)>=10000:return prefix+f'{n/10000:.2f}万'
    return prefix+f'{n:,.0f}'
def text(txt,x,y,size=10,color=INK):
    c.setFont('CN',size);c.setFillColor(color);c.drawString(x,HEI-y,txt)
def para(txt,y,size=10.5,color=INK,width=WIDTH,x=LEFT,space=10,record=True):
    p=Paragraph(txt,ParagraphStyle('body',fontName='CN',fontSize=size,leading=size*1.6,textColor=color,wordWrap='CJK'))
    _,h=p.wrap(width,1000)
    if y+h>778:raise ValueError(f'Overflow at {y+h}: {txt[:35]}')
    p.drawOn(c,x,HEI-y-h)
    if record:md.append(txt.replace('<br/>','\n'))
    checks.append((page,y,y+h,txt[:30]))
    return y+h+space
def start(n,title,sub):
    global page
    page=n
    c.setFillColor(BLUE);c.rect(LEFT,HEI-34,24,3,fill=1,stroke=0)
    text('MCN  /  经营观察',LEFT+34,35,8,MUTED)
    text('2026.10.05',RIGHT-62,35,8,MUTED)
    text(title,LEFT,80,22)
    para(sub,95,size=9,color=MUTED,record=False)
    md.extend(['\n# '+title,sub])
def end():
    c.setStrokeColor(LINE);c.line(LEFT,47,RIGHT,47)
    text('北京时间  |  已保存快照  |  完整日截至 2026-10-04',LEFT,HEI-31,8,MUTED)
    text(f'{page} / 7',RIGHT-27,HEI-31,8,MUTED)
    c.showPage()
def heading(t,y):
    text(t,LEFT,y+13,13);md.append('\n## '+t);return y+27
def table(headers,rows,widths,y,size=9):
    def cell(v,head=False):
        return Paragraph(html.escape(str(v)),ParagraphStyle('cell',fontName='CN',fontSize=size,leading=size*1.5,textColor=colors.white if head else INK,wordWrap='CJK'))
    data=[[cell(v,True) for v in headers]]+[[cell(v) for v in r] for r in rows]
    t=Table(data,colWidths=widths,repeatRows=1)
    t.setStyle(TableStyle([('BACKGROUND',(0,0),(-1,0),BLUE),('GRID',(0,0),(-1,-1),.35,LINE),('VALIGN',(0,0),(-1,-1),'MIDDLE'),('LEFTPADDING',(0,0),(-1,-1),8),('RIGHTPADDING',(0,0),(-1,-1),8),('TOPPADDING',(0,0),(-1,-1),7),('BOTTOMPADDING',(0,0),(-1,-1),7),('ROWBACKGROUNDS',(0,1),(-1,-1),[colors.white,colors.HexColor('#F6F8FB')])]))
    _,h=t.wrap(WIDTH,1000)
    if y+h>778:raise ValueError(f'Table overflow {y+h} {headers}')
    t.drawOn(c,LEFT,HEI-y-h)
    md.append('| '+' | '.join(headers)+' |');md.append('| '+' | '.join(['---']*len(headers))+' |')
    md.extend('| '+' | '.join(str(v) for v in r)+' |' for r in rows)
    checks.append((page,y,y+h,'table'))
    return y+h+14
def cards(items,y):
    gap=12;w=(WIDTH-gap*(len(items)-1))/len(items)
    for i,(label,value,note) in enumerate(items):
        x=LEFT+i*(w+gap)
        c.setFillColor(LIGHT);c.roundRect(x,HEI-y-92,w,92,7,fill=1,stroke=0)
        text(label,x+12,y+22,9,MUTED);text(value,x+12,y+53,24,BLUE)
        text(note,x+12,y+76,8,MUTED)
        md.append(f'{label}：{value}（{note}）')
    return y+108
def bars(labels,values,x,y,width,height,title,unit=''):
    text(title,x,y,11)
    maxv=max([abs(v or 0) for v in values]) or 1
    ploty=y+25;bottom=ploty+height
    c.setStrokeColor(LINE);c.line(x,bottom and HEI-bottom,x+width,HEI-bottom)
    step=width/len(values); bw=step*.58
    for i,(label,v) in enumerate(zip(labels,values)):
        h=(v or 0)/maxv*(height-18)
        c.setFillColor(BLUE if (v or 0)>=0 else RED);c.rect(x+i*step+(step-bw)/2,HEI-bottom,bw,h,stroke=0,fill=1)
        val=f'{v/10000:.1f}' if unit=='万' else str(v)
        text(val,x+i*step+2,bottom-h-7,7,MUTED);text(label,x+i*step+2,bottom+15,7,MUTED)
    if unit:text(f'单位：{unit}',x+width-47,y,8,MUTED)
def enabled(d):return [x for x in d['accounts'] if x['enabled']]
def scoped(d,key):return [x for x in enabled(d) if x['classification']['theme']['key']==key]
def stat(rows,key):
    vals=[a['metrics'][key]['delta'] for a in rows if a['metrics'][key]['comparable']]
    return (sum(vals) if vals else None,len(vals))
def nonstream(d):return [x for x in enabled(d) if x['classification']['theme']['key']!='douyin-streamers']

# 1 Executive summary
start(1,'MCN 矩阵经营数据报告','监控积累 2026-09-12 至 2026-10-04  |  最新补充采样 2026-10-05  |  面向矩阵负责人')
y=140
y=para('团团主题仍在增长，但增粉速度放缓，获赞贡献集中。经营判断应先看业务主题，再看全量监控池；头部主播观察数据不宜直接记作旗下矩阵业绩。',y,14)
y=cards([('团团近 7 天粉丝净增','+4,612','545 / 556 个账号可比'),('团团近 7 天获赞净增','+41.05万','较上周由负转正'),('团团作品存量净增','+1,098','不等于新增发布量')],y+3)
y=heading('这份报告最值得关注的三件事',y)
for title,body in [
 ('01  总盘与业务主题必须分开','近 7 天全部监控池获赞净增 2,579.16 万，其中 98.29% 来自“抖音主播”主题。剔除此观察主题后，其他主题获赞净增为 440,411；团团贡献其中的 93.21%。这更接近当前业务主题的经营视角，但仍不等同已核实合同归属。'),
 ('02  团团增粉放缓，优先复盘高贡献账号','同一批 545 个团团账号，周净增粉由 6,207 降至 4,612，下降 25.70%。别碰小羊的熊熊贡献 139,135 净增赞，占团团净增赞的 33.9%；建议优先复盘其内容与分发方式，而不是只增加账号数量。'),
 ('03  主页数据可用不代表作品明细齐全','10 月 4 日主页指标覆盖 697 / 701，完整作品明细覆盖仅 85 / 701。可以据此判断粉丝、获赞和作品存量变化；不能据此承诺完整新增投稿量、作品播放量或单条内容效率。')]:
    y=para(title,y,11.5,BLUE,space=4);y=para(body,y,10,space=13)
y=para('阅读顺序：第 2 页看积累与周期，第 3 页看主题，第 4–5 页看团团和账号，第 6 页看话题，第 7 页看数据边界与行动。',y,9,MUTED)
end()

# 2 Periods and accumulation
start(2,'监控积累与周期表现','全量监控池与业务主题分开读  |  近 7 天为 09-28 至 10-04  |  本月为 10-01 至 10-04')
y=cards([('已启用监控','701','抖音 687 / B站 14'),('已登记但暂停','60','不计入本报告增长'),('总表待唯一定位','645','资料条目，不等于监控账号')],140)
y=para('总表共 1,406 条资料，761 个已登记账号，其中 701 个启用。小红书、快手尚无启用监控账号。待定位资料可能包含重复或不完整信息，不能算作已经监控成功的独立作者。',y,9.5)
y=heading('不同周期的真实净变化',y)
rows=[]
for k,label in [('accumulated','09-12 至 10-04'),('week','最近完整 7 天'),('month','10 月前 4 天')]:
    d=A['periods'][k]['counts'];rows.append([label,num(d['followers']['delta'],1),num(d['likes']['delta'],1),num(d['posts']['delta'],1),f"{d['followers']['n']} / {d['likes']['n']} / {d['posts']['n']}"])
y=table(['统计期','粉丝净变化','获赞净变化','作品存量净变化','可比账号 粉/赞/作'],rows,[113,98,106,90,WIDTH-407],y,8.6)
y=para('以上均为全部监控池的部分可比账号合计。09-12 完整区间仅 454 / 701 个账号粉丝可比、440 / 701 个账号获赞可比；不宜外推为全矩阵成绩。不同周期的可比账号集合不同，不能直接相减求中间阶段增长。',y,9,MUTED)
y=heading('覆盖更充分的共同已记录时段',y)
r=C['recordedWindow'];y=para(f"09-14 当日采样 → 10-04 当日采样，同一批 {r['comparableCount']} 个账号：粉丝 {num(r['metrics']['followers']['delta'],1)}，获赞 {num(r['metrics']['likes']['delta'],1)}，作品存量 {num(r['metrics']['posts']['delta'],1)}。这是单列的共同采样时段，不能改称 09-12 起完整增长。",y,10)
y=heading('与上一完整 7 天对比',y)
rows=[]
for k,label in [('followers','粉丝净增'),('likes','获赞净增'),('posts','作品存量净增')]:
    s=A['pairedWeek'][k];rows.append([label,num(s['prior'],1),num(s['current'],1),f"{s['percent']:+.2f}%"])
y=table(['同一批 687 个账号','09-21 至 09-27','09-28 至 10-04','变化幅度'],rows,[145,125,125,WIDTH-395],y,9)
y=para('以上不是总存量增长率，而是两周“净变化数”的环比。账号粉丝累计数也不是跨账号去重后的独立用户规模。',y,9,MUTED)
end()

# 3 Themes and daily dynamics
start(3,'最近七天主题表现','主题按账号 ID 去重且单一归属  |  分类取冻结提取时的主表与证据记录')
y=140
rows=[]
for t in A['themes']:
    rows.append([t['label'],str(t['count']),f"{t['likes']['n']}/{t['count']}",num(t['followers']['delta'],1),num(t['likes']['delta'],1),num(t['posts']['delta'],1)])
y=table(['大主题','启用','可比','粉丝净变化','获赞净变化','作品存量净变化'],rows,[88,42,55,100,113,WIDTH-398],y,8.8)
y=para('“抖音主播”主题按观察口径单列，不推定为旗下签约账号。不能用板块人数相加：当前板块关系存在交叉；例如“抖音主播板块”还挂有团团主题账号。报告采用大主题单一归属，避免重复统计。',y,9.4,MUTED)
y=heading('业务主题合计与贡献',y)
y=para('剔除“抖音主播”主题后：590 个启用账号，578 个可比；粉丝净增 5,371、获赞净增 440,411、作品存量净增 1,141。其中团团获赞净增 410,490，老飞宇 29,836，玉麒麟 85。',y,11)
y=heading('逐日净变化观察',y+4)
pts=A['periods']['week']['trend'];labels=[p['date'][5:] for p in pts]
bars(labels,[p['followersDelta'] for p in pts],LEFT,y+8,238,112,'全监控池每日粉丝净变化','万')
bars(labels,[p['likesDelta'] for p in pts],LEFT+270,y+8,238,112,'全监控池每日获赞净变化','万')
y+=186
y=para('每日可比账号数：09-28 为 687，09-29 为 696，09-30 至 10-04 为 697。每天只比较相邻两天有观测的同一账号；每天的账号集合并不完全相同，柱状图不可当作固定样本折线，逐日合计也不必等于区间端点差。',y,9,MUTED)
y=para('10-01 获赞净增约 589.80 万，为本周单日最高；10-02 粉丝净增约 61.11 万，为本周单日最高。峰值主要受主播观察主题影响，不能直接推导切片矩阵运营爆发。',y,10)
end()

# 4 Tuantuan and category
start(4,'团团矩阵与内容分类','本页仅统计团团大主题  |  不把“一条小团团OvO”主播主号自动合并进切片矩阵')
y=140
rows=[]
for key,label in [('week','09-28 至 10-04'),('month','10-01 至 10-04')]:
    t=A['tuantuan'][key];rows.append([label,f"{t['likes']['n']}/556",num(t['followers']['delta'],1),num(t['likes']['delta'],1),num(t['posts']['delta'],1)])
y=table(['期间','可比账号','粉丝净变化','获赞净变化','作品存量净变化'],rows,[121,71,101,108,WIDTH-401],y,9)
y=para('周度同批 545 个账号：粉丝净增下降 25.70%；作品存量净增从 1,016 到 1,098，增加 8.07%。获赞从 -73,195 转为 +410,490，改善 483,685，不计算“负基数增长率”。',y,10)
y=para('需要注意：上周“美味大红鼠”单账号获赞净减 396,324，显著影响上周基数。当前转正可能包含异常存量变化的影响，不能直接归因为内容策略改善。',y,9.5,RED)
y=heading('常用内容标签的周度表现',y+2)
rows=[]
for key in ['slice','original','ai-remix','remix','live-hotspot','game']:
    t=next(x for x in A['tuantuan']['labels'] if x['key']==key)
    rows.append([t['label'],f"{t['likes']['n']}/{t['count']}",num(t['followers']['delta'],1),num(t['likes']['delta'],1),num(t['posts']['delta'],1)])
y=table(['标签','可比/启用','粉丝净变化','获赞净变化','作品存量净变化'],rows,[104,75,103,118,WIDTH-400],y,9)
y=para('标签可以重叠，表内各行不能相加；它们来自账号资料与既有分类规则，并非对本周每条作品逐条识别。“别碰小羊的熊熊”同时带切片、原创、AI二创等标签，因此不能据此证明 AI 内容比其他类型更有效。',y,9.5,MUTED)
y=heading('这组数据对应的运营判断',y)
y=para('切片标签覆盖 289 个启用账号，285 个可比，贡献净增赞 356,773；它是当前最值得持续追踪的入口。团团主题有 292 个可比账号作品存量不变、23 个净减少，但“存量不变”不等于没有发布，不能直接将这些账号判为停更。',y,10)
y=para('建议把复盘分为两类：一类是高贡献内容的可复制因素；另一类是掉粉、获赞回落或作品存量骤减的账号核查。不要仅靠作品存量变化考核发布勤奋度。',y,10)
end()

# 5 Accounts
start(5,'重点账号与处理优先级','团团主题近 7 天榜单  |  原始名称与账号 ID 一并保留在数据附件')
y=heading('获赞净增前八名',139)
rows=[[x['name'],num(x['followers'],1),num(x['likes'],1),num(x['posts'],1)] for x in A['tuantuan']['ranking']['up']]
y=table(['账号','粉丝净变化','获赞净变化','作品存量净变化'],rows,[198,90,110,WIDTH-398],y,9.2)
y=para('别碰小羊的熊熊净增赞 139,135，占团团净增赞合计 33.9%。这是净贡献占比，不是观看份额，也不是收入贡献。建议优先抽查其高表现作品，保留源链接后做可复制性复盘。',y,9.4,MUTED)
y=heading('优先核查名单',y)
risks=[['团团家的粉丝日记','粉丝 -799；获赞 -392','核对账号变化及近期内容'],['一条条小团团ovo','粉丝 -775；获赞 -84','关注持续掉粉与内容方向'],['the only1','作品存量 -161；获赞 -291','核实删除、隐藏或平台统计变化'],['五月半OvO','获赞 -720；作品存量 +9','检查获赞回落，不推定违规']]
y=table(['账号','本周异常信号','建议动作'],risks,[157,173,WIDTH-330],y,8.8)
y=heading('主播观察侧的参考信号',y)
y=para('粉丝净增前三：陈伯(全能王) +735,916、HangHang +445,783、一条小团团OvO +395,989。获赞净增前三：HangHang +3,314,881、成成大王（三角洲行动）+2,062,982、林树（三角洲行动）+1,728,917。仅作观察参考，不记为团团切片账号业绩。',y,9.4)
end()

# 6 Topics
start(6,'话题参与人数与实际播放','话题数据独立于账号范围  |  仅使用通过来源校验的参与人数与平台实际播放字段')
y=140
for t in A['topics']['topics']:
    by={p['date']:p for p in t['points']};endp=by['2026-10-04'];base=by['2026-09-30']
    name=t['label'];y=para(name,y,11.5,BLUE,space=7)
    dp=endp['participants']-base['participants'];dv=endp['views']-base['views']
    y=table(['10-04 参与人数','10 月参与人数变化','10-04 累计实际播放','10 月实际播放变化'],[[num(endp['participants']),num(dp,1),compact(endp['views']),num(dv,1)]],[116,120,140,WIDTH-376],y,9)
    y-=3
y=para('“累计实际播放”是平台话题历年累计，不是本期新增，更不是旗下账号播放。以上本月变化采用 09-30 与 10-04 的末次有效采样相减；话题间参与者及作品可重叠，不将四个话题相加作为去重总量。',y,9.3,MUTED)
y=heading('10 月 5 日最新补充',y)
rows=[]
short=['主话题','切片激励','创作激励','即梦二创']
for s,t in zip(short,A['topics']['topics']):
    p=t['points'][-1];rows.append([s,num(p['participants']),num(p['participantsDelta'],1),num(p['viewsDelta'],1)])
y=table(['话题简称','参与人数','较前日采样变化','实际播放较前日变化'],rows,[102,112,128,WIDTH-342],y,8.7)
y=para('10-05 采样约为北京时间 18:00，当日尚未结束。四个话题的 09-27 基准均未通过来源校验，因此不提供完整 09-28 至 10-04 周变化；缺口不补零，也不跨过缺测日拼成连续周报。',y,9,MUTED)
end()

# 7 Boundaries/action plan
start(7,'数据可信范围与下周动作','报告冻结时间 2026-10-05 18:48 北京时间  |  本次只读分析，没有重新发起采集')
y=140
y=table(['核对项目','已确认结果','使用边界'],[
 ['10-04 主页三项','697 / 701，99.43%','不是实时同秒采样，也不是作品完整率'],
 ['10-04 完整作品明细','85 / 701，12.13%','另有 229 有限、383 未取得、4 缺记录'],
 ['10 月话题双指标','4 / 4 话题，10-01 至 10-04 均有记录','更早日期存在来源未验证缺口'],
 ['10-05 主页三项','696 / 701；末次约 18:25','当日未结束，与完整日分列'],
 ['总表接入','701 启用、60 暂停、645 待定位资料','待定位条目不称为已监控独立账号']
],[125,165,WIDTH-290],y,9)
y=heading('10 月 5 日截至提取时的变化',y)
y=para('全监控池 696 个可比账号：粉丝 +189,271、获赞 +4,282,914、作品存量 +183。剔除主播观察主题后，587 个可比账号：粉丝 +675、获赞 +40,598、作品存量 +153。以上不是完整日最终结果。',y,9.8)
y=heading('建议负责人本周先做的三项动作',y)
for s in ['先分经营范围：周会默认看团团、玉麒麟、老飞宇等主题；主播观察单列。账号归属以资料证据为准，不能靠昵称推断合同关系。','先复盘关键账号：检查获赞高贡献账号与掉粉、作品存量骤降名单。上周异常点赞基数未核实前，不把本周转正归因为运营策略。','先补数据，再做内容效率考核：优先补齐 645 条待定位资料与作品明细缺口。没有完整作品级数据时，不用“估算播放 / 作品存量净增”当作单条平均播放或投入产出指标。']:
    y=para(s,y,9.8)
y=heading('计算与审查说明',y)
y=para('账号净变化要求开始日前一日与结束日均有有效观测，逐账号相减后汇总；环比限定两期共同可比账号。作品是存量净变化，可能受删除或隐藏影响。账号估算播放 = 获赞净变化 × 100，不能称实际播放；例如团团周度换算为 +41,049,000，仅为代理值。',y,9,MUTED)
y=para('来源为本机保存快照及总表分类。完整性校验包括原始记录绑定、身份、时间和校验和，不能替代平台后台审计或合同归属核验。独立复核 20 组指标加总及人数全部一致，6 份冻结数据校验和匹配。CSV 附件保留各期账号变化与采样时间，空白表示不可比。',y,9,MUTED)
end()
c.save()
(DIR/'报告正文.md').write_text('\n\n'.join(md),encoding='utf-8')
(E/'layout-checks.json').write_text(json.dumps(checks,ensure_ascii=False,indent=2))

# Delivery appendices, deliberately without raw payloads or login material.
with (DIR/'主题与标签明细.csv').open('w',encoding='utf-8-sig',newline='') as f:
    wr=csv.writer(f);wr.writerow(['类别','名称','启用数','可比数','粉丝净变化','获赞净变化','作品存量净变化','期间'])
    for typ,rows in [('大主题',A['themes']),('团团多选标签',A['tuantuan']['labels'])]:
        for r in rows:wr.writerow([typ,r['label'],r['count'],r['likes']['n'],r['followers']['delta'],r['likes']['delta'],r['posts']['delta'],'2026-09-28至2026-10-04'])
with (DIR/'话题每日明细.csv').open('w',encoding='utf-8-sig',newline='') as f:
    wr=csv.writer(f);wr.writerow(['话题','北京时间日期','参与人数','实际累计播放','参与人数日变化','实际播放日变化','采样时间UTC','来源已验证','缺口原因'])
    for t in A['topics']['topics']:
        for p in t['points']:wr.writerow([t['label'],p['date'],p.get('participants'),p.get('views'),p.get('participantsDelta'),p.get('viewsDelta'),p.get('capturedAt'),p.get('sourceVerified',False),p.get('sourceVerificationReason') or ('当日缺测' if p.get('qualityStatus')=='missing' else '')])
with (DIR/'每日总盘变化.csv').open('w',encoding='utf-8-sig',newline='') as f:
    wr=csv.writer(f);wr.writerow(['北京时间日期','粉丝净变化','获赞净变化','作品存量净变化','粉丝可比数','获赞可比数','作品可比数','粉丝样本指纹','获赞样本指纹'])
    for p in A['periods']['accumulated']['trend']:wr.writerow([p['date'],p['followersDelta'],p['likesDelta'],p['postsDelta'],p['followersComparableCount'],p['likesComparableCount'],p['postsComparableCount'],p['followersDeltaCohortKey'],p['likesDeltaCohortKey']])
(DIR/'附件说明.txt').write_text('数据冻结：2026-10-05 18:48 北京时间。\n正式完整日截至10月4日，10月5日为未完日。\n账号变化明细.csv含五个区间，不能把各区间行直接求和。英文期间：accumulated=09/12至10/04；week=09/28至10/04；priorWeek=09/21至09/27；month=10/01至10/04；today=10/05截至提取时。\n数值空白表示缺测或不可比，不表示0。暂停账号单列，不参与报告合计。\n账号估算播放仅为获赞净变化乘以100，不是实际播放。作品存量净变化不等于新增发布。\n主题单一归属；内容标签多选，标签行不能加总。主题是当前证据分类，不等于已核实合同归属。\nUTC采样时间需加8小时查看北京时间。期末已知值可能来自更早历史采样，必须结合采样时间判断。\n话题仅使用已验证的参与人数及实际累计播放。\n',encoding='utf-8')
with zipfile.ZipFile(DIR/'MCN数据报告_明细附件_2026-10-05.zip','w',zipfile.ZIP_DEFLATED) as z:
    for name in ['账号变化明细.csv','主题与标签明细.csv','话题每日明细.csv','每日总盘变化.csv','附件说明.txt','报告正文.md']:z.write(DIR/name,name)
print(json.dumps({'pdf':str(PDF),'bytes':PDF.stat().st_size,'pages':page,'zip':str(DIR/'MCN数据报告_明细附件_2026-10-05.zip')},ensure_ascii=False))
