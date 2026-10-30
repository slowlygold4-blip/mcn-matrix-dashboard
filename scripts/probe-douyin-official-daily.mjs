import { officialDailyReadiness, probeOfficialDaily, officialVideoPlayReadiness, probeOfficialVideoPlays } from '../lib/douyin-official-daily-probe.mjs';
const credentials = { accessToken: process.env.DOUYIN_OPEN_ACCESS_TOKEN, openId: process.env.DOUYIN_OPEN_ID,
  scopes: (process.env.DOUYIN_OPEN_SCOPES ?? '').split(/[ ,]+/).filter(Boolean) };
const argv = process.argv.slice(2);
const videoPlays = argv[0] === '--video-plays';
const args = videoPlays ? argv.slice(1) : argv;
if (videoPlays) credentials.itemId = process.env.DOUYIN_OPEN_ITEM_ID;
if (args.length === 0) {
  process.stdout.write(JSON.stringify({ mode: 'readiness', api: videoPlays ? 'video-dated-plays' : 'user-daily', ...(videoPlays ? officialVideoPlayReadiness(credentials) : officialDailyReadiness(credentials)),
    networkRequests: 0, databaseWrites: 0, modelCalls: 0 }) + '\n');
} else if (args.length !== 3 || args[0] !== '--run' || args[1] !== '--account-key') {
  process.stderr.write('Usage: node scripts/probe-douyin-official-daily.mjs [--video-plays] [--run --account-key KEY]\n');
  process.exitCode = 2;
} else {
  try { process.stdout.write(JSON.stringify(await (videoPlays ? probeOfficialVideoPlays : probeOfficialDaily)({ ...credentials, accountKey: args[2] })) + '\n'); }
  catch (error) {
    process.stdout.write(JSON.stringify({ status: 'unavailable', code: error.code ?? 'collector_error', officialErrorCode: error.officialErrorCode ?? null,
      productionAdmitted: false, databaseWrites: 0, modelCalls: 0 }) + '\n');
    process.exitCode = 1;
  }
}
