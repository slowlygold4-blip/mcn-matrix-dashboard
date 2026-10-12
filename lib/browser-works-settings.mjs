// Versioned, explicit browser-only page policy. Legacy storage limits and
// historical evidence are never reinterpreted by a mode/default change.
export const BROWSER_WORKS_SETTING_DEFAULTS = Object.freeze({
  publicWorksPageMode: 'legacy',
  publicWorksPageHardLimit: '100',
  publicWorksRequestThreshold: '30',
});
const keys = Object.keys(BROWSER_WORKS_SETTING_DEFAULTS);
function integer(value, name) {
  if (!((typeof value === 'number' && Number.isSafeInteger(value))
    || (typeof value === 'string' && /^[1-9]\d*$/.test(value)))) throw new Error(`${name}必须是规范整数`);
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1 || number > 100) throw new Error(`${name}必须在1–100之间`);
  return number;
}
export function readBrowserWorksSettings(settings = {}) {
  const values = { ...BROWSER_WORKS_SETTING_DEFAULTS, ...settings };
  const mode = values.publicWorksPageMode;
  if (!['legacy', 'whole-page-v2'].includes(mode)) throw new Error('作品分页模式无效');
  const hardLimit = integer(values.publicWorksPageHardLimit, '完整页保存上限');
  const requestThreshold = integer(values.publicWorksRequestThreshold, '停止续页阈值');
  if (requestThreshold > hardLimit) throw new Error('停止续页阈值不能超过完整页保存上限');
  return Object.freeze({ mode, hardLimit, requestThreshold });
}
export function validateBrowserWorksSettingsUpdate(values, current = {}) {
  const patch = Object.fromEntries(keys.filter(key => Object.hasOwn(values, key)).map(key => [key, values[key]]));
  const before = readBrowserWorksSettings(current);
  if (patch.publicWorksPageMode === 'whole-page-v2' && before.mode !== 'whole-page-v2'
    && (!Object.hasOwn(patch, 'publicWorksPageHardLimit') || !Object.hasOwn(patch, 'publicWorksRequestThreshold')))
    throw new Error('启用完整页模式时必须明确提交保存上限和停止续页阈值');
  const next = readBrowserWorksSettings({ ...current, ...patch });
  return Object.fromEntries(Object.keys(patch).map(key => [key, key === 'publicWorksPageMode' ? next.mode
    : String(key === 'publicWorksPageHardLimit' ? next.hardLimit : next.requestThreshold)]));
}
