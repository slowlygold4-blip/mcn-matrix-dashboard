// Administrator-only controls. Public viewers never gain write authority here.
const MODES = new Set(['legacy', 'whole-page-v2']);
export function worksSettingInteger(value, label, maximum = 100) {
  if (!((typeof value === 'number' && Number.isInteger(value)) ||
      (typeof value === 'string' && /^[1-9]\d{0,2}$/.test(value)))) throw new Error(`${label}必须是整数`);
  const number = Number(value);
  if (number < 1 || number > maximum) throw new Error(`${label}必须在 1–${maximum} 之间`);
  return number;
}
export function readWorksSettings(value) {
  if (!value || !MODES.has(value.publicWorksPageMode)) throw new Error('采集模式回执无效');
  const hard = worksSettingInteger(value.publicWorksPageHardLimit, '保存上限');
  return {
    publicWorksPageMode: value.publicWorksPageMode,
    publicWorksPageHardLimit: hard,
    publicWorksRequestThreshold: worksSettingInteger(value.publicWorksRequestThreshold, '续页停止阈值', hard),
    publicPostsPerAccount: worksSettingInteger(value.publicPostsPerAccount, '旧模式作品上限'),
  };
}
export function buildWorksSettingsSubmission({ mode, legacy, hard, threshold }) {
  if (!MODES.has(mode)) throw new Error('请选择有效采集模式');
  if (mode === 'legacy') return { publicWorksPageMode: mode, publicPostsPerAccount: worksSettingInteger(legacy, '旧模式作品上限') };
  const maximum = worksSettingInteger(hard, '保存上限');
  return { publicWorksPageMode: mode, publicWorksPageHardLimit: maximum,
    publicWorksRequestThreshold: worksSettingInteger(threshold, '续页停止阈值', maximum) };
}
export function createWorksSettings({ api, canManage, document: doc = document }) {
  const el = id => doc.getElementById(id);
  const opener = el('worksSettingsButton'), dialog = el('worksSettingsDialog');
  if (!opener || !dialog) return { syncRole() {} };
  const form = el('worksSettingsForm'), mode = el('worksPageMode'), legacy = el('worksLegacyLimit');
  const hard = el('worksHardLimit'), threshold = el('worksThreshold');
  const status = el('worksSettingsStatus'), saved = el('worksSettingsSaved');
  const preview = el('worksSettingsPreview'), save = el('worksSettingsSave'), reload = el('worksSettingsReload');
  let current = null, loading = false, saving = false, loadId = 0, loadController = null;
  const message = (text, error = false) => { status.textContent = text; status.dataset.state = error ? 'error' : 'normal'; };
  function updateControls() {
    const whole = mode.value === 'whole-page-v2', disabled = loading || saving || !current || !canManage();
    mode.disabled = disabled; legacy.disabled = disabled || whole;
    hard.disabled = threshold.disabled = disabled || !whole;
    save.disabled = reload.disabled = loading || saving || !canManage();
    save.disabled ||= !current;
    el('worksLegacyFields').hidden = whole; el('worksWholeFields').hidden = !whole;
    if (!current) { preview.textContent = '读取已保存的策略后才能修改。'; return; }
    try {
      const draft = buildWorksSettingsSubmission({mode: mode.value, legacy: legacy.value, hard: hard.value, threshold: threshold.value});
      preview.textContent = whole
        ? `待保存策略：每轮最多保存 ${draft.publicWorksPageHardLimit} 条；累计达到 ${draft.publicWorksRequestThreshold} 条后不再请求下一页。已经返回的当前页尽量完整保存，但不得超过保存上限。`
        : `待保存策略：每个账号每轮最多保存 ${draft.publicPostsPerAccount} 条，达到上限会截断当前页。`;
    } catch (error) { preview.textContent = error.message; }
  }
  function showSettings(value) {
    current = readWorksSettings(value);
    mode.value = current.publicWorksPageMode; legacy.value = String(current.publicPostsPerAccount);
    hard.value = String(current.publicWorksPageHardLimit); threshold.value = String(current.publicWorksRequestThreshold);
    saved.textContent = current.publicWorksPageMode === 'legacy'
      ? `已保存：旧数量上限模式 · 每轮最多 ${current.publicPostsPerAccount} 条。整页模式尚未开启。`
      : `已保存：整页保存模式 · 保存上限 ${current.publicWorksPageHardLimit} 条 · 续页停止阈值 ${current.publicWorksRequestThreshold} 条。旧模式上限 ${current.publicPostsPerAccount} 条仍保留。`;
    updateControls();
  }
  async function read() {
    if (!canManage() || saving || loading) return;
    const id = ++loadId, controller = new AbortController(); loadController = controller; loading = true;
    message('正在读取已保存的采集策略…'); updateControls();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    try {
      const result = await api('/api/settings', {signal: controller.signal});
      if (id !== loadId || !dialog.open || !canManage()) return;
      showSettings(result); message('已读取。修改后需要点击「保存策略」；不会立即触发采集。');
    } catch (error) {
      if (id === loadId && dialog.open) message(`读取失败：${error.message}。可重新读取；未更改已保存设置。`, true);
    } finally {
      clearTimeout(timeout);
      if (id === loadId) { loading = false; loadController = null; updateControls(); }
    }
  }
  opener.addEventListener('click', () => {
    if (!canManage() || dialog.open) return;
    dialog.showModal();
    if (saving) { message('策略仍在保存，请等待回执；不会重复提交。'); updateControls(); }
    else void read();
  });
  el('worksSettingsClose').addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => {
    loadId++; loadController?.abort(); loadController = null; loading = false;
    if (canManage()) opener.focus({preventScroll: true});
  });
  reload.addEventListener('click', () => void read());
  for (const field of [mode, legacy, hard, threshold]) field.addEventListener('input', updateControls);
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (!canManage() || !current || loading || saving) return;
    let body;
    try { body = buildWorksSettingsSubmission({mode: mode.value, legacy: legacy.value, hard: hard.value, threshold: threshold.value}); }
    catch (error) { message(error.message, true); return; }
    saving = true; updateControls(); message('正在保存策略…不触发平台采集。');
    try {
      const receipt = readWorksSettings(await api('/api/settings', {method: 'POST', body: JSON.stringify(body)}));
      for (const [key, value] of Object.entries(body)) if (receipt[key] !== value) throw new Error('保存回执与提交不一致，请重新读取确认');
      showSettings(receipt);
      message('策略已保存。下一次后台采集使用新设置；正在运行的批次保持原策略。历史数据不会改写，也不保证全部作品已采到。');
    } catch (error) { message(`未确认保存成功：${error.message}。保留当前草稿，请重新读取核对后再操作。`, true); }
    finally { saving = false; updateControls(); }
  });
  return { syncRole() {
    opener.hidden = !canManage();
    if (!canManage() && dialog.open) dialog.close();
  }};
}
// Keep the administrative component separate from the data/graph module.
// The shell supplies its normal authenticated request function, not secrets.
if (typeof document !== 'undefined') {
  let controller = null;
  document.addEventListener('mcn:works-settings-bind', event => {
    if (controller || typeof event.detail?.api !== 'function' || typeof event.detail?.canManage !== 'function') return;
    controller = createWorksSettings(event.detail);
  });
  document.addEventListener('mcn:works-settings-session', () => controller?.syncRole());
}
