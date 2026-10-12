import { periodDelta } from './console-model.js';

const METRIC_KEY = /^(followers|likes|posts|estimatedPlays)(?:\.(?:value|delta))?$/;
const TASKS = new Set(['all', 'growing', 'declining', 'unobserved']);

export function getWorkflowMetric(sortKey, fallback = 'followers') {
  const match = typeof sortKey === 'string' ? sortKey.match(METRIC_KEY) : null;
  return match && match[0] === sortKey ? match[1] : fallback;
}

function enabledAccounts(accounts) {
  return Array.isArray(accounts) ? accounts.filter((account) => account?.enabled === true) : [];
}

function workflowTask(account, metric, period) {
  // The shared model preserves missing endpoints as null, including a daily
  // metric whose available samples do not form an adjacent-day comparison.
  const observation = account.metrics?.[metric];
  if (observation?.comparable === false) return 'unobserved';
  const delta = periodDelta(observation, period);
  if (delta === null) return 'unobserved';
  if (delta > 0) return 'growing';
  if (delta < 0) return 'declining';
  return 'unchanged';
}

export function createWorkflowSummary(accounts, metric = 'followers', period) {
  const selectedMetric = getWorkflowMetric(metric);
  const summary = { all: 0, growing: 0, declining: 0, unobserved: 0, unchanged: 0 };
  for (const account of enabledAccounts(accounts)) {
    summary.all += 1;
    summary[workflowTask(account, selectedMetric, period)] += 1;
  }
  return summary;
}

export function filterWorkflowAccounts(accounts, {
  task = 'all', metric = 'followers', period,
} = {}) {
  const selectedTask = TASKS.has(task) ? task : 'all';
  const selectedMetric = getWorkflowMetric(metric);
  return enabledAccounts(accounts).filter((account) => selectedTask === 'all'
    || workflowTask(account, selectedMetric, period) === selectedTask);
}
