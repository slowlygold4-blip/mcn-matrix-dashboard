import { officialProbeReadiness, probeOfficialVideos, miniAppVideoReadiness, probeOfficialMiniAppVideos,
  authorListReadiness, probeOfficialAuthorList } from '../lib/douyin-open-api-probe.mjs';
import { officialSearchReadiness, probeOfficialSearch } from '../lib/douyin-official-search-probe.mjs';

// Secrets are read only from the process environment, never command arguments,
// logs, research artifacts or public snapshots. No browser/model/database access.
const argv = process.argv.slice(2);
const miniApp = argv[0] === '--miniapp';
const authorList = argv[0] === '--author-list';
const search = argv[0] === '--search';
const args = miniApp || authorList || search ? argv.slice(1) : argv;
let itemIds;
try {
  const raw = process.env.DOUYIN_OPEN_ITEM_IDS ?? '';
  if (raw.length <= 8192) itemIds = JSON.parse(raw);
} catch { /* A missing/invalid JSON array is a readiness failure, never a request. */ }
const credentials = search ? {
  clientToken: process.env.DOUYIN_CLIENT_TOKEN,
  deviceId: process.env.DOUYIN_SEARCH_DEVICE_ID,
  keyword: process.env.DOUYIN_SEARCH_KEYWORD,
  scopes: (process.env.DOUYIN_CLIENT_SCOPES ?? '').split(/[ ,]+/).filter(Boolean),
} : authorList ? {
  clientToken: process.env.DOUYIN_CLIENT_TOKEN,
  authorHandle: process.env.DOUYIN_AUTHOR_HANDLE,
  scopes: (process.env.DOUYIN_CLIENT_SCOPES ?? '').split(/[ ,]+/).filter(Boolean),
} : {
  accessToken: process.env.DOUYIN_OPEN_ACCESS_TOKEN,
  openId: process.env.DOUYIN_OPEN_ID,
  scopes: (process.env.DOUYIN_OPEN_SCOPES ?? '').split(/[ ,]+/).filter(Boolean),
  ...(miniApp ? { itemIds } : {}),
};
const accepted = search ? args.length === 1 && args[0] === '--run'
  : args.length === 3 && args[0] === '--run' && args[1] === '--account-key';
if (args.length === 0) {
  const readiness = search ? officialSearchReadiness(credentials) : authorList ? authorListReadiness(credentials) : miniApp ? miniAppVideoReadiness(credentials) : officialProbeReadiness(credentials);
  process.stdout.write(JSON.stringify({ mode: 'readiness', api: search ? 'official-video-search' : authorList ? 'bound-author-list' : miniApp ? 'miniapp-query' : 'legacy-video-list', ...readiness,
    networkRequests: 0, databaseWrites: 0, modelCalls: 0 }) + '\n');
} else if (!accepted) {
  process.stderr.write('Usage: node scripts/probe-douyin-open-api.mjs [--miniapp|--author-list] [--run --account-key KEY]; or --search [--run]\n');
  process.exitCode = 2;
} else {
  try {
    const probe = search ? probeOfficialSearch : authorList ? probeOfficialAuthorList : miniApp ? probeOfficialMiniAppVideos : probeOfficialVideos;
    const result = await probe({ ...credentials, accountKey: args[2] });
    process.stdout.write(JSON.stringify(result) + '\n');
  } catch (error) {
    // No raw response, URL, credential or upstream exception is printed.
    process.stdout.write(JSON.stringify({ status: 'unavailable', code: error.code ?? 'collector_error',
      ...(Number.isSafeInteger(error.officialErrorCode) ? { officialErrorCode: error.officialErrorCode } : {}),
      productionAdmitted: false, databaseWrites: 0, modelCalls: 0 }) + '\n');
    process.exitCode = 1;
  }
}
