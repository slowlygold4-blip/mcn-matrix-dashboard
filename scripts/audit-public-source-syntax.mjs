/** Compile tracked JS modules without evaluating imports or executing code.
 * Run in the public Git checkout with --experimental-vm-modules (Node 24).
 * This catches broken archive redactions in synthetic security fixtures.
 */
import { SourceTextModule } from 'node:vm';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const files = execFileSync('git', ['ls-files', '-z', '*.mjs', '*.js'], { encoding: 'utf8' })
  .split('\0').filter(Boolean);
const syntaxErrors = [];
for (const file of files) {
  try { new SourceTextModule(readFileSync(file, 'utf8'), { identifier: file }); }
  catch (error) { syntaxErrors.push({ file, message: error.message }); }
}
console.log(JSON.stringify({ filesChecked: files.length, executedModules: false, syntaxErrors }));
process.exitCode = syntaxErrors.length ? 1 : 0;
