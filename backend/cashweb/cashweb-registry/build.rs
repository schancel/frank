use std::io::Result;

fn main() -> Result<()> {
    prost_build::compile_protos(
        &[
            "proto/registry.proto",
            "proto/broadcast.proto",
            "proto/monad_message.proto",
            "proto/topic_message.proto",
            "proto/monad_profile.proto",
        ],
        &["proto/", "../cashweb-payload/proto/"],
    )?;
    Ok(())
}
