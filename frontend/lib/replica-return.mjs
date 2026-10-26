import {workspaceNavigation, workspacePath} from './replica-navigation.mjs';

const validGeneration = value => typeof value === 'string'
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;

/** In-memory only. Never accepts a user-supplied redirect or puts return state in shared links. */
export function captureWorkspaceReturn({pathname, search, hash, generation}) {
  if (!validGeneration(generation)) throw Error('返回版本无效');
  const route = workspaceNavigation(search, hash);
  if (route.personal) throw Error('返回地址必须是矩阵工作区');
  return Object.freeze({path: workspacePath(pathname, route.tab, search), generation});
}

/** Direct shares and stale/foreign state have no return context: caller uses the account directory. */
export function workspaceReturnPath(context, {pathname, generation}) {
  try {
    if (!context || typeof context !== 'object' || Array.isArray(context)
      || Object.keys(context).length !== 2 || !Object.hasOwn(context, 'path')
      || !Object.hasOwn(context, 'generation') || !validGeneration(generation)
      || context.generation !== generation || typeof context.path !== 'string'
      || context.path.length > 12000 || !context.path.startsWith('/')
      || context.path.startsWith('//') || /[\u0000-\u001f\u007f\\]/.test(context.path)) return null;
    const url = new URL(context.path, 'https://return.invalid');
    if (url.origin !== 'https://return.invalid' || url.pathname !== pathname) return null;
    const route = workspaceNavigation(url.search, url.hash);
    if (route.personal || workspacePath(pathname, route.tab, url.search) !== context.path) return null;
    return context.path;
  } catch { return null; }
}
