export type PlaytimeByGame = Record<string, number>;

function storageKey(accountEmail: string) {
  return `nordiee.playtime.${accountEmail.trim().toLocaleLowerCase()}`;
}

export function readPlaytime(accountEmail: string): PlaytimeByGame {
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey(accountEmail)) ?? "{}") as PlaytimeByGame;
    return Object.fromEntries(Object.entries(saved).filter(([, seconds]) => typeof seconds === "number" && Number.isFinite(seconds) && seconds >= 0));
  } catch {
    return {};
  }
}

export function addPlaytime(accountEmail: string, gameId: string, seconds: number) {
  const current = readPlaytime(accountEmail);
  const next = { ...current, [gameId]: (current[gameId] ?? 0) + Math.max(0, Math.round(seconds)) };
  localStorage.setItem(storageKey(accountEmail), JSON.stringify(next));
  return next;
}
