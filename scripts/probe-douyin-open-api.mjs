import { officialProbeReadiness, probeOfficialVideos, miniAppVideoReadiness, probeOfficialMiniAppVideos,
  authorListReadiness, probeOfficialAuthorList } from '../lib/douyin-open-api-probe.mjs';

// Secrets are read only from the process environment, never command arguments,
// logs, research artifacts or public snapshots. No browser/model/database access.
const argv = process.argv.slice(2);
const miniApp = argv[0] === '--miniapp';
const authorList = argv[0] === '--author-list';
const args = miniApp || authorList ? argv.slice(1) : argv;
let itemIds;
try {
  const raw = process.env.DOUYIN_OPEN_ITEM_IDS ?? '';
  if (raw.length <= 8192) itemIds = JSON.parse(raw);
} catch { /* A missing/invalid JSON array is a readiness failure, never a request. */ }
const credentials = authorList ? {
  clientToken: process.env.DOUYIN_CLIENT_TOKEN,
  authorHandle: process.env.DOUYIN_AUTHOR_HANDLE,
  scopes: (process.env.DOUYIN_CLIENT_SCOPES ?? '').split(/[ ,]+/).filter(Boolean),
} : {
  accessToken: process.env.DOUYIN_OPEN_ACCESS_TOKEN,
  openId: process.env.DOUYIN_OPEN_ID,
  scopes: (process.env.DOUYIN_OPEN_SCOPES ?? '').split(/[ ,]+/).filter(Boolean),
  ...(miniApp ? { itemIds } : {}),
};
const accepted = args.length === 3 && args[0] === '--run' && args[1] === '--account-key';
if (args.length === 0) {
  const readiness = authorList ? authorListReadiness(credentials) : miniApp ? miniAppVideoReadiness(credentials) : officialProbeReadiness(credentials);
  process.stdout.write(JSON.stringify({ mode: 'readiness', api: authorList ? 'bound-author-list' : miniApp ? 'miniapp-query' : 'legacy-video-list', ...readiness,
    networkRequests: 0, databaseWrites: 0, modelCalls: 0 }) + '\n');
} else if (!accepted) {
  process.stderr.write('Usage: node scripts/probe-douyin-open-api.mjs [--miniapp|--author-list] [--run --account-key KEY]\n');
  process.exitCode = 2;
} else {
  try {
    const probe = authorList ? probeOfficialAuthorList : miniApp ? probeOfficialMiniAppVideos : probeOfficialVideos;
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
