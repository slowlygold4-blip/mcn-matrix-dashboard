import { businessDateKey, isCalendarDate } from './utils.mjs';

const KEYS = new Set(['kind', 'page', 'pageSize', 'sort', 'order', 'asOf', 'startDate', 'endDate', 'workId',
  'snapshotMaxId', 'postMaxId', 'postMetricMaxId']);
const REVISION_KEYS = ['snapshotMaxId', 'postMaxId', 'postMetricMaxId'];
const invalid = (message) => Object.assign(new Error(message), { status: 400, code: 'INVALID_ACCOUNT_HISTORY_QUERY' });
const integer = (value, key, min, max) => {
  if (!/^(0|[1-9]\d*)$/.test(value)) throw invalid(`${key}必须为有效整数`);
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) throw invalid(`${key}超出允许范围`);
  return number;
};

/** HTTP boundary only: the read model independently validates the same contract. */
export function accountHistoryOptions(params, reference = new Date()) {
  if (!(params instanceof URLSearchParams) || !Number.isFinite(reference.getTime())) throw invalid('历史查询无效');
  for (const key of params.keys()) {
    if (!KEYS.has(key) || params.getAll(key).length !== 1) throw invalid('历史查询含未知或重复参数');
  }
  const options = { timeZone: 'Asia/Shanghai', kind: params.get('kind') || 'works' };
  if (!['works', 'daily', 'workMetrics'].includes(options.kind)) throw invalid('不支持的历史记录类型');
  for (const [key, min, max] of [['page', 1, 100000], ['pageSize', 1, 100], ['workId', 1, Number.MAX_SAFE_INTEGER],
    ...REVISION_KEYS.map(key => [key, 0, Number.MAX_SAFE_INTEGER])]) {
    if (params.has(key)) options[key] = integer(params.get(key), key, min, max);
  }
  if (options.kind === 'workMetrics' && options.workId === undefined) throw invalid('请选择需要查看历史的作品');
  if (options.kind !== 'workMetrics' && options.workId !== undefined) throw invalid('当前历史类型不接受作品编号');
  const revisionCount = REVISION_KEYS.filter(key => options[key] !== undefined).length;
  if (revisionCount !== 0 && revisionCount !== REVISION_KEYS.length) throw invalid('历史截面标识不完整，请重新读取');
  if (params.has('sort')) {
    const value = params.get('sort');
    if (!/^[A-Za-z][A-Za-z0-9]{0,30}$/.test(value)) throw invalid('历史排序字段无效');
    options.sort = value;
  }
  if (params.has('order')) {
    if (!['asc', 'desc'].includes(params.get('order'))) throw invalid('历史排序方向无效');
    options.order = params.get('order');
  }
  let asOf = reference;
  if (params.has('asOf')) {
    const value = params.get('asOf');
    if (!/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(value)
      || !isCalendarDate(value.slice(0, 10))) throw invalid('历史截止时间无效');
    asOf = new Date(value);
    if (!Number.isFinite(asOf.getTime()) || asOf > reference) throw invalid('历史截止时间不能晚于现在');
  }
  options.asOf = asOf.toISOString();
  for (const key of ['startDate', 'endDate']) {
    if (!params.has(key)) continue;
    const value = params.get(key);
    if (!isCalendarDate(value)) throw invalid('历史日期必须为有效的YYYY-MM-DD');
    options[key] = value;
  }
  if (Boolean(options.startDate) !== Boolean(options.endDate)) throw invalid('请同时填写历史开始与结束日期');
  if (options.startDate && (options.startDate > options.endDate || options.endDate > businessDateKey(asOf, options.timeZone))) {
    throw invalid('历史日期不能倒序或晚于本次读取截面');
  }
  return options;
}
