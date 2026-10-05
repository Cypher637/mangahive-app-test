// App-shell cache only. Chapter images and third-party APIs stay on the
// network (or in IndexedDB after an explicit Save).
var CACHE = "fairs-library-shell-v76";
var SHELL_FILES = [
  "./",
  "./index.html",
  "./manifest.json",
  "./vendor-supabase.js",
  // Phase 1 / Stage 1 app-shell modules (code only: no chapter/API/page caching)
  "./src/domain/identity.js",
  "./src/domain/chapterOrder.js",
  "./src/domain/progress.js",
  "./src/domain/readerSession.js",
  "./src/services/libraryStore.js",
  "./src/domain/searchResult.js",
  "./src/services/discoverySearch.js",
  "./src/services/progressStore.js",
  "./src/services/startupCoordinator.js",
  "./icon-192.png",
  "./icon-512.png",
  "./icon-maskable-512.png"
];

function shellIndexRequest(){
  try{
    return new Request(new URL("index.html", self.registration.scope).href, { cache: "reload" });
  }catch(e){
    return new Request("./index.html");
  }
}

function precacheShell(cache){
  // addAll is all-or-nothing. Cache each file so one missing icon
  // does not abort the entire offline install.
  return Promise.all(SHELL_FILES.map(function(path){
    var req = new Request(path, { cache: "reload" });
    return fetch(req).then(function(res){
      if(!res || !res.ok) return;
      return cache.put(path, res);
    }).catch(function(){ /* skip missing optional assets */ });
  }));
}

function matchShell(request){
  return caches.open(CACHE).then(function(cache){
    return cache.match(request).then(function(hit){
      if(hit) return hit;
      return cache.match("./index.html").then(function(html){
        if(html) return html;
        return cache.match("./");
      });
    });
  });
}

self.addEventListener("install", function(event){
  event.waitUntil(
    caches.open(CACHE).then(precacheShell)
  );
});

self.addEventListener("message", function(event){
  if(event.data === "SKIP_WAITING") self.skipWaiting();
});

self.addEventListener("notificationclick", function(event){
  event.notification.close();
  var data = event.notification.data || {};
  var seriesId = data.seriesId;
  var chatId = data.chatId;
  var targetUrl = self.registration.scope + "index.html";
  if(seriesId) targetUrl += "?openSeries=" + encodeURIComponent(seriesId);
  else if(chatId) targetUrl += "?openChat=" + encodeURIComponent(chatId);
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(function(list){
      for(var i = 0; i < list.length; i++){
        var client = list[i];
        if("focus" in client){
          client.focus();
          if(seriesId && "postMessage" in client) client.postMessage({ type: "OPEN_SERIES", seriesId: seriesId });
          else if(chatId && "postMessage" in client) client.postMessage({ type: "OPEN_CHAT", chatId: chatId });
          return;
        }
      }
      if(self.clients.openWindow) return self.clients.openWindow(targetUrl);
    })
  );
});

self.addEventListener("activate", function(event){
  event.waitUntil(
    caches.keys().then(function(keys){
      // Only remove our own shell caches — never wipe unrelated PWAs on the same origin.
      return Promise.all(keys.filter(function(k){
        if(k === CACHE) return false;
        return /^(fairs-library-shell|mangahive-shell)-v\d+$/i.test(k);
      }).map(function(k){ return caches.delete(k); }));
    })
  );
  self.clients.claim();
});

// P2 FIX: the old fetch handler cached *any* successful same-origin GET,
// with no distinction between static shell files and dynamic data. That's
// fine for icons/JS, but this app lets you point mangpiBaseUrl /
// mangahookBaseUrl / mangadexProxyUrl at a same-origin path (e.g. your own
// Cloudflare Worker route living under the same domain as the PWA) --
// and those responses (search results, chapter lists) would silently get
// pulled into the offline cache and served stale on the next visit.
// Static assets: known shell files, or app code/font files with no query
// string. Everything else same-origin is treated as dynamic data and never
// touches the cache.
// Audit item 11: json and image extensions are deliberately NOT here. For a
// manga app a same-origin *.json is chapter/series data and a same-origin
// image is a chapter page, and this handler serves cached copies first, so
// listing them would show stale chapters after a source updates. The shell's
// own icons and manifest.json are still cached because they're listed in
// SHELL_FILES above.
var STATIC_EXT_RE = /\.(js|css|woff2?|ttf)$/i;
// Never store a response the server marked no-store/private, and only cache
// plain same-origin responses.
function isCacheableResponse(res){
  if(!res || !res.ok || res.type !== "basic") return false;
  var cc = res.headers && res.headers.get("Cache-Control");
  return !(cc && /no-store|private/i.test(cc));
}
function isStaticAssetRequest(url){
  if(url.search) return false; // query string almost always means dynamic data
  if(/\/api\//i.test(url.pathname)) return false; // proxy/API routes, even if same-origin
  if(SHELL_FILES.some(function(f){
    try{ return new URL(f, self.registration.scope).pathname === url.pathname; }catch(e){ return false; }
  })) return true;
  return STATIC_EXT_RE.test(url.pathname);
}

self.addEventListener("fetch", function(event){
  var request = event.request;
  if(request.method !== "GET") return;
  var url;
  try{ url = new URL(request.url); }catch(e){ return; }
  if(url.origin !== self.location.origin) return;

  var isNavigate = request.mode === "navigate" ||
    (request.destination === "document") ||
    /\/$/.test(url.pathname) ||
    /\/index\.html$/i.test(url.pathname);

  if(isNavigate){
    // Network first for HTML so a hosted update lands; cache if offline.
    event.respondWith(
      fetch(shellIndexRequest()).then(function(res){
        if(res && res.ok){
          var copy = res.clone();
          caches.open(CACHE).then(function(cache){
            cache.put("./index.html", copy.clone());
            cache.put("./", copy);
          });
        }
        return res;
      }).catch(function(){
        return matchShell(request).then(function(cached){
          return cached || new Response("MangaHive is offline and the app shell is not cached yet. Open it once while online.", {
            status: 503,
            headers: { "Content-Type": "text/plain; charset=utf-8" }
          });
        });
      })
    );
    return;
  }

  if(!isStaticAssetRequest(url)){
    // Dynamic same-origin request (API/proxy data): straight to the
    // network, never read from or written into the cache.
    return;
  }

  event.respondWith(
    // Network-first for executable/static assets: deployed JS/CSS should
    // update as soon as the network is available. If offline, fall back to
    // the last known-good cached asset. This avoids silently running stale
    // application code merely because the filename did not change.
    fetch(request).then(function(res){
      if(isCacheableResponse(res)){
        var copy = res.clone();
        caches.open(CACHE).then(function(cache){ cache.put(request, copy); });
      }
      return res;
    }).catch(function(){
      return caches.open(CACHE).then(function(cache){ return cache.match(request); });
    })
  );
});
