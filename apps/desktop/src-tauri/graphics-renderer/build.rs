//! Copies the FFmpeg 9 shared libraries the binary imports next to it, so the renderer folder
//! runs without PATH changes (Windows searches the executable's directory first).

use std::{env, fs, path::PathBuf};

fn main() {
    println!("cargo:rerun-if-env-changed=FFMPEG_DIR");
    if env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("windows") {
        return;
    }
    let Ok(ffmpeg_dir) = env::var("FFMPEG_DIR") else {
        // ffmpeg-sys-fframes fails the build with its own message when FFMPEG_DIR is missing.
        return;
    };
    let bin = PathBuf::from(ffmpeg_dir).join("bin");
    let out_dir = PathBuf::from(env::var("OUT_DIR").expect("cargo sets OUT_DIR"));
    // OUT_DIR is <target>/<profile>/build/<pkg>-<hash>/out; the binary lives in <target>/<profile>.
    let profile_dir = out_dir
        .ancestors()
        .nth(3)
        .expect("OUT_DIR has the cargo layout")
        .to_path_buf();
    let entries = fs::read_dir(&bin)
        .unwrap_or_else(|error| panic!("cannot read FFmpeg 9 bin dir {}: {error}", bin.display()));
    for entry in entries {
        let path = entry.expect("FFmpeg 9 bin dir entry").path();
        let is_dll = path
            .extension()
            .is_some_and(|extension| extension.eq_ignore_ascii_case("dll"));
        if !is_dll {
            continue;
        }
        println!("cargo:rerun-if-changed={}", path.display());
        let target = profile_dir.join(path.file_name().expect("dll has a file name"));
        fs::copy(&path, &target).unwrap_or_else(|error| {
            panic!(
                "cannot copy {} to {}: {error}",
                path.display(),
                target.display()
            )
        });
    }
}
