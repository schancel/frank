//! Loopback-only group HTTP fixture for cross-language protocol integration tests.

use std::{
    io::{self, Write},
    net::{IpAddr, Ipv4Addr, SocketAddr},
};

use cashweb_registry::{
    http::groups::{router_with_store, GroupWriteRuntime},
    store::groups::GroupStore,
};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let address = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0);
    let listener = std::net::TcpListener::bind(address)?;
    listener.set_nonblocking(true)?;
    let origin = format!("http://{}", listener.local_addr()?);
    // Writes are paid as on a deployed relay: to the burn address, at least 1000 wei (the
    // minimum, until a group's creator sets a price) on monad-testnet, committed to this
    // fixture's origin. There is no chain: payer accounts are not read and nothing is broadcast.
    let writes = GroupWriteRuntime::loopback_fixture(
        "monad-testnet",
        &cashweb_config::GroupWritesConf {
            min_price_wei: "1000".into(),
            payee: cashweb_config::BURN_ADDRESS_HEX.into(),
        },
        &origin.parse()?,
    )?;
    println!("{origin}");
    io::stdout().flush()?;
    axum::Server::from_tcp(listener)?
        .serve(
            router_with_store(GroupStore::new_temporary(), std::sync::Arc::new(writes))
                .into_make_service(),
        )
        .await?;
    Ok(())
}
