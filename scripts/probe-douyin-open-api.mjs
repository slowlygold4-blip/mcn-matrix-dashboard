import { officialProbeReadiness, probeOfficialVideos } from '../lib/douyin-open-api-probe.mjs';

// Secrets are read only from the process environment, never command arguments,
// logs, research artifacts or public snapshots. No browser/model/database access.
const args = process.argv.slice(2);
const credentials = {
  accessToken: process.env.DOUYIN_OPEN_ACCESS_TOKEN,
  openId: process.env.DOUYIN_OPEN_ID,
  scopes: (process.env.DOUYIN_OPEN_SCOPES ?? '').split(/[ ,]+/).filter(Boolean),
};
const accepted = args.length === 3 && args[0] === '--run' && args[1] === '--account-key';
if (args.length === 0) {
  process.stdout.write(JSON.stringify({ mode: 'readiness', ...officialProbeReadiness(credentials),
    networkRequests: 0, databaseWrites: 0, modelCalls: 0 }) + '\n');
} else if (!accepted) {
  process.stderr.write('Usage: node scripts/probe-douyin-open-api.mjs [--run --account-key KEY]\n');
  process.exitCode = 2;
} else {
  try {
    const result = await probeOfficialVideos({ ...credentials, accountKey: args[2] });
    process.stdout.write(JSON.stringify(result) + '\n');
  } catch (error) {
    // No raw response, URL, credential or upstream exception is printed.
    process.stdout.write(JSON.stringify({ status: 'unavailable', code: error.code ?? 'collector_error',
      productionAdmitted: false, databaseWrites: 0, modelCalls: 0 }) + '\n');
    process.exitCode = 1;
  }
}
