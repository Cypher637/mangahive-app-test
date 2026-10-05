/* MangaHive Phase 1 — Stage 8 final integration & freeze regression suite. */
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const root = path.resolve(__dirname, '../..');
const index = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

function ok(condition, message) {
  assert.ok(condition, message);
  console.log('PASS', message);
}

const files = [
  'src/domain/identity.js','src/domain/chapterOrder.js','src/domain/progress.js','src/domain/readerSession.js',
  'src/domain/chapterSystem.js','src/domain/readerKeyboard.js',
  'src/services/libraryStore.js','src/services/progressStore.js','src/domain/readingContinuity.js',
  'src/services/readerPageService.js','src/services/chapterService.js','src/services/startupCoordinator.js'
];
for (const f of files) ok(fs.existsSync(path.join(root, f)), `authoritative Phase 1 module exists: ${f}`);

ok(index.includes('ChapterService'), 'Details/chapter runtime references ChapterService');
ok(index.includes('ChapterSystem'), 'Chapter runtime references ChapterSystem');
ok(index.includes('ReaderSession'), 'Reader runtime references ReaderSession');
ok(index.includes('ReaderPageService'), 'Reader runtime references ReaderPageService');
ok(index.includes('ReadingContinuity'), 'Runtime references ReadingContinuity');
ok(index.includes('ProgressStore'), 'Runtime references ProgressStore');
ok(index.includes('openChapterInApp'), 'Explicit chapter handoff remains present');
ok(index.includes('resolveExplicitChapterOpen'), 'Explicit chapter open uses canonical continuity resolution');
ok(index.includes('resolveSeriesContinuity'), 'Continue Reading uses continuity resolution');
ok(index.includes('startupCoordinator'), 'Startup coordinator remains part of runtime');

// No-redirect audit: reject common source-navigation primitives in the reader path.
const redirectPatterns = [
  /window\.location\s*=\s*[^;]+source/i,
  /location\.(?:assign|replace)\([^)]*source/i,
  /window\.open\([^)]*source/i,
  /(?:read|open)[A-Za-z]*OnSource/i,
  /Read\s+on\s+source/i
];
for (const re of redirectPatterns) ok(!re.test(index), `no source redirect primitive matches ${re}`);
ok(index.includes('in-app') || index.includes('openChapterInApp'), 'In-app reading boundary remains explicit');

// Phase 1 runtime boundary must be enabled and future systems disabled.
ok(index.includes('mangahive-phase\" content=\"phase1-frozen\"'), 'Phase 1 freeze marker is present');
ok(index.includes('mangahive-phase-status\" content=\"frozen\"'), 'Phase 1 freeze status marker is present');
ok(index.includes('MangaHivePhase1Runtime'), 'Phase 1 runtime boundary exists');
ok(index.includes('enabled:true'), 'Phase 1 runtime boundary is enabled');
ok(index.includes('isFutureRoute:function'), 'Future routes are centrally guarded');
ok(index.includes('isFutureAction:function'), 'Future actions are centrally guarded');
ok(index.includes('if(window.MangaHivePhase1Runtime && !window.MangaHivePhase1Runtime.enabled)'), 'Future initialization is behind disabled-phase guard');

// Future services must not be directly script-loaded.
const scripts = [...index.matchAll(/<script\s+src="([^"]+)"/g)].map(m => m[1]);
const futureLoaded = scripts.filter(src => /social|extension|mihon|download|stage10/i.test(src));
ok(futureLoaded.length === 0, 'No future-phase service script is directly loaded by index.html');

// Service worker remains app-shell scoped.
const sw = fs.readFileSync(path.join(root, 'sw.js'), 'utf8');
ok(/addEventListener\(['"]install/.test(sw), 'Service worker install handler exists');
ok(/addEventListener\(['"]fetch/.test(sw), 'Service worker fetch handler exists');
ok(!/downloadChapter|downloadAllUnread|stage10/i.test(sw), 'Service worker does not implement future download runtime');

// Future navigation must stay inaccessible through the main dispatcher.
ok(index.includes('if(window.MangaHivePhase1Runtime && window.MangaHivePhase1Runtime.isFutureRoute(name))'), 'Programmatic future-route guard is active');
ok(index.includes('if(window.MangaHivePhase1Runtime && !window.MangaHivePhase1Runtime.guardAction(action)) return;'), 'Action dispatcher future-action guard is active');

// Phase 1 core entry points are still wired.
const required = [
  'nav-home','nav-library','nav-discover','discover-search','openSeriesFromNotificationLink',
  'refreshDetailsChapters','renderReader','continueReadingItems'
];
for (const name of required) ok(index.includes(name), `Phase 1 runtime entry point remains wired: ${name}`);

// Basic debug residue guard.
ok(!/debugger\s*;/.test(index), 'No debugger statements remain in the main runtime');

console.log('Stage 8 Integration: PASS');
