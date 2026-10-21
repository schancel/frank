//! Loopback-only group HTTP fixture for cross-language protocol integration tests.

use std::{
    io::{self, Write},
    net::{IpAddr, Ipv4Addr, SocketAddr},
};

use cashweb_registry::{http::groups::router_with_store, store::groups::GroupStore};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let address = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0);
    let listener = std::net::TcpListener::bind(address)?;
    listener.set_nonblocking(true)?;
    println!("http://{}", listener.local_addr()?);
    io::stdout().flush()?;
    axum::Server::from_tcp(listener)?
        .serve(router_with_store(GroupStore::new_in_memory()).into_make_service())
        .await?;
    Ok(())
}
