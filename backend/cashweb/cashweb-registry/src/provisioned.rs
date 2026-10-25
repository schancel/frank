//! Operator-provisioned secret files (`registry.session_secret_file`,
//! `registry.vapid_private_key_file`): read, never created, and refused unless only their
//! owner can read them.

use std::{io, path::Path};

/// Read a provisioned secret file. On Unix, a file that its group or other users can read or
/// write is refused (`chmod 0400` or `0600` it), so a mistake in provisioning fails the start
/// instead of leaving the secret readable by every account on the host.
pub fn read_secret_file(path: &Path) -> io::Result<Vec<u8>> {
    let file = std::fs::File::open(path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = file.metadata()?.permissions().mode();
        if mode & 0o077 != 0 {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                format!(
                    "{} is accessible to its group or other users (mode {:03o}); \
                     make it readable by its owner only (chmod 0400)",
                    path.display(),
                    mode & 0o777
                ),
            ));
        }
    }
    let mut bytes = Vec::new();
    io::Read::read_to_end(&mut &file, &mut bytes)?;
    Ok(bytes)
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    #[test]
    fn group_or_world_access_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("secret");
        std::fs::write(&path, b"secret").unwrap();
        for mode in [0o640, 0o604, 0o620, 0o602, 0o644, 0o666] {
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(mode)).unwrap();
            let error = read_secret_file(&path).unwrap_err();
            assert_eq!(error.kind(), io::ErrorKind::PermissionDenied, "{mode:o}");
        }
        for mode in [0o400, 0o600] {
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(mode)).unwrap();
            assert_eq!(read_secret_file(&path).unwrap(), b"secret", "{mode:o}");
        }
    }
}
