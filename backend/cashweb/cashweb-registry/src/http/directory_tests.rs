use super::*;
use crate::{
    directory_runtime::*, disabled_chain_adapter::DisabledChainAdapter, registry::Registry,
    store::db::Db,
};
use axum::body::Body;
use bitcoinsuite_core::Net;
use cashweb_config::{DirectoryConf, DirectoryPrincipalConf};
use serde_json::Value;
use tower::ServiceExt;
fn source() -> Value {
    serde_json::from_str(include_str!(
        "../../../../../docs/protocol/proposals/suite1-directory/vectors.json"
    ))
    .unwrap()
}
pub(crate) fn record(id: &str) -> Value {
    source()["records"]
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["id"] == id)
        .unwrap()
        .clone()
}
pub(crate) fn setup(root: &std::path::Path) -> (Arc<Registry>, DirectoryConf) {
    std::fs::create_dir(root.join("bundle")).unwrap();
    std::fs::write(root.join("clock"), "1700000100000000000\n").unwrap();
    let registry = Arc::new(Registry::new(
        Db::open(root.join("db")).unwrap(),
        Arc::new(DisabledChainAdapter),
        Net::Regtest,
    ));
    let config = DirectoryConf {
        clock_file: root.join("clock"),
        principals: vec![DirectoryPrincipalConf {
            network: "monad-testnet".into(),
            subject: "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798".into(),
            revision_zero: record("bootstrap")["t1"].as_str().unwrap().into(),
            manifest_identity: "00".repeat(32),
            relay_id: "000102030405060708090a0b0c0d0e0f".into(),
            relay_identity: "02e493dbf1c10d80f3581e4904930b1404cc6c13900ee0758474fa94abe8c4cd13"
                .into(),
            endpoint: "https://relay.example.invalid".into(),
            binding_expiry_ns: "1700007200000000000".into(),
            continuity_file: root.join("continuity"),
            bundle_root: root.join("bundle"),
            mode: "new".into(),
        }],
    };
    (registry, config)
}
async fn request(
    router: Router,
    method: &str,
    path: &str,
    bytes: Vec<u8>,
    media: &str,
) -> (StatusCode, HeaderMap, Vec<u8>) {
    let response = router
        .oneshot(
            axum::http::Request::builder()
                .method(method)
                .uri(path)
                .header(header::CONTENT_TYPE, media)
                .body(Body::from(bytes))
                .unwrap(),
        )
        .await
        .unwrap();
    let (status, headers) = (response.status(), response.headers().clone());
    let body = hyper::body::to_bytes(response.into_body())
        .await
        .unwrap()
        .to_vec();
    (status, headers, body)
}
#[tokio::test]
async fn exact_http_admission_duplicate_history_and_authenticated_reopen() {
    let root = tempfile::tempdir().unwrap();
    let (registry, mut config) = setup(root.path());
    let (runtime, ready) =
        DirectoryRuntime::start(registry.clone(), root.path().join("db"), config.clone()).unwrap();
    ready.await.unwrap().unwrap();
    let path = format!(
        "/directory/v1/{}/{}/head",
        config.principals[0].network, config.principals[0].subject
    );
    let routes = router(Arc::new(runtime.clone()));
    let original = hex::decode(record("bootstrap")["type2_hex"].as_str().unwrap()).unwrap();
    let result = request(routes.clone(), "PUT", &path, original.clone(), MEDIA).await;
    assert_eq!(result.0, StatusCode::OK);
    assert_eq!(result.2, original);
    assert_eq!(result.1["x-frank-directory-evidence"], "fresh-current");
    let renew = hex::decode(record("renew")["type2_hex"].as_str().unwrap()).unwrap();
    let result = request(routes.clone(), "PUT", &path, renew.clone(), MEDIA).await;
    assert_eq!(result.0, StatusCode::OK);
    let duplicate = request(routes.clone(), "PUT", &path, original.clone(), MEDIA).await;
    assert_eq!(duplicate.0, StatusCode::OK);
    assert_eq!(duplicate.2, renew);
    let history = path.trim_end_matches("head").to_owned()
        + "statements/"
        + record("bootstrap")["t1"].as_str().unwrap();
    let result = request(routes.clone(), "GET", &history, vec![], MEDIA).await;
    assert_eq!(result.2, original);
    assert_eq!(result.1["x-frank-directory-evidence"], "historical");
    assert_eq!(
        request(
            routes.clone(),
            "PUT",
            &path,
            original.clone(),
            "application/json"
        )
        .await
        .0,
        StatusCode::UNSUPPORTED_MEDIA_TYPE
    );
    assert_eq!(
        request(
            routes.clone(),
            "GET",
            &path.replace(
                &config.principals[0].subject,
                &("02".to_owned() + &"00".repeat(32))
            ),
            vec![],
            MEDIA
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
    runtime.begin_shutdown();
    runtime.wait_stopped().await;
    drop(routes);
    drop(runtime);
    config.principals[0].mode = "reopen".into();
    let (reopened, ready) =
        DirectoryRuntime::start(registry.clone(), root.path().join("db"), config.clone()).unwrap();
    ready.await.unwrap().unwrap();
    let response = request(
        router(Arc::new(reopened.clone())),
        "GET",
        &path,
        vec![],
        MEDIA,
    )
    .await;
    assert_eq!(response.2, renew);
    reopened.begin_shutdown();
    reopened.wait_stopped().await;
    drop(reopened);
    std::fs::remove_file(&config.principals[0].continuity_file).unwrap();
    let (failed, ready) =
        DirectoryRuntime::start(registry, root.path().join("db"), config).unwrap();
    assert_eq!(ready.await.unwrap(), Err(RuntimeError::Trust));
    failed.wait_stopped().await;
}
#[tokio::test]
async fn http_reserves_before_body_and_bounds_collection_without_starting_native_work() {
    let root = tempfile::tempdir().unwrap();
    let (registry, config) = setup(root.path());
    let (runtime, ready) =
        DirectoryRuntime::start(registry, root.path().join("db"), config.clone()).unwrap();
    ready.await.unwrap().unwrap();
    let c = &config.principals[0];
    let path = format!("/directory/v1/{}/{}/head", c.network, c.subject);
    let routes = router(Arc::new(runtime.clone()));
    let mut held = Vec::new();
    for _ in 0..8 {
        held.push(runtime.reserve(&c.network, &c.subject).unwrap());
    }
    // A never-ending body cannot consume a ninth slot or postpone overload rejection.
    let (_sender, body) = Body::channel();
    let response = tokio::time::timeout(
        Duration::from_millis(100),
        routes.clone().oneshot(
            axum::http::Request::builder()
                .method("PUT")
                .uri(&path)
                .header(header::CONTENT_TYPE, MEDIA)
                .body(body)
                .unwrap(),
        ),
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(response.status(), StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(
        response.headers()["x-frank-directory-disposition"],
        "not-started"
    );
    drop(held);
    let oversized = request(
        routes.clone(),
        "PUT",
        &path,
        vec![0; crate::directory_admission::MAX_FRAME_BYTES + 1],
        MEDIA,
    )
    .await;
    assert_eq!(oversized.0, StatusCode::TOO_MANY_REQUESTS);
    assert!(!c.continuity_file.exists());
    let (_sender, body) = Body::channel();
    let response = routes
        .oneshot(
            axum::http::Request::builder()
                .method("PUT")
                .uri(&path)
                .header(header::CONTENT_TYPE, MEDIA)
                .body(body)
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(
        response.headers()["x-frank-directory-disposition"],
        "not-started"
    );
    assert!(!c.continuity_file.exists());
    runtime.begin_shutdown();
    runtime.wait_stopped().await;
}
#[tokio::test]
async fn startup_does_not_substitute_for_missing_operator_clock() {
    let root = tempfile::tempdir().unwrap();
    let (registry, mut config) = setup(root.path());
    std::fs::remove_file(&config.clock_file).unwrap();
    let (runtime, ready) =
        DirectoryRuntime::start(registry, root.path().join("db"), config.clone()).unwrap();
    assert_eq!(ready.await.unwrap(), Err(RuntimeError::Trust));
    runtime.wait_stopped().await;
    config.principals[0].mode = "reopen".into();
}

#[tokio::test]
async fn real_http_socket_exact_bytes_and_expired_current_never_promote_history() {
    let root = tempfile::tempdir().unwrap();
    let (registry, config) = setup(root.path());
    let (runtime, ready) =
        DirectoryRuntime::start(registry, root.path().join("db"), config.clone()).unwrap();
    ready.await.unwrap().unwrap();
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let address = listener.local_addr().unwrap();
    let (stop, stopped) = tokio::sync::oneshot::channel::<()>();
    let server = axum::Server::from_tcp(listener)
        .unwrap()
        .serve(router(Arc::new(runtime.clone())).into_make_service())
        .with_graceful_shutdown(async {
            let _ = stopped.await;
        });
    let server = tokio::spawn(server);
    let c = &config.principals[0];
    let path = format!(
        "http://{address}/directory/v1/{}/{}/head",
        c.network, c.subject
    );
    let client = reqwest::Client::new();
    let original = hex::decode(record("bootstrap")["type2_hex"].as_str().unwrap()).unwrap();
    let put = client
        .put(&path)
        .header("content-type", MEDIA)
        .body(original.clone())
        .send()
        .await
        .unwrap();
    assert_eq!(put.status().as_u16(), 200);
    assert_eq!(put.bytes().await.unwrap().as_ref(), original);
    let get = client.get(&path).send().await.unwrap();
    assert_eq!(get.headers()["x-frank-directory-evidence"], "fresh-current");
    assert_eq!(get.bytes().await.unwrap().as_ref(), original);
    std::fs::write(&config.clock_file, "1800000000000000000\n").unwrap();
    assert_eq!(
        client.get(&path).send().await.unwrap().status().as_u16(),
        409
    );
    let history = path.trim_end_matches("head").to_owned()
        + "statements/"
        + record("bootstrap")["t1"].as_str().unwrap();
    let history = client.get(history).send().await.unwrap();
    assert_eq!(history.status().as_u16(), 200);
    assert_eq!(
        history.headers()["x-frank-directory-evidence"],
        "historical"
    );
    assert_eq!(history.bytes().await.unwrap().as_ref(), original);
    stop.send(()).unwrap();
    server.await.unwrap().unwrap();
    runtime.begin_shutdown();
    runtime.wait_stopped().await;
}

// This child uses actual reviewed provisioning/TLS material, public TS admission and the new
// client against a real Rust socket. All scalars and funds are disposable public fixtures.
const NODE_STAGE_A: &str = r#"
const path=require('node:path'),fs=require('node:fs'),net=require('node:net'),https=require('node:https'),tls=require('node:tls'),crypto=require('node:crypto');
const [repo,root,mode,backend]=process.argv.slice(2);const load=p=>require(path.join(repo,p));
const codec=load('packages/frank-codec/src/index.ts'),{SigningKey}=require(require.resolve('ethers',{paths:[repo]}));
const provision=load('packages/bot/demo/directory-trust/provision.ts');
async function main(){
 if(mode==='prepare'){
  const server=net.createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;await new Promise(r=>server.close(r));
  const source=JSON.parse(fs.readFileSync(path.join(repo,'docs/protocol/proposals/suite1-directory/vectors.json')));const record=source.records.find(r=>r.id==='bootstrap');
  const payload=new Map(codec.validateFrame(codec.fromHex(record.type4_hex),codec.previewDirectoryContext()).payload);
  const subject=codec.toHex(payload.get(1n).get(1n)),endpoint='https://127.0.0.1:'+port;
  const trust={network:'monad-testnet',subject,rev0T1:'00'.repeat(32),relayId:'000102030405060708090a0b0c0d0e0f',relayIdentity:{keyType:1,point:subject},endpoint,bindingExpiryNs:1700007200000000000n};
  payload.set(4n,[new Map([[0n,codec.fromHex(trust.relayId)],[1n,endpoint],[2n,new Map([[0n,1n],[1n,codec.fromHex(subject)]])],[3n,new Map([[0n,1700007200n],[1n,0n]])]])]);
  const statement=codec.encodeFrame({typeId:4,schemaVersion:4,minReaderVersion:4},payload);const signature=new SigningKey('0x'+'1'.padStart(64,'0')).sign('0x'+codec.toHex(codec.directorySignatureDigest(trust.network,statement)));
  const integer=h=>{let b=Buffer.from(h.slice(2),'hex');while(b.length>1&&b[0]===0)b=b.subarray(1);if(b[0]&128)b=Buffer.concat([Buffer.from([0]),b]);return Buffer.concat([Buffer.from([2,b.length]),b]);};const pair=Buffer.concat([integer(signature.r),integer(signature.s)]),der=Buffer.concat([Buffer.from([48,pair.length]),pair]);
  const attestation=codec.encodeFrame({typeId:2,schemaVersion:1,minReaderVersion:1},new Map([[0n,statement],[1n,[new Map([[0n,1n],[1n,payload.get(1n)],[2n,der]])]]]));
  trust.rev0T1=codec.toHex(codec.contentHash(codec.validateFrame(statement,codec.previewDirectoryContext())));
  const bundle=provision.initBundle({mode:'synthetic-demo',runDir:path.join(root,'directory-trust-stagea'),trustInputs:trust,nowNs:1700000100000000000n,witnessHex:codec.toHex(attestation)});
  fs.writeFileSync(path.join(root,'clock'),'1700000100000000000\n');fs.writeFileSync(path.join(root,'bundle.json'),JSON.stringify({...bundle,trustInputs:provision.trustJSON(trust)}));
  fs.writeFileSync(path.join(root,'native.json'),JSON.stringify({clock_file:path.join(root,'clock'),principals:[{network:trust.network,subject,revision_zero:trust.rev0T1,manifest_identity:bundle.manifestIdentity,relay_id:trust.relayId,relay_identity:subject,endpoint,binding_expiry_ns:String(trust.bindingExpiryNs),continuity_file:path.join(root,'native-continuity'),bundle_root:bundle.runDir,mode:'new'}]}));return;
 }
 const raw=JSON.parse(fs.readFileSync(path.join(root,'bundle.json'))),trust=provision.parseTrust(raw.trustInputs),bundle=provision.reopenBundle(raw,1700000100000000000n);
 const {startDirectoryRouteTransport}=load('packages/bot/demo/demo.ts');let browser,session,driver,browserScript,front,store,agent;
 try {
 if(process.env.DIRECTORY_ADMISSION_CHROMIUM){
  const file=path.join(repo,'packages/bot/demo/directory-trust/check-admission-browser.cjs'),Module=require('node:module');driver=new Module(file,module);driver.filename=file;driver.paths=Module._nodeModulePaths(path.dirname(file));const source=fs.readFileSync(file,'utf8');driver._compile(source.slice(0,source.lastIndexOf('main().catch(error => {'))+'module.exports={launch,stop,page};',file);driver=driver.exports;
  const {startFixture,checkNode}=load('packages/bot/demo/directory-trust/https-fixture.ts');const fixture=await startFixture(bundle,1700000100000000000n);
  try{await checkNode(bundle,1700000100000000000n);browser=await driver.launch(process.env.DIRECTORY_ADMISSION_CHROMIUM,path.join(root,'stagea-chrome'),bundle.tls.leafSpkiSha256);
   const build=await require(require.resolve('esbuild',{paths:[repo]})).build({stdin:{contents:`export {openBrowserDirectoryStore} from '@frank/directory-admission/browser'; export {createDirectoryClient} from './packages/cashweb/relay/directory-client.ts'; export {admissionAnchor,admissionContext,continuityJSON,parseContinuity} from './packages/bot/demo/directory-trust/browser-admission.ts';`,loader:'ts',resolveDir:repo},bundle:true,write:false,platform:'browser',format:'iife',globalName:'StageA',metafile:true,alias:{'@frank/codec':path.join(repo,'packages/frank-codec/src/index.ts'),'@frank/directory-admission/browser':path.join(repo,'packages/directory-admission/src/browser.ts')}});
   if(Object.keys(build.metafile.inputs).some(p=>/node_modules\/(level|leveldown)|src\/node\.ts/.test(p)))throw Error('browser dependency');browserScript=build.outputFiles[0].text;
  }catch(e){await driver.stop(browser);throw e;}finally{await fixture.stop();}
 }
 front=await startDirectoryRouteTransport({bundle,nowNs:1700000100000000000n,backendUrl:backend});
 // The front returns a static plaintext404 for the old proof page. This establishes the same controlled
 // origin without borrowing or weakening the probe page's deliberately evidence-only CSP.
 if(browser)session=await driver.page(browser,bundle,browserScript,path.join(root,'browser-continuity'));
 const {openNodeDirectoryStore}=load('packages/directory-admission/src/node.ts');const {admissionAnchor,admissionContext,continuityJSON,parseContinuity}=load('packages/bot/demo/directory-trust/browser-admission.ts');const installation={manifestIdentity:bundle.manifestIdentity,trustInputs:trust,witnessHex:bundle.witnessHex};
 const continuityFile=path.join(root,'client-continuity');store=await openNodeDirectoryStore({location:path.join(root,'client-db'),anchor:admissionAnchor(trust),mode:mode==='reopen'?{kind:'reopen',checkpoint:parseContinuity(fs.readFileSync(continuityFile,'utf8'),installation)}:{kind:'new'}});
 agent=new https.Agent({ca:bundle.tls.caPem,rejectUnauthorized:true,keepAlive:false,maxCachedSessions:0});
 const fetcher=(url,init)=>new Promise((resolve,reject)=>{const req=https.request(url,{agent,method:init.method,headers:init.headers,checkServerIdentity:(host,peer)=>{const e=tls.checkServerIdentity(host,peer);if(e)return e;const cert=new crypto.X509Certificate(peer.raw);if(provision.sha256(cert.raw)!==bundle.tls.leafSha256||provision.spki(cert)!==bundle.tls.leafSpkiSha256)return Error('pin');}},res=>{const iterator=res[Symbol.asyncIterator]();resolve({status:res.statusCode,url,headers:{get:n=>res.headers[n]??null},body:{getReader:()=>({read:()=>iterator.next(),cancel:async()=>{res.destroy();}})}});});req.on('error',reject);init.signal.addEventListener('abort',()=>req.destroy(Error('deadline')),{once:true});req.end(init.body);});
 const {createDirectoryClient}=load('packages/cashweb/relay/directory-client.ts');const client=createDirectoryClient({network:trust.network,subject:trust.subject,endpoint:trust.endpoint,store,context:()=>admissionContext(trust,1700000100000000000n),fetch:fetcher,saveCheckpoint:async cp=>{const data=continuityJSON(installation,cp);const fd=fs.openSync(continuityFile,'w',0o600);try{fs.writeFileSync(fd,data);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}});
 const current=mode==='reopen'?await client.current():await client.put(await client.preparePut(codec.fromHex(bundle.witnessHex)));if(current.t1!==trust.rev0T1)throw Error('T1');const historical=await client.historical(current.t1);if(codec.toHex(historical.frame)!==bundle.witnessHex||historical.kind!=='historical')throw Error('bytes');
  if(browser){const external=mode==='reopen'?fs.readFileSync(path.join(root,'browser-continuity'),'utf8'):null;const result=await browser.cdp.evaluate(session,`await (async()=>{const trust=${JSON.stringify(provision.trustJSON(trust))};trust.bindingExpiryNs=BigInt(trust.bindingExpiryNs);const installation={manifestIdentity:${JSON.stringify(bundle.manifestIdentity)},trustInputs:trust,witnessHex:${JSON.stringify(bundle.witnessHex)}};const store=await StageA.openBrowserDirectoryStore({name:'stage-a-http',anchor:StageA.admissionAnchor(trust),mode:${external?`{kind:'reopen',checkpoint:StageA.parseContinuity(${JSON.stringify(external)},installation)}`:`{kind:'new'}`}});try{const api=StageA.createDirectoryClient({network:trust.network,subject:trust.subject,endpoint:trust.endpoint,store,context:()=>StageA.admissionContext(trust,1700000100000000000n),fetch:(url,init)=>fetch(url,init),saveCheckpoint:cp=>saveRecord(StageA.continuityJSON(installation,cp))});const head=await api.current();const old=await api.historical(head.t1);if(head.t1!==trust.rev0T1||old.kind!=='historical')throw Error('browser authority');return head.t1;}finally{await store.close();}})()`);if(result!==trust.rev0T1)throw Error('browser T1 '+JSON.stringify({result,expected:trust.rev0T1}));console.log('exact HTTPS Rust/Chromium '+mode+' accepted');}
  console.log('exact HTTPS Rust/Node '+mode+' accepted');}
 finally{await store?.close();agent?.destroy();await front?.stop();if(browser)await driver.stop(browser);}
}
main().catch(e=>{console.error(e);process.exitCode=1});
"#;

#[tokio::test]
async fn authenticated_https_rust_and_node_client_close_reopen_exact_bytes() {
    use tokio::process::Command;
    let root = tempfile::tempdir().unwrap();
    let repo = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(3)
        .unwrap();
    let script = root.path().join("stagea.cjs");
    std::fs::write(&script, NODE_STAGE_A).unwrap();
    let run = |mode: &str, backend: &str| {
        let mut command = Command::new("node");
        command
            .arg("--import")
            .arg(repo.join("node_modules/tsx/dist/loader.mjs"))
            .arg(&script)
            .arg(repo)
            .arg(root.path())
            .arg(mode)
            .arg(backend)
            .env("TSX_TSCONFIG_PATH", repo.join("packages/bot/tsconfig.json"));
        command
    };
    let prepared = run("prepare", "").output().await.unwrap();
    assert!(
        prepared.status.success(),
        "{}",
        String::from_utf8_lossy(&prepared.stderr)
    );
    let mut config: DirectoryConf =
        serde_json::from_slice(&std::fs::read(root.path().join("native.json")).unwrap()).unwrap();
    for mode in ["new", "reopen"] {
        let registry = Arc::new(Registry::new(
            Db::open(root.path().join("db")).unwrap(),
            Arc::new(DisabledChainAdapter),
            Net::Regtest,
        ));
        let (runtime, ready) =
            DirectoryRuntime::start(registry, root.path().join("db"), config.clone()).unwrap();
        ready.await.unwrap().unwrap();
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let address = listener.local_addr().unwrap();
        let (stop, stopped) = tokio::sync::oneshot::channel::<()>();
        let server = axum::Server::from_tcp(listener)
            .unwrap()
            .serve(router(Arc::new(runtime.clone())).into_make_service())
            .with_graceful_shutdown(async {
                let _ = stopped.await;
            });
        let server = tokio::spawn(server);
        let checked = run(mode, &format!("http://{address}"))
            .output()
            .await
            .unwrap();
        stop.send(()).unwrap();
        server.await.unwrap().unwrap();
        runtime.begin_shutdown();
        runtime.wait_stopped().await;
        drop(runtime);
        assert!(
            checked.status.success(),
            "{}",
            String::from_utf8_lossy(&checked.stderr)
        );
        let output = String::from_utf8_lossy(&checked.stdout);
        assert!(output.contains(&format!("exact HTTPS Rust/Node {mode} accepted")));
        if std::env::var_os("DIRECTORY_ADMISSION_CHROMIUM").is_some() {
            assert!(output.contains(&format!("exact HTTPS Rust/Chromium {mode} accepted")));
        }
        config.principals[0].mode = "reopen".into();
    }
}
