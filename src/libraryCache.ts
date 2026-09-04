export type LibraryGame = { id: string; title: string; installState: string; installSizeBytes: number };

type LibraryCache = { savedAt: string; games: LibraryGame[] };
const CACHE_PREFIX = "nordiee.library-cache.v1:";

function cacheKey(email: string) {
  return `${CACHE_PREFIX}${email.trim().toLowerCase()}`;
}

export function readLibraryCache(email: string): LibraryCache | null {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(cacheKey(email)) ?? "null");
    if (!parsed || typeof parsed !== "object") return null;
    const cache = parsed as Partial<LibraryCache>;
    if (typeof cache.savedAt !== "string" || !Array.isArray(cache.games)) return null;
    if (!cache.games.every((game) => game && typeof game.id === "string" && typeof game.title === "string" && typeof game.installState === "string" && typeof game.installSizeBytes === "number")) return null;
    return cache as LibraryCache;
  } catch { return null; }
}

export function saveLibraryCache(email: string, games: LibraryGame[]) {
  localStorage.setItem(cacheKey(email), JSON.stringify({ savedAt: new Date().toISOString(), games } satisfies LibraryCache));
}
