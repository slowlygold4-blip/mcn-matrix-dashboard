#!/usr/bin/env python3
"""Zero-key Douyin public-web collector.

Only Python's standard library and reviewed, vendored public signing modules
are used. Guest cookies are held in memory for one process and never printed.
"""

import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from functools import reduce
import hashlib
from http.cookiejar import Cookie, CookieJar
import json
import math
import random
import re
import subprocess
import sys
import time
import unicodedata
from pathlib import Path
from urllib.parse import parse_qs, urlencode, urlparse
import urllib.parse
import urllib.request


PROJECT_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT_DIR / "vendor"))
sys.path.insert(0, str(PROJECT_DIR / "vendor" / "evil0ctal"))
from xbogus import XBogus  # noqa: E402
from f2.abogus import ABogus, BrowserFingerprintGenerator  # noqa: E402


def observation_timestamp(now=None):
    """UTC milliseconds at the existing observation point; never repair history."""
    observed = datetime.now(timezone.utc) if now is None else now
    if not isinstance(observed, datetime) or observed.utcoffset() is None:
        raise ValueError("Observation time must be timezone-aware")
    return observed.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 "
    "Safari/537.36 Edg/131.0.0.0"
)
BILIBILI_UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
)
TTWID_URL = "https://ttwid.bytedance.com/ttwid/union/register/"
PROFILE_URL = "https://www.douyin.com/aweme/v1/web/user/profile/other/"
POSTS_URL = "https://www.douyin.com/aweme/v1/web/aweme/post/"
DETAIL_URL = "https://www.douyin.com/aweme/v1/web/aweme/detail/"
HOT_URL = "https://www.iesdouyin.com/aweme/v1/hot/search/list/"
GENERAL_SEARCH_URL = "https://www.douyin.com/aweme/v1/web/general/search/single/"
CHALLENGE_DETAIL_URL = "https://www.douyin.com/aweme/v1/web/challenge/detail/"
SELFTEST_SEC_UID = "MS4wLjABAAAAYSOcrkBBqaB3slbNIj7wqaOLcGlJrjx7vl6XhruDUEw"
BILIBILI_MIXIN = [46,47,18,2,53,8,23,32,15,50,10,31,58,3,45,35,27,43,5,49,33,9,42,19,29,28,14,39,12,38,41,13,37,48,7,16,24,55,40,61,26,17,0,1,60,51,30,4,22,25,54,21,56,59,6,63,57,62,11,36,20,34,44,52]
BILIBILI_DM_IMG = "V2ViR0wgMS4wIChPcGVuR0wgRVMgMi4wIENocm9taXVtKQ"
BILIBILI_DM_COVER = (
    "QU5HTEUgKEFwcGxlLCBBcHBsZSBNMSwgT3BlbkdMIDQuMSBNZXRhbCAtIDg5LjMpR29v"
    "Z2xlIEluYy4gKEFwcGxlKQ"
)
SEC_UID_RE = re.compile(r"MS4wLj[\w-]+")
POST_TRANSPORT_HEADERS = {
    "date": "date",
    "age": "age",
    "cache-control": "cacheControl",
    "etag": "etag",
    "cdn-cache": "cdnCache",
    "whale-decision-custom": "whaleDecisionCustom",
    "whale-block-time-select": "whaleBlockTimeSelect",
}


class CollectorError(RuntimeError):
    def __init__(self, message, *, code=None):
        super().__init__(message)
        self.code = code


def parse_retry_after(value, now=None):
    """Return only validated delay metadata, never the original header."""
    from email.utils import parsedate_to_datetime, format_datetime
    from datetime import datetime, timezone
    if not isinstance(value, str) or not value or len(value) > 512:
        return {"retryAfterStatus": "invalid", "retryAfterSeconds": None}
    observed = time.time() if now is None else now
    try:
        if re.fullmatch(r"[0-9]+", value):
            delay = int(value)
        else:
            # RFC 9110 HTTP-date includes two obsolete forms which recipients
            # must still accept. Match a whole allowed form before parsing.
            imf = re.fullmatch(r"[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT", value)
            rfc850 = re.fullmatch(r"[A-Z][a-z]+, \d{2}-[A-Z][a-z]{2}-\d{2} \d{2}:\d{2}:\d{2} GMT", value)
            asctime = re.fullmatch(r"[A-Z][a-z]{2} [A-Z][a-z]{2} [ \d]\d \d{2}:\d{2}:\d{2} \d{4}", value)
            if not (imf or rfc850 or asctime):
                raise ValueError("Invalid HTTP date")
            parsed = parsedate_to_datetime(value)
            if asctime:
                parsed = parsed.replace(tzinfo=timezone.utc)
                canonical = "%s %s %2d %s" % (parsed.strftime("%a"), parsed.strftime("%b"), parsed.day, parsed.strftime("%H:%M:%S %Y"))
            elif rfc850:
                current_year = datetime.fromtimestamp(observed, timezone.utc).year
                year = current_year // 100 * 100 + parsed.year % 100
                if year > current_year + 50:
                    year -= 100
                parsed = parsed.replace(year=year)
                canonical = parsed.strftime("%A, %d-%b-%y %H:%M:%S GMT")
            else:
                canonical = format_datetime(parsed, usegmt=True)
            if parsed.tzinfo is None or canonical != value:
                raise ValueError("Invalid HTTP date")
            delay = max(0, math.ceil(parsed.timestamp() - observed))
        if delay > 253402300799 - observed:
            return {"retryAfterStatus": "too-long", "retryAfterSeconds": None}
        return {"retryAfterStatus": "valid", "retryAfterSeconds": delay}
    except (TypeError, ValueError, OverflowError):
        return {"retryAfterStatus": "invalid", "retryAfterSeconds": None}


def emit(payload, exit_code=0):
    print(json.dumps(payload, ensure_ascii=False, separators=(",", ":")))
    raise SystemExit(exit_code)


def post_transport_value(name, value):
    """Keep only bounded, non-secret values for the approved HTTP fields."""
    if not isinstance(value, str) or not value or len(value) > 512:
        return None
    if not re.fullmatch(r"[\x20-\x7e]+", value):
        return None
    if re.search(r"cookie|token|signature|authorization|bogus|://", value, re.I):
        return None
    if name == "date":
        from email.utils import parsedate_to_datetime
        if not re.fullmatch(r"[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT", value):
            return None
        try:
            parsedate_to_datetime(value)
        except (TypeError, ValueError, OverflowError):
            return None
    elif name == "age":
        if not re.fullmatch(r"\d{1,12}", value):
            return None
    elif name == "cache-control":
        directive = (r"(?:public|private|no-cache|no-store|no-transform|must-revalidate|"
                     r"proxy-revalidate|immutable|(?:max-age|s-maxage|stale-while-revalidate|"
                     r"stale-if-error)\s*=\s*\d{1,12})")
        if not re.fullmatch(directive + r"(?:\s*,\s*" + directive + r")*", value, re.I):
            return None
    elif name == "etag":
        if not re.fullmatch(r'(?:W/)?"[A-Za-z0-9._:-]{1,128}"', value):
            return None
    elif name == "cdn-cache":
        if value.upper() not in {"HIT", "MISS", "BYPASS", "EXPIRED", "STALE", "REVALIDATED", "DYNAMIC", "UPDATING"}:
            return None
    elif name == "whale-decision-custom":
        if not re.fullmatch(r"(?:black|white|gray)(?:_[a-z0-9]{1,16}){0,3}", value):
            return None
    elif name == "whale-block-time-select":
        if value not in {"0", "1"}:
            return None
    else:
        return None
    return value


def post_transport_evidence(stderr, status, now=None):
    """Read only the last response block; never return the captured headers."""
    evidence = {
        "evidenceScope": "sanitized-final-http-headers-not-full-response",
        "httpStatus": status,
        "headersStatus": "unavailable",
        "headers": {key: None for key in POST_TRANSPORT_HEADERS.values()},
        "retryAfterStatus": "absent", "retryAfterSeconds": None,
    }
    if not isinstance(stderr, bytes) or len(stderr) > 65536:
        return evidence
    blocks = list(re.finditer(br"(?m)^HTTP/(?:1\.[01]|2|3)\s+(\d{3})(?:[ \t][^\r\n]*)?\r?$", stderr))
    if not blocks or int(blocks[-1].group(1)) != status:
        return evidence
    last = stderr[blocks[-1].end():]
    if not last.startswith(b"\n"):
        return evidence
    last = last[1:]
    boundary = re.search(br"\r?\n\r?\n", last)
    if last.startswith((b"\r\n", b"\n")):
        header_block = b""
    elif boundary:
        header_block = last[:boundary.start()]
    else:
        return evidence
    raw_values = {}
    invalid = set()
    previous = None
    for line in header_block.split(b"\n"):
        line = line.rstrip(b"\r")
        if line[:1] in (b" ", b"\t"):
            if previous:
                invalid.add(previous)
            continue
        raw_name, separator, raw_value = line.partition(b":")
        try:
            name = raw_name.decode("ascii").lower()
        except UnicodeDecodeError:
            previous = None
            continue
        previous = name if name in POST_TRANSPORT_HEADERS or name == "retry-after" else None
        if not separator or (name not in POST_TRANSPORT_HEADERS and name != "retry-after"):
            continue
        if name in raw_values:
            invalid.add(name)
        try:
            raw_values[name] = raw_value.strip(b" \t").decode("ascii")
        except UnicodeDecodeError:
            invalid.add(name)
    for name, value in raw_values.items():
        if name == "retry-after":
            evidence.update(parse_retry_after(None if name in invalid else value, now))
            if evidence["retryAfterStatus"] == "invalid":
                invalid.add(name)
            continue
        safe = None if name in invalid else post_transport_value(name, value)
        evidence["headers"][POST_TRANSPORT_HEADERS[name]] = safe
        if safe is None:
            invalid.add(name)
    evidence["headersStatus"] = "partial-invalid" if invalid else "parsed"
    return evidence


def request(url, *, method="GET", data=None, referer="https://www.douyin.com/", timeout=35, cookie=None, transport_evidence=None):
    marker = b"\n__CODEX_HTTP_META__"
    parsed_url = urlparse(url)
    capture_transport = isinstance(transport_evidence, dict) and (
        parsed_url.scheme == "https" and parsed_url.netloc == "www.douyin.com"
        and parsed_url.path in {"/aweme/v1/web/aweme/post/", "/aweme/v1/web/aweme/detail/"}
    )
    args = [
        "curl",
        "-sS",
        "-L",
        "--compressed",
        "--max-time",
        str(timeout),
        "-A",
        UA,
        "-H",
        "Accept: application/json, text/plain, */*",
        "-H",
        "Accept-Language: zh-CN,zh;q=0.9",
        "-H",
        "Referer: %s" % referer,
        "-w",
        "\n__CODEX_HTTP_META__%{http_code}\t%{url_effective}",
    ]
    if capture_transport:
        # stderr remains in memory; stdout/body and the tuple contract do not change.
        args.extend(["-D", "/dev/stderr"])
        transport_evidence.update(post_transport_evidence(b"", None))
    if cookie:
        args.extend(["-b", "ttwid=%s" % cookie])
    if data is not None:
        args.extend(["-H", "Content-Type: application/json", "-X", method, "--data-binary", "@-"])
    args.append(url)
    try:
        completed = subprocess.run(args, input=data, capture_output=True, timeout=timeout + 5, check=False)
    except (OSError, subprocess.TimeoutExpired) as exc:
        if capture_transport:
            raise CollectorError("公开网页连接失败；未记录传输错误原文", code="network_error") from None
        raise CollectorError("公开网页连接失败：%s" % exc) from exc
    if completed.returncode != 0:
        if capture_transport and parsed_url.path == "/aweme/v1/web/aweme/detail/" and marker in completed.stdout:
            # Curl can fail while finishing a body after already observing an
            # explicit refusal. Do not let that transport error permit a
            # different detail request form; other endpoint behavior is unchanged.
            observed_status = completed.stdout.rsplit(marker, 1)[1].split(b"\t", 1)[0]
            if re.fullmatch(br"4\d{2}", observed_status):
                status = int(observed_status)
                transport_evidence.update(post_transport_evidence(completed.stderr, status))
                code = {401: "login_required", 403: "blocked", 429: "rate_limited"}.get(status, "business_error")
                raise CollectorError("公开网页请求失败（HTTP %s）；未记录错误响应原文" % status, code=code)
        if capture_transport:
            raise CollectorError("公开网页连接失败（curl=%s）；未记录传输错误原文" % completed.returncode, code="network_error")
        detail = completed.stderr.decode("utf-8", "replace").strip()[:240]
        raise CollectorError("公开网页连接失败（curl=%s）：%s" % (completed.returncode, detail))
    if marker not in completed.stdout:
        raise CollectorError("公开网页响应缺少状态信息")
    body, metadata = completed.stdout.rsplit(marker, 1)
    status_text, _, final_url = metadata.decode("utf-8", "replace").partition("\t")
    try:
        status = int(status_text or 0)
    except ValueError:
        raise CollectorError("公开网页响应缺少有效状态信息") from None
    if capture_transport:
        transport_evidence.update(post_transport_evidence(completed.stderr, status))
    if status < 200 or status >= 400:
        if capture_transport:
            code = {401: "login_required", 403: "blocked", 429: "rate_limited"}.get(status)
            code = code or ("network_error" if status >= 500 else "business_error")
            raise CollectorError("公开网页请求失败（HTTP %s）；未记录错误响应原文" % status, code=code)
        raise CollectorError("公开网页请求失败（HTTP %s）：%s" % (status, body[:300].decode("utf-8", "replace")))
    return body, final_url


def register_guest():
    body = json.dumps(
        {
            "region": "cn",
            "aid": 1768,
            "needFid": False,
            "service": "www.ixigua.com",
            "migrate_info": {"ticket": "", "source": "node"},
            "cbUrlProtocol": "https",
            "union": True,
        },
        separators=(",", ":"),
    ).encode("utf-8")
    args = [
        "curl",
        "-sS",
        "--max-time",
        "25",
        "-A",
        UA,
        "-H",
        "Content-Type: application/json",
        "-X",
        "POST",
        TTWID_URL,
        "--data-binary",
        "@-",
        "-D",
        "-",
        "-o",
        "/dev/null",
    ]
    try:
        completed = subprocess.run(args, input=body, capture_output=True, timeout=30, check=False)
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise CollectorError("游客会话注册失败：%s" % exc) from exc
    if completed.returncode != 0:
        raise CollectorError("游客会话注册失败（curl=%s）" % completed.returncode)
    match = re.search(br"set-cookie:\s*ttwid=([^;\r\n]+)", completed.stdout, re.I)
    if not match:
        raise CollectorError("游客会话注册失败：未收到 ttwid")
    return match.group(1).decode("ascii", "strict")


def signed_url(base_url, params):
    query = urlencode(params)
    unsigned = "%s?%s" % (base_url, query)
    signature = XBogus(user_agent=UA).getXBogus(unsigned)[1]
    return "%s&%s" % (unsigned, urlencode({"X-Bogus": signature}))


def a_bogus_signed_url(base_url, params):
    """Sign a public-web request with the current anonymous A-Bogus route."""
    query = urlencode(params)
    fingerprint = BrowserFingerprintGenerator.generate_fingerprint("Edge")
    signature = ABogus(fp=fingerprint, user_agent=UA).generate_abogus(query)[1]
    return "%s?%s&%s" % (base_url, query, urlencode({"a_bogus": signature}))


def request_json(url, *, referer, cookie=None, transport_evidence=None):
    options = {"referer": referer, "cookie": cookie}
    if transport_evidence is not None:
        options["transport_evidence"] = transport_evidence
    body, _ = request(url, **options)
    if not body.strip():
        raise CollectorError("公开网页返回空内容；为保护历史数据，本次采集已拒绝写入")
    try:
        payload = json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise CollectorError("公开网页返回的内容不是合法 JSON", code="upstream_changed") from exc
    if not isinstance(payload, dict):
        raise CollectorError("公开网页响应必须为 JSON 对象", code="upstream_changed")
    status = payload.get("status_code")
    post_request = transport_evidence is not None and urlparse(url).path == "/aweme/v1/web/aweme/post/"
    # Only an explicit integer zero proves works success. Preserve the existing
    # rejection classification below for explicit nonzero integer statuses.
    if post_request and type(status) is not int:
        raise CollectorError("公开作品列表未返回明确业务成功状态", code="upstream_changed")
    detail_request = transport_evidence is not None and urlparse(url).path == "/aweme/v1/web/aweme/detail/"
    if detail_request and status in (None, 0) and type(status) is not int:
        raise CollectorError("公开视频详情未返回明确业务成功状态", code="upstream_changed")
    if status not in (None, 0):
        if transport_evidence is not None:
            # Detail callers stop on every explicit business refusal. A numeric
            # code alone does not establish that an account session expired.
            code = "login_required" if status == 2483 and not detail_request else "business_error"
            raise CollectorError("抖音公开网页拒绝请求；未记录业务错误原文", code=code)
        message = payload.get("status_msg") or payload.get("message") or "未知状态"
        raise CollectorError("抖音公开网页拒绝请求（status_code=%s）：%s" % (status, message))
    return payload


def expand_douyin_share_user(url):
    """Resolve a profile share link with validation on every redirect hop."""
    current = str(url or "").strip()
    visited = set()
    for _ in range(8):
        parsed = validated_douyin_url(current)
        if current in visited:
            raise CollectorError("分享链接出现循环跳转")
        visited.add(current)
        match = re.fullmatch(r"/user/(MS4wLj[\w-]+)/?", parsed.path)
        if match:
            return match.group(1)
        values = parse_qs(parsed.query).get("sec_uid", [])
        if len(values) == 1 and SEC_UID_RE.fullmatch(values[0]):
            return values[0]
        status, location = official_share_redirect(current)
        if status in (301, 302, 303, 307, 308) and location:
            next_url = urllib.parse.urljoin(current, location)
            validated_douyin_url(next_url)
            current = next_url
            continue
        if status >= 400:
            raise CollectorError("分享链接请求失败（HTTP %s）" % status)
        raise CollectorError("链接未解析到 sec_uid；请从抖音主页复制完整分享链接")
    raise CollectorError("分享链接跳转超过 8 次限制")


def extract_sec_uid(text):
    raw = (text or "").strip()
    direct = SEC_UID_RE.fullmatch(raw)
    if direct:
        return direct.group(0)
    link_match = re.search(r"https?://(?:v\.|www\.)?douyin\.com/[^\s]+", raw)
    if not link_match:
        raise CollectorError("账号监控需要完整抖音主页/分享链接或 sec_uid；公开游客接口不能按昵称或抖音号可靠解析")
    link = link_match.group(0).rstrip("。，,;；!！")
    try:
        return expand_douyin_share_user(link)
    except CollectorError as exc:
        raise CollectorError("短链接解析失败：%s" % exc) from exc


def common_params():
    return {
        "device_platform": "webapp",
        "aid": "6383",
        "channel": "channel_pc_web",
        "pc_client_type": "1",
        "pc_libra_divert": "Windows",
        "version_code": "290100",
        "version_name": "29.1.0",
        "cookie_enabled": "true",
        "screen_width": "1920",
        "screen_height": "1080",
        "browser_language": "zh-CN",
        "browser_platform": "Win32",
        "browser_name": "Edge",
        "browser_version": "131.0.0.0",
        "browser_online": "true",
        "engine_name": "Blink",
        "engine_version": "131.0.0.0",
        "os_name": "Windows",
        "os_version": "10",
        "cpu_core_num": "12",
        "device_memory": "8",
        "platform": "PC",
        "downlink": "10",
        "effective_type": "4g",
        "round_trip_time": "50",
    }


def public_user(user):
    keys = (
        "sec_uid",
        "uid",
        "short_id",
        "unique_id",
        "nickname",
        "follower_count",
        "mplatform_followers_count",
        "following_count",
        "total_favorited",
        "aweme_count",
        "signature",
    )
    return {key: user.get(key) for key in keys if user.get(key) is not None}


def public_post_author(author):
    """Retain observed textual handles only; never derive identity from a name/uid."""
    result = {key: author.get(key) for key in ("sec_uid", "uid", "nickname") if author.get(key) is not None}
    for key, pattern in (("unique_id", r"[A-Za-z0-9_.-]{1,100}"), ("short_id", r"[0-9]{1,25}")):
        value = author.get(key)
        if isinstance(value, str) and re.fullmatch(pattern, value):
            result[key] = value
    return result


def public_post(item):
    author = item.get("author") or {}
    statistics = item.get("statistics") or {}
    text_extra = []
    for extra in item.get("text_extra") or []:
        if not isinstance(extra, dict):
            continue
        text_extra.append(
            {
                key: extra.get(key)
                for key in ("hashtag_name", "hashtag_id", "start", "end")
                if extra.get(key) is not None
            }
        )
    return {
        "aweme_id": item.get("aweme_id"),
        "desc": item.get("desc") or "",
        "create_time": item.get("create_time"),
        "author": public_post_author(author),
        "statistics": {
            key: statistics.get(key)
            for key in ("digg_count", "comment_count", "share_count", "collect_count", "play_count")
            if statistics.get(key) is not None
        },
        "text_extra": text_extra,
    }


def fetch_public_profile(sec_uid, guest_cookie):
    """Read the anonymous profile with the smallest proven public parameter set.

    Douyin currently serves this route to guest ttwid sessions without X-Bogus.
    Keeping the unsigned request first mirrors the working Jixuan command-console
    collector and avoids turning a valid public profile into a signing failure.
    The signed request remains a compatibility fallback only.
    """
    referer = "https://www.douyin.com/user/%s" % sec_uid
    minimal_params = {
        "device_platform": "webapp",
        "aid": "6383",
        "channel": "channel_pc_web",
        "sec_user_id": sec_uid,
        "publish_video_strategy_type": "2",
        "personal_center_strategy": "1",
        "pc_client_type": "1",
        "version_code": "170400",
        "cookie_enabled": "true",
        "platform": "PC",
    }
    try:
        return (
            request_json(
                "%s?%s" % (PROFILE_URL, urlencode(minimal_params)),
                referer=referer,
                cookie=guest_cookie,
            ),
            "guest-ttwid-unsigned-profile",
        )
    except CollectorError as unsigned_error:
        signed_params = common_params()
        signed_params.update(
            {
                "sec_user_id": sec_uid,
                "publish_video_strategy_type": "2",
                "personal_center_strategy": "1",
            }
        )
        try:
            return (
                request_json(
                    signed_url(PROFILE_URL, signed_params),
                    referer=referer,
                    cookie=guest_cookie,
                ),
                "guest-ttwid-unsigned-profile-with-x-bogus-fallback",
            )
        except CollectorError as signed_error:
            raise CollectorError(
                "公开主页读取失败：免签游客接口：%s；签名兼容接口：%s"
                % (unsigned_error, signed_error)
            ) from signed_error


def pagination_scalar(value):
    """Retain only safe numeric pagination values, never arbitrary text."""
    if type(value) in (bool, int):
        return value
    if isinstance(value, str) and re.fullmatch(r"-?\d{1,24}", value):
        return value
    return None


def pagination_more(value):
    if type(value) is bool:
        return value
    if type(value) is int and value in (0, 1):
        return bool(value)
    if type(value) is str and value in ("0", "1"):
        return value == "1"
    return None


def classify_works_error(error):
    """Return a bounded transport class for UI/audit without raw responses."""
    if getattr(error, "code", None) in {"login_required", "blocked", "rate_limited", "network_error", "business_error", "upstream_changed"}:
        return error.code
    text = str(error or "").lower()
    if "http 401" in text or "status_code=2483" in text or "登录" in text:
        return "login_required"
    if "http 403" in text or "argus" in text or "sign invalid" in text or "blocked" in text:
        return "blocked"
    if "http 429" in text or "限流" in text or "rate" in text:
        return "rate_limited"
    if "超时" in text or "timeout" in text or "连接" in text or "curl=" in text:
        return "network_error"
    return "unknown"


def collect_account(locator, limit, *, works_mode="collect"):
    if works_mode not in {"collect", "deferred"}:
        raise CollectorError("无效作品采集策略")
    sec_uid = extract_sec_uid(locator)
    guest_cookie = register_guest()
    referer = "https://www.douyin.com/user/%s" % sec_uid
    profile_raw, profile_mode = fetch_public_profile(sec_uid, guest_cookie)
    user = profile_raw.get("user") or profile_raw.get("user_info") or {}
    if not user:
        raise CollectorError("账号响应缺少 user 字段")
    returned_sec_uid = user.get("sec_uid")
    if returned_sec_uid and returned_sec_uid != sec_uid:
        raise CollectorError("账号身份校验失败：响应 sec_uid 与目标不一致")

    # A deleted profile is a lifecycle observation, never a zero-valued
    # metric sample. Retain the complete official response for verification.
    if user.get("user_deleted") is True:
        return {
            "capturedAt": observation_timestamp(),
            "profile": {"user": public_user(user)},
            "profileResponse": profile_raw,
            "accountStatus": "unavailable",
            "worksCoverage": "not-applicable",
            "works": {"aweme_list": []},
            "warnings": [],
            "provenance": {
                "mode": profile_mode,
                "profileMode": profile_mode,
                "profileEndpoint": PROFILE_URL,
                "accountLocator": "sec_uid",
                "cookiePersisted": False,
                "runtimeAI": False,
                "paidAPI": False,
            },
        }

    if works_mode == "deferred":
        return {
            "capturedAt": observation_timestamp(),
            "profile": {"user": public_user(user)}, "accountStatus": "validated", "accountError": None,
            "worksCoverage": "unavailable", "worksErrorCode": "deferred",
            "worksError": "作品请求因传输冷却暂缓；本次未请求作品，已保留主页指标",
            "works": {"stopReason": "request-deferred", "pagination": {"requestCount": 0, "pages": []}},
            "warnings": ["作品请求因传输冷却暂缓；本次未请求作品，未覆盖历史作品"],
            "provenance": {"mode": profile_mode, "profileMode": profile_mode,
                           "profileEndpoint": PROFILE_URL, "accountLocator": "sec_uid",
                           "cookiePersisted": False, "runtimeAI": False, "paidAPI": False},
        }

    items = []
    seen_aweme_ids = set()
    warnings = []
    excluded_non_target_posts = 0
    cursor = 0
    seen_cursors = {"0"}
    public_window_limited = False
    works_coverage = "retry"
    works_error = None
    works_error_code = None
    stop_reason = "not-started"
    page_evidence = []
    upstream_has_more = None
    upstream_cursor = None
    while len(items) < limit:
        count = min(18, limit - len(items))
        post_params = common_params()
        post_params.update(
            {
                "sec_user_id": sec_uid,
                "max_cursor": str(cursor),
                "locate_query": "false",
                "show_live_replay_strategy": "1",
                "need_time_list": "1",
                "time_list_query": "0",
                "whale_cut_token": "",
                "cut_version": "1",
                "count": str(count),
                "publish_video_strategy_type": "2",
                "from_user_page": "1",
                "update_version_code": "170400",
                "support_h265": "1",
                "support_dash": "0",
            }
        )
        evidence = {
            "endpoint": POSTS_URL,
            "requestedAt": observation_timestamp(),
            "request": {"count": count, "max_cursor": cursor},
            "response": None,
            "rawCount": None, "retainedCount": 0,
            "excludedNonTargetCount": 0, "duplicateCount": 0,
            "invalidCount": 0, "localOmittedCount": 0,
            "transport": post_transport_evidence(b"", None),
        }
        page_evidence.append(evidence)
        try:
            post_raw = request_json(
                a_bogus_signed_url(POSTS_URL, post_params), referer=referer,
                cookie=guest_cookie, transport_evidence=evidence["transport"],
            )
        except CollectorError as exc:
            evidence["capturedAt"] = observation_timestamp()
            works_coverage = "unavailable"
            stop_reason = "request-failed"
            works_error = str(exc)[:500]
            works_error_code = classify_works_error(exc)
            warnings.append("作品列表接口未通过：%s；已保留主页总量，未用空数据覆盖历史作品" % exc)
            break
        evidence["capturedAt"] = observation_timestamp()
        response = post_raw if isinstance(post_raw, dict) else {}
        page = response.get("aweme_list")
        more = pagination_more(response.get("has_more"))
        upstream_has_more = pagination_scalar(response.get("has_more"))
        upstream_cursor = pagination_scalar(response.get("max_cursor"))
        evidence["response"] = {
            "status_code": pagination_scalar(response.get("status_code")),
            "has_more": upstream_has_more,
            "hasMorePresent": "has_more" in response,
            "hasMoreValid": more is not None,
            "max_cursor": upstream_cursor,
            "maxCursorPresent": "max_cursor" in response,
            "awemeListPresent": "aweme_list" in response,
            "awemeListValid": isinstance(page, list),
            "notLoginModulePresent": "not_login_module" in response,
            "anonymousRestricted": bool(response.get("not_login_module")),
        }
        if not isinstance(page, list):
            works_error_code = "upstream_changed"
            stop_reason = "missing-list" if "aweme_list" not in response else "invalid-list"
            works_error = "作品列表接口未通过：响应缺失有效 aweme_list 数组，不等于明确空列表"
            warnings.append(works_error)
            break
        evidence["rawCount"] = len(page)
        for item in page:
            if not isinstance(item, dict):
                evidence["invalidCount"] += 1
                continue
            author = item.get("author")
            if not isinstance(author, dict):
                evidence["invalidCount"] += 1
                continue
            item_author_id = str(author.get("sec_uid") or "").strip()
            expected_author_id = returned_sec_uid or sec_uid
            if item_author_id != expected_author_id:
                excluded_non_target_posts += 1
                evidence["excludedNonTargetCount"] += 1
                continue
            aweme_id = str(item.get("aweme_id") or "").strip()
            if not aweme_id:
                evidence["invalidCount"] += 1
                continue
            if aweme_id in seen_aweme_ids:
                evidence["duplicateCount"] += 1
                continue
            if ((item.get("statistics") is not None and not isinstance(item["statistics"], dict))
                    or (item.get("text_extra") is not None and not isinstance(item["text_extra"], list))):
                evidence["invalidCount"] += 1
                continue
            seen_aweme_ids.add(aweme_id)
            if len(items) >= limit:
                evidence["localOmittedCount"] += 1
                continue
            items.append(public_post(item))
            evidence["retainedCount"] += 1
        if response.get("not_login_module"):
            public_window_limited = more is True
            works_coverage = "latest-public-window"
            stop_reason = "anonymous-window"
            if public_window_limited:
                warnings.append(
                    "匿名公开接口仅返回账号最新公开作品窗口；后续每日采集会持续累积，未将该窗口冒充完整历史"
                )
            break
        if len(items) >= limit and (more is not False or evidence["localOmittedCount"]):
            works_coverage = "limited"
            stop_reason = "local-limit"
            warnings.append("已达到本地作品样本上限；未将截断样本视为完整作品历史")
            break
        if more is False:
            if any(entry["invalidCount"] for entry in page_evidence):
                stop_reason = "invalid-items"
                works_error = "作品列表接口未通过：已读取页面含无法解析的作品记录；保留其他有效样本"
                warnings.append(works_error)
            else:
                works_coverage = "complete"
                stop_reason = "end-of-list"
            break
        if more is None:
            stop_reason = "missing-has-more" if "has_more" not in response else "invalid-has-more"
        elif not page:
            stop_reason = "empty-page-with-more"
        elif evidence["retainedCount"] == 0:
            stop_reason = "no-new-items"
        elif upstream_cursor is None or type(upstream_cursor) is bool or not re.fullmatch(r"\d{1,24}", str(upstream_cursor)):
            stop_reason = "missing-or-invalid-cursor"
        elif str(int(upstream_cursor)) in seen_cursors:
            stop_reason = "cursor-repeated"
        else:
            cursor = upstream_cursor
            seen_cursors.add(str(int(cursor)))
            time.sleep(random.uniform(0.8, 1.4))
            continue
        works_error = "作品列表接口未通过：分页未证明结束（%s）；保留已返回样本" % stop_reason
        warnings.append(works_error)
        break

    if excluded_non_target_posts:
        warnings.append(
            "公开作品页混入 %s 条非目标作者推荐，已按 sec_uid 全部剔除" % excluded_non_target_posts
        )

    return {
        "capturedAt": observation_timestamp(),
        "accountStatus": "validated",
        "accountError": None,
        "worksCoverage": works_coverage,
        "worksError": works_error,
        "worksErrorCode": works_error_code or ("upstream_changed" if works_error else None),
        "profile": {"user": public_user(user)},
        "works": {
            "aweme_list": items[:limit],
            "has_more": upstream_has_more,
            "max_cursor": upstream_cursor,
            "public_window_limited": public_window_limited,
            "stopReason": stop_reason,
            "pagination": {
                "evidenceScope": "sanitized-pagination-fields-not-full-response",
                "requestedLimit": limit,
                "requestCount": len(page_evidence),
                "collectedCount": len(items[:limit]),
                "pages": page_evidence,
            },
        },
        "warnings": warnings,
        "provenance": {
            "mode": "%s-a-bogus-posts" % profile_mode,
            "profileMode": profile_mode,
            "profileEndpoint": PROFILE_URL,
            "accountLocator": "sec_uid",
            "worksScope": "latest-public-window" if works_coverage == "latest-public-window" else works_coverage,
            "worksCoverage": works_coverage,
            "excludedNonTargetPosts": excluded_non_target_posts,
            "cookiePersisted": False,
            "runtimeAI": False,
            "paidAPI": False,
        },
    }


def collect_hot(limit):
    payload = request_json(HOT_URL, referer="https://www.douyin.com/hot")
    words = payload.get("data", {}).get("word_list") or payload.get("word_list") or []
    return {
        "capturedAt": observation_timestamp(),
        "word_list": words[:limit],
        "count": min(limit, len(words)),
        "provenance": {"mode": "public-hot-endpoint", "runtimeAI": False, "paidAPI": False},
    }


def _normalized_topic_name(value):
    return re.sub(r"\s+", "", str(value or "").replace("#", "").strip()).casefold()


def _search_topic_candidates(value, expected_name):
    """Extract only exact-name challenge IDs from the bounded search payload."""
    wanted = _normalized_topic_name(expected_name)
    found = []
    seen = set()
    name_keys = ("cha_name", "challenge_name", "hashtag_name", "tag_name", "word", "text", "name")
    id_keys = ("cid", "challenge_id", "hashtag_id", "tag_id", "id")

    def walk(node):
        if isinstance(node, dict):
            names = [_normalized_topic_name(node.get(key)) for key in name_keys if node.get(key) is not None]
            if wanted and wanted in names:
                for key in id_keys:
                    candidate = str(node.get(key) or "").strip()
                    if re.fullmatch(r"\d{8,24}", candidate) and candidate not in seen:
                        seen.add(candidate)
                        found.append(candidate)
            for child in node.values():
                walk(child)
        elif isinstance(node, list):
            for child in node:
                walk(child)

    walk(value)
    return found[:8]


def collect_hashtag_search(label):
    """Resolve a #话题 search to an official challenge detail without a key."""
    expected_name = str(label or "").lstrip("#").strip()
    if not expected_name:
        raise CollectorError("缺少话题名称")
    guest_cookie = register_guest()
    keyword = "#" + expected_name
    params = common_params()
    params.update(
        {
            "search_channel": "aweme_general",
            "enable_history": "1",
            "keyword": keyword,
            "search_source": "tab_search",
            "query_correct_type": "1",
            "is_filter_search": "0",
            "from_group_id": "7378810571505847586",
            "offset": "0",
            "count": "15",
            "need_filter_settings": "1",
            "list_type": "multi",
            "search_id": "",
        }
    )
    referer = "https://www.douyin.com/search/" + urllib.parse.quote(keyword, safe="")
    payload = request_json(
        "%s?%s" % (GENERAL_SEARCH_URL, urlencode(params)),
        referer=referer,
        cookie=guest_cookie,
    )
    candidates = _search_topic_candidates(payload, expected_name)
    if not candidates:
        raise CollectorError("抖音公开搜索未返回匹配话题或 challenge ID")
    errors = []
    for challenge_id in candidates:
        try:
            result = collect_hashtag_detail(challenge_id, expected_name)
            result["raw"] = {
                **(result.get("raw") or {}),
                "searchKeyword": keyword,
                "candidateChallengeIds": candidates,
                "sourceScope": "douyin-public-hashtag-search",
            }
            result["provenance"] = {
                **(result.get("provenance") or {}),
                "mode": "douyin-public-hashtag-search-and-detail",
                "searchEndpoint": GENERAL_SEARCH_URL,
            }
            return result
        except CollectorError as exc:
            errors.append(str(exc)[:180])
    raise CollectorError("话题搜索结果无法通过官方详情复核：%s" % "；".join(errors[:3]))


def collect_hashtag_detail(locator, label):
    """Read official public topic totals for a known challenge ID.

    Douyin's anonymous web search is login-gated, but the official challenge
    detail route remains publicly readable when a challenge ID is already
    present in a public work's ``text_extra``.  Never derive either metric from
    the local account pool.
    """
    challenge_id = str(locator or "").strip()
    if not re.fullmatch(r"\d{8,24}", challenge_id):
        raise CollectorError("话题详情需要合法的抖音 challenge ID")
    guest_cookie = register_guest()
    params = common_params()
    params.update({"ch_id": challenge_id, "query_type": "0"})
    payload = request_json(
        a_bogus_signed_url(CHALLENGE_DETAIL_URL, params),
        referer="https://www.douyin.com/hashtag/%s" % challenge_id,
        cookie=guest_cookie,
    )
    if not isinstance(payload, dict) or type(payload.get("status_code")) is not int or payload["status_code"] != 0:
        raise CollectorError("抖音官方话题详情未明确返回成功业务状态", code="business_error")
    info = payload.get("ch_info") if isinstance(payload.get("ch_info"), dict) else {}
    returned_id = str(info.get("cid") or "").strip()
    if returned_id != challenge_id:
        raise CollectorError("抖音官方话题详情未回显相同 challenge ID")
    returned_name = str(info.get("cha_name") or "").strip()
    expected_name = str(label or "").lstrip("#").strip()
    warnings = []
    if not expected_name or returned_name.casefold() != expected_name.casefold():
        raise CollectorError("抖音官方话题详情名称与监控标签不一致", code="upstream_changed")
    participant_value = info.get("user_count")
    view_value = info.get("view_count")
    participants = participant_value if type(participant_value) is int and 0 <= participant_value <= 9007199254740991 else None
    views = view_value if type(view_value) is int and 0 <= view_value <= 9007199254740991 else None
    if participants is None:
        warnings.append("官方话题详情未返回参与人数")
    if views is None:
        warnings.append("官方话题详情未返回播放量")
    observed_at = observation_timestamp()
    raw = {
        "scope": "douyin-official-challenge-detail",
        "topicTimeContractVersion": 1,
        "capturedAt": observed_at,
        "businessStatusCode": 0,
        "challengeId": challenge_id,
        "label": expected_name,
        "officialName": returned_name,
        "participants": participants,
        "views": views,
        "provenance": {
            "mode": "douyin-official-anonymous-challenge-detail",
            "endpoint": CHALLENGE_DETAIL_URL,
            "authenticated": False,
            "runtimeAI": False,
            "paidAPI": False,
        },
    }
    return {
        "capturedAt": observed_at,
        "posts": [],
        "snapshot": {
            "followers": None,
            "totalLikes": None,
            "totalPosts": None,
            "hashtagParticipants": participants,
            "hashtagViews": views,
            "hashtagPosts": None,
            "authorCount": None,
        },
        "warnings": warnings,
        "qualityStatus": "warning" if warnings else "validated",
        "provenance": raw["provenance"],
        "raw": raw,
    }


def extract_bilibili_mid(locator):
    raw = str(locator or "").strip()
    if re.fullmatch(r"\d{2,20}", raw):
        return raw
    match = re.search(r"https?://space[.]bilibili[.]com/(\d{2,20})", raw, re.I)
    if not match:
        raise CollectorError("B站账号监控需要数字 UID 或 space.bilibili.com 官方主页")
    return match.group(1)


def bili_json(opener, url, *, headers=None, timeout=18):
    merged = {
        "User-Agent": BILIBILI_UA,
        "Referer": "https://www.bilibili.com/",
        "Accept": "application/json, text/plain, */*",
    }
    merged.update(headers or {})
    try:
        response = opener.open(urllib.request.Request(url, headers=merged), timeout=timeout)
        payload = json.loads(response.read().decode("utf-8", "replace"))
    except Exception as exc:
        raise CollectorError("B站公开接口连接失败：%s" % exc) from exc
    if payload.get("code") not in (None, 0):
        raise CollectorError(
            "B站公开接口拒绝请求（code=%s）：%s"
            % (payload.get("code"), payload.get("message") or "未知状态")
        )
    return payload


def bili_opener():
    jar = CookieJar()
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
    opener.addheaders = [
        ("User-Agent", BILIBILI_UA),
        ("Referer", "https://www.bilibili.com/"),
        ("Accept", "application/json, text/plain, */*"),
    ]
    try:
        opener.open(urllib.request.Request("https://www.bilibili.com/", headers={"User-Agent": BILIBILI_UA}), timeout=12).read()
    except Exception:
        pass
    try:
        spi = (bili_json(opener, "https://api.bilibili.com/x/frontend/finger/spi").get("data") or {})
        for name, key in (("buvid3", "b_3"), ("buvid4", "b_4")):
            value = spi.get(key)
            if value:
                jar.set_cookie(Cookie(0, name, value, None, False, ".bilibili.com", True, False, "/", True, False, None, True, None, None, {}))
        request_object = urllib.request.Request(
            "https://api.bilibili.com/x/internal/gaia-gateway/ExClimbWuzhi",
            data=json.dumps({"3064": 1}).encode("utf-8"),
            headers={"User-Agent": BILIBILI_UA, "Content-Type": "application/json", "Referer": "https://www.bilibili.com/"},
        )
        opener.open(request_object, timeout=12).read()
    except Exception:
        pass
    return opener


def bili_wbi_key(opener):
    try:
        request_object = urllib.request.Request(
            "https://api.bilibili.com/x/web-interface/nav",
            headers={"User-Agent": BILIBILI_UA, "Referer": "https://www.bilibili.com/"},
        )
        payload = json.loads(opener.open(request_object, timeout=15).read().decode("utf-8", "replace"))
    except Exception as exc:
        raise CollectorError("B站公开 WBI 导航连接失败：%s" % exc) from exc
    data = ((payload.get("data") or {}).get("wbi_img") or {})
    image = (data.get("img_url") or "").rsplit("/", 1)[-1].split(".")[0]
    sub = (data.get("sub_url") or "").rsplit("/", 1)[-1].split(".")[0]
    raw = image + sub
    if not raw or max(BILIBILI_MIXIN) >= len(raw):
        raise CollectorError("B站公开 WBI 导航未返回签名图片")
    return reduce(lambda output, index: output + raw[index], BILIBILI_MIXIN, "")[:32]


def bili_latest_videos(opener, mid, limit, *, evidence=None):
    if evidence is None:
        evidence = {}
    evidence.update({"status": "unavailable", "source": "wbi", "listObserved": False, "rawCount": None})

    def refused(error_code):
        evidence.update({"status": "refused", "errorCode": error_code})
        return []

    def accepted(rows, source, raw_count):
        evidence.update({"status": "success", "source": source, "statusCode": 0,
                         "listObserved": True, "rawCount": raw_count})
        return rows

    count = max(1, min(int(limit), 30))
    params = {
        "mid": mid, "ps": count, "tid": 0, "pn": 1, "keyword": "", "order": "pubdate",
        "platform": "web", "web_location": 1550101, "order_avoided": "true",
        "dm_img_list": "[]", "dm_img_str": BILIBILI_DM_IMG,
        "dm_cover_img_str": BILIBILI_DM_COVER,
        "dm_img_inter": '{"ds":[],"wh":[0,0,0],"of":[0,0,0]}', "wts": int(time.time()),
    }
    try:
        query = "&".join("%s=%s" % (key, urllib.parse.quote(str(params[key]))) for key in sorted(params))
        params["w_rid"] = hashlib.md5((query + bili_wbi_key(opener)).encode("utf-8")).hexdigest()
        signed_query = "&".join("%s=%s" % (key, urllib.parse.quote(str(params[key]))) for key in sorted(params))
        url = "https://api.bilibili.com/x/space/wbi/arc/search?%s" % signed_query
        payload = None
        for attempt in range(2):
            try:
                request_object = urllib.request.Request(
                    url,
                    headers={"Referer": "https://space.bilibili.com/%s/video" % mid, "Origin": "https://space.bilibili.com"},
                )
                payload = json.loads(opener.open(request_object, timeout=15).read().decode("utf-8", "ignore"))
                # Rejection bodies may contain stale list-shaped data. Only an
                # explicit successful response can supply works or permit fallback.
                if not isinstance(payload, dict) or type(payload.get("code")) is not int:
                    return []
                if payload["code"] != 0:
                    return refused("business_error")
                break
            except Exception as exc:
                if getattr(exc, "code", None) in (401, 403, 429):
                    return refused({401: "login_required", 403: "blocked", 429: "rate_limited"}[exc.code])
                payload = None
                if attempt == 0:
                    time.sleep(2)
        data = payload.get("data") if isinstance(payload, dict) else None
        listing = data.get("list") if isinstance(data, dict) else None
        videos = listing.get("vlist") if isinstance(listing, dict) else None
        if not isinstance(videos, list) or any(not isinstance(value, dict) for value in videos):
            return []
    except CollectorError:
        # Navigation-key errors can wrap an explicit refusal; do not follow
        # an unclassified key failure with a different works endpoint.
        return []
    if videos:
        return accepted([
            {
                "bvid": value.get("bvid"), "title": value.get("title"), "created": value.get("created"),
                "play": value.get("play"), "comment": value.get("comment") or value.get("video_review"),
            }
            for value in videos[:count]
        ], "wbi", len(videos))
    evidence["source"] = "dynamic"
    payload = None
    for attempt in range(2):
        try:
            request_object = urllib.request.Request(
                "https://api.bilibili.com/x/polymer/web-dynamic/v1/feed/space?offset=&host_mid=%s&timezone_offset=-480" % mid,
                headers={"Referer": "https://space.bilibili.com/%s/dynamic" % mid, "Origin": "https://space.bilibili.com"},
            )
            payload = json.loads(opener.open(request_object, timeout=15).read().decode("utf-8", "ignore"))
            if not isinstance(payload, dict) or type(payload.get("code")) is not int:
                return []
            if payload["code"] != 0:
                return refused("business_error")
            break
        except Exception as exc:
            if getattr(exc, "code", None) in (401, 403, 429):
                return refused({401: "login_required", 403: "blocked", 429: "rate_limited"}[exc.code])
            payload = None
            if attempt == 0:
                time.sleep(1.5)
    data = payload.get("data") if isinstance(payload, dict) else None
    items = data.get("items") if isinstance(data, dict) else None
    if not isinstance(items, list):
        return []
    output = []
    for item in items:
        if not isinstance(item, dict):
            return []
        archive = item
        for key in ("modules", "module_dynamic", "major", "archive"):
            archive = archive.get(key, {})
            if archive is None:
                archive = {}
            if not isinstance(archive, dict):
                return []
        if archive.get("bvid"):
            output.append({"bvid": archive.get("bvid"), "title": archive.get("title"), "created": None})
        if len(output) >= count:
            break
    return accepted(output, "dynamic", len(items))


def collect_bilibili_account(locator, limit):
    mid = extract_bilibili_mid(locator)
    opener = bili_opener()
    card_url = "https://api.bilibili.com/x/web-interface/card?mid=%s&photo=true" % mid
    card_payload = bili_json(opener, card_url)
    card_data = card_payload.get("data") or {}
    card = card_data.get("card") or {}
    returned_mid = str(card.get("mid") or "").strip()
    if returned_mid != mid:
        raise CollectorError("B站账号身份校验失败：公开卡片 UID 与提交 UID 不一致")
    # The card's like_num is account-level cumulative received likes, not
    # a sum of the (potentially incomplete) recent video window.
    total_likes = card_data.get("like_num")
    if (
        isinstance(total_likes, bool)
        or not isinstance(total_likes, (int, float))
        or not 0 <= total_likes <= 9_007_199_254_740_991
        or not math.isfinite(total_likes)
        or int(total_likes) != total_likes
    ):
        total_likes = None
    else:
        total_likes = int(total_likes)
    followers = card.get("fans")
    if followers is None:
        relation = bili_json(opener, "https://api.bilibili.com/x/relation/stat?vmid=%s" % mid)
        followers = (relation.get("data") or {}).get("follower")
    try:
        nav = bili_json(opener, "https://api.bilibili.com/x/space/navnum?mid=%s" % mid).get("data") or {}
    except CollectorError:
        nav = {}
    warnings = []
    if total_likes is None:
        warnings.append("B站公开账号卡片未返回有效累计获赞；保留为空，未用作品点赞合计或 0 替代")
    works_list_evidence = {}
    video_refs = bili_latest_videos(opener, mid, limit, evidence=works_list_evidence)
    confirmed_empty_list = (nav.get("video") == 0 and works_list_evidence.get("status") == "success"
                            and works_list_evidence.get("listObserved") is True
                            and works_list_evidence.get("rawCount") == 0)
    if not video_refs and not confirmed_empty_list:
        warnings.append("B站公开投稿列表当前受限；已保存账号粉丝与稿件总量，未用空列表覆盖历史作品")
    works = []
    for video in video_refs:
        bvid = str(video.get("bvid") or "").strip()
        if not re.fullmatch(r"BV[0-9A-Za-z]{10}", bvid):
            continue
        try:
            detail = (bili_json(opener, "https://api.bilibili.com/x/web-interface/view?bvid=%s" % bvid).get("data") or {})
        except CollectorError as exc:
            warnings.append("B站作品 %s 详情暂未读取；已保留投稿列表中的标题、时间和播放/评论字段：%s" % (bvid, exc))
            works.append({
                "aweme_id": bvid,
                "desc": video.get("title") or "",
                "create_time": video.get("created"),
                "author": {"uid": returned_mid, "nickname": card.get("name") or ""},
                "statistics": {"comment_count": video.get("comment"), "play_count": video.get("play")},
                "share_url": "https://www.bilibili.com/video/%s" % bvid,
            })
            continue
        owner = detail.get("owner") or {}
        if str(owner.get("mid") or "") != mid:
            warnings.append("B站作品 %s 的作者 UID 不一致，已剔除" % bvid)
            continue
        stat = detail.get("stat") or {}
        works.append({
            "aweme_id": bvid,
            "desc": detail.get("title") or video.get("title") or "",
            "create_time": detail.get("pubdate") or video.get("created"),
            "author": {"uid": returned_mid, "nickname": card.get("name") or owner.get("name")},
            "statistics": {
                "digg_count": stat.get("like"), "comment_count": stat.get("reply"),
                "share_count": stat.get("share"), "collect_count": stat.get("favorite"),
                "play_count": stat.get("view"),
            },
            "share_url": "https://www.bilibili.com/video/%s" % bvid,
        })
    return {
        "capturedAt": observation_timestamp(),
        "profile": {"user": {
            "uid": returned_mid, "nickname": card.get("name") or "",
            "follower_count": followers, "aweme_count": nav.get("video"),
            "total_favorited": total_likes,
            "signature": card.get("sign") or "",
        }},
        "works": {"aweme_list": works},
        "worksListEvidence": works_list_evidence,
        "warnings": warnings,
        "sourceEvidence": {"bilibiliCard": {
            "endpoint": card_url,
            "requestedMid": mid,
            "data": {
                "card": {"mid": card.get("mid")},
                "like_num": card_data.get("like_num") if total_likes is not None else None,
            },
            "likeNumPresent": "like_num" in card_data,
            "likeNumValid": total_likes is not None,
            "selection": "public-account-identity-and-cumulative-likes-only",
        }},
        "provenance": {
            "mode": "bilibili-public-card-relation-wbi-view", "accountLocator": "mid",
            "totalLikesSource": "https://api.bilibili.com/x/web-interface/card:data.like_num",
            "totalLikesScope": "account-cumulative-received-likes",
            "cookiePersisted": False, "runtimeAI": False, "paidAPI": False,
        },
    }


def normalized_identity(value):
    return unicodedata.normalize("NFKC", str(value or "")).strip().lstrip("@").casefold()


def normalized_nickname(value):
    return " ".join(normalized_identity(value).split())


def safe_video_detail_error(error):
    """Only bounded error classes leave this path, never upstream text/URLs."""
    allowed = {"login_required", "blocked", "rate_limited", "network_error", "business_error", "upstream_changed"}
    code = getattr(error, "code", None)
    if not isinstance(code, str) or code not in allowed:
        code = "unknown"
    return CollectorError("公开视频详情请求未完成（%s）；未记录错误原文" % code, code=code)


def fetch_public_video_detail(video_id, guest_cookie):
    video_id = str(video_id or "").strip()
    if not re.fullmatch(r"\d{15,25}", video_id):
        raise CollectorError("公开视频内容 ID 格式无效")
    params = common_params()
    params.update({"aweme_id": video_id})
    referer = "https://www.douyin.com/video/%s" % video_id
    try:
        payload = request_json(a_bogus_signed_url(DETAIL_URL, params), referer=referer, cookie=guest_cookie, transport_evidence={})
        mode = "guest-ttwid-a-bogus-video-detail"
    except CollectorError as error:
        failure = safe_video_detail_error(error)
        # A refusal, login/challenge page, malformed body, or unknown outcome
        # never authorises changing request form. Preserve only the existing
        # one fallback for an explicitly classified transient transport error.
        if failure.code != "network_error":
            raise failure from None
        try:
            payload = request_json("%s?%s" % (DETAIL_URL, urlencode(params)), referer=referer, cookie=guest_cookie, transport_evidence={})
            mode = "guest-ttwid-unsigned-video-detail-fallback"
        except Exception as fallback_error:
            raise safe_video_detail_error(fallback_error) from None
    except Exception as error:
        raise safe_video_detail_error(error) from None
    # Shared by identity-work and author resolution, including injected readers:
    # transport success or a present detail alone is never business success.
    if not isinstance(payload, dict) or type(payload.get("status_code")) is not int or payload["status_code"] != 0:
        raise CollectorError("公开视频详情未返回成功状态；已停止请求", code="business_error")
    # Match the source-identity verifier's JSON truthiness contract (empty
    # arrays/objects are truthy there too). A module's mere presence is not a
    # login-expiry signal; only these explicit blocking flags are considered.
    if any(payload.get(field) not in (None, False, 0, "") for field in ("need_login", "login_required", "captcha_required", "verify_required")):
        raise CollectorError("公开视频详情明确要求登录或验证；已停止请求，未处理验证码", code="business_error")
    if not isinstance(payload.get("aweme_detail"), dict):
        raise CollectorError("公开视频详情缺少有效作品对象；已停止请求", code="upstream_changed")
    return payload, mode


def collect_identity_work(video_id):
    video_id = str(video_id or "").strip()
    if not re.fullmatch(r"\d{15,25}", video_id):
        raise CollectorError("原表作品内容 ID 格式无效")
    payload, mode = fetch_public_video_detail(video_id, register_guest())
    detail = payload.get("aweme_detail") or {}
    if type(payload.get("status_code")) is not int or payload["status_code"] != 0:
        raise CollectorError("原表作品公开接口未返回成功状态")
    if detail.get("aweme_id") != video_id:
        raise CollectorError("原表作品公开响应未严格回显提交内容 ID")
    return {
        "capturedAt": observation_timestamp(),
        "requestedVideoId": video_id,
        "response": payload,
        "provenance": {
            "mode": mode, "endpoint": DETAIL_URL,
            "cookiePersisted": False, "runtimeAI": False, "paidAPI": False,
        },
    }


def resolve_video_author(video_id, guest_cookie):
    video_id = str(video_id or "").strip()
    payload, _mode = fetch_public_video_detail(video_id, guest_cookie)
    detail = payload.get("aweme_detail") or {}
    returned_id = str(detail.get("aweme_id") or "").strip()
    if not returned_id or returned_id != video_id:
        raise CollectorError("公开视频身份校验失败：公开响应未严格回显提交内容 ID")
    author = detail.get("author") or {}
    sec_uid = str(author.get("sec_uid") or "").strip()
    if not SEC_UID_RE.fullmatch(sec_uid):
        raise CollectorError("公开视频未返回可验证的作者 sec_uid")
    return {
        "videoId": video_id,
        "secUid": sec_uid,
        "nickname": str(author.get("nickname") or "").strip(),
        "uniqueId": str(author.get("unique_id") or "").strip(),
        "shortId": str(author.get("short_id") or "").strip(),
        "uid": str(author.get("uid") or "").strip(),
        "provenance": "public-video-detail",
    }


def validated_douyin_url(url):
    parsed = urlparse(str(url or ""))
    try:
        safe = (parsed.scheme == "https" and parsed.hostname in {
            "v.douyin.com", "www.douyin.com", "douyin.com",
            "www.iesdouyin.com", "iesdouyin.com",
        } and not parsed.username and not parsed.password and parsed.port is None)
    except ValueError:
        safe = False
    if not safe:
        raise CollectorError("分享链接只允许无凭据、无端口的抖音官方 HTTPS 地址")
    return parsed


def official_share_redirect(url):
    # Deliberately do not use request(): its curl -L would follow an unchecked
    # redirect. Validate every hop before any network request and send no cookie.
    validated_douyin_url(url)
    args = ["curl", "-sS", "--proto", "=https", "--max-time", "20",
            "-A", UA, "-D", "-", "-o", "/dev/null", url]
    try:
        completed = subprocess.run(args, capture_output=True, timeout=25, check=False)
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise CollectorError("分享链接连接失败") from exc
    if completed.returncode:
        raise CollectorError("分享链接连接失败（curl=%s）" % completed.returncode)
    headers = completed.stdout.decode("utf-8", "replace")
    # HTTPS proxies may emit a CONNECT block before the origin response.
    blocks = [block for block in re.split(r"\r?\n\r?\n", headers)
              if re.match(r"^HTTP/\S+\s+\d{3}", block)]
    if not blocks:
        raise CollectorError("分享链接响应缺少 HTTP 状态")
    block = blocks[-1]
    status = int(re.match(r"^HTTP/\S+\s+(\d{3})", block).group(1))
    location = re.search(r"^location:\s*(.+?)\s*$", block, re.I | re.M)
    return status, location.group(1).strip() if location else None


def expand_douyin_share_video(url):
    current = str(url or "").strip()
    visited = set()
    for _ in range(8):
        parsed = validated_douyin_url(current)
        if current in visited:
            raise CollectorError("分享链接出现循环跳转")
        visited.add(current)
        # The official redirect gives a locator, not proof of authorship.
        # resolve_video_author still verifies the actual API response ID.
        match = re.fullmatch(r"/(?:share/video|video|note)/(\d{15,25})/?", parsed.path)
        if match and parsed.hostname != "v.douyin.com":
            return match.group(1)
        for key in ("modal_id", "aweme_id", "item_id"):
            values = parse_qs(parsed.query).get(key, [])
            if parsed.hostname != "v.douyin.com" and len(values) == 1 and re.fullmatch(r"\d{15,25}", values[0]):
                return values[0]
        status, location = official_share_redirect(current)
        if status in (301, 302, 303, 307, 308) and location:
            current = urllib.parse.urljoin(current, location)
            continue
        if status >= 400:
            raise CollectorError("分享链接请求失败（HTTP %s）" % status)
        raise CollectorError("分享链接未返回可核验的作品 ID")
    raise CollectorError("分享链接跳转超过 8 次限制")


def resolve_author_item(item, guest_cookie, retries=3):
    key = str(item.get("key") or "")[:300]
    video_ids = []
    for value in item.get("videoIds") or []:
        value = str(value or "").strip()
        if not re.fullmatch(r"\d{15,25}", value) or value in video_ids:
            continue
        video_ids.append(value)
        if len(video_ids) > 5000:
            raise CollectorError("单个作者的作品 ID 超过 5000 条限制")
    share_urls = list(dict.fromkeys(str(value or "").strip() for value in item.get("shareUrls") or []))
    if len(share_urls) > 5000:
        raise CollectorError("单个作者的分享链接超过 5000 条限制")
    candidates = []
    errors = []
    detail_cache = {}

    def resolve_with_retry(video_id):
        if video_id in detail_cache:
            return dict(detail_cache[video_id])
        active_cookie = guest_cookie
        final_error = None
        attempts = max(1, min(int(retries), 4))
        for attempt in range(attempts):
            try:
                candidate = resolve_video_author(video_id, active_cookie)
                detail_cache[video_id] = candidate
                return dict(candidate)
            except CollectorError as exc:
                final_error = exc
                # Do not turn a detail access/business refusal into guest
                # rotation. Only explicit transient transport failures retain
                # the already-bounded retry budget on this identity path.
                if exc.code != "network_error" or attempt + 1 >= attempts:
                    break
                time.sleep(random.uniform(0.35, 0.8) * (attempt + 1))
                try:
                    active_cookie = register_guest()
                except CollectorError:
                    pass
        raise final_error

    for video_id in video_ids:
        try:
            candidates.append(resolve_with_retry(video_id))
        except CollectorError as exc:
            errors.append({"videoId": video_id, "error": str(exc)[:300]})
    for share_url in share_urls:
        try:
            video_id = expand_douyin_share_video(share_url)
            candidate = resolve_with_retry(video_id)
            candidate["sourceEvidenceUrl"] = share_url
            candidates.append(candidate)
        except CollectorError as exc:
            errors.append({"shareUrl": share_url, "error": str(exc)[:300]})
    return {"key": key, "candidates": candidates, "errors": errors}


def resolve_authors_from_stdin(workers):
    try:
        payload = json.load(sys.stdin)
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise CollectorError("自动核验输入不是合法 JSON") from exc
    items = payload.get("items") if isinstance(payload, dict) else None
    if not isinstance(items, list) or not items:
        raise CollectorError("自动核验缺少作者证据")
    if len(items) > 5000:
        raise CollectorError("单次自动核验作者超过 5000 个限制")
    results = [None] * len(items)
    # Anonymous public-detail sessions are deliberately short lived. In real
    # batches a single ttwid starts returning empty details after roughly one
    # hundred requests, so rotate before that threshold instead of treating a
    # rate-limited response as an identity mismatch.
    session_size = 36
    max_workers = max(1, min(int(workers), 4))
    for batch_start in range(0, len(items), session_size):
        batch = items[batch_start : batch_start + session_size]
        guest_cookie = register_guest()
        with ThreadPoolExecutor(max_workers=max_workers) as executor:
            pending = {
                executor.submit(resolve_author_item, item, guest_cookie, 3): batch_start + offset
                for offset, item in enumerate(batch)
            }
            for future in as_completed(pending):
                index = pending[future]
                try:
                    results[index] = future.result()
                except Exception as exc:
                    results[index] = {
                        "key": str(items[index].get("key") or "")[:300],
                        "candidates": [],
                        "errors": [{"error": str(exc)[:300], "attempts": 1}],
                    }
        if batch_start + session_size < len(items):
            time.sleep(random.uniform(0.45, 0.95))
    return {
        "items": results,
        "provenance": {
            "mode": "public-video-detail-author-resolution",
            "cookiePersisted": False,
            "runtimeAI": False,
            "paidAPI": False,
        },
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--operation", choices=("account", "bilibili-account", "hot", "hashtag-search", "hashtag-detail", "selftest", "resolve-authors", "identity-work"), required=True)
    parser.add_argument("--locator", default="")
    parser.add_argument("--label", default="")
    parser.add_argument("--limit", type=int, default=30)
    parser.add_argument("--workers", type=int, default=4)
    parser.add_argument("--works-mode", choices=("collect", "deferred"), default="collect")
    args = parser.parse_args()
    limit = max(1, min(args.limit, 100))
    try:
        if args.operation == "account":
            if not args.locator.strip():
                raise CollectorError("缺少账号主页链接或 sec_uid")
            emit({"ok": True, "data": collect_account(args.locator, limit, works_mode=args.works_mode)})
        if args.operation == "bilibili-account":
            if not args.locator.strip():
                raise CollectorError("缺少 B站 UID 或官方主页")
            emit({"ok": True, "data": collect_bilibili_account(args.locator, limit)})
        if args.operation == "identity-work":
            emit({"ok": True, "data": collect_identity_work(args.locator)})
        if args.operation == "hot":
            emit({"ok": True, "data": collect_hot(limit)})
        if args.operation == "hashtag-search":
            if not args.label.strip():
                raise CollectorError("缺少话题名称")
            emit({"ok": True, "data": collect_hashtag_search(args.label)})
        if args.operation == "hashtag-detail":
            if not args.locator.strip():
                raise CollectorError("缺少抖音 challenge ID")
            emit({"ok": True, "data": collect_hashtag_detail(args.locator, args.label)})
        if args.operation == "resolve-authors":
            emit({"ok": True, "data": resolve_authors_from_stdin(args.workers)})
        result = collect_account(SELFTEST_SEC_UID, 1)
        hot_result = collect_hot(1)
        user = result["profile"]["user"]
        if "林树" not in (user.get("nickname") or "") or int(user.get("follower_count") or 0) < 10_000_000:
            raise CollectorError("自检账号身份或粉丝量级不符合预期")
        if not hot_result.get("word_list"):
            raise CollectorError("公开热榜端点未返回可核验条目")
        emit(
            {
                "ok": True,
                "data": {
                    "profileEndpoint": True,
                    "postsEndpoint": bool(result["works"]["aweme_list"]),
                    "hotEndpoint": True,
                    "nickname": user.get("nickname"),
                    "followerCount": user.get("follower_count"),
                    "postCount": len(result["works"]["aweme_list"]),
                    "firstHotWord": (hot_result["word_list"][0] or {}).get("word"),
                    "mode": result["provenance"]["mode"],
                    "runtimeAI": False,
                    "paidAPI": False,
                    "warnings": result.get("warnings") or [],
                },
            }
        )
    except CollectorError as exc:
        emit({"ok": False, "error": str(exc)}, 2)
    except Exception as exc:  # fail closed without a traceback or secret-bearing headers
        emit({"ok": False, "error": "公开采集器异常：%s" % exc}, 2)


if __name__ == "__main__":
    main()
