export type RecentGame = { id: string; title: string; lastPlayedAt: number };

function storageKey(accountEmail: string) {
  return `nordiee.recentGames.${accountEmail.trim().toLocaleLowerCase()}`;
}

export function readRecentGames(accountEmail: string): RecentGame[] {
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey(accountEmail)) ?? "[]") as RecentGame[];
    return Array.isArray(saved) ? saved.filter((game) => typeof game.id === "string" && typeof game.title === "string" && typeof game.lastPlayedAt === "number").slice(0, 8) : [];
  } catch {
    return [];
  }
}

export function recordRecentGame(accountEmail: string, game: Omit<RecentGame, "lastPlayedAt">) {
  const next = [{ ...game, lastPlayedAt: Date.now() }, ...readRecentGames(accountEmail).filter((recent) => recent.id !== game.id)].slice(0, 8);
  localStorage.setItem(storageKey(accountEmail), JSON.stringify(next));
  return next;
}

export function clearRecentGames(accountEmail: string) {
  localStorage.removeItem(storageKey(accountEmail));
  return [];
}
