import { check } from "@tauri-apps/plugin-updater";

export type UpdateState = "checking" | "installing" | "ready";
export type ManualUpdateState = "idle" | "checking" | "latest" | "installing" | "unavailable";

export async function applyAvailableUpdate(onState: (state: UpdateState) => void) {
  if (!("__TAURI_INTERNALS__" in window)) {
    onState("ready");
    return;
  }

  try {
    const update = await check();
    if (!update) {
      onState("ready");
      return;
    }

    onState("installing");
    await update.downloadAndInstall();
  } catch {
    // The account gate remains available when the release feed is temporarily offline.
    onState("ready");
  }
}

export async function checkForLauncherUpdate(onState: (state: ManualUpdateState) => void) {
  if (!("__TAURI_INTERNALS__" in window)) {
    onState("unavailable");
    return;
  }
  onState("checking");
  try {
    const update = await check();
    if (!update) {
      onState("latest");
      return;
    }
    onState("installing");
    await update.downloadAndInstall();
  } catch {
    onState("unavailable");
  }
}
