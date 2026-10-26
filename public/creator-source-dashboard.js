const host = document.getElementById('creatorSourceBridge');
const fmt = value => Number.isSafeInteger(value) ? new Intl.NumberFormat('zh-CN').format(value) : '—';
const diff = (a, b) => Number.isSafeInteger(a) && Number.isSafeInteger(b) ? `${a - b > 0 ? '+' : ''}${fmt(a - b)}` : '—';
const esc = value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const beijingTime = value => value && Number.isFinite(Date.parse(value))
  ? new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', dateStyle: 'short', timeStyle: 'short' }).format(new Date(value)) : '—';

async function read() {
  if (!host) return;
  try {
    const response = await fetch('/api/creator-source/overview', { credentials: 'same-origin', cache: 'no-store' });
    if (response.status === 401 || response.status === 403) {
      host.innerHTML = '<p>登录后可查看团团全量来源与监控对照。</p>';
      return;
    }
    if (!response.ok) throw new Error(`来源对照读取失败（${response.status}）`);
    const data = await response.json();
    if (!data.available) { host.innerHTML = '<p>全量来源尚未整合进主数据库。</p>'; return; }
    const latestDay = data.daily?.[0];
    const firstDay = data.daily?.at(-1);
    const maxDaily = Math.max(1, ...(data.daily || []).map(item => Number(item.works) || 0));
    const dailyRows = (data.daily || []).map(item => `<a class="creator-source-day" href="/creator-library.html?sheet=09&q=${encodeURIComponent(item.day)}" aria-label="查看 ${esc(item.day)} 发布的 ${fmt(item.works)} 条来源作品"><time>${esc(item.day)}</time><span class="creator-source-day-track"><i style="width:${Math.max(2, Math.round(Number(item.works) / maxDaily * 100))}%"></i></span><strong>${fmt(item.works)} 条</strong><small>来源累计播放 ${fmt(item.cumulativePlays)}（${fmt(item.playsKnown)}/${fmt(item.works)} 条有值） · 累计赞 ${fmt(item.cumulativeLikes)}（${fmt(item.likesKnown)}/${fmt(item.works)} 条有值）</small></a>`).join('');
    const dayOptions = (data.daily || []).map(item => `<option value="${esc(item.day)}">${esc(item.day)}</option>`).join('');
    const registryRows = (data.registryAdditionRows || []).map(item => `<li><a href="/creator-library.html?sheet=08&q=${encodeURIComponent(item.accountId)}">${esc(item.authorName)} · ${esc(item.accountId)}</a> <span>${esc(item.classifications.join('、'))} · 原表修改 ${esc(beijingTime(item.sourceModifiedAt))}（北京）</span> <a href="${esc(item.sourceUrl)}" target="_blank" rel="noopener noreferrer">原登记 ↗</a></li>`).join('');
    const awardDeltas = (data.awardDeltaRows || []).map(item => `<li>${esc(item.payload.author_name)} · ${esc(item.payload.account_id)}：<a href="${esc(item.payload.work_url)}" target="_blank" rel="noopener noreferrer">原公示作品 ↗</a> · 公示点赞 ${fmt(item.payload.likes_in_announcement)} / 播放 ${fmt(item.payload.plays_in_announcement)} / 候选金额 ¥${fmt(item.payload.announced_amount_yuan)} · <a href="${esc(item.sourceUrl)}" target="_blank" rel="noopener noreferrer">公示表第 ${esc(item.originKey.split(':').at(-1))} 行 ↗</a></li>`).join('');
    const accountCorrections = (data.registryCorrectionRows || []).map(item => `<li>登记记录 ${esc(item.originKey)}：总表账号文本 ${esc(item.payload.previous_account_id || '空')} → 原登记当前 ${esc(item.payload.current_source_account_id || '空')} · <a href="${esc(item.sourceUrl)}" target="_blank" rel="noopener noreferrer">核对来源 ↗</a></li>`).join('');
    host.innerHTML = `<div class="creator-source-head"><div><p class="creator-source-eyebrow">团团 · 全量来源对照</p>
      <h2>来源名册已并入主数据台</h2><p>来源版本 ${esc(data.sourceRevision)} · ${fmt(data.sheets)} 张表 / ${fmt(data.rows)} 行 · 不是平台实时采样</p></div>
      <div class="creator-source-actions"><button type="button" data-source-roster>查看完整来源名册</button><a href="/creator-library.html">逐行查看来源 ↗</a></div></div>
      <div class="creator-source-stats">
        <div><span>来源作者</span><strong>${fmt(data.authors)}</strong><small>其中 ${fmt(data.accountLinks)} 位与现有监控严格对应</small></div>
        <div><span>去重来源作品</span><strong>${fmt(data.works)}</strong><small>原表内容完整保留</small></div>
        <div><span>作品 ID 与监控库重合</span><strong>${fmt(data.exactWorkIdOverlap)}</strong><small>仅作品 ID 去重，不冒充作者核验</small></div>
        <div><span>仅在来源表的作品 ID</span><strong>${fmt(data.sourceOnlyWorkIds)}</strong><small>待按账号与作品覆盖继续核对，不能直接称漏采</small></div>
      </div><div class="creator-source-bottom"><p>严格对应账号下，${fmt(data.identityAndWorkOverlap)} 条来源作品已在同账号监控库找到；${fmt(data.identityLinkedNotObserved)} 条尚未找到。${latestDay ? `来源作品最新推算发布日期 ${esc(latestDay.day)}（${fmt(latestDay.works)} 条）` : ''}</p>
      <p>来源“推算日期”可用于作品发布日分布，不是每日播放增长；来源累计播放也不混入粉丝、获赞或真实快照。${data.registryAdditions ? `另有 ${fmt(data.registryAdditions)} 条授权登记新增证据已去重入库，未重复增加作者。` : ''}${awardDeltas ? ` 原排名公示另有 ${fmt(data.awardDeltaRows.length)} 条逐行核出的遗漏证据。` : ''}</p></div>
      ${registryRows ? `<details class="creator-source-registry"><summary>本次新增授权登记证据 · ${fmt(data.registryAdditions)} 条</summary><ul>${registryRows}</ul></details>` : ''}
      ${awardDeltas ? `<details class="creator-source-registry"><summary>原排名公示遗漏明细 · ${fmt(data.awardDeltaRows.length)} 条</summary><p>仅保留原公示的候选记录；未加入平台实时播放、账号增长或已结算金额。</p><ul>${awardDeltas}</ul></details>` : ''}
      ${accountCorrections ? `<details class="creator-source-registry"><summary>登记账号文本待复核 · ${fmt(data.registryCorrectionRows.length)} 处</summary><p>保留两边原文，不自动改动已核验账号身份。</p><ul>${accountCorrections}</ul></details>` : ''}
      <details class="creator-source-daily"><summary>按发布日期对比作品数、来源累计播放及点赞 · ${fmt(data.daily?.length || 0)} 天</summary><p>每行按当天发布的去重作品汇总，其播放与点赞为来源表采样时累计值，并非当天新增。点击日期查看作品。</p>
      <div class="creator-source-compare"><label>基准日 <select data-creator-day-base>${dayOptions}</select></label><label>对比日 <select data-creator-day-current>${dayOptions}</select></label><div data-creator-day-result></div></div>
      <div class="creator-source-days">${dailyRows || '<p>来源没有有效发布日期。</p>'}</div></details>`;
    const base = host.querySelector('[data-creator-day-base]');
    const current = host.querySelector('[data-creator-day-current]');
    const result = host.querySelector('[data-creator-day-result]');
    if (base && current && result && firstDay && latestDay) {
      base.value = firstDay.day;
      current.value = latestDay.day;
      const renderComparison = () => {
        const left = data.daily.find(day => day.day === base.value);
        const right = data.daily.find(day => day.day === current.value);
        if (!left || !right) return;
        result.innerHTML = `<strong>${esc(left.day)} → ${esc(right.day)}</strong><span>作品：${fmt(left.works)} → ${fmt(right.works)}（差 ${diff(right.works, left.works)}）</span><span>来源累计赞：${fmt(left.cumulativeLikes)} → ${fmt(right.cumulativeLikes)}（差 ${diff(right.cumulativeLikes, left.cumulativeLikes)}）</span><span>来源累计播放：${fmt(left.cumulativePlays)} → ${fmt(right.cumulativePlays)}（差 ${diff(right.cumulativePlays, left.cumulativePlays)}）</span><small>两组是不同发布日期的作品，不是相同作品跨日增长；播放与赞来自同一来源采样 ${esc(beijingTime(data.sourceRefreshedAt || data.sourceModifiedAt))}（北京）。</small>`;
      };
      base.addEventListener('change', renderComparison);
      current.addEventListener('change', renderComparison);
      renderComparison();
    }
  } catch (error) {
    host.textContent = `来源对照暂不可读：${error.message}`;
  }
}

host?.addEventListener('click', event => {
  if (!event.target.closest('[data-source-roster]')) return;
  document.querySelector('.sidebar [data-view="accounts"]')?.click();
  document.getElementById('accountModeRosterTab')?.click();
});
document.addEventListener('mcn:master-roster-bind', () => { void read(); });
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => { void read(); }, { once: true });
else void read();
