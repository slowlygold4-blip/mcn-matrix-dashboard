import { formatNumber } from './console-model.js';

const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const sourceColumns = [['sourceSummary.works', '表格作品'], ['sourceSummary.cumulativePlays', '作品累计播放·表格'], ['sourceSummary.cumulativeLikes', '作品累计赞·表格']];
export function accountStateLabel(account) {
  return account.sourceOnly ? '表格资料 · 未接通实时采样' : account.enabled ? '监控已启用' : '监控已暂停';
}
export function unifiedRosterCaption(accounts = []) {
  const enabled = accounts.filter(a => a.enabled === true).length;
  const sourceOnly = accounts.filter(a => a.sourceOnly === true).length;
  const paused = accounts.length - enabled - sourceOnly;
  return `名册记录 ${formatNumber(accounts.length, true)} 条 · 监控启用 ${formatNumber(enabled, true)} · 暂停 ${formatNumber(paused, true)} · 表格资料 ${formatNumber(sourceOnly, true)}（尚无实时采样；同名缺 ID 保留独立来源行）`;
}
export function sourceMetricCell(account, key, tag = 'td') {
  const field = key.split('.')[1];
  const value = account.sourceSummary?.[field];
  const conflicted = account.sourceSummary?.conflicts?.some(item => item.field === field);
  return `<${tag} title="表格记录的作品累计值，不是账号主页统计或每日新增"><span class="metric">${formatNumber(value)}</span><small class="muted">${conflicted ? '来源值冲突 · 待核对' : value == null ? '表格未记录' : '表格累计 · 非日增'}</small></${tag}>`;
}
export function sourceFactsMarkup(account) {
  const s = account?.sourceSummary;
  const references = [...(account?.sourceProvenance || [])];
  if (s?.sourceUrl && !references.some(ref => ref.url === s.sourceUrl)) references.push({url:s.sourceUrl,title:'原始来源表'});
  const sourceLinks = references.map(ref => {
    let url = ''; try { const parsed = new URL(ref.url); if (['https:', 'http:'].includes(parsed.protocol) && !parsed.username && !parsed.password) url = parsed.href; } catch {}
    return `<li>${url ? `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(ref.title || ref.sheetName || '查看原始来源')}</a>` : esc(ref.title || ref.sheetName || '提交来源')} ${ref.rows?.length ? `· 行 ${esc(ref.rows.join('、'))}` : ''}</li>`;
  }).join('');
  const evidence = sourceLinks ? `<details><summary>来源与原始行</summary><ul>${sourceLinks}</ul></details>` : '';
  if (!s) return `<p class="muted">已保留此账号的提交资料；该来源未提供可对比的作品指标。</p>${evidence}`;
  const keys = (s.authorKeys || []).filter(key => /^source-author:\d+:\d+$/.test(key));
  return `<section class="account-source-facts"><h3>已合并的表格资料</h3><p class="muted">按严格身份合并的来源资料。以下为表格记录的累计值，不是日增长，也不替代主页统计。</p>${s.hasConflicts ? `<p class="notice error">重复身份的来源值不一致，冲突字段留空：${esc((s.conflicts || []).map(item => item.field).join('、'))}。请查看原始来源。</p>` : ''}<dl class="creator-operating-stats">${sourceColumns.map(([key, label]) => `<div><dt>${label}</dt><dd>${formatNumber(s[key.split('.')[1]], true)}</dd></div>`).join('')}</dl><p class="muted">来源版本 ${esc(s.sourceRevision || '未记录')} · 来源刷新 ${esc(s.refreshedAt || '未记录')}；刷新时间不等于指标采样时间。</p>${evidence}${keys.map((key, i) => `<button type="button" class="link-btn" data-source-works-key="${esc(key)}">查看已入库作品${keys.length > 1 ? ` · 来源条目 ${i + 1}` : ''} →</button>`).join('')}<div id="sourceAccountWorks" aria-live="polite"></div></section>`;
}
export function sourceWorksMarkup(data, key) {
  const items = Array.isArray(data?.items) ? data.items : [];
  const table = items.length ? `<div class="table-card"><table class="table"><thead><tr><th>作品 / ID</th><th>发布日期</th><th>表格累计播放</th><th>表格累计赞</th></tr></thead><tbody>${items.map(w => `<tr><td>${esc(w.title || '未记录标题')}<small>${esc(w.contentId)}</small></td><td>${esc(w.publishedOn || '未知')}</td><td>${formatNumber(w.cumulativePlays, true)}</td><td>${formatNumber(w.cumulativeLikes, true)}</td></tr>`).join('')}</tbody></table></div>` : '<p>此来源作者没有已登记作品，不记为平台作品数 0。</p>';
  return `<p class="muted">全部来源日期 · 已入库 ${formatNumber(data.total, true)} 条去重作品 · 发布日不是播放采样日</p>${table}<div class="pager"><button type="button" data-source-works-page="${data.page - 1}" data-source-works-key="${esc(key)}" ${data.page <= 1 ? 'disabled' : ''}>上一页</button><span>${data.page} / ${Math.max(1, data.pages || 0)}</span><button type="button" data-source-works-page="${data.page + 1}" data-source-works-key="${esc(key)}" ${data.page >= data.pages ? 'disabled' : ''}>下一页</button></div>`;
}
