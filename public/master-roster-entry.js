import { mountMasterRoster } from './master-roster.js?v=20261010-jupiter-workspace-2';

const host = document.getElementById('masterRosterHost');
const view = document.getElementById('accountsView');
let controller = null, bridge = null;
let pendingOpen = null;

function openRequestedSearch() {
  if (!controller || !pendingOpen || view?.hidden || document.hidden) return;
  const options = pendingOpen; pendingOpen = null;
  void controller.openSearch(options);
}

function mountWhenVisible() {
  if (!host || !view || view.hidden || document.hidden) return;
  if (controller) { void controller.requestRefresh(); openRequestedSearch(); return; }
  controller = mountMasterRoster({
    host,
    isVisible: () => !view.hidden && !document.hidden,
    api: (...args) => {
      if (typeof bridge?.api !== 'function') return Promise.reject(new Error('登录状态尚未就绪，请稍后重试。'));
      return bridge.api(...args);
    },
    canEdit: () => bridge?.canEdit?.() === true,
    onOpenAccount: (id, context) => document.dispatchEvent(new CustomEvent('mcn:open-account', {
      detail: { id, trigger: context?.trigger },
    })),
  });
  openRequestedSearch();
}

document.addEventListener('mcn:master-roster-bind', event => {
  if (typeof event.detail?.api !== 'function' || typeof event.detail?.canEdit !== 'function') return;
  bridge = event.detail; controller?.syncRole(); mountWhenVisible();
});
document.addEventListener('mcn:works-settings-session', () => controller?.syncRole());
document.addEventListener('mcn:master-roster-refresh', event => {
  if (controller) void controller.requestRefresh({ force: event.detail?.force === true });
});
document.addEventListener('mcn:master-roster-open', event => {
  pendingOpen = { query: typeof event.detail?.query === 'string' ? event.detail.query : '',
    theme: typeof event.detail?.theme === 'string' ? event.detail.theme : 'all',
    ...(typeof event.detail?.entryKey === 'string' ? { entryKey:event.detail.entryKey,platform:event.detail.platform,submittedId:event.detail.submittedId } : {}) };
  mountWhenVisible();
});
document.addEventListener('mcn:master-roster-activate', event => {
  mountWhenVisible();
  if (controller) void controller.activate({ focusSearch: event.detail?.focusSearch === true });
});
document.addEventListener('mcn:account-mode-change', mountWhenVisible);
document.addEventListener('visibilitychange', mountWhenVisible);
document.dispatchEvent(new CustomEvent('mcn:master-roster-ready'));
if (host && view && typeof MutationObserver !== 'undefined') {
  new MutationObserver(mountWhenVisible).observe(view, { attributes: true, attributeFilter: ['hidden'] });
}
mountWhenVisible();
