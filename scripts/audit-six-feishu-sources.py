#!/usr/bin/env python3
"""Read-only, row-level audit of the six user-supplied Feishu sources.

Uses locally exported XLSX originals and the existing immutable source rows.
The exporter writes an incorrect A1:A1 dimension; reset_dimensions is required.
No private registration fields are copied into the report.
"""

import argparse
import collections
import hashlib
import json
import re
import sqlite3
from decimal import Decimal, InvalidOperation
from pathlib import Path

import openpyxl


TOPIC_KEYS = [
    "event_topic", "jimeng_topic_historical", "slice_topic",
    "creation_topic", "jimeng_topic",
]
VIDEO_ID = re.compile(r"^\d{17,20}$")
REF = re.compile(r"(event_topic|jimeng_topic_historical|slice_topic|creation_topic|jimeng_topic):(\d+)")
LINK = re.compile(r"https?://(?:v\.douyin\.com|www\.douyin\.com/video)/[^\s]+")


def value_text(value):
    return "" if value is None else str(value).strip()


def normalize_link(value):
    return value_text(value).rstrip("/ ")


def metric(value):
    if value is None or value_text(value) in ("", "—", "-"):
        return None
    raw = value_text(value).replace(",", "").replace("+", "")
    factor = 100000000 if raw.endswith("亿") else 10000 if raw.lower().endswith("w") or raw.endswith("万") else 1
    if factor != 1:
        raw = raw[:-1]
    try:
        return int(Decimal(raw) * factor)
    except InvalidOperation:
        return None


def iter_sheet(sheet):
    sheet.reset_dimensions()  # Feishu XLSX exporter declares A1:A1 even for huge sheets.
    for row_number, row in enumerate(sheet.iter_rows(values_only=True), 1):
        trimmed = list(row)
        while trimmed and trimmed[-1] is None:
            trimmed.pop()
        if any(value_text(v) for v in trimmed):
            yield row_number, trimmed


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--export-dir", required=True)
    parser.add_argument("--db", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()

    db = sqlite3.connect(args.db)
    latest = db.execute("SELECT MAX(id) FROM creator_source_imports").fetchone()[0]
    source = {}
    for sheet_id, row_number, raw in db.execute(
        "SELECT sheet_id,row_number,values_json FROM creator_source_rows "
        "WHERE import_id=? AND sheet_id IN ('02','09','13')", (latest,)
    ):
        source.setdefault(sheet_id, []).append((row_number, json.loads(raw)))
    expected = {v[0]: v[2] for _, v in source["02"] if v[0] in TOPIC_KEYS}
    canonical_refs = {}
    for _, values in source["09"]:
        refs = REF.findall(value_text(values[13]))
        for key, row in refs:
            canonical_refs[(key, int(row))] = (values, len(refs))

    result = {
        "source_import_id": latest,
        "expected_topic_rows": expected,
        "workbooks": {},
        "topics": {},
        "award_comparison": {},
    }
    all_topic_ids = collections.defaultdict(set)
    award_raw = collections.defaultdict(dict)
    for workbook_name in ("topics", "slice", "jimeng", "creation"):
        path = Path(args.export_dir) / (workbook_name + ".xlsx")
        workbook = openpyxl.load_workbook(path, read_only=True, data_only=True)
        sheet_reports = []
        for sheet_index, sheet in enumerate(workbook.worksheets):
            rows = list(iter_sheet(sheet))
            digest = hashlib.sha256()
            for number, row in rows:
                digest.update(json.dumps([number, row], ensure_ascii=False, default=str).encode())
                digest.update(b"\n")
            report = {
                "title": sheet.title,
                "nonempty_rows": len(rows),
                "last_nonempty_row": rows[-1][0] if rows else None,
                "first_rows": [{"row": n, "cells": [value_text(v)[:70] for v in r[:7]]}
                               for n, r in rows[:3]],
                "tail_rows": [{"row": n, "cells": [value_text(v)[:70] for v in r[:7]]}
                              for n, r in rows[-2:]],
                "sha256_nonempty_rows": digest.hexdigest(),
            }
            if workbook_name == "topics":
                key = TOPIC_KEYS[sheet_index]
                ids = collections.defaultdict(list)
                missing = []
                absent_ref = []
                wrong_ref = []
                single_ref_metric_mismatch = []
                canonical_below_raw = []
                raw_metric_missing = collections.Counter()
                for number, row in rows[1:]:
                    id_col = 0 if key == "jimeng_topic_historical" else 2
                    video_id = value_text(row[id_col]) if len(row) > id_col else ""
                    if not VIDEO_ID.fullmatch(video_id):
                        missing.append(number)
                        continue
                    ids[video_id].append(number)
                    all_topic_ids[video_id].add(key)
                    play_col = 5 if key == "jimeng_topic_historical" else 4
                    like_col = 6 if key == "jimeng_topic_historical" else 5
                    raw_plays = metric(row[play_col]) if len(row) > play_col else None
                    raw_likes = metric(row[like_col]) if len(row) > like_col else None
                    if raw_plays is None:
                        raw_metric_missing["plays"] += 1
                    if raw_likes is None:
                        raw_metric_missing["likes"] += 1
                    linked = canonical_refs.get((key, number))
                    if not linked:
                        absent_ref.append(number)
                    elif value_text(linked[0][0]) != video_id:
                        wrong_ref.append({"row": number, "live": video_id, "stored": linked[0][0]})
                    elif linked[1] == 1 and (raw_plays != metric(linked[0][7]) or raw_likes != metric(linked[0][8])):
                        single_ref_metric_mismatch.append({"row": number, "video_id": video_id,
                            "raw_plays": raw_plays, "stored_plays": metric(linked[0][7]),
                            "raw_likes": raw_likes, "stored_likes": metric(linked[0][8])})
                    if linked and value_text(linked[0][0]) == video_id:
                        saved_play, saved_like = metric(linked[0][7]), metric(linked[0][8])
                        if ((raw_plays is not None and saved_play is not None and saved_play < raw_plays)
                            or (raw_likes is not None and saved_like is not None and saved_like < raw_likes)):
                            canonical_below_raw.append({"row": number, "video_id": video_id,
                                "raw_plays": raw_plays, "stored_plays": saved_play,
                                "raw_likes": raw_likes, "stored_likes": saved_like})
                report["topic"] = {
                    "source_key": key,
                    "expected_raw_rows": expected[key],
                    "actual_raw_rows": len(rows) - 1,
                    "valid_video_id_rows": sum(len(v) for v in ids.values()),
                    "unique_video_ids": len(ids),
                    "missing_or_invalid_video_id_rows": len(missing),
                    "missing_or_invalid_sample_rows": missing[:12],
                    "duplicate_video_ids_within_tab": sum(len(v) > 1 for v in ids.values()),
                    "duplicate_extra_rows_within_tab": sum(len(v)-1 for v in ids.values()),
                    "duplicate_samples": [{"video_id": k, "rows": v} for k,v in ids.items() if len(v)>1][:8],
                    "not_linked_to_canonical_work": len(absent_ref),
                    "not_linked_sample_rows": absent_ref[:12],
                    "wrong_canonical_video_id": len(wrong_ref),
                    "wrong_canonical_samples": wrong_ref[:8],
                    "raw_metric_missing": dict(raw_metric_missing),
                    "single_source_work_metric_mismatch": len(single_ref_metric_mismatch),
                    "single_source_work_metric_samples": single_ref_metric_mismatch[:8],
                    "canonical_metric_below_raw_rows": len(canonical_below_raw),
                    "canonical_metric_below_raw_samples": canonical_below_raw[:8],
                }
                result["topics"][key] = report["topic"]
            else:
                links = set()
                for _, row in rows:
                    for cell in row:
                        links.update(normalize_link(link) for link in LINK.findall(value_text(cell)))
                report["douyin_links"] = len(links)
                report["link_samples"] = sorted(links)[:3]
                report["_links"] = links
                if (workbook_name == "slice" and sheet_index in (1, 2)) or (workbook_name == "jimeng" and sheet_index in (1, 2)) or (workbook_name == "creation" and sheet_index == 1):
                    first_data_row = 2 if (workbook_name == "slice" and sheet_index == 1) or (workbook_name == "jimeng" and sheet_index == 2) else 3
                    for number, row in rows:
                        if number >= first_data_row:
                            award_raw[workbook_name][(sheet_index, number)] = row
            sheet_reports.append(report)
        result["workbooks"][workbook_name] = sheet_reports
        workbook.close()

    awards = collections.defaultdict(set)
    for _, values in source["13"]:
        awards[value_text(values[0])].add(normalize_link(values[6]))
    for workbook_name, key in (("slice", "slice_awards"),
                               ("jimeng", "jimeng_awards"),
                               ("creation", "creation_awards")):
        raw_links = set().union(*(r.pop("_links") for r in result["workbooks"][workbook_name]))
        stored_links = awards[key]
        result["award_comparison"][key] = {
            "stored_detail_rows": sum(value_text(v[0]) == key for _, v in source["13"]),
            "raw_unique_links_all_tabs": len(raw_links),
            "stored_unique_links": len(stored_links),
            "raw_not_in_stored_count": len(raw_links - stored_links),
            "raw_not_in_stored_samples": sorted(raw_links - stored_links)[:10],
            "stored_not_in_raw_count": len(stored_links - raw_links),
            "stored_not_in_raw_samples": sorted(stored_links - raw_links)[:10],
        }
        stored_by_row = {}
        for _, v in source["13"]:
            if value_text(v[0]) != key:
                continue
            index = (1 if value_text(v[2]) == "新人激励" else 2) if workbook_name == "slice" else (2 if value_text(v[2]) == "模板跟拍奖" else 1) if workbook_name == "jimeng" else 1
            stored_by_row[(index, int(v[11]))] = v
        raw_keys = set(award_raw[workbook_name])
        saved_keys = set(stored_by_row)
        field_mismatch = []
        for origin in sorted(raw_keys & saved_keys):
            index, number = origin
            raw = award_raw[workbook_name][origin]
            saved = stored_by_row[origin]
            link_col = None if workbook_name == "slice" and index == 1 else 2 if workbook_name in ("jimeng", "creation") else 3
            if workbook_name == "jimeng" and index == 2:
                link_col = 2
            if link_col is not None and normalize_link(raw[link_col]) != normalize_link(saved[6]):
                field_mismatch.append({"tab_index": index, "row": number, "field": "link", "raw": normalize_link(raw[link_col]), "stored": normalize_link(saved[6])})
        result["award_comparison"][key].update({
            "raw_detail_rows": len(raw_keys),
            "stored_detail_rows_by_origin": len(saved_keys),
            "missing_origin_rows": [{"tab_index": i, "row": n,
                "author": value_text(award_raw[workbook_name][(i,n)][0])[:50]}
                for i,n in sorted(raw_keys - saved_keys)[:15]],
            "missing_origin_count": len(raw_keys - saved_keys),
            "stored_origin_not_raw_count": len(saved_keys - raw_keys),
            "link_mismatch_count": len(field_mismatch),
            "link_mismatch_samples": field_mismatch[:8],
        })
    result["cross_topic"] = {
        "unique_video_ids": len(all_topic_ids),
        "ids_in_multiple_tabs": sum(len(v) > 1 for v in all_topic_ids.values()),
        "overlap_samples": [{"video_id": k, "source_keys": sorted(v)}
                            for k, v in all_topic_ids.items() if len(v)>1][:10],
    }
    Path(args.output).write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({
        "output": args.output,
        "topics": result["topics"],
        "award_comparison": result["award_comparison"],
        "cross_topic": result["cross_topic"],
        "tabs": {name: [(r["title"], r["nonempty_rows"], r["last_nonempty_row"])
                        for r in reports] for name, reports in result["workbooks"].items()},
    }, ensure_ascii=False))


if __name__ == "__main__":
    main()
