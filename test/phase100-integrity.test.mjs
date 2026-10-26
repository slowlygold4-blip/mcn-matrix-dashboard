// Keep the independent source/writer/publication counterexamples in every full run.
import { fileURLToPath } from 'node:url';
const actualMain = fileURLToPath(new URL('../', import.meta.url));
process.env.PHASE100_CANDIDATE = actualMain;
process.env.PHASE100_MAIN = actualMain;
// The immutable Phase100 evidence remains in place; only the separately
// reviewed, one-source Phase117 freeze changes. All business cases are exact.
await import('../docs/phase117-integrity-permanent.test.mjs');
