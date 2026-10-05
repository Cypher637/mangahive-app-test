const fs = require('fs');
const assert = require('assert');
const html = fs.readFileSync('index.html','utf8');
const sw = fs.readFileSync('sw.js','utf8');

function has(s, needle, msg){ assert(s.includes(needle), msg || `missing ${needle}`); }

has(html, 'indexedDB.open(DOWNLOAD_DB_NAME, 3)', 'download DB must be version 3');
for (const store of ['downloadJobs','downloadManifests','downloadMeta','downloadStaging'])
  has(html, `createObjectStore(\"${store}\"`, `missing ${store}`);

for (const fn of [
  'stage10RunDownloadJob','stage10RecoverJobs','stage10BuildManifest',
  'stage10ValidateManifest','stage10ImageProbe','stage10EnsureStorage',
  'stage10PauseDownload','stage10ResumeDownload','stage10ListJobs'
]) has(html, `function ${fn}`, `missing ${fn}`);

has(html, 'stage10SourceIdentity', 'downloads must record source identity');
has(html, 'remoteChapterId', 'download manifest must record remote chapter identity');
has(html, 'extensionId', 'download manifest must record extension identity');
has(html, 'SHA-256', 'manifest/integrity documentation should mention SHA-256');
has(html, 'STAGE10_MAX_PAGE_BYTES', 'page size limit missing');
has(html, 'STAGE10_MAX_PAGES', 'page count limit missing');
has(html, 'INSUFFICIENT_STORAGE', 'storage exhaustion classification missing');
has(html, 'POLICY_BLOCKED', 'policy blocking missing');
has(html, 'PAUSED', 'pause state missing');

// Downloaded content is not served as executable service-worker cache content.
has(sw, 'Dynamic same-origin request', 'service worker dynamic-cache boundary missing');
assert(!/cache\.put\(request, copy\)/.test(sw) || sw.includes('isStaticAssetRequest'), 'service worker must not globally cache arbitrary requests');

// Security primitives must remain absent from the PWA extension boundary.
assert(!/\beval\s*\(/.test(html), 'eval must remain absent');
assert(!/new\s+Function\s*\(/.test(html), 'new Function must remain absent');

console.log('Phase 10 download regression: PASS');
