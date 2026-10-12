import { AUTHOR_UPLOAD_LIMITS, parseAuthorSpreadsheet } from './author-spreadsheet.mjs';

const recordId = value => typeof value === 'string' && /^rec[A-Za-z0-9_-]{6,120}$/.test(value) ? value : '';
const normalized = value => String(value ?? '').normalize('NFKC').trim().toLowerCase().replace(/[\s_\-—–·:：/\\()（）\[\]【】.]/g, '');
const headerAliases = new Map([
  ['抖音名称', '抖音昵称'], ['作品类型', '内容类型'], ['内容类型选项', '内容类型'],
  ['抖音号id', '抖音号'],
]);
const header = value => {
  if (typeof value !== 'string') throw new Error('多维表字段名称格式无法识别；未丢弃字段或导入部分行');
  return headerAliases.get(normalized(value)) || value;
};
// Only declared identity/evidence columns may contribute embedded hyperlink
// targets. A work URL in a caption, human note or unrelated body is not proof.
const linkedField = value => /(?:主页|链接|地址|secuid|内容id|视频id|作品id|awemeid|itemid|bvid|bv号|^(?:url|link|profileurl|accounturl|videourl|awemeurl)$)/i.test(normalized(value));

function cellText(value, includeLink, depth = 0) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number' && (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER)) {
    throw new Error('多维表含无法精确表示的数字；账号和作品 ID 请使用文本，未猜测或四舍五入后导入');
  }
  if (['string', 'number', 'boolean'].includes(typeof value)) return String(value);
  if (depth > 3) throw new Error('多维表单元格结构层级过深；未截断证据或导入部分行');
  if (Array.isArray(value)) {
    if (value.length > 100) throw new Error('多维表单元格内容超过安全读取上限；未截断证据');
    return [...new Set(value.map(item => cellText(item, includeLink, depth + 1)).filter(Boolean))].join(includeLink ? ' ' : '、');
  }
  if (typeof value !== 'object') return '';
  const visible = [value.text, value.name, value.value].find(item => ['string', 'number', 'boolean'].includes(typeof item));
  const parts = [visible === undefined ? '' : cellText(visible, false, depth + 1)];
  if (includeLink) for (const key of ['link', 'url', 'hyperlink']) {
    if (typeof value[key] === 'string' && value[key].trim()) parts.push(value[key]);
  }
  return [...new Set(parts.filter(Boolean))].join(' ');
}

const csvRow = values => values.map(value => `"${String(value).replaceAll('"', '""')}"`).join(',');

/** Network-free adapter. Security and conflicting identities use the upload parser. */
export async function mapBitableAuthorRows({ fields, rows, defaultBoard = '' } = {}) {
  if (!Array.isArray(fields) || !Array.isArray(rows)) throw new Error('多维表缺少明确字段或记录数组；未执行导入');
  if (fields.length > AUTHOR_UPLOAD_LIMITS.maxColumns) throw new Error(`多维表超过 ${AUTHOR_UPLOAD_LIMITS.maxColumns} 列限制`);
  if (rows.length > AUTHOR_UPLOAD_LIMITS.maxRows) throw new Error(`多维表超过单次安全导入 ${AUTHOR_UPLOAD_LIMITS.maxRows} 行限制；未只导入前半部分`);
  if (!rows.length) return [];
  const headers = fields.map(header);
  const values = rows.map((row, index) => {
    if (!row || !Array.isArray(row.values) || row.values.length > fields.length) throw new Error(`多维表第 ${index + 1} 行结构与字段不一致；未执行部分导入`);
    return headers.map((name, column) => {
      const evidenceField = linkedField(name);
      // Feishu can serialize one link as [URL](URL). Collapse only identical
      // label/target pairs, before enforcing the evidence limit. No URL,
      // selector, query parameter or conflicting second link is discarded.
      const raw = cellText(row.values[column], evidenceField);
      const text = evidenceField ? raw.replace(/\[(https?:\/\/[^\]\s]+)\]\(\1\)/g, '$1') : raw;
      if (evidenceField && text.length > 1_000) throw new Error(`多维表第 ${index + 1} 行证据超过解析上限；未截断链接后选择其中一个账号`);
      return text;
    });
  });
  const parsed = await parseAuthorSpreadsheet({ fileName: '多维表作者字段.csv', buffer: Buffer.from([csvRow(headers), ...values.map(csvRow)].join('\n')) });
  if (parsed.headerRow !== 1) throw new Error('多维表字段未识别；未将数据正文猜作表头');
  return parsed.rows.map(row => {
    const sourceRow = row.sourceRow - 1;
    const name = row.board || String(defaultBoard ?? '').trim();
    const sourceRecordId = recordId(rows[sourceRow - 1]?.recordId);
    return { ...row, sourceRow, ...(sourceRecordId ? { sourceRecordId } : {}), board: name,
      boards: name ? [{ name, sourceRow, organization: row.organization, tier: row.tier, category: row.category,
        owner: row.owner, filledDate: row.filledDate, note: row.notes }] : [] };
  });
}
