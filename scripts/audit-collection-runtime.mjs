#!/usr/bin/env node
import { DatabaseSync } from "node:sqlite";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { auditCollectionRuntime } from "../lib/collection-runtime-audit.mjs";

const args = process.argv.slice(2);
const arg = (name) => args.includes(name) ? args[args.indexOf(name) + 1] : null;
const project = fileURLToPath(new URL("..", import.meta.url));
const path = resolve(project, arg("--database") || "data/douyin-monitor.sqlite");
const db = new DatabaseSync(path, { readOnly: true });
try {
  const runId = Number(arg("--run") || db.prepare("SELECT id FROM runs ORDER BY id DESC LIMIT 1").get()?.id);
  const report = auditCollectionRuntime({ database: db, runId });
  if (arg("--out")) {
    const output = resolve(project, arg("--out"));
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  }
  const { samples, ...summary } = report;
  console.log(JSON.stringify(summary, null, 2));
} finally { db.close(); }
