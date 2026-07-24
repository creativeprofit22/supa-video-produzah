# Desktop application

The desktop package contains the React workspace and the Tauri v2 Rust boundary for Supa Video Producer.

```sh
pnpm --dir apps/desktop dev
pnpm --dir apps/desktop tauri dev
```

The browser dev server is useful for injected-backend UI tests. File dialogs, media preparation, project persistence, and rendering are available only through the Tauri runtime.
