# HTTP collection review and publication reliability — 2026-10-29

## Verified changes

The unattended publisher now reuses a previously validated upload plan only for an explicitly sealed, immutable source snapshot, within the same process and date-index mode. First use still performs the complete content, identity, provenance, schema and hash audits. Credentials, persisted checkpoint state, activation and remote readback are always fresh. Mutable inputs, changed generations, changed mode and a new process do not inherit the cached validation capability. Batch bytes and manifest contracts are unchanged. This is publication work, not a claim that platform collection is complete.

Four adversarial retry cases and a synthetic benchmark were added. The related backend suite passes 102 tests. A synthetic 1,000-account fixture measured 322.2 ms cold validation/plan versus 0.11 ms warm plan lookup in this run; these are local synthetic timings, not production throughput or network performance. Two mock manifest reads occur, zero real HTTP/model calls. An initial benchmark incorrectly expected zero mock reads; the fixture assertion was corrected to preserve required fresh remote-state checks.

## Additional primary-source review

No candidate was installed merely because it advertised a skill. Reviewed source text was not executed.

| Candidate | Pinned evidence | Finding and disposition |
|---|---|---|
| growth-lab MediaCrawler Douyin skill | [SKILL.md](https://github.com/tsingyuai/growth-lab/blob/2d0807c5831c69eac4267702f539957a621e7689/collectors/media-crawler-douyin/SKILL.md) | Delegates to MediaCrawler; search is discovery evidence, not complete coverage. Its stop-on-login/risk-control advice is useful; browser collection stays disabled. |
| sigcli Douyin | [SKILL.md](https://github.com/sigcli/sigcli/blob/9ba8b35415bfee4fca67927a5b62d9e2ef676e81/skills/douyin/SKILL.md) | Browser cookie provisioning, not a new public-data source; no browser login or credential extraction executed. |
| openakita Douyin tool | [SKILL.md](https://github.com/openakita/openakita/blob/5f5b38da728274f0fd06461a481851be7c0bca6a/skills/douyin-tool/SKILL.md) | Mostly production/marketing guidance, not an implemented matrix collector. |
| guaikei crawler skill | [repository](https://github.com/why20261/douyin-crawler-guaikei) | Requires GUAIKEI_API_TOKEN and a third-party service; excluded under no new paid/API-key-service requirement. |
| F2 | [source](https://github.com/Johnserf-Seed/f2/tree/f6be8c0ffba9a127075bbeafe4838716650b6325), [open issue 443](https://github.com/Johnserf-Seed/f2/issues/443) | HTTP architecture worth inspecting, but current issue reports 403 even after cookie refresh. No proof it resolves this deployment; no credential/identity rotation adopted. |
| Evil0ctal API | [README](https://github.com/Evil0ctal/Douyin_TikTok_Download_API/blob/b5505e3830a2e4b9b8608962f58e96dfe75f23c5/README.md) | New version still mints Douyin visitor identities through headless browser. Rotation and browser fallback were not adopted. |
| media-parser | [Douyin source](https://github.com/ucmao/media-parser/blob/19496f8c253ee0c18a2e2e27e23267c76aecaa63/src/parsers/douyin_parser.py) | Supports HTTP/shared-page parsing, but also contains disabled TLS verification, embedded guest credential material and access-control workarounds; not imported. Only an ordinary public-share-page hypothesis was tested independently with TLS checks and no credential changes. |
| Kuhakucai creator MCP | [README](https://github.com/Kuhakucai/douyin-mcp/tree/53c888a5e1d83ea70978e71432ad8774707d69b7) | Explicitly a local Playwright/single-account creator-center reader, not a browser-free matrix API; excluded. |
| yzfly video MCP | [parser](https://github.com/yzfly/douyin-mcp-server/blob/b0bb8b1fbe4f514bf28099b1471928ebb3716ad2/douyin-video/scripts/douyin_downloader.py) | Parsing itself is key-free ordinary share HTML; its model API key is for optional transcription, so it must not be misclassified as a paid metadata API. It expects loaderData/videoInfoRes, absent in this environment's isolated share-page response. No transcription/model calls made. |
| pazwusimple MCP | [README](https://github.com/pazwusimple-netizen/douyin-mcp/tree/ab9eb3b36cd47e9091e520f9a5faabf72f1f16e4) | Requires browser cookie login and advertises challenge retries/browser fallback; excluded. |
| Official API | [video/data](https://open.douyin.com/platform/resource/docs/openapi/video-management/douyin/search-video/video-data/) | Requires approved video.data permission and user authorization; only token owner's uploaded videos. Not a secret-free arbitrary-account API. No new authorization/app was created. |

## Isolated network evidence

- One current stored-work HTTP detail probe returned 403; stopped without production writes.
- One explicit numeric-UID public-share redirect check returned 200 but no canonical sec_uid; not an identity resolution success.
- One independent public share HTML request followed an official-host redirect and returned 200/72,914 bytes. It contained none of the expected public data markers. No browser, signatures, cookie substitution, CAPTCHA processing or script execution; stopped without admitting data.

The works API 403 and complete automatic identity linkage remain unresolved. Existing authorized workbook/source data is still ingested and published by the ordinary script pipeline. These outcomes must not be relabeled platform-collection success.

- A separate ordinary mobile representation of the share page returned 200/32,454 bytes with security-verification markers. Parsing stopped without executing scripts or attempting the verification. It is not a successful data result.

## Publication preparation observability

During a graceful publisher reload, the persisted state still described the previous completed generation while the next read-only export had already started. The graceful abort retained the new immutable stage and the existing daemon resumed it; main/source workers and business data were untouched. Added a persisted `preparing` state before slow baseline/export work so future maintenance does not infer runtime idleness from the previous success record. The active retry cache was observed as `reused-immutable` on a real network retry; this is not an end-to-end production speed benchmark.


## Final network observation

At 07:33–07:35 UTC, the existing proxy route reset TLS to the public Site before any HTTP response; a direct diagnostic received Cloudflare HTTP 403. GitHub through the same proxy returned 200. The next generation remains checkpointed at 96/342 batches, while the earlier generation had been fully read back at 07:16 UTC. Existing bounded retry continues; no checkpoint reset, duplicate publisher, global proxy change or challenge handling. Public availability at the final observation is not claimed. This Site connectivity problem is separate from the Douyin works API failure.

The preparation-status patch passes related tests and is committed, but is not yet loaded in the active publisher; it awaits a safe idle reload. Agent Reach reports v1.6.0 available; no tool upgrade was performed during this investigation.
