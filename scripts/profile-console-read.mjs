import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MonitorDatabase } from '../lib/database.mjs';
import { getProductInsights } from '../lib/product-insights.mjs';

// Read-only diagnostics: never prints raw source, account names or credentials.
// Use an existing consistent backup to compare implementations on fixed data.
export function profileConsoleRead(databasePath, options, readInsights = getProductInsights) {
  const source = new DatabaseSync(databasePath, { readOnly: true });
  const statements = new Map(), ledgerReads = [];
  const summarize = (sql, elapsed, rows) => {
    const query = createHash('sha256').update(sql).digest('hex').slice(0, 12);
    const entry = statements.get(query) ?? { query, calls: 0, rows: 0, sqlMs: 0 };
    entry.calls += 1;
    entry.rows += Array.isArray(rows) ? rows.length : rows ? 1 : 0;
    entry.sqlMs += elapsed;
    statements.set(query, entry);
  };
  const database = new Proxy(source, {
    get(db, key) {
      if (key !== 'prepare') {
        const value = Reflect.get(db, key, db);
        return typeof value === 'function' ? value.bind(db) : value;
      }
      return sql => {
        const prepared = db.prepare(sql);
        return new Proxy(prepared, {
          get(statement, method) {
            if (method === 'all' || method === 'get') return (...args) => {
              const start = performance.now();
              const rows = statement[method](...args);
              summarize(sql, performance.now() - start, rows);
              if (method === 'all' && sql.includes('FROM included i JOIN works_observations')) {
                ledgerReads.push({
                  kind: sql.includes('scoped_targets AS') ? 'default' : 'explicit',
                  asOf: args.find(value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT/.test(value)),
                  candidates: new Set(rows.filter(row => row.selected_row).map(row => `${row.target_id}:${row.run_id}`)),
                  materializedRows: rows.length,
                });
              }
              return rows;
            };
            if (method === 'iterate') return (...args) => {
              const iterator = statement.iterate(...args);
              let sqlMs = 0, count = 0, finished = false;
              const finish = () => {
                if (finished) return;
                finished = true;
                // Iterator timing measures next(), not validation work between rows.
                summarize(sql, sqlMs, null);
                const query = createHash('sha256').update(sql).digest('hex').slice(0, 12);
                statements.get(query).rows += count;
              };
              return {
                [Symbol.iterator]() { return this; },
                next() {
                  const start = performance.now();
                  try {
                    const value = iterator.next();
                    sqlMs += performance.now() - start;
                    if (value.done) finish(); else count += 1;
                    return value;
                  } catch (error) {
                    sqlMs += performance.now() - start;
                    finish();
                    throw error;
                  }
                },
                return() { finish(); return iterator.return?.() ?? { done: true }; },
              };
            };
            const value = Reflect.get(statement, method, statement);
            return typeof value === 'function' ? value.bind(statement) : value;
          },
        });
      };
    },
  });
  try {
    source.exec('BEGIN');
    const adapter = Object.assign(Object.create(MonitorDatabase.prototype), { db: database, filePath: databasePath });
    const start = performance.now();
    const result = readInsights(adapter, options);
    const totalMs = performance.now() - start;
    source.exec('COMMIT');
    const overlaps = ledgerReads.filter(read => read.kind === 'explicit').map(read => {
      const defaults = ledgerReads.filter(other => other.kind === 'default' && other.asOf === read.asOf);
      const candidates = new Set(defaults.flatMap(other => [...other.candidates]));
      return { asOf: read.asOf, explicitCandidates: read.candidates.size,
        overlapCandidates: [...read.candidates].filter(key => candidates.has(key)).length };
    });
    return {
      totalMs: Math.round(totalMs), accounts: result.accounts?.length ?? 0,
      responseChecksum: createHash('sha256').update(JSON.stringify(result)).digest('hex'),
      ledgerReads: ledgerReads.map(({ candidates, ...read }) => ({ ...read, selectedCandidates: candidates.size })),
      candidateOverlaps: overlaps,
      statements: [...statements.values()].map(entry => ({ ...entry, sqlMs: Math.round(entry.sqlMs) }))
        .sort((left, right) => right.sqlMs - left.sqlMs).slice(0, 10),
    };
  } finally { source.close(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const path = process.argv[2];
  if (!path) throw new Error('Provide an existing consistent SQLite backup path');
  const options = { period: 'custom', startDate: '2026-09-12', endDate: '2026-10-04',
    comparisonStartDate: '2026-08-30', comparisonEndDate: '2026-09-11',
    reference: new Date('2026-10-04T16:00:00.000Z'), timeZone: 'Asia/Shanghai', comparisonProjection: 'summary' };
  const sourceHashes = Object.fromEntries(['product-insights.mjs', 'works-observation.mjs'].map(name =>
    [name, createHash('sha256').update(readFileSync(new URL(`../lib/${name}`, import.meta.url))).digest('hex')]));
  console.log(JSON.stringify({ sourceHashes, ...profileConsoleRead(resolve(path), options) }));
}
