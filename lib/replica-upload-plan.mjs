import {replicaBatchByteLimit} from './replica-partition-budget.mjs';

const invalid = code => { throw Object.assign(new Error(code), {code}); };

/** Exact UTF-8 request budgets, encoding each partition once. Callers validate
 * source schema and identity. The iterator also permits bounded read-only
 * archive audits without retaining every partition body in memory. */
export function* replicaUploadBatches(publication, {reuseUnchanged = false} = {}) {
  if (!publication?.manifest || typeof publication.manifest.asOf !== 'string'
    || !publication.files?.[Symbol.iterator] || typeof reuseUnchanged !== 'boolean') invalid('invalid-source');
  const envelope = Buffer.byteLength(JSON.stringify({action: 'upload', asOf: publication.manifest.asOf,
    files: [], ...(reuseUnchanged ? {reuseUnchanged: true} : {})}));
  let files = [], bytes = envelope;
  for (const source of publication.files) {
    if (typeof source?.path !== 'string' || typeof source.sha256 !== 'string'
      || typeof source.content !== 'string') invalid('invalid-source');
    const file = {path: source.path, sha256: source.sha256, data: source.content};
    const encoded = Buffer.byteLength(JSON.stringify(file));
    const candidate = [...files, file], nextBytes = bytes + encoded + (files.length ? 1 : 0);
    if (files.length && (candidate.length > 35 || nextBytes > replicaBatchByteLimit(candidate))) {
      yield files;
      files = []; bytes = envelope;
    }
    bytes += encoded + (files.length ? 1 : 0);
    files.push(file);
    if (bytes > replicaBatchByteLimit(files)) invalid('partition-too-large');
  }
  if (files.length) yield files;
}
