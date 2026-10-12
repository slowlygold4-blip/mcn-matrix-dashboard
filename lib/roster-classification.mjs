import { classificationCatalog, isContentClassificationLabel } from './author-classification.mjs';

const THEME_CATALOG = new Map([
  ['tuantuan', '团团'], ['yangqijia', '杨齐家'], ['laofeiyu', '老飞宇'], ['yuqilin', '玉麒麟'],
  ['anlan', '安澜'], ['jihuang', '极煌'], ['7jia', '7jia'], ['naituan', '奶团'],
  ['douyin-streamers', '抖音主播'],
]);

const BUILTIN_LABELS = classificationCatalog().filter(item => item.key !== 'all');
const BUILTIN_BY_KEY = new Map(BUILTIN_LABELS.map(item => [item.key, item]));
const BUILTIN_BY_LABEL = new Map(BUILTIN_LABELS.map(item => [item.label.normalize('NFKC').trim().toLowerCase(), item]));

function sourceClassification(rosterEntry) {
  const seen = new Set();
  const labels = [];
  const descriptions = [];
  for (const raw of Array.isArray(rosterEntry?.classifications) ? rosterEntry.classifications : []) {
    const label = String(raw?.label ?? '').trim().slice(0, 100);
    const normalizedLabel = label.normalize('NFKC').toLowerCase();
    if (!isContentClassificationLabel(label)) continue;
    const builtin = BUILTIN_BY_KEY.get(String(raw?.key ?? '').trim())
      ?? BUILTIN_BY_LABEL.get(normalizedLabel);
    if (!builtin) {
      if (!descriptions.includes(label)) descriptions.push(label);
      continue;
    }
    const key = builtin.key;
    if (seen.has(key)) continue;
    seen.add(key);
    labels.push({ key, label: builtin.label, color: builtin.color,
      confidence: 1, sourceConfirmed: true });
  }
  return { labels, descriptions };
}

function hasSliceMatrixEvidence(classification, rosterEntry) {
  const boardNames = (Array.isArray(rosterEntry?.boards) ? rosterEntry.boards : [])
    .map(board => typeof board === 'string' ? board : board?.name);
  const currentEvidence = Array.isArray(classification?.theme?.evidence)
    ? classification.theme.evidence.filter(item => item?.source === '所属板块').map(item => item.value)
    : [];
  return [...boardNames, ...currentEvidence].some(value => String(value ?? '').normalize('NFKC').includes('切片矩阵'));
}

function matrixSliceLabel() {
  const builtin = BUILTIN_BY_KEY.get('slice');
  return { key: builtin.key, label: builtin.label, color: builtin.color,
    confidence: 1, sourceConfirmed: true };
}

/**
 * Supplement derived operating classifications with the source-confirmed
 * major theme and explicit secondary labels from the latest imported roster.
 * This is a read projection only: it never changes targets, memberships,
 * snapshots, or the original roster evidence.
 */
export function mergeRosterClassification(classification, rosterEntry) {
  if (!classification || !rosterEntry) return classification;
  const sourceThemeKey = String(rosterEntry.theme?.key ?? '');
  const canonicalTheme = THEME_CATALOG.get(sourceThemeKey);
  const currentThemeKey = String(classification.theme?.key ?? 'unassigned');
  const currentThemeConfirmed = classification.theme?.confirmed === true && currentThemeKey !== 'unassigned';
  // A current IP-specific membership is stronger than a frozen roster
  // snapshot. “抖音主播板块” is only the generic intake bucket, so an explicit
  // IP source in the roster may replace that fallback, just as it does in the
  // base theme classifier. The roster must not overwrite another current IP.
  const canApplyRosterTheme = canonicalTheme && sourceThemeKey !== 'unassigned'
    && (!currentThemeConfirmed || currentThemeKey === sourceThemeKey
      || currentThemeKey === 'douyin-streamers' && sourceThemeKey !== 'douyin-streamers');
  const theme = canApplyRosterTheme
    ? { ...classification.theme, key: sourceThemeKey, label: canonicalTheme,
      confirmed: true, mode: 'master-roster-source' }
    : classification.theme;
  const source = sourceClassification(rosterEntry);
  // The owner confirmed that every account in the consolidated Tuantuan
  // roster belongs to the Tuantuan clipping matrix. Content variants such as
  // original, AI remix and live-hotspot remain overlapping secondary labels;
  // they must not replace the matrix's primary operating class.
  const matrixPrimary = hasSliceMatrixEvidence(classification, rosterEntry)
    || theme?.confirmed === true && theme.key === 'tuantuan';
  if (!canonicalTheme && !source.labels.length && !matrixPrimary) return classification;
  const merged = new Map();
  if (matrixPrimary) merged.set('slice', matrixSliceLabel());
  for (const label of source.labels) merged.set(label.key, label);
  for (const label of Array.isArray(classification.labels) ? classification.labels : []) {
    if (!BUILTIN_BY_KEY.has(label.key)) continue;
    if (!merged.has(label.key)) merged.set(label.key, label);
  }
  const labels = [...merged.values()];
  const currentPrimary = BUILTIN_BY_KEY.has(classification.primaryKey) ? merged.get(classification.primaryKey) : null;
  const primary = matrixPrimary ? merged.get('slice') : currentPrimary ?? source.labels[0] ?? labels[0];
  const rawDescriptions = [
    ...(Array.isArray(classification.sourceDescriptions) ? classification.sourceDescriptions : []),
    ...(Array.isArray(classification.labels) ? classification.labels.filter(item => String(item?.key ?? '').startsWith('custom:')).map(item => item.label) : []),
    ...source.descriptions,
  ];
  const descriptionKeys = new Set();
  const sourceDescriptions = rawDescriptions.flatMap(value => {
    const original = String(value ?? '').trim();
    const key = original.normalize('NFKC').toLowerCase();
    if (!original || descriptionKeys.has(key)) return [];
    descriptionKeys.add(key);
    return [original];
  }).slice(0, 24);
  return {
    ...classification,
    theme,
    labels,
    ...(sourceDescriptions.length ? { sourceDescriptions } : {}),
    ...(primary ? { primaryKey: primary.key, primaryLabel: primary.label, confidence: 1,
      mode: matrixPrimary ? 'source-confirmed-matrix' : 'master-roster-source' } : {}),
  };
}
