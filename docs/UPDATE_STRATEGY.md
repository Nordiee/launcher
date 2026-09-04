# Nordiee launcher update policy

This is a release requirement, not an optional feature.

## User flow

1. On every launcher start, before the account screen is shown, the updater checks the signed Nordiee update feed over HTTPS.
2. If no update exists, the launcher continues normally.
3. If an update exists, it shows version and release notes, then downloads it in the background.
4. The launcher never interrupts an active game, install, repair or file verification. It marks the update as ready instead.
5. On the next safe launcher exit or startup, the updater closes Nordiee and applies the signed Windows package.
6. The launcher opens at the new version. Players never need to uninstall or download the launcher again.

## Technical implementation

- Tauri updater checks before the account screen. When a newer signed package exists, it downloads and installs before launcher access is allowed.
- Windows uses the passive installer mode so the update shows a small progress window without manual setup steps.
- Every release artifact is signed with the Nordiee private updater key. The public key is embedded in `tauri.conf.json`.
- The update feed is served from `https://github.com/Nordiee/launcher/releases/latest/download/latest.json`.
- The private signing key must be stored only in GitHub Actions secrets. It must never be committed to this repository or sent to the launcher.
- Release CI publishes the NSIS updater artifact, its `.sig` signature and `latest.json` together.

## Before first public release

1. Build a signed test update from `0.1.0` to `0.1.1` and verify it installs on a clean Windows machine.

## Account gate

The launcher shell is never rendered for an anonymous user. Account access uses the Nordiee backend session API. Refresh tokens must be stored in OS-backed secure storage, not browser local storage. The account menu supports Switch account, Log off and Remove this account.
