import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const parse = value => JSON.parse(value);
const escapeLike = value => value.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_');
const boundedInteger = (value, fallback, maximum) => {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 1 ? Math.min(number, maximum) : fallback;
};

export class CreatorLibraryReader {
  constructor(filePath) { this.filePath = filePath; }

  withDb(callback) {
    if (!existsSync(this.filePath)) return null;
    const db = new DatabaseSync(this.filePath, { readOnly: true });
    try { return callback(db); } finally { db.close(); }
  }

  summary({ admin = false } = {}) {
    return this.withDb(db => {
      const metadata = Object.fromEntries(db.prepare('SELECT key,value FROM metadata').all().map(row => [row.key, parse(row.value)]));
      const sheets = db.prepare('SELECT sheet_id,sheet_name,ordinal,row_count,headers_json,restricted FROM source_sheets ORDER BY ordinal').all()
        .map(row => ({ id: row.sheet_id, name: row.sheet_name, rowCount: row.row_count,
          headers: parse(row.headers_json), restricted: Boolean(row.restricted) }));
      const rows = id => db.prepare('SELECT values_json FROM source_rows WHERE sheet_id=? ORDER BY row_number').all(id).map(row => parse(row.values_json));
      const overview = Object.fromEntries(rows('01').map(row => [String(row[0] ?? ''), row[1]]));
      const tracks = rows('05').map(row => ({ name: row[0], works: row[1], authors: row[2], plays: row[3], highLikeWorks: row[4], collectionRecords: row[5] }));
      const audit = { ...metadata.audit };
      if (!admin) { delete audit.candidateBonus; delete audit.announcedBonus; }
      return { available: true, sourceUrl: metadata.sourceUrl, sourceSha256: metadata.sourceSha256,
        sourceRevision: metadata.sourceRevision, sourceModifiedAt: metadata.sourceModifiedAt, importedAt: metadata.importedAt,
        note: metadata.note, audit, sheets, tracks,
        sourcePeriod: { start: overview['统计开始'], end: overview['统计结束'] },
        dataRefreshedAt: overview['数据刷新'],
        // Never present source cumulative play totals as period growth or monitoring observations.
        semantics: { plays: '来源表去重后的已知累计播放；不是监控区间新增播放，未独立核实为平台实时值',
          bonus: '公示与候选分列，均不是实付金额', missing: '空播放、空点赞、空奖金不是 0' } };
    }) ?? { available: false, error: '创作者库尚未完成导入' };
  }

  rows({ sheetId = '08', query = '', track = '', linkStatus = 'all', page = 1, pageSize = 30, admin = false } = {}) {
    return this.withDb(db => {
      const sheet = db.prepare('SELECT * FROM source_sheets WHERE sheet_id=?').get(String(sheetId));
      if (!sheet) return { error: '不存在该来源子表', statusCode: 404 };
      if (sheet.restricted && !admin) return { error: '此子表含授权、原始记录或奖金明细，仅管理员可查看', statusCode: 403 };
      const q = String(query ?? '').normalize('NFKC').trim().slice(0, 120).toLowerCase();
      const exactTrack = sheet.sheet_id === '09' ? String(track ?? '').trim().slice(0, 80) : '';
      const accountLinks = sheet.sheet_id === '08' && ['linked', 'unlinked'].includes(linkStatus) ? linkStatus : 'all';
      const size = boundedInteger(pageSize, 30, 100), current = boundedInteger(page, 1, 100000);
      const conditions = ['sheet_id=?'], params = [sheet.sheet_id];
      if (q) { conditions.push(`${admin ? 'search_text' : 'public_search_text'} LIKE ? ESCAPE '\\'`); params.push(`%${escapeLike(q)}%`); }
      if (exactTrack) { conditions.push("json_extract(values_json,'$[5]')=?"); params.push(exactTrack); }
      if (accountLinks !== 'all') conditions.push(`${accountLinks === 'linked' ? '' : 'NOT '}EXISTS (SELECT 1 FROM account_links WHERE author_row=source_rows.row_number)`);
      const where = conditions.join(' AND ');
      const count = db.prepare(`SELECT count(*) AS total FROM source_rows WHERE ${where}`).get(...params).total;
      const records = db.prepare(`SELECT row_number,values_json FROM source_rows WHERE ${where} ORDER BY row_number LIMIT ? OFFSET ?`)
        .all(...params, size, (current - 1) * size).map(row => ({ sourceRow: row.row_number, values: parse(row.values_json) }));
      if (sheet.sheet_id === '08') {
        const linked = db.prepare('SELECT target_id,matched_id FROM account_links WHERE author_row=? ORDER BY target_id');
        for (const record of records) {
          record.monitorMatches = linked.all(record.sourceRow).map(row => ({ targetId: row.target_id, matchedId: row.matched_id }));
          record.targetIds = record.monitorMatches.map(row => row.targetId);
          if (!admin) { record.values[16] = null; record.values[17] = null; }
        }
      }
      const headers = parse(sheet.headers_json);
      if (sheet.sheet_id === '08' && !admin) { headers[16] = '公示奖金（仅管理员）'; headers[17] = '候选奖金（仅管理员）'; }
      return { sheet: { id: sheet.sheet_id, name: sheet.sheet_name, headers, rowCount: sheet.row_count },
        query: q, track: exactTrack, linkStatus: accountLinks, page: current, pageSize: size, total: count, pages: Math.ceil(count / size), rows: records };
    }) ?? { error: '创作者库尚未完成导入', statusCode: 503 };
  }

  searchAll({ query = '', admin = false } = {}) {
    const q = String(query ?? '').normalize('NFKC').trim().slice(0, 120).toLowerCase();
    if (q.length < 2) return { error: '至少输入两个字符再搜索', statusCode: 400 };
    return this.withDb(db => {
      const condition = admin ? '' : ' AND s.restricted=0';
      const sql = `FROM source_rows r JOIN source_sheets s ON s.sheet_id=r.sheet_id
        WHERE r.${admin ? 'search_text' : 'public_search_text'} LIKE ? ESCAPE '\\'${condition}`;
      const term = `%${escapeLike(q)}%`;
      const total = db.prepare(`SELECT count(*) AS total ${sql}`).get(term).total;
      const matches = db.prepare(`SELECT r.sheet_id,s.sheet_name,r.row_number,r.values_json ${sql}
        ORDER BY s.ordinal,r.row_number LIMIT 100`).all(term).map(row => {
        const values = parse(row.values_json);
        if (!admin && row.sheet_id === '08') { values[16] = null; values[17] = null; }
        return { sheetId: row.sheet_id, sheetName: row.sheet_name, sourceRow: row.row_number,
          preview: values.filter(value => value != null).slice(0, 4).map(value => String(value).slice(0, 90)) };
      });
      return { query: q, total, shown: matches.length, matches };
    }) ?? { error: '创作者库尚未完成导入', statusCode: 503 };
  }
}
