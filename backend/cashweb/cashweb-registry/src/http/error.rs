//! Module containing [`HttpRegistryError`], an error newtype and [`report_to_error_meta`] to map
//! errors of this crate to [`ErrorMeta`].

use axum::response::{IntoResponse, Response};
use bitcoinsuite_error::{report_to_details, ErrorMeta, Report};
use cashweb_http_utils::error::details_to_status_proto;

use crate::{
    evm_profile_verify::EvmProfileVerifyError,
    http::{evm_profile::EvmProfileRouteError, server::RegistryServerError},
    p2p::relay_info::RelayInfoError,
    registry::RegistryError,
    store::{evm_profiles::DbEvmProfilesError, pubkeyhash::PkhError},
};

/// Newtype around [`Report`], implements [`IntoResponse`].
#[derive(Debug)]
pub struct HttpRegistryError(pub Report);

impl From<Report> for HttpRegistryError {
    fn from(err: Report) -> Self {
        HttpRegistryError(err)
    }
}

impl From<RegistryServerError> for HttpRegistryError {
    fn from(err: RegistryServerError) -> Self {
        HttpRegistryError(err.into())
    }
}

impl IntoResponse for HttpRegistryError {
    fn into_response(self) -> Response {
        let details = report_to_details(&self.0, self::report_to_error_meta);
        details_to_status_proto(details).into_response()
    }
}

/// Maps errors occuring in this crate to an [`ErrorMeta`] trait object.
pub fn report_to_error_meta(report: &Report) -> Option<&dyn ErrorMeta> {
    if let Some(err) = report.downcast_ref::<RegistryServerError>() {
        Some(err)
    } else if let Some(err) = report.downcast_ref::<RegistryError>() {
        Some(err)
    } else if let Some(err) = report.downcast_ref::<PkhError>() {
        Some(err)
    } else if let Some(err) = report.downcast_ref::<RelayInfoError>() {
        Some(err)
    } else if let Some(err) = report.downcast_ref::<EvmProfileRouteError>() {
        Some(err)
    } else if let Some(err) = report.downcast_ref::<EvmProfileVerifyError>() {
        Some(err)
    } else if let Some(err) = report.downcast_ref::<DbEvmProfilesError>() {
        Some(err)
    } else if let Some(err) = cashweb_payload::error::report_to_error_meta(report) {
        Some(err)
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn historical_public_error_codes_survive_implementation_owner_renaming() {
        let report = Report::new(
            RegistryError::MonadProfileTimestampNotMonotonicallyIncreasing {
                previous: 1000,
                next: 999,
            },
        );
        let details = report_to_details(&report, report_to_error_meta);
        assert_eq!(
            details.error_code,
            "monad-profile-timestamp-not-monotonically-increasing"
        );
        let (status, body) = details_to_status_proto(details);
        assert_eq!(status, axum::http::StatusCode::BAD_REQUEST);
        assert_eq!(
            body.0.error_code,
            "monad-profile-timestamp-not-monotonically-increasing"
        );
        assert!(body.0.is_user_error);

        // ErrorMeta derives codes from variant identifiers. Keep the historical identifier
        // even when this critical internal error is redacted by the HTTP projection.
        let report = Report::new(DbEvmProfilesError::CannotDecodeMonadProfile(
            "fixture".into(),
        ));
        let details = report_to_details(&report, report_to_error_meta);
        assert_eq!(details.error_code, "cannot-decode-monad-profile");
        let (status, body) = details_to_status_proto(details);
        assert_eq!(status, axum::http::StatusCode::INTERNAL_SERVER_ERROR);
        assert_eq!(body.0.error_code, "internal-server-error");
    }
}
