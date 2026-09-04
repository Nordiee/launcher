# Nordiee Launcher

Desktop launcher built with Tauri 2, React, TypeScript and Vite. The framework-independent Rust core is in `crates/nordiee-core`.

## Current scope

- Secure account sign-in, saved-account switching and OS credential storage
- Custom Tauri window chrome, self-updating signed Windows releases and manual update checks
- Library search, filters, Favorites, per-game update preferences and launch options
- Manifest installs, resumable downloads, queue ordering, disk checks, verify, repair and uninstall
- Offline cached library, recent games, local playtime and download recovery per account
- Live API health, diagnostics export and notification center
- Windows path validation that blocks manifest files from writing outside a game folder

## Verification

```powershell
npm run build
Set-Location src-tauri
cargo test
```

Every push to `main` also runs the same frontend build and Rust tests on a GitHub Windows runner. Tagged `v*` releases run Rust tests before producing the signed NSIS updater artifacts.

## Release

1. Update the version in `package.json`, `src-tauri/Cargo.toml` and `src-tauri/tauri.conf.json`.
2. Run the verification commands above.
3. Commit the version update, push `main`, then create and push an annotated `vX.Y.Z` tag.
4. GitHub creates the signed Windows release and updater manifest.

## Run locally

```powershell
npm install
npm run tauri dev
```

Windows build prerequisites for Tauri must be installed before the first native build.
