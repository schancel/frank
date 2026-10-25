//! S3 driver for the [`ObjectStore`] capability, over the existing SigV4 transport
//! ([`ReqwestS3Transport`]). Composition constructs it; owners only see `dyn ObjectStore`.
//!
//! Owners call the store synchronously from inside blocking work, sometimes on an async worker
//! of whatever runtime the caller has. The HTTP requests therefore run on a small runtime
//! owned by one dedicated thread, and the caller waits on a channel. That never nests one
//! runtime inside another, and the runtime is dropped on its own thread.

use std::{
    fmt::{self, Debug},
    future::Future,
    pin::Pin,
    sync::{mpsc, Arc},
};

use crate::store::{
    blob_store::{BlobError, ReqwestS3Transport, S3BlobStoreConfig, S3ObjectTransport},
    large_values::{check_object_key, ObjectStore, ObjectStoreError},
};

type Job = Pin<Box<dyn Future<Output = ()> + Send>>;

/// S3-compatible object store (AWS S3, MinIO, R2).
pub struct S3ObjectStore {
    transport: Arc<dyn S3ObjectTransport>,
    jobs: tokio::sync::mpsc::UnboundedSender<Job>,
    endpoint: String,
    bucket: String,
}

impl Debug for S3ObjectStore {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        // Never print credentials.
        f.debug_struct("S3ObjectStore")
            .field("endpoint", &self.endpoint)
            .field("bucket", &self.bucket)
            .finish()
    }
}

fn s3_error(error: BlobError) -> ObjectStoreError {
    ObjectStoreError(error.to_string())
}

impl S3ObjectStore {
    /// Connect lazily to the bucket in `config`. No request is made until the first call.
    pub fn new(config: S3BlobStoreConfig) -> Result<Self, ObjectStoreError> {
        url::Url::parse(&config.endpoint)
            .map_err(|e| ObjectStoreError(format!("invalid S3 endpoint: {e}")))?;
        let (endpoint, bucket) = (config.endpoint.clone(), config.bucket.clone());
        let transport: Arc<dyn S3ObjectTransport> = Arc::new(ReqwestS3Transport::new(config));
        let (jobs, mut queue) = tokio::sync::mpsc::unbounded_channel::<Job>();
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .thread_name("frank-s3")
            .enable_all()
            .build()
            .map_err(|e| ObjectStoreError(format!("start S3 runtime: {e}")))?;
        std::thread::Builder::new()
            .name("frank-s3".into())
            .spawn(move || {
                runtime.block_on(async move {
                    while let Some(job) = queue.recv().await {
                        tokio::spawn(job);
                    }
                });
            })
            .map_err(|e| ObjectStoreError(format!("start S3 thread: {e}")))?;
        Ok(Self {
            transport,
            jobs,
            endpoint,
            bucket,
        })
    }

    fn run<T: Send + 'static>(
        &self,
        request: impl Future<Output = Result<T, BlobError>> + Send + 'static,
    ) -> Result<T, ObjectStoreError> {
        let (done, result) = mpsc::sync_channel(1);
        self.jobs
            .send(Box::pin(async move {
                let _ = done.send(request.await);
            }))
            .map_err(|_| ObjectStoreError("S3 runtime stopped".into()))?;
        result
            .recv()
            .map_err(|_| ObjectStoreError("S3 request was dropped".into()))?
            .map_err(s3_error)
    }
}

impl ObjectStore for S3ObjectStore {
    fn put(&self, key: &str, bytes: &[u8], sha256: &[u8; 32]) -> Result<(), ObjectStoreError> {
        check_object_key(key)?;
        let (transport, key, bytes, sha) = (
            self.transport.clone(),
            key.to_string(),
            bytes.to_vec(),
            hex::encode(sha256),
        );
        self.run(async move { transport.put_object(&key, bytes, &sha).await })
    }

    fn get(&self, key: &str) -> Result<Option<Vec<u8>>, ObjectStoreError> {
        check_object_key(key)?;
        let (transport, key) = (self.transport.clone(), key.to_string());
        self.run(async move { transport.get_object(&key).await })
    }

    fn delete(&self, key: &str) -> Result<(), ObjectStoreError> {
        check_object_key(key)?;
        let (transport, key) = (self.transport.clone(), key.to_string());
        self.run(async move { transport.delete_object(&key).await.map(|_| ()) })
    }

    fn contains(&self, key: &str) -> Result<bool, ObjectStoreError> {
        check_object_key(key)?;
        let (transport, key) = (self.transport.clone(), key.to_string());
        self.run(async move { transport.head_object(&key).await.map(|len| len.is_some()) })
    }
}
