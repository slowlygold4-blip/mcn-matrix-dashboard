#!/usr/bin/env python3
"""Read-only complete public-field reconciliation of two Feishu author bases."""
import argparse
import json
import re
import sqlite3
import subprocess
import time
from pathlib import Path

BASES = [
    ("ai_registry", "EVkPbUqX8aFBlcs7KEJc5CX6nLf", "tbldHq5cIDTm97XZ"),
    ("slice_registry", "VMdZbsT6uajUg4s9wtNcRjZtnEh", "tblvx0Q1ZmVx88Er"),
]


def get_page(base, table, offset):
    argv = ["lark-cli", "base", "+record-list", "--base-token", base,
            "--table-id", table, "--offset", str(offset), "--limit", "200",
            "--field-id", "抖音ID", "--field-id", "抖音名称",
            "--as", "user", "--format", "json"]
    for attempt in range(3):
        run = subprocess.run(argv, capture_output=True, text=True)
        if run.returncode == 0:
            break
        if attempt == 2:
            raise RuntimeError(f"Base page offset {offset} failed: {run.stderr[-300:]} {run.stdout[-500:]}")
        time.sleep(attempt + 1)
    envelope = json.loads(run.stdout)
    if not envelope.get("ok"):
        raise RuntimeError(envelope.get("error"))
    return envelope["data"]


def text(value):
    if isinstance(value, dict):
        return str(value.get("text") or value.get("value") or "").strip()
    return "" if value is None else str(value).strip()


def normalized_account(value):
    value = re.sub(r"\[([^]]+)\]\(https?://[^)]+\)", r"\1", value)
    return value.casefold()


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--db", required=True)
    p.add_argument("--output", required=True)
    args = p.parse_args()
    db = sqlite3.connect(args.db)
    latest = db.execute("SELECT MAX(id) FROM creator_source_imports").fetchone()[0]
    stored = {}
    for (raw,) in db.execute(
        "SELECT values_json FROM creator_source_rows WHERE import_id=? AND sheet_id='11'", (latest,)
    ):
        values = json.loads(raw)
        stored[(values[1], values[0])] = (text(values[3]), text(values[2]))
    additions = {}
    for base, record, account, name in db.execute(
        "SELECT base_token,record_id,account_id,author_name FROM creator_source_registry_additions"
    ):
        additions[(base, record)] = (text(account), text(name))

    report = {}
    for key, base, table in BASES:
        live = {}
        offset = 0
        rev = None
        while True:
            page = get_page(base, table, offset)
            if rev is None:
                rev = page["rev"]
            elif rev != page["rev"]:
                raise RuntimeError(f"{key} revision changed while paging: {rev} -> {page['rev']}")
            ids, rows = page["record_id_list"], page["data"]
            if len(ids) != len(rows):
                raise RuntimeError(f"{key} id/value count mismatch at offset {offset}")
            for record, row in zip(ids, rows):
                if record in live:
                    raise RuntimeError(f"{key} repeated record id {record}")
                live[record] = (text(row[0]), text(row[1]))
            offset += len(ids)
            if not page.get("has_more"):
                break
            if not ids:
                raise RuntimeError(f"{key} has_more but empty page")
        old = {record: values for (source, record), values in stored.items() if source == key}
        added = {record: values for (source, record), values in additions.items() if source == base}
        missing = sorted(set(old) - set(live))
        new = sorted(set(live) - set(old) - set(added))
        discrepancies = []
        normalized_account_changes = []
        name_changes = []
        for record, current in live.items():
            prior = old.get(record) or added.get(record)
            if prior and prior != current:
                discrepancies.append({"record_id": record, "stored": prior, "live": current})
                if normalized_account(prior[0]) != normalized_account(current[0]):
                    normalized_account_changes.append({"record_id": record, "stored": prior[0], "live": current[0]})
                if prior[1] != current[1]:
                    name_changes.append({"record_id": record, "stored": prior[1], "live": current[1]})
        report[key] = {
            "rev": rev,
            "live_rows": len(live),
            "stored_import_rows": len(old),
            "stored_addition_rows": len(added),
            "missing_from_live": len(missing),
            "missing_sample_record_ids": missing[:10],
            "new_unrecorded": len(new),
            "new_unrecorded_samples": [{"record_id": r, "account": live[r][0], "name": live[r][1]} for r in new[:10]],
            "public_identity_discrepancies": len(discrepancies),
            "identity_discrepancy_samples": discrepancies[:10],
            "account_changes_after_case_and_link_normalization": len(normalized_account_changes),
            "account_change_details": normalized_account_changes,
            "name_changes": len(name_changes),
            "name_change_details": name_changes,
            "blank_account_ids": sum(not account for account, _ in live.values()),
        }
    Path(args.output).write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False))


if __name__ == "__main__":
    main()
