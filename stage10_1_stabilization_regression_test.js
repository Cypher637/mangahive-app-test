const fs=require('fs'), assert=require('assert');
const root=__dirname;
const html=fs.readFileSync(root+'/index.html','utf8');
const runtime=fs.readFileSync(root+'/android/mihon/src/main/java/app/mangahive/mihon/runtime/RuntimeEngine.kt','utf8');
const store=fs.readFileSync(root+'/android/mihon/src/main/java/app/mangahive/mihon/offline/OfflineDownloadJobStore.kt','utf8');
function ok(name,cond){assert.ok(cond,name);console.log('PASS: '+name)}
ok('download identity contains extension/source/remote chapter', /function stage10IdentityKey[\s\S]*canonicalMangaId,identity\.canonicalChapterId,identity\.extensionId,identity\.sourceId,identity\.remoteChapterId/.test(html));
ok('manifest validation requires source-qualified identity', /!m\.canonicalMangaId\|\|!m\.canonicalChapterId\|\|!m\.extensionId\|\|!m\.sourceId\|\|!m\.remoteChapterId/.test(html));
ok('fallback is explicitly opt-in', /var allowFallback=!!\(state\.settings&&state\.settings\.autoSourceFallback===true\)/.test(html));
ok('native Mihon downloads use native invoke', /mihonNativeInvoke\("download"/.test(html));
ok('native runtime downloads through broker', /downloadPageToFileWithRetry\(broker, req/.test(runtime));
ok('native offline jobs are persistent', /class OfflineDownloadJobStore/.test(store) && /jobs\.json/.test(store));
ok('offline policy checks age and NSFW mode', /function stage10PolicyDecision[\s\S]*AGE_RESTRICTED[\s\S]*NSFW_HIDDEN/.test(html));
ok('reader treats manifest as authoritative', /function stage10GetOfflineForReader[\s\S]*stage10ValidateManifest/.test(html));
ok('native source identity is checked on return', /INVALID_NATIVE_IDENTITY/.test(html));
ok('staging is cleared on failed web download', /stage10ClearStaging\(job,job\.total\|\|0\)/.test(html));
console.log('Stage 10.1 stabilization regression: PASS');
