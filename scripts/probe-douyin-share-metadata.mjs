import { probeDouyinShareMetadata } from '../lib/douyin-share-metadata-probe.mjs';

const args = process.argv.slice(2);
if (!args.length) {
  process.stdout.write(JSON.stringify({ mode: 'readiness', networkRequests: 0, databaseWrites: 0, modelCalls: 0,
    requiresBrowser: false, requiresCookies: false, productionAdmitted: false }) + '\n');
} else if (args.length !== 3 || args[0] !== '--run' || args[1] !== '--content-id') {
  process.stderr.write('Usage: node scripts/probe-douyin-share-metadata.mjs [--run --content-id PUBLIC_VIDEO_ID]\n');
  process.exitCode = 2;
} else {
  try {
    process.stdout.write(JSON.stringify(await probeDouyinShareMetadata({ contentId: args[2] })) + '\n');
  } catch (error) {
    // Fixed codes only; raw HTML, Set-Cookie, redirects and remote errors are private.
    process.stdout.write(JSON.stringify({ status: 'unavailable', code: error?.code ?? 'collector_error',
      ...(error?.diagnostic ? { diagnostic: error.diagnostic } : {}),
      ...(error?.transportEvidence ? { transport: error.transportEvidence } : {}),
      productionAdmitted: false, allAuthorWorksCollected: false, databaseWrites: 0, modelCalls: 0 }) + '\n');
    process.exitCode = 1;
  }
}
