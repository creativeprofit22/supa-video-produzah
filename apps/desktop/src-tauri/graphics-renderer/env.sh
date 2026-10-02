# Source from bash (Git Bash on Windows) before cargo commands in this crate:
#   source apps/desktop/src-tauri/graphics-renderer/env.sh
# Exports FFMPEG_DIR, LIBCLANG_PATH and puts the FFmpeg 9 DLLs and libclang on PATH.
_graphics_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
while IFS='=' read -r _key _value; do
  _value="${_value%$'\r'}"
  [ -n "$_key" ] && export "$_key=$_value"
done < <(powershell -NoProfile -ExecutionPolicy Bypass -File "$_graphics_root/scripts/bootstrap-graphics-renderer-windows.ps1" -EnvOnly)
export PATH="$(cygpath "$FFMPEG9_BIN"):$(cygpath "$LIBCLANG_PATH"):$PATH"
unset _graphics_root _key _value
