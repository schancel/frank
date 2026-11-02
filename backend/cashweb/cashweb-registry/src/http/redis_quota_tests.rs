use super::*;
use std::sync::Arc;

#[tokio::test]
async fn bounded_timeout_and_saturation_are_explicit_fail_open() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let node = Arc::new(
        RedisQuota::new(
            "monad-regtest",
            &format!("redis://{address}/"),
            "bounded/".into(),
            50,
            1,
        )
        .unwrap(),
    );
    let first = tokio::spawn({
        let node = node.clone();
        async move {
            node.charge(QuotaDomain::EvmCustomer, b"a".to_vec(), 1, 7, 1)
                .await
        }
    });
    let (_silent_stream, _) = listener.accept().await.unwrap();
    let busy = tokio::time::timeout(
        Duration::from_millis(20),
        node.charge(QuotaDomain::EvmCustomer, b"b".to_vec(), 1, 7, 1),
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(busy, QuotaDecision::Degraded(RedisFailure::Busy));
    assert!(busy.snapshot().is_none());
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(1), first)
            .await
            .unwrap()
            .unwrap()
            .unwrap(),
        QuotaDecision::Degraded(RedisFailure::Timeout)
    );
}

/// The unsafe negative control deliberately reproduces the former caller-owned lifetime.
/// Its actual EVAL count must exceed the bound, while the production path must not.
#[tokio::test]
async fn cancelled_callers_cannot_accumulate_unanswered_redis_commands() {
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let active = Arc::new(AtomicUsize::new(0));
    let maximum = Arc::new(AtomicUsize::new(0));
    let reply = Arc::new(AtomicBool::new(false));
    let (sent, mut events) = tokio::sync::mpsc::channel(32);
    struct Backlog {
        count: usize,
        active: Arc<AtomicUsize>,
    }
    impl Drop for Backlog {
        fn drop(&mut self) {
            self.active.fetch_sub(self.count, Ordering::SeqCst);
        }
    }
    let server = tokio::spawn({
        let active = active.clone();
        let maximum = maximum.clone();
        let reply = reply.clone();
        async move {
            let mut connections = tokio::task::JoinSet::new();
            loop {
                tokio::select! {
                    accepted=listener.accept()=>{
                        let (stream,_)=accepted.unwrap();let active=active.clone();let maximum=maximum.clone();let reply=reply.clone();let sent=sent.clone();
                        connections.spawn(async move {
                            let (read,mut write)=stream.into_split();let mut read=BufReader::new(read);let mut backlog=Backlog {count:0,active:active.clone()};
                            loop {
                                // Test-only bounded RESP request parsing, never a production client.
                                let mut header=String::new();match read.read_line(&mut header).await {Ok(0)|Err(_)=>break,Ok(_)=>()}
                                let count:usize=header.trim().strip_prefix('*').unwrap().parse().unwrap();assert!(count<=32);
                                let mut command=Vec::new();
                                for _ in 0..count {let mut bulk=String::new();read.read_line(&mut bulk).await.unwrap();let length:usize=bulk.trim().strip_prefix('$').unwrap().parse().unwrap();assert!(length<=16384);let mut data=vec![0;length+2];read.read_exact(&mut data).await.unwrap();data.truncate(length);command.push(data);}
                                if command[0]==b"EVAL" {
                                    let n=active.fetch_add(1,Ordering::SeqCst)+1;maximum.fetch_max(n,Ordering::SeqCst);backlog.count+=1;
                                    sent.try_send(()).unwrap();
                                    if reply.load(Ordering::SeqCst) {
                                        write.write_all(b"*2\r\n:0\r\n:6\r\n").await.unwrap();backlog.count-=1;active.fetch_sub(1,Ordering::SeqCst);
                                    }
                                } else {write.write_all(b"+OK\r\n").await.unwrap();}
                            }
                        });
                    },
                    _=connections.join_next(),if !connections.is_empty()=>{}
                }
            }
        }
    });
    for protected in [false, true] {
        maximum.store(0, Ordering::SeqCst);
        let node = Arc::new(
            RedisQuota::new(
                "monad-regtest",
                &format!("redis://{address}/"),
                "cancellation/".into(),
                200,
                2,
            )
            .unwrap(),
        );
        let mut observed = 0;
        for _ in 0..10 {
            let mut caller = tokio::spawn({
                let node = node.clone();
                async move {
                    if protected {
                        node.charge(QuotaDomain::EvmCustomer, b"payer".to_vec(), 1, 7, 1)
                            .await
                    } else {
                        let _caller_permit = node.permits.clone().try_acquire_owned().unwrap();
                        node.execute(
                            QuotaDomain::EvmCustomer,
                            b"payer".to_vec(),
                            1,
                            7,
                            1,
                            tokio::time::Instant::now() + node.timeout,
                        )
                        .await
                    }
                }
            });
            tokio::select! {
                result=&mut caller=>assert_eq!(result.unwrap().unwrap(),QuotaDecision::Degraded(RedisFailure::Busy)),
                event=events.recv()=>{event.unwrap();observed+=1;caller.abort();assert!(caller.await.unwrap_err().is_cancelled());}
            }
        }
        println!(
            "cancellation protected={protected} observed_EVAL={observed} max_unanswered={}",
            maximum.load(Ordering::SeqCst)
        );
        if protected {
            assert_eq!(observed, 2);
            assert!(maximum.load(Ordering::SeqCst) <= 2);
            tokio::time::timeout(Duration::from_secs(1), async {
                while active.load(Ordering::SeqCst) != 0 {
                    tokio::time::sleep(Duration::from_millis(2)).await;
                }
            })
            .await
            .unwrap();
            reply.store(true, Ordering::SeqCst);
            tokio::time::sleep(Duration::from_millis(1100)).await;
            assert_eq!(
                node.charge(QuotaDomain::EvmCustomer, b"recovered".to_vec(), 1, 7, 1)
                    .await
                    .unwrap()
                    .snapshot()
                    .unwrap()
                    .remaining,
                6
            );
            events.recv().await.unwrap();
        } else {
            assert_eq!(observed, 10);
            assert!(maximum.load(Ordering::SeqCst) > 2);
        }
        drop(node);
        tokio::time::timeout(Duration::from_secs(1), async {
            while active.load(Ordering::SeqCst) != 0 {
                tokio::time::sleep(Duration::from_millis(2)).await;
            }
        })
        .await
        .unwrap();
    }
    server.abort();
    let _ = server.await;
}
fn url() -> String {
    std::env::var("FRANK_QUOTA_TEST_REDIS_URL").expect("explicit approved Redis test URL required")
}
fn prefix() -> String {
    format!("frank-quota-test/{}/", uuid::Uuid::new_v4())
}
fn now_hour() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs()
        / 3600
}
async fn admin() -> MultiplexedConnection {
    redis::Client::open(url())
        .unwrap()
        .get_multiplexed_async_connection()
        .await
        .unwrap()
}
fn instance(prefix: String) -> Arc<RedisQuota> {
    Arc::new(RedisQuota::new("monad-regtest", &url(), prefix, 100, 64).unwrap())
}

#[tokio::test]
#[ignore = "requires explicitly approved FRANK_QUOTA_TEST_REDIS_URL"]
async fn weighted_atomic_shared_instances_domains_networks_and_hour() {
    let p = prefix();
    let nodes: Vec<_> = (0..3).map(|_| instance(p.clone())).collect();
    let h = now_hour();
    assert!(matches!(
        nodes[0]
            .charge(QuotaDomain::EvmCustomer, b"warm".to_vec(), 1, 7, h)
            .await
            .unwrap(),
        QuotaDecision::Enforced(_)
    ));
    let mut workers = Vec::new();
    for i in 0..24 {
        let node = nodes[i % 3].clone();
        workers.push(tokio::spawn(async move {
            node.charge(QuotaDomain::EvmCustomer, b"payer".to_vec(), 2, 7, h)
                .await
        }));
    }
    let mut accepted = 0;
    for worker in workers {
        match worker.await.unwrap() {
            Ok(QuotaDecision::Enforced(_)) => accepted += 1,
            Err(QuotaDenial::Exhausted { .. }) => {}
            other => panic!("healthy atomic outcome {other:?}"),
        }
    }
    assert_eq!(accepted, 3);
    let restarted = instance(p.clone());
    assert_eq!(
        restarted
            .charge(QuotaDomain::EvmCustomer, b"payer".to_vec(), 1, 7, h)
            .await
            .unwrap()
            .snapshot()
            .unwrap()
            .remaining,
        0
    );
    for domain in [
        QuotaDomain::DirectoryEnrollment,
        QuotaDomain::EvmAnonymous,
        QuotaDomain::BitcoinAnonymous,
        QuotaDomain::BitcoinCustomer,
        QuotaDomain::SolanaCustomer,
        QuotaDomain::SolanaAnonymous,
    ] {
        assert_eq!(
            nodes[0]
                .charge(domain, b"payer".to_vec(), 7, 7, h)
                .await
                .unwrap()
                .snapshot()
                .unwrap()
                .remaining,
            0
        );
    }
    for network in ["solana-devnet", "xec-regtest", "btc-regtest"] {
        let other = Arc::new(RedisQuota::new(network, &url(), p.clone(), 100, 64).unwrap());
        assert_eq!(
            other
                .charge(QuotaDomain::EvmCustomer, b"payer".to_vec(), 7, 7, h)
                .await
                .unwrap()
                .snapshot()
                .unwrap()
                .remaining,
            0
        );
    }
    assert!(RedisQuota::new("evm", &url(), p.clone(), 100, 64).is_err());
    assert_eq!(
        nodes[0]
            .charge(QuotaDomain::EvmCustomer, b"payer".to_vec(), 7, 7, h + 1)
            .await
            .unwrap()
            .snapshot()
            .unwrap()
            .remaining,
        0
    );
}
#[tokio::test]
#[ignore = "requires explicitly approved FRANK_QUOTA_TEST_REDIS_URL"]
async fn actual_redis_ttl_and_malformed_counter_are_conservative() {
    let node = instance(prefix());
    let h = now_hour();
    let key = format!("{}v1:monad-regtest:1:{h}", node.prefix);
    let mut admin = admin().await;
    node.charge(QuotaDomain::EvmCustomer, b"payer".to_vec(), 1, 7, h)
        .await
        .unwrap();
    let expiry: i64 = redis::cmd("EXPIRETIME")
        .arg(&key)
        .query_async(&mut admin)
        .await
        .unwrap();
    assert_eq!(expiry as u64, (h + 2) * 3600);
    let _: () = redis::cmd("HSET")
        .arg(&key)
        .arg(hex::encode(b"payer"))
        .arg("corrupt")
        .query_async(&mut admin)
        .await
        .unwrap();
    assert!(matches!(
        node.charge(QuotaDomain::EvmCustomer, b"payer".to_vec(), 1, 7, h)
            .await
            .unwrap(),
        QuotaDecision::Degraded(RedisFailure::Protocol)
    ));
    let unchanged: String = redis::cmd("HGET")
        .arg(&key)
        .arg(hex::encode(b"payer"))
        .query_async(&mut admin)
        .await
        .unwrap();
    assert_eq!(unchanged, "corrupt");
    let _: bool = redis::cmd("PEXPIRE")
        .arg(&key)
        .arg(30)
        .query_async(&mut admin)
        .await
        .unwrap();
    tokio::time::sleep(Duration::from_millis(60)).await;
    let exists: bool = redis::cmd("EXISTS")
        .arg(&key)
        .query_async(&mut admin)
        .await
        .unwrap();
    assert!(!exists);
    assert_eq!(
        node.charge(QuotaDomain::EvmCustomer, b"payer".to_vec(), 7, 7, h)
            .await
            .unwrap()
            .snapshot()
            .unwrap()
            .remaining,
        0
    );
}
#[tokio::test]
#[ignore = "requires explicitly approved FRANK_QUOTA_TEST_REDIS_URL"]
async fn redis_auth_and_command_errors_fail_open_without_mutating_bad_data() {
    let mut raw = url::Url::parse(&url()).unwrap();
    raw.set_username("invalid").unwrap();
    raw.set_password(Some("never-log-this-secret")).unwrap();
    let bad_auth =
        Arc::new(RedisQuota::new("monad-regtest", raw.as_str(), prefix(), 50, 2).unwrap());
    assert!(!format!("{bad_auth:?}").contains("never-log-this-secret"));
    assert!(matches!(
        bad_auth
            .charge(
                QuotaDomain::EvmCustomer,
                b"payer".to_vec(),
                1,
                7,
                now_hour()
            )
            .await
            .unwrap(),
        QuotaDecision::Degraded(_)
    ));
    let node = instance(prefix());
    let key = format!("{}v1:monad-regtest:1:{}", node.prefix, now_hour());
    let mut admin = admin().await;
    let _: () = redis::cmd("SET")
        .arg(&key)
        .arg("wrong-type")
        .query_async(&mut admin)
        .await
        .unwrap();
    assert!(matches!(
        node.charge(
            QuotaDomain::EvmCustomer,
            b"payer".to_vec(),
            1,
            7,
            now_hour()
        )
        .await
        .unwrap(),
        QuotaDecision::Degraded(RedisFailure::Command)
    ));
    let value: String = redis::cmd("GET")
        .arg(&key)
        .query_async(&mut admin)
        .await
        .unwrap();
    assert_eq!(value, "wrong-type");
}
async fn owned_docker(args: &[&str]) -> String {
    let context = std::env::var("FRANK_QUOTA_TEST_DOCKER_CONTEXT")
        .expect("explicit Docker context required for owned Redis lifecycle tests");
    let output = tokio::time::timeout(
        Duration::from_secs(10),
        tokio::process::Command::new("docker")
            .arg("--context")
            .arg(context)
            .args(args)
            .kill_on_drop(true)
            .output(),
    )
    .await
    .expect("bounded owned Redis Docker operation")
    .unwrap();
    assert!(
        output.status.success(),
        "owned Redis command failed (details deliberately redacted)"
    );
    String::from_utf8(output.stdout).unwrap()
}
async fn owned_server() -> String {
    let cid = std::env::var("FRANK_QUOTA_TEST_REDIS_CONTAINER_ID")
        .expect("explicit owned immutable Redis CID required");
    let owner = std::env::var("FRANK_QUOTA_TEST_WORKSPACE_UUID")
        .expect("explicit owned Redis workspace UUID required");
    assert_eq!(cid.len(), 64);
    uuid::Uuid::parse_str(&owner).unwrap();
    let info: serde_json::Value =
        serde_json::from_str(&owned_docker(&["inspect", &cid]).await).unwrap();
    let actual = &info[0];
    assert_eq!(actual["Id"].as_str(), Some(cid.as_str()));
    assert_eq!(
        actual["Config"]["Labels"]["frank.workspace"].as_str(),
        Some(owner.as_str())
    );
    let ports = actual["HostConfig"]["PortBindings"]["6379/tcp"]
        .as_array()
        .unwrap();
    assert_eq!(ports.len(), 1);
    assert_eq!(ports[0]["HostIp"], "127.0.0.1");
    let raw = url::Url::parse(&url()).unwrap();
    assert_eq!(raw.host_str(), Some("127.0.0.1"));
    assert_eq!(
        raw.port().unwrap().to_string(),
        ports[0]["HostPort"].as_str().unwrap()
    );
    assert_eq!(actual["HostConfig"]["AutoRemove"], false);
    assert!(
        actual["Mounts"]
            .as_array()
            .unwrap()
            .iter()
            .all(|m| m["Type"] == "tmpfs"),
        "test control cannot target durable Redis data"
    );
    cid
}
#[tokio::test]
#[ignore = "root-approved dedicated ephemeral Redis CID+UUID+loopback binding required"]
async fn owned_redis_stop_restart_fails_open_recovers_and_resets_ephemeral_budget() {
    let cid = owned_server().await;
    let node = instance(prefix());
    let h = now_hour();
    assert_eq!(
        node.charge(QuotaDomain::EvmCustomer, b"payer".to_vec(), 7, 7, h)
            .await
            .unwrap()
            .snapshot()
            .unwrap()
            .remaining,
        0
    );
    assert!(matches!(
        node.charge(QuotaDomain::EvmCustomer, b"payer".to_vec(), 1, 7, h)
            .await,
        Err(QuotaDenial::Exhausted { .. })
    ));
    owned_docker(&["stop", "--time", "3", &cid]).await;
    let down = node
        .charge(QuotaDomain::EvmCustomer, b"payer".to_vec(), 1, 7, h)
        .await
        .unwrap();
    assert!(matches!(down, QuotaDecision::Degraded(_)));
    assert!(down.snapshot().is_none());
    owned_server().await;
    owned_docker(&["start", &cid]).await;
    tokio::time::sleep(Duration::from_millis(1100)).await;
    let recovered = node
        .charge(QuotaDomain::EvmCustomer, b"payer".to_vec(), 7, 7, h)
        .await
        .unwrap();
    assert_eq!(
        recovered
            .snapshot()
            .expect("Redis restart must recover enforcement")
            .remaining,
        0
    );
    assert!(matches!(
        node.charge(QuotaDomain::EvmCustomer, b"payer".to_vec(), 1, 7, h)
            .await,
        Err(QuotaDenial::Exhausted { .. })
    ));
}
#[tokio::test]
#[ignore = "root-approved dedicated ephemeral Redis CID+UUID+loopback binding required"]
async fn owned_redis_noeviction_oom_is_fail_open_and_recovers() {
    owned_server().await;
    let node = instance(prefix());
    let mut admin = admin().await;
    let prior: Vec<String> = redis::cmd("CONFIG")
        .arg("GET")
        .arg("maxmemory")
        .query_async(&mut admin)
        .await
        .unwrap();
    let _: () = redis::cmd("CONFIG")
        .arg("SET")
        .arg("maxmemory")
        .arg(1)
        .query_async(&mut admin)
        .await
        .unwrap();
    let result = node
        .charge(
            QuotaDomain::EvmCustomer,
            b"payer".to_vec(),
            1,
            7,
            now_hour(),
        )
        .await;
    // Restore our dedicated server even if the assertion below fails; no operator instance.
    let _: () = redis::cmd("CONFIG")
        .arg("SET")
        .arg("maxmemory")
        .arg(&prior[1])
        .query_async(&mut admin)
        .await
        .unwrap();
    assert!(matches!(
        result.unwrap(),
        QuotaDecision::Degraded(RedisFailure::Command)
    ));
    tokio::time::sleep(Duration::from_millis(1100)).await;
    assert!(matches!(
        node.charge(
            QuotaDomain::EvmCustomer,
            b"payer".to_vec(),
            1,
            7,
            now_hour()
        )
        .await
        .unwrap(),
        QuotaDecision::Enforced(_)
    ));
}
