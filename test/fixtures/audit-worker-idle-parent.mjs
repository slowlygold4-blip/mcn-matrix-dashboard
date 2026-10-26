import { SystemAuditReader } from '../../lib/system-audit-reader.mjs';

const reader = new SystemAuditReader({ databasePath: process.argv[2], backupDir: process.argv[3] });
const result = await reader.read();
if (result.database.status !== 'ok') process.exitCode = 1;
// No explicit close: an idle worker must not pin the owning process forever.
