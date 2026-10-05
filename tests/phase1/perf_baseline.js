'use strict';
// Stage 1 performance baseline. Run: node tests/phase1/perf_baseline.js
// Measures the pure/service code against an IN-MEMORY storage stand-in (no real IndexedDB, no browser),
// so it isolates serialization + store overhead only. It is a baseline for Stage 5/6 comparison, not a device number.
const { createMemoryStorage } = require('./helpers/memoryStorage.js');
const ls = require('../../src/services/libraryStore.js');
const ps = require('../../src/services/progressStore.js');
const rs = require('../../src/domain/readerSession.js');
const order = require('../../src/domain/chapterOrder.js');

function makeLibrary(nSeries, nChapters, nPages) {
  return { series: Array.from({ length: nSeries }, (_, i) => ({ id: 's' + i, canonicalId: 's' + i, title: 'Series ' + i, chapters: Array.from({ length: nChapters }, (_, j) => ({ id: 's' + i + 'c' + j, chapter: String(j + 1), pages: Array.from({ length: nPages }, (_, k) => 'https://cdn.example.invalid/' + i + '/' + j + '/' + k + '.jpg') })) })), progress: {}, bookmarks: {}, history: [] };
}
const median = (a) => a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)];
const t = () => Number(process.hrtime.bigint()) / 1e6;
async function time(n, fn) { const xs = []; for (let i = 0; i < n; i++) { const a = t(); await fn(i); xs.push(t() - a); } return { median: +median(xs).toFixed(3), max: +Math.max(...xs).toFixed(3), runs: n }; }

(async () => {
  const out = { node: process.version, note: 'in-memory storage stand-in; no IndexedDB, no browser', sizes: {} };
  for (const [name, dims] of [['small (20 series x 30 ch x 15 pages)', [20, 30, 15]], ['large (300 series x 80 ch x 25 pages)', [300, 80, 25]]]) {
    const lib = makeLibrary(...dims); const text = JSON.stringify(lib);
    const st = createMemoryStorage(); st.data.set('fairs-library-v1', text);
    const store = ls.createLibraryStore({ storage: st }); const prog = ps.createProgressStore({ storage: st });
    const r = { libraryBytes: text.length };
    r.libraryLoad = await time(5, () => ls.createLibraryStore({ storage: st }).loadLibrary());
    r.librarySave = await time(5, () => store.saveLibrary(lib));
    r.oldPerPageTurn_JSON_stringify_state = await time(20, () => JSON.stringify(lib).length);
    r.newPerPageTurn_progressUpdate = await time(200, (i) => prog.updateChapterProgress({ seriesId: 's1', chapterId: 's1c1', pageIndex: i % 25, pageCount: 25 }));
    r.newPerPageTurn_bytesWritten = prog.getMetrics().lastWriteBytes;
    r.hydrateLibraryProgress = await time(3, () => prog.hydrateLibraryProgress(JSON.parse(text)));
    r.sortChapters_80 = await time(50, () => order.sortChapters(lib.series[0].chapters));
    const s = lib.series[0], c = s.chapters[0];
    r.readerSessionCreate = await time(500, () => rs.createReaderSession({ series: s, chapter: c }));
    out.sizes[name] = r;
  }
  console.log(JSON.stringify(out, null, 2));
})();
