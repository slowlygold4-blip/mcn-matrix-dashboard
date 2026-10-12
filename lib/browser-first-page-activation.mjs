import { withBrowserAccessGate, sanitizeBrowserAccessGateObservation } from './browser-access-gate.mjs';

/** A fixed structural projection, not a works parser. Runs in the current main document. */
export const observeFirstPageActivation = withBrowserAccessGate(function observeFirstPageActivation({ secUid, trackScrollId, observeControls = false } = {}) {
  /* MCN_FIXED_ACCESS_GATE */
  // Counts describe only the bounded selector/ancestor checks below; null
  // means that stage was not reached. 9 means the existing 8-region cap.
  const structure = { reason: "not-eligible", regionCount: null, visibleRegionCount: null, leafRegionCount: null, ancestorCount: null };
  const no = (reason, detail = reason) => { structure.reason = detail; return { eligible: false, reason, structure }; };
  try {
    const url = new URL(location.href);
    if (url.origin !== "https://www.douyin.com" || url.username || url.password
      || ![`/user/${secUid}`, `/user/${secUid}/`].includes(url.pathname)
      || !["interactive", "complete"].includes(document.readyState)) return no("not-eligible");
    const width = window.innerWidth, height = window.innerHeight;
    if (!(width > 0 && height > 0)) return no("not-eligible");
    const visible = node => {
      const style = getComputedStyle(node), rect = node.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && style.visibility !== "collapse"
        && Number(style.opacity) !== 0 && rect.width > 0 && rect.height > 0
        && rect.right > 0 && rect.bottom > 0 && rect.left < width && rect.top < height;
    };
    // Never dismiss a dialog or interact with a login/verification gate.
    const gate = observeBrowserAccessGate();
    if (gate.observation.candidateCount > 0 || gate.blocked) structure.gates = gate.observation;
    if (gate.blocked) return no("blocked", gate.observation.decision === 'limit' ? 'gate-limit' : 'visible-gate');
    // Passive, bounded semantic evidence only. A missing/unselected control
    // never authorises a click, request, wheel, or acceptance of works data.
    // Do not read whole subtrees or retain labels, attributes, nodes or URLs.
    if (observeControls === true) {
      const empty = observation => ({ version: 1, attribution: "controls-structure-not-works-evidence", observation,
        candidateCount: null, labelUnavailableCount: null, worksControlCount: null, visibleWorksControlCount: null,
        selectedWorksControlCount: null, unselectedWorksControlCount: null, unknownSelectionWorksControlCount: null });
      structure.controls = empty("unavailable");
      try {
        const nodes = document.querySelectorAll('[role="tab"],button,[role="button"]');
        if (nodes.length > 80) structure.controls = { ...empty("over-limit"), candidateCount: 81 };
        else {
          const controls = { ...empty("observed"), candidateCount: nodes.length, labelUnavailableCount: 0,
            worksControlCount: 0, visibleWorksControlCount: 0, selectedWorksControlCount: 0,
            unselectedWorksControlCount: 0, unknownSelectionWorksControlCount: 0 };
          const shortLabel = node => {
            const label = node.getAttribute("aria-label");
            if (label !== null) return label.length <= 96 ? label.trim() : null;
            const walker = document.createTreeWalker(node, 4); // SHOW_TEXT, never input values.
            let text = "", part, visited = 0;
            while ((part = walker.nextNode())) {
              if (++visited > 24 || typeof part.nodeValue !== "string" || part.nodeValue.length > 96
                || text.length + part.nodeValue.length > 96) return null;
              text += part.nodeValue;
            }
            return text.trim();
          };
          for (const node of nodes) {
            let label;
            try { label = shortLabel(node); } catch { label = null; }
            if (label === null) { controls.labelUnavailableCount++; continue; }
            if (!/^作品(?:\s*[（(]?\s*[\d,.万亿]+\s*[）)]?)?$/u.test(label)) continue;
            controls.worksControlCount++;
            if (visible(node)) controls.visibleWorksControlCount++;
            const selected = node.getAttribute("aria-selected");
            if (selected === "true") controls.selectedWorksControlCount++;
            else if (selected === "false") controls.unselectedWorksControlCount++;
            else controls.unknownSelectionWorksControlCount++;
          }
          structure.controls = controls;
        }
      } catch { /* Unknown markup is diagnostic uncertainty, not an action gate. */ }
    }
    const regions = document.querySelectorAll('[data-e2e="user-post-list"],[data-e2e="user-post-item-list"]');
    structure.regionCount = Math.min(9, regions.length);
    if (regions.length > 8) return no("no-container", "region-limit");
    const candidates = [];
    for (const region of regions) if (visible(region)) candidates.push(region);
    structure.visibleRegionCount = candidates.length;
    // Nested list wrappers describe one region; unrelated visible lists are ambiguous.
    const leaves = candidates.filter(node => !candidates.some(other => other !== node && node.contains(other)));
    structure.leafRegionCount = leaves.length;
    if (leaves.length !== 1) return no("no-container", !regions.length ? "region-absent" : !candidates.length ? "region-not-visible" : "region-ambiguous");
    const region = leaves[0];
    let scroller = null, ancestor = region;
    structure.ancestorCount = 0;
    for (let i = 0; ancestor && i < 12; i++, ancestor = ancestor.parentElement) {
      structure.ancestorCount++;
      const style = getComputedStyle(ancestor);
      if (ancestor.scrollHeight > ancestor.clientHeight + 1 && /^(auto|scroll)$/.test(style.overflowY)) { scroller = ancestor; break; }
    }
    if (!scroller) {
      const root = document.scrollingElement;
      if (root && root.scrollHeight > root.clientHeight + 1) scroller = root;
    }
    if (!scroller) return no("no-container", "not-scrollable");
    // Optional, attempt-private geometry. DOM identity is not a data source and
    // is never included in canonical works or persisted diagnostics. The random
    // namespace and WeakMap live only in this document, not in the site session.
    let scroll = null;
    if (typeof trackScrollId === "string" && /^[a-f0-9-]{36}$/.test(trackScrollId)) {
      const top = scroller.scrollTop, clientHeight = scroller.clientHeight, scrollHeight = scroller.scrollHeight;
      if (![top, clientHeight, scrollHeight].every(n => Number.isFinite(n) && n >= 0 && n <= 100_000_000)
        || clientHeight <= 0 || scrollHeight <= clientHeight || top > scrollHeight - clientHeight + 1) return no("not-eligible", "projection-error");
      const key = Symbol.for(`mcn:works-scroll:${trackScrollId}`);
      if (!Object.prototype.hasOwnProperty.call(document, key))
        Object.defineProperty(document, key, { value: { owners: new WeakMap(), next: 1 }, configurable: true });
      const registry = document[key];
      if (!(registry?.owners instanceof WeakMap) || !Number.isSafeInteger(registry.next) || registry.next < 1 || registry.next > 65)
        return no("not-eligible", "projection-error");
      if (!registry.owners.has(scroller)) {
        if (registry.next > 64) return no("not-eligible", "projection-error");
        registry.owners.set(scroller, registry.next++);
      }
      scroll = { ownerId: registry.owners.get(scroller), top, clientHeight, scrollHeight,
        remaining: Math.max(0, scrollHeight - clientHeight - top) };
    }
    if (scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 1)
      return { ...no("no-container", "at-bottom"), ...(scroll ? { scroll } : {}) };
    const rect = region.getBoundingClientRect();
    const bounds = scroller === document.scrollingElement ? { left: 0, top: 0, right: width, bottom: height } : scroller.getBoundingClientRect();
    const left = Math.max(0, rect.left, bounds.left), right = Math.min(width, rect.right, bounds.right);
    const top = Math.max(0, rect.top, bounds.top), bottom = Math.min(height, rect.bottom, bounds.bottom);
    if (right - left < 8 || bottom - top < 8) return no("no-container", "small-area");
    const x = Math.floor((left + right) / 2), y = Math.floor((top + bottom) / 2);
    const hit = document.elementFromPoint(x, y);
    if (!hit || !(hit === region || region.contains(hit))) return no("blocked", "occluded");
    structure.reason = "eligible";
    return { eligible: true, x, y, deltaY: Math.floor(Math.min(800, Math.max(200, height * 0.75))), structure,
      ...(scroll ? { scroll } : {}) };
  } catch { return no("not-eligible", "projection-error"); }
});

const STRUCTURE_REASONS = new Set(["eligible", "not-eligible", "gate-limit", "visible-gate", "region-limit", "region-absent",
  "region-not-visible", "region-ambiguous", "not-scrollable", "at-bottom", "small-area", "occluded", "projection-error"]);
/** Called on browser projection ingress AND diagnostic egress; never retain coordinates or raw data. */
export function sanitizeFirstPageActivationStructure(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const count = (input, max) => Number.isSafeInteger(input) && input >= 0 && input <= max ? input : null;
  const controls = sanitizeFirstPageControlsStructure(value.controls);
  const gates = sanitizeBrowserAccessGateObservation(value.gates);
  return { reason: STRUCTURE_REASONS.has(value.reason) ? value.reason : "not-eligible",
    regionCount: count(value.regionCount, 9), visibleRegionCount: count(value.visibleRegionCount, 8),
    leafRegionCount: count(value.leafRegionCount, 8), ancestorCount: count(value.ancestorCount, 12),
    ...(controls ? { controls } : {}), ...(gates ? { gates } : {}) };
}

/** Optional only: old records retain their exact canonical shape. No raw labels. */
export function sanitizeFirstPageControlsStructure(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.version !== 1
    || value.attribution !== "controls-structure-not-works-evidence") return null;
  const observation = ["observed", "over-limit", "unavailable"].includes(value.observation) ? value.observation : "unavailable";
  const count = (input, max = 80) => Number.isSafeInteger(input) && input >= 0 && input <= max ? input : null;
  const keys = ["labelUnavailableCount", "worksControlCount", "visibleWorksControlCount", "selectedWorksControlCount",
    "unselectedWorksControlCount", "unknownSelectionWorksControlCount"];
  const counts = Object.fromEntries(keys.map(key => [key, observation === "observed" ? count(value[key]) : null]));
  const candidateCount = observation === "observed" ? count(value.candidateCount) : null;
  if (observation === "over-limit" && value.candidateCount !== 81) return null;
  if (observation === "observed" && (candidateCount === null || Object.values(counts).some(n => n === null)
    || counts.worksControlCount + counts.labelUnavailableCount > candidateCount
    || counts.visibleWorksControlCount > counts.worksControlCount
    || counts.selectedWorksControlCount + counts.unselectedWorksControlCount + counts.unknownSelectionWorksControlCount !== counts.worksControlCount)) return null;
  return { version: 1, attribution: "controls-structure-not-works-evidence", observation,
    candidateCount: observation === "over-limit" ? 81 : candidateCount,
    ...counts };
}
