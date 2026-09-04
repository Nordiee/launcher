# Nordiee Launcher

Desktop launcher built with Tauri 2, React, TypeScript and Vite. The framework-independent Rust core is in `crates/nordiee-core`.

## Current scope

- Desktop shell and keyboard-accessible launcher navigation
- Nordiee visual tokens: `#10141A`, `#161B22`, `#79C7FF`, `#E05D5D`
- Empty states for library and downloads
- Tauri bridge prepared for core functionality

## Next milestones

1. Account session and backend API contract
2. Game manifest format and local install registry
3. Download engine with persistent progress
4. Verify, repair and game launch flow

## Run locally

```powershell
npm install
npm run tauri dev
```

Windows build prerequisites for Tauri must be installed before the first native build.
