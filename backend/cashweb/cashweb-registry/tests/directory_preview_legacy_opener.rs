//! Build this helper against exact reviewed base 7b45b3374c102dda10c8c561535c8fd7f7183778.
//! It uses that production Db::open unchanged, not copied/widened CF descriptors.
use cashweb_registry::store::db::Db;

#[test]
fn directory_preview_actual_legacy_opener() {
    if let Ok(path) = std::env::var("FRANK_DIRECTORY_LEGACY_DB") {
        drop(Db::open(path).expect("actual reviewed-base registry opener must succeed"));
    }
}
