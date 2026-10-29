// Deployment policy wins over every request/adapter opt-in. HTTP collection,
// imported evidence and stored observations remain available independently.
export function douyinBrowserDisabled(environment = process.env) {
  return ['1', 'true', 'on'].includes(String(environment.DOUYIN_BROWSER_DISABLED ?? '').trim().toLowerCase());
}
