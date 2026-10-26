"""One-off, read-only Douyin works probe using the user's existing browser session.

This does not write to the monitor database, refresh login state, or treat a web
response play_count as a verified play count. Results live in a private directory.
"""

import argparse
import asyncio
import json
import os
import sqlite3
import time
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlsplit

from playwright.async_api import async_playwright

POST_PATH = "/aweme/v1/web/aweme/post/"
PROFILE_PATH = "/aweme/v1/web/user/profile/other/"


def utc_now():
    return datetime.now(timezone.utc).isoformat()


def nonnegative_int(value):
    if isinstance(value, bool):
        return None
    try:
        number = int(value)
    except (TypeError, ValueError, OverflowError):
        return None
    return number if number >= 0 else None


def targets_from_db(path, limit):
    conn = sqlite3.connect(f"file:{Path(path).resolve()}?mode=ro", uri=True)
    try:
        conn.execute("PRAGMA query_only=ON")
        rows = conn.execute("""SELECT id, label, locator FROM targets
            WHERE enabled=1 AND type='account' AND provider='public-web'
            ORDER BY id""").fetchall()
    finally:
        conn.close()
    targets = [(int(identifier), str(label), str(uid)) for identifier, label, uid in rows
               if str(uid).startswith("MS4wLjAB")]
    return targets[:limit] if limit else targets


async def collect_account(context, target, timeout):
    identifier, label, uid = target
    page = await context.new_page()
    events = asyncio.Queue()
    pending = set()
    result = {"targetId": identifier, "label": label, "observedAt": utc_now(),
              "status": "unavailable", "profile": None, "works": [],
              "worksResponseCount": 0, "worksErrorCodes": [], "hasMore": None}

    async def inspect_response(response):
        path = urlsplit(response.url).path
        if path not in (POST_PATH, PROFILE_PATH):
            return
        if response.status != 200:
            await events.put((path, {"http_status": response.status}))
            return
        try:
            body = await response.json()
            if not isinstance(body, dict):
                body = {"parse_error": "non_object"}
        except Exception:
            body = {"parse_error": "empty_or_invalid_json"}
        await events.put((path, body))

    def on_response(response):
        path = urlsplit(response.url).path
        if path not in (POST_PATH, PROFILE_PATH):
            return
        task = asyncio.create_task(inspect_response(response))
        pending.add(task)
        task.add_done_callback(pending.discard)

    page.on("response", on_response)
    collected = {}
    deadline = time.monotonic() + timeout
    try:
        await page.goto(f"https://www.douyin.com/user/{uid}",
                        wait_until="domcontentloaded", timeout=int(timeout * 1000))
        scroll_attempts = 0
        while time.monotonic() < deadline:
            remaining = deadline - time.monotonic()
            try:
                path, body = await asyncio.wait_for(events.get(), timeout=min(7, remaining))
            except asyncio.TimeoutError:
                if len(collected) >= 30 or scroll_attempts >= 2:
                    break
                await page.mouse.wheel(0, 1800)
                scroll_attempts += 1
                continue
            if path == PROFILE_PATH:
                profile = body.get("user") or {}
                if profile.get("sec_uid") == uid:
                    result["profile"] = {
                        "followers": nonnegative_int(profile.get("follower_count")),
                        "totalLikes": nonnegative_int(profile.get("total_favorited")),
                        "totalPosts": nonnegative_int(profile.get("aweme_count")),
                    }
                continue
            result["worksResponseCount"] += 1
            if "http_status" in body:
                result["worksErrorCodes"].append(f"http_{body['http_status']}")
                continue
            if "parse_error" in body:
                result["worksErrorCodes"].append(body["parse_error"])
                continue
            if body.get("status_code") not in (None, 0):
                result["worksErrorCodes"].append("upstream_status_nonzero")
                continue
            items = body.get("aweme_list")
            if not isinstance(items, list):
                result["worksErrorCodes"].append("missing_aweme_list")
                continue
            if body.get("has_more") is not None:
                result["hasMore"] = bool(body["has_more"])
            for item in items:
                if not isinstance(item, dict):
                    continue
                aid = str(item.get("aweme_id") or "")
                if not aid or aid in collected:
                    continue
                if (item.get("author") or {}).get("sec_uid") != uid:
                    result["worksErrorCodes"].append("identity_mismatch")
                    continue
                stats = item.get("statistics") or {}
                raw_plays = nonnegative_int(stats.get("play_count"))
                collected[aid] = {"contentId": aid, "title": str(item.get("desc") or "")[:200],
                                  "publishEpoch": nonnegative_int(item.get("create_time")),
                                  "likes": nonnegative_int(stats.get("digg_count")),
                                  "comments": nonnegative_int(stats.get("comment_count")),
                                  "shares": nonnegative_int(stats.get("share_count")),
                                  "collects": nonnegative_int(stats.get("collect_count")),
                                  "plays": None,
                                  "playsSource": "unavailable",
                                  "sourcePlayValue": raw_plays}
            if len(collected) >= 30 or (result["hasMore"] is False and collected):
                break
        result["works"] = list(collected.values())[:30]
        result["status"] = "sampled" if result["works"] else (
            "profile_only" if result["profile"] else "unavailable")
    except Exception as exc:
        # Do not persist exception URLs, browser state, headers or cookies.
        result["worksErrorCodes"].append(type(exc).__name__)
        result["works"] = list(collected.values())[:30]
        result["status"] = "sampled" if result["works"] else (
            "profile_only" if result["profile"] else "unavailable")
    finally:
        page.remove_listener("response", on_response)
        for task in pending:
            task.cancel()
        await page.close()
    result["finishedAt"] = utc_now()
    return result


async def main(args):
    targets = targets_from_db(args.database, args.limit)
    if not targets:
        raise SystemExit("No eligible enabled accounts")
    output_dir = Path(args.output).resolve()
    output_dir.mkdir(mode=0o700, parents=True, exist_ok=False)
    output_file = output_dir / "accounts.jsonl"
    summary_file = output_dir / "summary.json"
    counters = Counter()
    started = utc_now()
    consecutive_empty = 0
    stopped_reason = None
    async with async_playwright() as playwright:
        browser = await playwright.chromium.launch(headless=not args.headed)
        context = await browser.new_context(storage_state=args.state, locale="zh-CN",
                                            timezone_id="Asia/Shanghai")
        try:
            fd = os.open(output_file, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, "w", encoding="utf-8") as stream:
                for index, target in enumerate(targets, 1):
                    item = await collect_account(context, target, args.account_timeout)
                    stream.write(json.dumps(item, ensure_ascii=False, separators=(",", ":")) + "\n")
                    stream.flush()
                    counters[item["status"]] += 1
                    counters["works"] += len(item["works"])
                    if item["profile"]:
                        counters["profile"] += 1
                    consecutive_empty = 0 if item["works"] else consecutive_empty + 1
                    if index == 1 or index % 20 == 0 or index == len(targets):
                        print(f"{index}/{len(targets)} sampled_accounts={counters['sampled']} "
                              f"profile_accounts={counters['profile']} works={counters['works']}", flush=True)
                    if "http_429" in item["worksErrorCodes"]:
                        stopped_reason = "rate_limited"
                    elif consecutive_empty >= 8:
                        stopped_reason = "eight_consecutive_accounts_without_works"
                    if stopped_reason:
                        print(f"STOP: {stopped_reason}", flush=True)
                        break
                    if index < len(targets):
                        await asyncio.sleep(args.gap_seconds)
        finally:
            await context.close()
            await browser.close()
    summary = {"startedAt": started, "finishedAt": utc_now(), "eligibleTargetCount": len(targets),
               "attemptedTargetCount": sum(counters[key] for key in ("sampled", "profile_only", "unavailable")),
               "sampledTargetCount": counters["sampled"], "profileTargetCount": counters["profile"],
               "sampledWorkCount": counters["works"], "counts": dict(counters),
               "stoppedReason": stopped_reason,
               "scope": "up-to-30-source-verified-works-per-account-not-full-history",
               "playPolicy": "web play_count is unverified; plays=null even when a source field exists",
               "productionDatabaseChanged": False}
    fd = os.open(summary_file, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as stream:
        json.dump(summary, stream, ensure_ascii=False, indent=2)
        stream.write("\n")
    print(json.dumps(summary, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--database", required=True)
    parser.add_argument("--state", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument("--account-timeout", type=float, default=25)
    parser.add_argument("--gap-seconds", type=float, default=0.75)
    parser.add_argument("--headed", action="store_true")
    asyncio.run(main(parser.parse_args()))
