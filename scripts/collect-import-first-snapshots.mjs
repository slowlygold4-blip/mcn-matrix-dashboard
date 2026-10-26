// Initialize only verified, enabled targets from one explicitly named import.
// All writes go through the authenticated application, not direct metric SQL.
import { DatabaseSync } from "node:sqlite";
import { resolve } from "node:path";

const fileName = process.argv[2];
if (!fileName) throw new Error("Provide the exact import file name");
const database = new DatabaseSync(resolve("data/douyin-monitor.sqlite"), { readOnly: true });
const base = "http://127.0.0.1:4188";
const authResponse = await fetch(`${base}/api/bootstrap`);
const cookie = authResponse.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
const bootstrap = await authResponse.json();
if (!authResponse.ok || !bootstrap.auth?.csrfToken) throw new Error("Application authentication failed");
const headers = { "content-type": "application/json", cookie, "x-csrf-token": bootstrap.auth.csrfToken, origin: base };
const attempted = new Set();
const deadline = Date.now() + 20 * 60_000;
let success = 0;
let failures = 0;
try {
  while (Date.now() < deadline) {
    const targets = database.prepare(`
      SELECT DISTINCT t.id,t.label FROM author_resolution_queue q
      JOIN targets t ON t.id=q.resolved_target_id
      WHERE q.file_name=? AND q.status='resolved' AND t.enabled=1 AND t.last_checked_at IS NULL
      ORDER BY t.id
    `).all(fileName).filter((target) => !attempted.has(target.id));
    for (const target of targets) {
      const response = await fetch(`${base}/api/sync`, {
        method: "POST", headers, body: JSON.stringify({ targetId: target.id }),
      });
      const result = await response.json();
      if (response.status === 409) break; // A normal scheduler run owns the collector.
      attempted.add(target.id);
      if (response.ok && result.successCount === 1) success += 1;
      else failures += 1;
      console.log(JSON.stringify({ event: "first-snapshot", targetId: target.id, name: target.label,
        ok: response.ok && result.successCount === 1, error: result.error ?? null, success, failures }));
    }
    const pending = database.prepare(`
      SELECT count(*) count FROM author_resolution_queue
      WHERE file_name=? AND (status='pending' OR (status='retry' AND next_attempt_at<=?))
    `).get(fileName, new Date().toISOString()).count;
    const remaining = database.prepare(`
      SELECT DISTINCT t.id FROM author_resolution_queue q JOIN targets t ON t.id=q.resolved_target_id
      WHERE q.file_name=? AND q.status='resolved' AND t.enabled=1 AND t.last_checked_at IS NULL
    `).all(fileName).filter((target) => !attempted.has(target.id)).length;
    if (!pending && !remaining) break;
    await new Promise((done) => setTimeout(done, 10_000));
  }
  console.log(JSON.stringify({ event: "complete", success, failures, attempted: attempted.size }));
} finally {
  database.close();
}
