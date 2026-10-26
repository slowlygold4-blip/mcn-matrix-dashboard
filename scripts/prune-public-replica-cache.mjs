import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {prunePublicReplicaStaging} from '../lib/public-replica-retention.mjs';
const dataDir=resolve(process.env.DATA_DIR||fileURLToPath(new URL('../data',import.meta.url)));
console.log(JSON.stringify(await prunePublicReplicaStaging({dataDir,dryRun:!process.argv.includes('--apply')}),null,2));
