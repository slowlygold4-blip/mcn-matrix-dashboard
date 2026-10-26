// Preserve only verified, previously public compiled assets across deployments.
// Never retain HTML, API responses, source maps, server code, or environment files.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';

const LIMIT_BYTES = 64 * 1024 * 1024;
// 2026-10-26: reviewed current union; bounded expansion to 64 MiB / 768 files.
// See docs/2026-10-26-continuous-monitoring.md. All allowlists/hash checks retained.
// Previous 2026-10-24 capacity review: 410 verified old/current files total 34,282,972
// bytes. Keep old lazy imports and every integrity check; the bounded 40 MiB
// ceiling is documented in docs/2026-10-24-retained-assets-capacity.md.
const LIMIT_FILES = 768;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const permitted = name => /^_next\/static\/(?:chunks\/[A-Za-z0-9_-]+-[A-Za-z0-9_-]{8}\.js|css\/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{8}\.css|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/_?(?:buildManifest|ssgManifest)\.js)$/.test(name);

function safePath(root, name, allowMissing = false) {
  if (!permitted(name)) throw new Error(`Asset is not allowlisted: ${name}`);
  const base = path.resolve(root);
  if (fs.existsSync(base) && (fs.lstatSync(base).isSymbolicLink() || !fs.lstatSync(base).isDirectory())) throw new Error('Asset root symlink or non-directory rejected');
  const rel = path.relative(base, path.resolve(base, name));
  if (rel !== name || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('Asset path escapes root');
  let target = base;
  for (const part of name.split('/')) {
    target = path.join(target, part);
    try { if (fs.lstatSync(target).isSymbolicLink()) throw new Error(`Symlink rejected: ${name}`); }
    catch (error) { if (!allowMissing || error.code !== 'ENOENT') throw error; }
  }
  return target;
}

function validate(entries) {
  if (entries.size > LIMIT_FILES) throw new Error('Retained asset file limit exceeded; explicit review required');
  let total = 0;
  for (const [name, bytes] of entries) {
    if (!permitted(name)) throw new Error(`Asset is not allowlisted: ${name}`);
    total += bytes.length;
    if (total > LIMIT_BYTES) throw new Error('Retained asset byte limit exceeded; explicit review required');
    if (name.endsWith('.js')) {
      for (const match of bytes.toString('utf8').matchAll(/\bimport\s*\(\s*([^)]*)\)/g)) {
        if (!/^["'`][^"'`$\s]+\.js["'`]\s*$/.test(match[1])) throw new Error(`Non-literal compiled import requires review: ${name}`);
      }
    }
    // Vite emits literal relative imports and preload names. Check all emitted
    // JS/CSS asset literals, including its preload map, not only static imports.
    for (const match of bytes.toString('utf8').matchAll(/["'`]((?:\.\/|\.\.\/|\/?_next\/static\/)[^"'`\s]*\.(?:js|css))["'`]/g)) {
      const specifier = match[1];
      const dependency = specifier.startsWith('.')
        ? path.posix.normalize(path.posix.join(path.posix.dirname(name), specifier))
        : specifier.replace(/^\//, '');
      if (!permitted(dependency) || !entries.has(dependency)) throw new Error(`Missing compiled dependency: ${name} -> ${dependency}`);
    }
  }
}

function scan(root) {
  const entries = new Map();
  let total = 0;
  if (fs.existsSync(root) && (fs.lstatSync(root).isSymbolicLink() || !fs.lstatSync(root).isDirectory())) throw new Error('Asset root symlink or non-directory rejected');
  const staticRoot = path.join(root, '_next/static');
  if (!fs.existsSync(staticRoot)) return entries;
  function visit(directory) {
    if (fs.lstatSync(directory).isSymbolicLink()) throw new Error('Asset directory symlink rejected');
    for (const item of fs.readdirSync(directory, {withFileTypes: true})) {
      const full = path.join(directory, item.name);
      if (item.isSymbolicLink()) throw new Error('Asset symlink rejected');
      if (item.isDirectory()) visit(full);
      else {
        const name = path.relative(root, full).split(path.sep).join('/');
        if (!item.isFile() || !permitted(name)) throw new Error(`Unexpected static asset: ${name}`);
        const stat = fs.statSync(full);
        total += stat.size;
        if (total > LIMIT_BYTES) throw new Error('Retained asset byte limit exceeded');
        if (entries.size >= LIMIT_FILES) throw new Error('Retained asset file limit exceeded');
        entries.set(name, fs.readFileSync(safePath(root, name)));
      }
    }
  }
  visit(staticRoot);
  validate(entries);
  return entries;
}

function readArchive(directory) {
  const manifest = path.join(directory, 'manifest.json');
  if (!fs.existsSync(manifest)) {
    if (fs.existsSync(directory) && fs.readdirSync(directory).length) throw new Error('Archive without manifest rejected');
    return new Map();
  }
  if (fs.lstatSync(directory).isSymbolicLink() || fs.lstatSync(manifest).isSymbolicLink()) throw new Error('Archive symlink rejected');
  if (fs.statSync(manifest).size > 256 * 1024) throw new Error('Oversized asset manifest');
  const saved = JSON.parse(fs.readFileSync(manifest, 'utf8'));
  if (saved.version !== 1 || !Array.isArray(saved.assets) || saved.assets.length > LIMIT_FILES) throw new Error('Invalid retained asset manifest');
  const entries = new Map();
  let total = 0;
  for (const row of saved.assets) {
    if (entries.has(row.path) || !/^[0-9a-f]{64}$/.test(row.sha256) || !Number.isSafeInteger(row.bytes) || row.bytes < 0 || row.bytes > LIMIT_BYTES) throw new Error('Invalid retained asset entry');
    total += row.bytes;
    if (total > LIMIT_BYTES) throw new Error('Retained asset byte limit exceeded');
    const full = safePath(directory, row.path);
    if (!fs.lstatSync(full).isFile() || fs.statSync(full).size !== row.bytes) throw new Error('Asset size mismatch');
    const bytes = fs.readFileSync(full);
    if (hash(bytes) !== row.sha256) throw new Error(`Asset digest mismatch: ${row.path}`);
    entries.set(row.path, bytes);
  }
  validate(entries);
  return entries;
}

function union(left, right) {
  const result = new Map(left);
  for (const [name, bytes] of right) {
    if (result.has(name) && !result.get(name).equals(bytes)) throw new Error(`Conflicting immutable asset: ${name}`);
    result.set(name, bytes);
  }
  validate(result);
  return result;
}

function writeMissing(directory, entries) {
  for (const [name, bytes] of entries) {
    const full = safePath(directory, name, true);
    fs.mkdirSync(path.dirname(full), {recursive: true});
    try { fs.writeFileSync(full, bytes, {flag: 'wx', mode: 0o644}); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (!fs.lstatSync(full).isFile() || !fs.readFileSync(full).equals(bytes)) throw new Error(`Existing asset changed: ${name}`);
    }
  }
}

export function retainClientAssets({projectRoot, clientRoot = path.join(projectRoot, 'dist/client'), mode}) {
  if (!['capture', 'merge'].includes(mode)) throw new Error('Expected capture or merge');
  const archiveRoot = path.join(projectRoot, 'build/retained-client-assets');
  if (fs.existsSync(path.join(projectRoot, 'build')) && fs.lstatSync(path.join(projectRoot, 'build')).isSymbolicLink()) throw new Error('Archive ancestor symlink rejected');
  const archived = readArchive(archiveRoot);
  const current = scan(clientRoot);
  const combined = union(archived, current); // Reject collisions before any write.
  if (mode === 'capture') {
    fs.mkdirSync(archiveRoot, {recursive: true});
    writeMissing(archiveRoot, combined);
    const manifest = {version: 1, assets: [...combined].sort(([a], [b]) => a.localeCompare(b)).map(([name, bytes]) => ({path: name, bytes: bytes.length, sha256: hash(bytes)}))};
    const bytes = JSON.stringify(manifest, null, 2) + '\n';
    const file = path.join(archiveRoot, 'manifest.json');
    if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== bytes) {
      const temporary = path.join(archiveRoot, `.manifest-${process.pid}.tmp`);
      fs.writeFileSync(temporary, bytes, {flag: 'wx', mode: 0o644});
      fs.renameSync(temporary, file);
    }
  } else {
    if (current.size === 0) throw new Error('Current compiled assets missing; build must finish before merge');
    writeMissing(clientRoot, archived); // Current entries are never overwritten.
  }
  return {mode, archived: archived.size, current: current.size, retained: combined.size, bytes: [...combined.values()].reduce((n, b) => n + b.length, 0)};
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const projectRoot = fileURLToPath(new URL('..', import.meta.url));
  console.log(JSON.stringify(retainClientAssets({projectRoot, mode: process.argv[2]})));
}
