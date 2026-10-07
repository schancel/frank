//! Module for [`RelayInfo`].

use std::str::Utf8Error;

use axum::http::HeaderMap;
use bitcoinsuite_error::{ErrorMeta, Result};
use reqwest::header::ORIGIN;
use thiserror::Error;
use uuid::Uuid;

use crate::p2p::descriptor::ClusterRelayDescriptor;

/// Header name for cluster ID.
pub const CLUSTER_ID_HEADER: &str = "x-frank-cluster-id";
/// Header name for cluster authority public key (hex).
pub const CLUSTER_AUTHORITY_HEADER: &str = "x-frank-cluster-authority";
/// Header name for cluster node public key (hex).
pub const CLUSTER_NODE_PUBKEY_HEADER: &str = "x-frank-node-pubkey";
/// Header name for serialized cluster descriptor (json).
pub const CLUSTER_DESCRIPTOR_HEADER: &str = "x-frank-cluster-descriptor";

/// Data extracted from a request necessary for relaying and cluster isolation.
#[derive(Debug, Clone, Eq, PartialEq)]
pub struct RelayInfo {
    /// 'Origin' header of the incoming metadata PUT request.
    pub origin: url::Url,
    /// Optional cluster UUID from `x-frank-cluster-id`.
    pub cluster_id: Option<Uuid>,
    /// Optional cluster authority public key from `x-frank-cluster-authority`.
    pub cluster_authority_pubkey: Option<[u8; 33]>,
    /// Optional cluster node public key from `x-frank-node-pubkey`.
    pub node_pubkey: Option<[u8; 33]>,
    /// Optional cluster relay descriptor from `x-frank-cluster-descriptor`.
    pub cluster_descriptor: Option<ClusterRelayDescriptor>,
}

/// Errors parsing RelayInfo.
#[derive(Error, ErrorMeta, Clone, Debug, Eq, PartialEq)]
pub enum RelayInfoError {
    /// HTTP request is missing the 'Origin' header.
    #[invalid_client_input()]
    #[error("'Origin' header missing")]
    MissingOrigin,

    /// 'Origin' header is not valid UTF-8.
    #[invalid_client_input()]
    #[error("'Origin' header not valid UTF-8: {0}")]
    OriginInvalidUtf8(Utf8Error),

    /// 'Origin' header is not a valid URL.
    #[invalid_client_input()]
    #[error("'Origin' header not a valid URL: {0}")]
    OriginInvaidUrl(url::ParseError),

    /// Cluster ID header is invalid UUID.
    #[invalid_client_input()]
    #[error("Cluster ID header not a valid UUID: {0}")]
    InvalidClusterId(String),

    /// Cluster authority header is invalid hex or length.
    #[invalid_client_input()]
    #[error("Cluster authority header invalid pubkey: {0}")]
    InvalidClusterAuthority(String),

    /// Cluster node pubkey header is invalid hex or length.
    #[invalid_client_input()]
    #[error("Cluster node pubkey header invalid: {0}")]
    InvalidClusterNodePubkey(String),

    /// Cluster descriptor header is invalid JSON.
    #[invalid_client_input()]
    #[error("Cluster descriptor header invalid JSON: {0}")]
    InvalidClusterDescriptor(String),
}

use self::RelayInfoError::*;

impl RelayInfo {
    /// Construct a basic `RelayInfo` with origin only.
    pub fn new(origin: url::Url) -> Self {
        Self {
            origin,
            cluster_id: None,
            cluster_authority_pubkey: None,
            node_pubkey: None,
            cluster_descriptor: None,
        }
    }

    /// Parse the [`RelayInfo`] from an HTTP [`HeaderMap`].
    pub fn parse_from_headers(header_map: &HeaderMap) -> Result<Self> {
        let origin = header_map.get(ORIGIN).ok_or(MissingOrigin)?;
        let origin = std::str::from_utf8(origin.as_bytes()).map_err(OriginInvalidUtf8)?;
        let origin = url::Url::parse(origin).map_err(OriginInvaidUrl)?;

        let cluster_id = if let Some(val) = header_map.get(CLUSTER_ID_HEADER) {
            let s = std::str::from_utf8(val.as_bytes()).map_err(OriginInvalidUtf8)?;
            Some(Uuid::parse_str(s).map_err(|e| InvalidClusterId(e.to_string()))?)
        } else {
            None
        };

        let cluster_authority_pubkey = if let Some(val) = header_map.get(CLUSTER_AUTHORITY_HEADER) {
            let s = std::str::from_utf8(val.as_bytes()).map_err(OriginInvalidUtf8)?;
            let bytes = hex::decode(s).map_err(|e| InvalidClusterAuthority(e.to_string()))?;
            let arr: [u8; 33] = bytes
                .try_into()
                .map_err(|_| InvalidClusterAuthority("expected 33 bytes".to_string()))?;
            Some(arr)
        } else {
            None
        };

        let node_pubkey = if let Some(val) = header_map.get(CLUSTER_NODE_PUBKEY_HEADER) {
            let s = std::str::from_utf8(val.as_bytes()).map_err(OriginInvalidUtf8)?;
            let bytes = hex::decode(s).map_err(|e| InvalidClusterNodePubkey(e.to_string()))?;
            let arr: [u8; 33] = bytes
                .try_into()
                .map_err(|_| InvalidClusterNodePubkey("expected 33 bytes".to_string()))?;
            Some(arr)
        } else {
            None
        };

        let cluster_descriptor = if let Some(val) = header_map.get(CLUSTER_DESCRIPTOR_HEADER) {
            let s = std::str::from_utf8(val.as_bytes()).map_err(OriginInvalidUtf8)?;
            let desc: ClusterRelayDescriptor =
                serde_json::from_str(s).map_err(|e| InvalidClusterDescriptor(e.to_string()))?;
            Some(desc)
        } else {
            None
        };

        Ok(RelayInfo {
            origin,
            cluster_id,
            cluster_authority_pubkey,
            node_pubkey,
            cluster_descriptor,
        })
    }

    /// Returns true if this request originated from a node sharing the given cluster authority or cluster ID.
    pub fn is_same_cluster(
        &self,
        my_authority: Option<&[u8; 33]>,
        my_cluster_id: Option<&Uuid>,
    ) -> bool {
        if let Some(auth) = my_authority {
            if let Some(candidate_auth) = &self.cluster_authority_pubkey {
                if candidate_auth == auth {
                    return true;
                }
            }
            if let Some(desc) = &self.cluster_descriptor {
                if desc.authority_pubkey == *auth {
                    return true;
                }
            }
        }
        if let Some(cid) = my_cluster_id {
            if let Some(candidate_cid) = &self.cluster_id {
                if candidate_cid == cid {
                    return true;
                }
            }
            if let Some(desc) = &self.cluster_descriptor {
                if desc.cluster_id == *cid {
                    return true;
                }
            }
        }
        false
    }
}

#[cfg(test)]
mod tests {
    use axum::http::{HeaderMap, HeaderValue};
    use bitcoinsuite_error::Result;
    use reqwest::header::ORIGIN;
    use uuid::Uuid;

    use crate::p2p::{
        descriptor::ClusterRelayDescriptor,
        relay_info::{
            RelayInfo, RelayInfoError, CLUSTER_AUTHORITY_HEADER, CLUSTER_DESCRIPTOR_HEADER,
            CLUSTER_ID_HEADER, CLUSTER_NODE_PUBKEY_HEADER,
        },
    };

    #[test]
    fn test_parse_from_headers() -> Result<()> {
        assert_eq!(
            RelayInfo::parse_from_headers(&HeaderMap::new())
                .unwrap_err()
                .downcast::<RelayInfoError>()?,
            RelayInfoError::MissingOrigin,
        );

        let mut header_map = HeaderMap::new();
        header_map.insert(ORIGIN, HeaderValue::from_bytes(&[0xf0, 0x20])?);
        assert_eq!(
            RelayInfo::parse_from_headers(&header_map)
                .unwrap_err()
                .downcast::<RelayInfoError>()?
                .to_string(),
            "'Origin' header not valid UTF-8: invalid utf-8 sequence of 1 bytes from index 0",
        );

        header_map.insert(ORIGIN, HeaderValue::from_static("http://anywhere.com"));
        assert_eq!(
            RelayInfo::parse_from_headers(&header_map)?,
            RelayInfo::new("http://anywhere.com".parse()?),
        );

        // Cluster headers
        let cluster_id = Uuid::new_v4();
        let auth_pubkey = [0x02; 33];
        let node_pubkey = [0x03; 33];
        header_map.insert(
            CLUSTER_ID_HEADER,
            HeaderValue::from_str(&cluster_id.to_string())?,
        );
        header_map.insert(
            CLUSTER_AUTHORITY_HEADER,
            HeaderValue::from_str(&hex::encode(auth_pubkey))?,
        );
        header_map.insert(
            CLUSTER_NODE_PUBKEY_HEADER,
            HeaderValue::from_str(&hex::encode(node_pubkey))?,
        );
        let dummy_desc = ClusterRelayDescriptor {
            authority_pubkey: auth_pubkey,
            cluster_id,
            cluster_name: "test-cluster".to_string(),
            public_endpoints: vec!["https://relay.test.org".parse().unwrap()],
            valid_until: 1700000000,
            authority_signature: vec![0u8; 64],
        };
        let desc_json = serde_json::to_string(&dummy_desc)?;
        header_map.insert(
            CLUSTER_DESCRIPTOR_HEADER,
            HeaderValue::from_str(&desc_json)?,
        );

        let parsed = RelayInfo::parse_from_headers(&header_map)?;
        assert_eq!(parsed.cluster_id, Some(cluster_id));
        assert_eq!(parsed.cluster_authority_pubkey, Some(auth_pubkey));
        assert_eq!(parsed.node_pubkey, Some(node_pubkey));
        assert_eq!(parsed.cluster_descriptor.as_ref(), Some(&dummy_desc));
        assert!(parsed.is_same_cluster(Some(&auth_pubkey), None));
        assert!(parsed.is_same_cluster(None, Some(&cluster_id)));

        let other_auth = [0x04; 33];
        let other_cluster_id = Uuid::new_v4();
        assert!(!parsed.is_same_cluster(Some(&other_auth), Some(&other_cluster_id)));

        Ok(())
    }
}
