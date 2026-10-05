// Stage 6 static gate. Source-level assertions for the layers the JVM harness cannot execute. Run: node mihon_stage6_resource_controls_test.js
const fs = require("fs"), path = require("path");
let pass = 0;
const ok = (c, m) => { if (!c) { console.error("FAIL: " + m); process.exit(1); } pass++; console.log("PASS: " + m); };
const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? (["build", "node_modules", ".git"].includes(e.name) ? [] : walk(path.join(d, e.name))) : [path.join(d, e.name)]);
const read = f => fs.readFileSync(f, "utf8");
const noc = t => t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const all = walk("android").filter(f => /\.(kt|java)$/.test(f));
const main = all.filter(f => !/\/(test|androidTest)\//.test(f));
const M = "android/mihon/src/main/java/app/mangahive/mihon/";
const N = "android/mihon-net/src/main/java/app/mangahive/mihon/net/";
const G = "android/mihon-compat/gateway/src/main/kotlin/app/mangahive/compat/gateway/";

// 1. streaming: no whole-body reads anywhere in the native network/runtime code
const bodyReaders = /\.readBytes\(\)|readAllBytes\s*\(|\.bytes\(\)|\.string\(\)|\.readText\(\)|toByteArray\(\)\s*\/\/\s*body|\.source\(\)\.readByteArray\(\)/;
// CompatBundleLocator / RuntimeProcessGate read small LOCAL files (a manifest, /proc/self/cmdline), not network responses.
const netFiles = main.filter(f => (/\/(network|apk|net|runtime)\//.test(f) || f.includes("BrokerInterceptor")) && !/CompatBundleLocator|RuntimeProcessGate/.test(f));
ok(netFiles.every(f => !bodyReaders.test(noc(read(f)))), "no bytes()/string()/readBytes()/readAllBytes() whole-body read in network, apk, net, runtime code: " + netFiles.filter(f => bodyReaders.test(noc(read(f)))).join(","));
const eng = noc(read(N + "BrokerEngine.java"));
ok(/BoundedStreams\.Body\(/.test(eng) && /declared > maxBody/.test(eng), "BrokerEngine wraps every delivered body in the bounded reader and refuses a declared oversize before reading");
const bs = noc(read(N + "BoundedStreams.java"));
ok(/\(max - total\) \+ 1L/.test(bs) && /total > max/.test(bs), "bounded reader never asks the wire for more than limit+1 bytes and throws on the first byte past the limit");
ok(/abortTransport\.run\(\)/.test(bs) && /scope\.isCancelled\(\)/.test(bs), "oversize/cancel aborts the transport (no drain); an abort can never read as a clean EOF");
const dl = noc(read(M + "apk/ApkDownloader.kt"));
ok(/maxBytes - total \+ 1/.test(dl) && /total > maxBytes/.test(dl) && !/AtomicBoolean/.test(dl), "APK download counts bytes per chunk, stops at the cap, and carries no AtomicBoolean cancel flag");
ok(/readBodyBounded/.test(read("index.html")) && !/res\.text\(\)|res\.json\(\)/.test(read("index.html").slice(read("index.html").indexOf("function extensionNetworkRequest"), read("index.html").indexOf("Build a controlled adapter from declarative engine config"))), "web extension HTTP reads through the streaming bounded reader");
const html = read("index.html");
const fj = html.slice(html.indexOf("function fetchJsonBounded"), html.indexOf("Strengthen extensionNetworkRequest"));
ok(!/res\.text\(\)|res\.json\(\)|res\.arrayBuffer\(\)/.test(fj), "web repository fetch has no text()/json() fallback (fails closed without a stream reader)");

// 2. one request id, no lower layer mints one
const idMint = /UUID\.randomUUID|Math\.random|"(?:web|m|c|h)-"\s*\+/;
const minters = main.filter(f => idMint.test(noc(read(f)))).map(f => path.basename(f)).sort();
ok(JSON.stringify(minters) === JSON.stringify(["MihonJsBridge.kt", "MihonServiceClient.kt", "WebRequestParser.kt"].sort()), "request ids are minted only at the top (bridge parser / cancel+health control messages), never in runtime, loader, gateway, network: " + minters.join(","));
ok(!/UUID|random/i.test(noc(read(N + "BrokerEngine.java")) + noc(read(N + "ActiveJobs.java")) + noc(read(G + "BrokerInterceptor.kt"))), "broker, job registry and interceptor mint no ids");
const wrp = noc(read(M + "bridge/WebRequestParser.kt"));
ok(/Rejected\("none", op, ErrorCode\.BAD_REQUEST\)/.test(wrp) && /IpcLimits\.REQUEST_ID\.matches\(rawId\)/.test(wrp), "a malformed web request id is refused, not replaced by another one");
ok(/Transport\.Request\(.*requestId, call\)/.test(eng.replace(/\n/g, " ")) && /b\.tag\(String::class\.java, r\.requestId\)/.test(read(M + "network/OkHttpTransport.kt")), "the request id reaches the transport and tags the OkHttp call");

// 3. job registry
const aj = noc(read(N + "ActiveJobs.java"));
ok(/ConcurrentHashMap<String, Job>/.test(aj) && /jobs\.remove\(requestId, this\)/.test(aj) && /compareAndSet\(State\.RUNNING/.test(aj), "ActiveJobs is requestId->Job with CAS terminal state and removal on every terminal path");
const disp = noc(read(M + "runtime/RuntimeDispatcher.kt"));
ok(/ActiveJobs/.test(disp) && !/ConcurrentHashMap/.test(disp) && !/ScheduledExecutorService/.test(disp), "dispatcher keeps no job table or watchdog of its own: the registry is the only one");
ok(/job\.tryComplete\(\)/.test(disp) && /job\.workerExited\(\)/.test(disp) && /future\.cancel\(true\)/.test(disp), "worker completion, worker exit and Future cancel are wired to the job");
ok(!/AtomicBoolean/.test(noc(read(M + "runtime/CancelToken.kt"))), "CancelToken is a view of the request's CancelScope, not an AtomicBoolean");
const svc = noc(read(M + "runtime/MihonExtensionService.kt"));
ok(/jobs\.cancelAll\(id, byRequest\)/.test(svc) && /governor\.clearExtension\(id\)/.test(svc), "uninstall aborts the extension's other in-flight work and forgets its limits");
ok(/val governor = ResourceGovernor\(\)/.test(svc) && /DefaultBrokerEngine\.create\(File\(filesDir, "mihon_cookies"\), policy, governor\)/.test(svc) && /ActiveJobs\(governor/.test(svc), "ONE governor shared by broker and job registry");

// 4. cancellation reaches the socket, not a flag
const sig = noc(read("android/mihon-spi/src/main/java/app/mangahive/mihon/spi/CancelSignal.java"));
ok(/Registration onCancel\(/.test(sig), "CancelSignal has abort callbacks (polling alone is not cancellation)");
ok(!all.some(f => /CancelSignal\s*\{\s*(call\.|cancelled\.get|f\.get)/.test(noc(read(f))) || /CancelSignal \{ call\.isCanceled/.test(read(f))), "no flag-polling CancelSignal lambda remains");
const okt = noc(read(M + "network/OkHttpTransport.kt"));
ok(/onCancel \{ call\.cancel\(\) \}/.test(okt) && /\{ call\.cancel\(\) \}/.test(okt), "OkHttp transport: cancel/timeout call Call.cancel() (socket closed); abort of a response cancels, not drains");
const bi = noc(read(G + "BrokerInterceptor.kt"));
ok(!/chain\.proceed/.test(bi) && /RequestScope\.current\(\) \?: throw BrokerException\("NO_REQUEST_CONTEXT"/.test(bi), "interceptor stays terminal and refuses an HTTP call with no current request (fail closed)");
ok(/override fun canceled\(call: Call\)/.test(bi) && /scope\.cancel\(CancelScope\.Reason\.CANCELLED\)|map\[call\]\?\.cancel/.test(bi), "a Source's own Call.cancel() aborts the brokered connection");
const rsg = noc(read(G + "RealSourceGateway.kt"));
ok(/RequestScope\.with\(hc\)/.test(rsg) && /RequestScope\.element\(hc\)/.test(rsg), "gateway makes the host-fixed call (identity + request) current for the Source call and its coroutines");
const bridge = noc(read(M + "bridge/MihonJsBridge.kt"));
ok(/fun mihonStart/.test(bridge) && /fun mihonCancel/.test(bridge) && /RuntimeRequest\.Cancel\(/.test(bridge), "bridge: start returns at once, cancel is a separate immediate call into the runtime");
ok(/native\.mihonCancel\(id\)/.test(html) && /signal\.addEventListener\("abort"/.test(html), "web AbortSignal -> mihonCancel(requestId)");
ok(/ThreadPoolExecutor\(4, 8/.test(bridge), "bridge threads are bounded");

// 5. limits
const gov = noc(read(N + "ResourceGovernor.java"));
ok(/CONCURRENCY_LIMIT/.test(gov) && /RATE_LIMITED/.test(gov) && /maxCallMs/.test(gov), "governor: concurrency, rate and timeout ceilings, per extension and per source");
ok(/governor\.admitCall\(scope\.extensionId, scope\.sourceId/.test(eng) && /lease\.hop\(call\)/.test(eng), "every brokered call is admitted per source+extension and every redirect hop takes a rate token");
ok(/deadlines\.after\(callMs/.test(eng) && /CancelScope\.Reason\.TIMEOUT/.test(eng), "call timeout cancels the call's scope (closes the socket)");

// 6. honesty
const st = read(M + "runtime/MihonRuntimeStatus.kt");
ok(/CANCEL_PATH_END_TO_END_DEVICE_VERIFIED\s*=\s*false/.test(st) && /SOURCE_EXECUTION_DEVICE_VERIFIED\s*=\s*false/.test(st), "no device-verified claim for the cancel path or source execution");
console.log(pass + " passed");
