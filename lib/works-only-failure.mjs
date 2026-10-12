import { sanitizeBrowserWorksDiagnostics } from './douyin-browser-diagnostics.mjs';
import { safeOwnershipFailure, safeOwnershipBranch } from './collector-ownership.mjs';

const STAGES = new Set(['browser-page', 'provider-validation', 'collector-envelope',
  'collector-process', 'collector-protocol', 'collector-ownership']);

// Optional append-only metadata: old canonical observations project to {}, so
// their hashes do not change. No arbitrary message, stack, URL or key survives.
export function projectWorksOnlyFailure(result) {
  const failureDiagnostics = sanitizeBrowserWorksDiagnostics(result?.failureDiagnostics);
  const failureCode = safeOwnershipFailure({ code: result?.failureCode })?.code;
  const failureBranch = failureCode && result?.failureStage === 'collector-ownership' ? safeOwnershipBranch(result?.failureBranch) : null;
  return {
    ...(failureDiagnostics ? { failureDiagnostics } : {}),
    ...(STAGES.has(result?.failureStage) ? { failureStage: result.failureStage } : {}),
    ...(failureCode ? { failureCode } : {}),
    ...(failureBranch ? { failureBranch } : {}),
  };
}
