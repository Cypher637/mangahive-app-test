/* MangaHive Phase 1 — Stage 7C runtime/performance hardening regression suite. */
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const root = path.resolve(__dirname, '../..');
const index = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

function ok(condition, message) {
  assert.ok(condition, message);
  console.log('PASS', message);
}
function count(re) { return (index.match(re) || []).length; }

ok(index.includes('mangahive-phase" content="phase1-frozen"'), 'Final Phase 1 freeze marker supersedes the Stage 7C marker');
ok(index.includes('MangaHivePhase1Runtime'), 'Phase 1 runtime boundary is installed');
ok(index.includes('isFutureRoute:function'), 'Future routes have a central guard');
ok(index.includes('isFutureAction:function'), 'Future actions have a central guard');
ok(index.includes('MutationObserver(function(){'), 'Dynamic future-phase controls are scrubbed after render');
ok(index.includes('obs.observe(root, {childList:true, subtree:true})'), 'Runtime scrubber observes only child-list mutations');
ok(index.includes('stage10-install'), 'Stage 10 installer remains present for later phases');
ok(index.includes('if(window.MangaHivePhase1Runtime && !window.MangaHivePhase1Runtime.enabled)'), 'Future-phase initializer calls are disabled in Phase 1');
ok(!/socialLoad\(\);\s*\n\s*startPresence\(\);\s*\n\s*try\{ updateBackendStatus\(\)/.test(index), 'Social/presence/backend polling is not initialized as a Phase 1 startup chain');
ok(!/refreshDownloadedIndex\(\);\s*\n\s*\}\)\.then\(function\(\)\{ startAutoSync\(\)/.test(index), 'Download index/autosync is not initialized during Phase 1 startup');
ok(index.includes('if(window.MangaHivePhase1Runtime && window.MangaHivePhase1Runtime.isFutureRoute(name))'), 'Programmatic navigation is future-route safe');
ok(index.includes('if(window.MangaHivePhase1Runtime && !window.MangaHivePhase1Runtime.guardAction(action)) return;'), 'Main action delegation is future-action safe');
ok(count(/data-action="nav-community"/g) >= 1, 'Community controls remain identifiable for later-phase builds');
ok(index.includes('hidden aria-hidden="true" tabindex="-1"'), 'Community tab is not exposed in the Phase 1 primary navigation');
ok(index.includes('var TAB_ORDER = ["home", "library", "discover", "profile"];'), 'Gesture navigation excludes future community/DM tabs');
ok(index.includes("'[data-action^=\"social-\"]'"), 'Social controls are removed from dynamically rendered Phase 1 UI');
ok(index.includes("'[data-action^=\"mihon-\"]'"), 'Mihon controls are removed from dynamically rendered Phase 1 UI');
ok(index.includes("'[data-action^=\"ext-\"]'"), 'Extension controls are removed from dynamically rendered Phase 1 UI');
ok(index.includes("'[data-action=\"open-downloads\"]'"), 'Download controls are removed from dynamically rendered Phase 1 UI');
ok(!index.includes('"add-github-repo":1'), 'Existing Phase 1 repository import is not blanket-blocked by the future-phase action guard');
ok(index.includes('openSeriesFromNotificationLink();'), 'Phase 1 series deep-link handling remains enabled');

// Runtime files loaded by the Phase 1 HTML must stay limited to the established
// domain/service surface. Future services may exist on disk but cannot be script-loaded here.
const loadedScripts = [...index.matchAll(/<script\s+src="([^"]+)"/g)].map(m => m[1]);
const futureLoaded = loadedScripts.filter(src => /social|extension|mihon|download|stage10/i.test(src));
ok(futureLoaded.length === 0, 'No future-phase service/extension/Mihon/download script is directly loaded by index.html');

// Basic runtime hygiene guards.
ok(!/setInterval\(updateBackendStatus,\s*8000\)/.test(index), 'Backend polling interval is not created by the Phase 1 runtime');
ok(index.includes('if(window.MangaHivePhase1Runtime && !window.MangaHivePhase1Runtime.enabled){\n      bkInitialSync();'), 'Community realtime sync is guarded behind the disabled future-phase branch');
ok(index.includes('if(window.MangaHivePhase1Runtime && !window.MangaHivePhase1Runtime.enabled) {\n    socialLoad(); startPresence();\n  }'), 'Social presence startup calls are guarded behind a disabled future-phase branch');
ok(index.includes('navigator.serviceWorker.register("sw.js"'), 'Service worker remains available for app-shell behavior');

console.log('Stage 7C: PASS');
