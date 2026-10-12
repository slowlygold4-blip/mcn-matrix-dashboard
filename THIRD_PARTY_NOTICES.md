# Third-party notices

## @e965/xlsx compatibility reader

- Source: https://github.com/e965/sheetjs-npm-publisher
- Installed version: `0.20.3` (pinned by `package-lock.json`)
- Purpose: public, local fallback reader for legacy or non-standard XLSX/XLS/XLSM/XLSB exports when ExcelJS cannot parse them.
- License: Apache License 2.0
- Security note: the package has no runtime dependencies; `npm audit` reports zero known vulnerabilities.

## ExcelJS

- Source: https://github.com/exceljs/exceljs
- Installed version: `4.4.0` (pinned by `package-lock.json`)
- Purpose: local, in-memory reading of uploaded XLSX workbooks; formulas are not evaluated.
- License: MIT
- Security note: the transitive `uuid` package is overridden to `11.1.1` or newer within major version 11; `npm audit` reports zero known vulnerabilities.

## Playwright Core

- Source: https://github.com/microsoft/playwright
- Installed version: `1.62.1` (pinned by `package-lock.json`)
- Purpose: drive a dedicated anonymous local Chrome session when resolving a submitted public Douyin video to its author identity.
- License: Apache License 2.0
- Privacy note: the resolver never attaches to the user's personal browser profile and does not read a logged-in browser session.

## X-Bogus (Evil0ctal/Douyin_TikTok_Download_API)

- Source: https://github.com/Evil0ctal/Douyin_TikTok_Download_API
- Pinned commit: `42784ffc83a72a516bfe952153ad7e2a3998d16c`
- Vendored file: `vendor/evil0ctal/xbogus.py`
- Vendored file SHA-256: `8641bed81dfd2ebb7cf7b5b935a1a94a9fb631148dd9c709142a7775447a873e`
- License: Apache License 2.0; the included copy is at `vendor/evil0ctal/LICENSE`

Only the self-contained X-Bogus implementation is vendored. The A-Bogus module
and the upstream web service from this repository are not bundled or called.

## A-Bogus (lXwalk/douyin-download, F2 signing subset)

- Source: https://github.com/lXwalk/douyin-download
- Pinned commit: `85c7c7f7a0b13482ba9bf7acad6976fed473119a`
- Vendored file: `vendor/f2/abogus.py`
- Vendored file SHA-256: `b3368b6f5e648ed89c1c05df52db24f3a24b855031313c7cd64d5ab64c58feaf`
- License: Apache License 2.0; the included copy is at `vendor/f2/LICENSE`
- License file SHA-256: `c95bae1d1ce0235ecccd3560b772ec1efb97f348a79f0fbe0a634f0c2ccefe2c`

Only the pure local A-Bogus and browser-fingerprint module is vendored. F2's
downloader, cookie reader, services, example cookies and network client are not
bundled or called.

## GmSSL SM3 subset (duanhongyi/gmssl)

- Source: https://github.com/duanhongyi/gmssl
- Pinned commit: `6ad876fe33ceeba68076e1591e74d610395d5de8`
- Vendored files: `vendor/gmssl/sm3.py`, `vendor/gmssl/func.py`
- File SHA-256: `e989ae78cfd026ca959bcf53fdffc43f4402e512da760de84d7b9611625cd699`, `c4e5096f95459c10b9744ee0065abb6bf7998ffcdae65878bc40daa840e5c25d`
- License: MIT; the included copy is at `vendor/gmssl/LICENSE`
- License file SHA-256: `d734a4444aa3c6c50b4a96defd09c4732e1312458dcbfa013a5ccc27211bf3cf`

Only the pure-Python SM3 functions required by A-Bogus are bundled. The SM2,
SM4 and PyCryptodome-dependent modules are not bundled.

## Bilibili public API route

- API reference: https://github.com/SocialSisterYi/bilibili-API-collect
- Implementation was reviewed against public API behavior; the local research checkout is not part of this repository.
- Purpose: read public account cards, follower counts, submission counts, WBI-signed public video lists and public video details without an API key.
- Runtime note: no third-party Bilibili package or credential is bundled; WBI signing is calculated locally and missing fields remain null.

## Xiaohongshu public profile state research

- Source: https://github.com/jackwener/opencli
- Purpose: research the public Xiaohongshu profile structure without an API key or paid API.
- Primary runtime source: the official public profile page's server-rendered `window.__INITIAL_STATE__`; it is parsed as data without executing page JavaScript, and returned user IDs must match the requested profile.
- Implementation references: https://github.com/Lixiansicong/xiaohongshu/blob/main/docs/TECHNICAL_DETAILS.md and https://github.com/jackwener/xiaohongshu-cli/pull/44/files
- Runtime note: OpenCLI is not invoked by this project. The runtime reads only the official public profile page; anti-bot or login-wall responses are rejected without overwriting history or reusing a personal browser session.
