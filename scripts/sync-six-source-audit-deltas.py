#!/usr/bin/env python3
"""Append-only public evidence for rows omitted by the consolidated source import.

Never edits imported source rows, monitoring targets, platform snapshots or
settlement amounts. Re-running against the same source revision is idempotent.
"""
import argparse
import json
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

import openpyxl

JIMENG_URL = "https://ccnmwvgvsr3v.feishu.cn/wiki/DoG0wooaBi57Z5k25nYciiL5n5e?sheet=292f5f"
BASE_URLS = {
    "ai_registry": "https://ccnmwvgvsr3v.feishu.cn/wiki/Nzk1wUABNiGZvckQX4BcrVl6nqc",
    "slice_registry": "https://ccnmwvgvsr3v.feishu.cn/wiki/FbWFw55aqibiMFkig84cKbvhnNe",
}


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--db", required=True)
    p.add_argument("--audit", required=True)
    p.add_argument("--registry-audit", required=True)
    p.add_argument("--jimeng-export", required=True)
    args = p.parse_args()
    audit = json.loads(Path(args.audit).read_text(encoding="utf-8"))
    registry = json.loads(Path(args.registry_audit).read_text(encoding="utf-8"))
    missing = audit["award_comparison"]["jimeng_awards"]["missing_origin_rows"]
    if [(r["tab_index"], r["row"]) for r in missing] != [(1, 150), (1, 151)]:
        raise RuntimeError("Award delta changed; review the raw audit before writing")

    book = openpyxl.load_workbook(args.jimeng_export, read_only=True, data_only=True)
    sheet = book.worksheets[1]
    sheet.reset_dimensions()
    award_payloads = []
    for number, row in enumerate(sheet.iter_rows(values_only=True), 1):
        if number not in (150, 151):
            continue
        name, account_id, link, likes, plays, amount = row[:6]
        if not name or not account_id or not str(link).strip().startswith("https://v.douyin.com/") or amount != 50:
            raise RuntimeError(f"Unexpected source row {number}; refusing to write")
        award_payloads.append((number, {
            "track": "即梦二创", "award": "点赞激励奖", "author_name": str(name),
            "account_id": str(account_id), "work_url": str(link).strip(),
            "likes_in_announcement": int(likes), "plays_in_announcement": int(plays),
            "announced_amount_yuan": int(amount),
            "video_id": None, "publication_date": None,
            "interpretation": "原公示表记录；未核验平台实时值、归属、资格或结算",
        }))
    book.close()
    if len(award_payloads) != 2:
        raise RuntimeError("Could not read both omitted rows from the original export")

    corrections = []
    for source, report in registry.items():
        for item in report["account_change_details"]:
            corrections.append((source, report["rev"], item))
    if len(corrections) != 3:
        raise RuntimeError("Registry correction count changed; review first")

    db = sqlite3.connect(args.db, timeout=30)
    db.execute("PRAGMA busy_timeout=30000")
    db.execute("""CREATE TABLE IF NOT EXISTS creator_source_external_deltas (
        source_url TEXT NOT NULL, source_revision TEXT NOT NULL, kind TEXT NOT NULL,
        origin_key TEXT NOT NULL, observed_at TEXT NOT NULL, payload_json TEXT NOT NULL,
        PRIMARY KEY(source_url,source_revision,kind,origin_key)
    )""")
    observed = datetime.now(timezone.utc).isoformat()
    inserted = 0
    with db:
        for number, payload in award_payloads:
            result = db.execute("""INSERT OR IGNORE INTO creator_source_external_deltas
                VALUES(?,?,?,?,?,?)""", (JIMENG_URL, "105", "award_missing_from_import",
                f"292f5f:{number}", observed, json.dumps(payload, ensure_ascii=False)))
            inserted += result.rowcount
        for source, revision, item in corrections:
            payload = {
                "record_id": item["record_id"],
                "previous_account_id": item["stored"],
                "current_source_account_id": item["live"],
                "interpretation": "原登记与总表标准化文本不一致；仅作为来源勘误，不自动修改监控身份",
            }
            result = db.execute("""INSERT OR IGNORE INTO creator_source_external_deltas
                VALUES(?,?,?,?,?,?)""", (BASE_URLS[source], str(revision),
                "registry_account_text_difference", item["record_id"], observed,
                json.dumps(payload, ensure_ascii=False)))
            inserted += result.rowcount
    total = db.execute("SELECT COUNT(*) FROM creator_source_external_deltas").fetchone()[0]
    print(json.dumps({"inserted": inserted, "total": total, "award_rows": len(award_payloads),
                      "registry_differences": len(corrections)}, ensure_ascii=False))


if __name__ == "__main__":
    main()
