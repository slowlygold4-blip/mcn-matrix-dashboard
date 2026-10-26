// Execute independent permanent contracts against the integrated Site, not /tmp.
import {fileURLToPath} from 'node:url';
process.env.PHASE99_CANDIDATE=fileURLToPath(new URL('../../mcn-public-site/',import.meta.url));
await import('../data/maintenance-journal/phase99-ux-topic-peer.test.mjs');
await import('../data/maintenance-journal/phase99-integrity-topic-numbers.test.mjs');
