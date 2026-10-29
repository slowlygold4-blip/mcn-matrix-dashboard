# Browser-free collection: continued source review

Reviewed on 2026-10-29 UTC / 2026-10-30 Beijing time. Eight additional GitHub repositories were pinned and 25 source/doc files retrieved. Review was targeted to collection entry points, authentication, endpoints and limits, not a whole-repository security certification. No upstream code was installed or executed. A source-file checksum manifest is retained in the private audit directory; original business data and credentials are excluded from this public report.

## Findings from actual source

| Candidate | Pinned primary evidence | Outcome |
|---|---|---|
| TikTokDownloader | [account.py](https://github.com/JoeanAmier/TikTokDownloader/blob/e327b9549d284a8b1613566f949fe2dbb8a6c2a1/src/interface/account.py), [requester.py](https://github.com/JoeanAmier/TikTokDownloader/blob/e327b9549d284a8b1613566f949fe2dbb8a6c2a1/src/link/requester.py) | Uses the same `/aweme/v1/web/aweme/post/` endpoint. Pagination and an early publication-date boundary are worth comparing, but a different wrapper does not establish restored access. The inspected redirect helper disables TLS verification; it was not adopted. |
| douyin-downloader | [README](https://github.com/jiji262/douyin-downloader/blob/ed863617aa52353821aca8fdebcfad4e916ebff5/README.md), [API client](https://github.com/jiji262/douyin-downloader/blob/ed863617aa52353821aca8fdebcfad4e916ebff5/core/api_client.py) | Explicitly documents a current verification block that cookie refresh/retry does not fix. Public-profile fallback uses a browser. Its distinction between deterministic verification rejection and transient HTTP errors is useful; this is not a demonstrated collection fix. |
| creatorhub | [HTTP client](https://github.com/3441293738/creatorhub/blob/13598884a6fcb3ccb661b6bbb7dea7c9b13fc478/app/platforms/douyin/client.py), [self-profile validation](https://github.com/3441293738/creatorhub/blob/13598884a6fcb3ccb661b6bbb7dea7c9b13fc478/app/platforms/douyin/auth.py) | Has a real HTTP implementation, but its author enumeration still uses the same signed web endpoint and session prerequisites. It separately recognizes endpoints requiring browser security state. A public profile or cached identity does not prove the session is logged in. Not installed; no identity rotation or forged session adopted. |
| DouyinDataReview | [creator queries](https://github.com/ZhangYukwiver/DouyinDataReview/blob/ba852eccb648d9ce345860230a29ac89b50256d6/collector/creatorCenter.mjs), [HTTP session](https://github.com/ZhangYukwiver/DouyinDataReview/blob/ba852eccb648d9ce345860230a29ac89b50256d6/collector/directApi.mjs) | A genuinely different route: saved, account-bound session credentials can query creator-center overview, works and trends over HTTP. The `playwrightRequest` client here is HTTP transport; this read path does not itself launch a browser. However, the repository provisions credentials through browser/desktop login, and the session only grants its actual account permissions. It does not grant access to all matrix owners' private analytics. Promising for already-authorized own-account data, not proven live here. |
| douyin-to-feishu skill | [SKILL.md](https://github.com/Super-Bull/douyin-to-feishu/blob/917dd6ba1319493e8b80240b63ff52f7c8ee25d0/douyin-to-feishu/SKILL.md) | Requires a real browser and explicitly excludes direct HTTP collection. It is not a browser-free unattended matrix collector. Not installed. |
| douyin_skill | [SKILL.md](https://github.com/Yym11345/douyin_skill/blob/716494967867361d7f812a94ada3ad15a8158ed7/SKILL.md), [adapter](https://github.com/Yym11345/douyin_skill/blob/716494967867361d7f812a94ada3ad15a8158ed7/scripts/adapters/douyin.mjs) | Browser-network interception with a persistent Chrome profile. Calling it a skill does not change its access method. Not installed. |
| AiToEarn | [work provider](https://github.com/yikart/AiToEarn/blob/cc13deb6ab6d17b55e733d9353ad3300e31f40f7/project/aitoearn-backend/apps/aitoearn-server/src/core/channels/platforms/douyin/douyin-work.provider.ts), [collection skill](https://github.com/yikart/AiToEarn/blob/cc13deb6ab6d17b55e733d9353ad3300e31f40f7/project/aitoearn-backend/apps/aitoearn-ai/src/core/agent/skills/crawling-social-media/SKILL.md) | The inspected link-info provider returns a parsed work identity and `snapshots: []`, not current engagement measurements. The skill delegates a crawl task to another service. Neither is evidence of a free standalone author-statistics collector. |
| ByteDance OpenAPI SDK | [README](https://github.com/bytedance/douyin-openapi-sdk-go/blob/a50593c5ccdc31ab5b7cb2153947dfad612bbed9/README.md), [generated client](https://github.com/bytedance/douyin-openapi-sdk-go/blob/a50593c5ccdc31ab5b7cb2153947dfad612bbed9/client/client.go) | Official HTTP client implementation exists. Its generated client is approximately 7.7 MB; targeted API review is not a claim that every generated method was audited. An SDK supplies neither app approval nor author consent. |

## Other acquisition routes and their actual boundaries

1. **Official authorized account list and statistics.** [`GET /video/list/`](https://open.douyin.com/platform/resource/docs/openapi/video-management/douyin/search-video/account-video-list/) requires `video.list`; the referenced documentation currently specifies at most four pages. [`POST /video/data/`](https://open.douyin.com/platform/resource/docs/openapi/video-management/douyin/search-video/video-data/) requires `video.data`, only permits the token owner's videos and recommends batches of at most ten IDs. It can provide real plays. These are useful collection paths after approval and consent, not an unrestricted whole-platform API.
2. **Official daily account metrics.** [The fans endpoint](https://open.douyin.com/platform/resource/docs/openapi/data-open-service/user-data/get-user-fans-count) returns dated new/total fans and documents next-day updates around noon. Preserve the metric date separately from retrieval time; do not promise minute-level updates. [Video basic data](https://open.douyin.com/platform/resource/docs/openapi/data-open-service/video-data/get-basic-data/) documents a recent-video limit, so it cannot reconstruct arbitrary old daily values.
3. **Official keyword discovery.** [Keyword management/search](https://open.douyin.com/platform/resource/docs/ability/search-management/video/) requires approved business-related keywords and only covers recently published content. A newer [search endpoint](https://developer.open-douyin.com/docs/resource/zh-CN/dop/develop/openapi/douyin-search-capability/aweme-dy-video-search/) exists, but its [capability page](https://partner.open-douyin.com/docs/resource/zh-CN/dop/ability/search-management/item-search) says it is experimental and currently not open externally. Do not present it as an immediately available no-auth fallback. Search hits can discover works, but cannot certify an author's complete daily output.
4. **Publication receipts/events.** [The event list](https://developer.open-douyin.com/docs/resource/zh-CN/dop/develop/webhooks/event-list) restricts `create_video` to application-mediated sharing with a share ID. It is useful for future works published through a connected workflow, not a webhook for every existing author's ordinary publication.
5. **Authorized workbooks and creator exports.** These remain real data sources in the existing reconciliation pipeline. Store immutable editions, deduplicate by verified author/work identity and metric/date, and add fresh observations. Absorb them into the same dashboard corpus. A publication date permits daily work counts; it does not manufacture a daily history of plays recorded only at a later observation.

Moving the same denied request to another machine, wrapping it in MCP or naming it a skill does not demonstrate restored access. No new account, paid service, CAPTCHA processing, browser launch, cookie extraction or proxy rotation was performed in this review.

## Implemented isolated official HTTP trial

New independently written files:

- `lib/douyin-open-api-probe.mjs`
- `scripts/probe-douyin-open-api.mjs`
- `test/douyin-open-api-probe.test.mjs`

Default invocation is a **zero-request readiness check**:

```sh
node scripts/probe-douyin-open-api.mjs
```

For an already-approved `video.list` authorization, provision `DOUYIN_OPEN_ACCESS_TOKEN`, `DOUYIN_OPEN_ID` and `DOUYIN_OPEN_SCOPES` securely in the process environment, then run:

```sh
node scripts/probe-douyin-open-api.mjs --run --account-key EXISTING_CANONICAL_KEY
```

Do not paste secrets into chat or command arguments. The tool performs one read-only account-page trial by default, directly to the official HTTPS host with a 20-second request bound and 2 MB response cap. There are no model calls, browser calls, token refreshes, database writes, timers or production scheduler changes. Authentication/permission/network refusals stop with fixed codes; raw upstream errors and credentials are not logged. The library supports up to four pages and exact cursor tracking; a failed later page does not return earlier pages as complete success.

Real returned zero plays remain zero with `plays_source=api`; absent plays remain null/unavailable. Publication and observation dates are separate. Official opaque `item_id` remains distinct from numeric public `aweme_id`; nickname or matching titles must not be used to invent that binding. Trial output explicitly has `productionAdmitted=false` and never asserts all-author work coverage. This is an isolated probe, not yet a production provider or an automatic repair of the existing 403.

Twelve synthetic tests pass: missing authorization before transport, readiness CLI, plays/null/zero and dates, cursor pagination/deduplication, partial page budgets, int64/repeated cursors, bounded input, private-date placeholders, HTTP/business errors, malformed/oversized responses, later-page failure and safe cancellation. The actual readiness check found none of these three environment prerequisites configured; it made zero platform requests. **No successful live official sample is claimed.**

## Acceptance still outstanding

Obtain a real authorized sample, verify public/official identity bindings, compare returned metrics against original evidence, then connect the accepted observations to the existing corpus and scheduler. Complete current works coverage remains unresolved. Existing account/source scripts continue without runtime model calls; passing this tool's tests does not change that coverage.
