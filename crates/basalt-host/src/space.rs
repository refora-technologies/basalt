//! Free and total space on the volume holding a path.

use std::path::Path;

/// Returns `(free, total)` in bytes, or `(0, 0)` if the volume will not say.
///
/// Zeros rather than an error on purpose: the drive gauge is decoration, and
/// failing a whole connection because a USB enclosure declined to report its
/// size would be absurd. The client hides the gauge when total is zero.
pub fn for_path(path: &Path) -> (u64, u64) {
    #[cfg(windows)]
    {
        windows_space(path).unwrap_or((0, 0))
    }
    #[cfg(unix)]
    {
        unix_space(path).unwrap_or((0, 0))
    }
    #[cfg(not(any(windows, unix)))]
    {
        let _ = path;
        (0, 0)
    }
}

#[cfg(unix)]
fn unix_space(path: &Path) -> Option<(u64, u64)> {
    use std::os::unix::ffi::OsStrExt;

    let path = std::ffi::CString::new(path.as_os_str().as_bytes()).ok()?;
    // SAFETY: a NUL-terminated path and a zeroed struct for statvfs to fill.
    let mut stats: libc::statvfs = unsafe { std::mem::zeroed() };
    if unsafe { libc::statvfs(path.as_ptr(), &mut stats) } != 0 {
        return None;
    }
    let block = stats.f_frsize as u64;
    // Available to this user, not the blocks kept for root, which is what a
    // person can actually fill.
    Some((
        (stats.f_bavail as u64).saturating_mul(block),
        (stats.f_blocks as u64).saturating_mul(block),
    ))
}

#[cfg(windows)]
fn windows_space(path: &Path) -> Option<(u64, u64)> {
    use std::os::windows::ffi::OsStrExt;

    use windows_sys::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;

    // A trailing separator makes the API treat the string as a directory,
    // which is what we want: without it a path naming a file is rejected.
    let mut wide: Vec<u16> = path.as_os_str().encode_wide().collect();
    if wide.last() != Some(&(b'\\' as u16)) {
        wide.push(b'\\' as u16);
    }
    wide.push(0);

    let mut available: u64 = 0;
    let mut total: u64 = 0;
    let mut free: u64 = 0;

    // SAFETY: `wide` is NUL-terminated and outlives the call, and the three
    // out-parameters are valid, correctly sized and independent.
    let ok = unsafe { GetDiskFreeSpaceExW(wide.as_ptr(), &mut available, &mut total, &mut free) };
    if ok == 0 {
        return None;
    }

    // `available` rather than `free`: on a volume with quotas they differ, and
    // what the user can actually write is the number worth showing.
    Some((available, total))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_real_directory_reports_a_size() {
        let (free, total) = for_path(&std::env::temp_dir());
        if cfg!(windows) {
            assert!(total > 0, "a mounted volume has a total size");
            assert!(free <= total, "free space cannot exceed the volume");
        }
    }

    #[test]
    fn a_missing_path_reports_zeros_rather_than_panicking() {
        let (free, total) = for_path(Path::new("Z:/definitely/not/mounted/8f2a"));
        assert_eq!((free, total), (0, 0));
    }
}
