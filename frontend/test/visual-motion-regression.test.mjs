import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';

const site=fileURLToPath(new URL('../',import.meta.url));
const backend=process.env.MCN_MAIN_ROOT||fileURLToPath(new URL('../../douyin-monitor-workbench/',import.meta.url));
const {chromium}=createRequire(backend+'package.json')('playwright-core');
const theme=readFileSync(site+'app/visual-theme.css','utf8');
const motion=readFileSync(site+'app/dashboard-motion.css','utf8');
const html=`<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>
*{box-sizing:border-box}html,body{margin:0}.workspace{padding:10px}.overview-account-preview{max-width:1100px;margin-inline:auto}
${theme}${motion}
</style></head><body><main class="workspace"><section class="panel overview-account-preview">
<div class="overview-account-preview__grid">
<article class="overview-account-preview__card"><div class="dashboard-orbits" data-dashboard-orbit-active="true" aria-hidden="true"><span></span><span></span></div><small>粉丝净变化</small><strong class="positive">+123,456</strong><span>2 个账号可比</span></article>
<article class="overview-account-preview__card"><small>主页获赞净变化</small><strong>—</strong><span>缺少可比起止快照</span></article>
<article class="overview-account-preview__card"><small>作品存量净变化</small><strong class="negative">-2</strong><span>1 个账号可比</span></article>
</div><details class="overview-account-preview__trend"><summary>展开每日曲线与区间对比</summary><p>真实曲线</p></details>
</section></main></body></html>`;

test('growth preview visual hierarchy stays readable on desktop and small phones',async()=>{
 const browser=await chromium.launch({headless:true,executablePath:process.env.MCN_TEST_CHROME||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',args:['--disable-background-networking']});
 try{
  for(const width of [1280,390,320]){
   const page=await browser.newPage({viewport:{width,height:800},reducedMotion:'reduce'});
   await page.setContent(html);
   const result=await page.evaluate(()=>{
    const cards=[...document.querySelectorAll('.overview-account-preview__card')];
    const boxes=cards.map(card=>card.getBoundingClientRect());
    return {
     overflow:document.documentElement.scrollWidth>innerWidth+1,
     boxes:boxes.map(box=>({x:box.x,y:box.y,width:box.width,right:box.right})),
     numbers:cards.map(card=>card.querySelector('strong').textContent),
     colors:cards.map(card=>getComputedStyle(card.querySelector('strong')).color),
     decoration:getComputedStyle(cards[0],'::before').backgroundImage,
     transition:getComputedStyle(cards[0]).transitionDuration,
     orbits:[...cards[0].querySelectorAll('.dashboard-orbits > span')].map(ring=>getComputedStyle(ring).animationName),
     orbitPointerEvents:getComputedStyle(cards[0].querySelector('.dashboard-orbits')).pointerEvents,
     orbitZ:getComputedStyle(cards[0].querySelector('.dashboard-orbits')).zIndex,
     figureZ:getComputedStyle(cards[0].querySelector('strong')).zIndex,
    };
   });
   assert.equal(result.overflow,false,`${width}px must have no horizontal page overflow`);
   assert.deepEqual(result.numbers,['+123,456','—','-2'],'decoration must not alter data or missing-value glyphs');
   assert.match(result.decoration,/gradient/,'accent is decoration, not a data label');
   assert.equal(result.transition,'0s','reduced-motion disables the card movement');
   assert.deepEqual(result.orbits,['none','none'],'reduced motion disables both primary-card rings');
   assert.equal(result.orbitPointerEvents,'none','rings never intercept a data interaction');
   assert.ok(Number(result.figureZ)>Number(result.orbitZ),'focal value stays above the orbital decoration');
   if(width===1280){assert.ok(result.boxes[0].width>result.boxes[1].width,'desktop lead metric has modest emphasis');}
   else{assert.ok(result.boxes[0].y<result.boxes[1].y&&result.boxes[1].y<result.boxes[2].y,'phone metrics stack in reading order');}
   assert.ok(result.boxes.every(box=>box.right<=width+1));
   await page.close();
  }
  const motionPage=await browser.newPage({viewport:{width:1280,height:800},reducedMotion:'no-preference'});
  try{
   await motionPage.setContent(html);
   const rings=await motionPage.locator('.overview-account-preview__card:first-child .dashboard-orbits > span').evaluateAll(items=>items.map(item=>({name:getComputedStyle(item).animationName,state:getComputedStyle(item).animationPlayState})));
   assert.equal(rings.length,2);
   assert.ok(rings.every(ring=>ring.name!=='none'&&ring.state==='running'),'normal motion rotates both rings behind the true figure');
  }finally{await motionPage.close();}
 }finally{await browser.close();}
});
