function storageKey(accountEmail: string) {
  return `nordiee.libraryFavorites.${accountEmail.trim().toLocaleLowerCase()}`;
}

export function readLibraryFavorites(accountEmail: string): string[] {
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey(accountEmail)) ?? "[]");
    return Array.isArray(saved) ? saved.filter((gameId): gameId is string => typeof gameId === "string") : [];
  } catch {
    return [];
  }
}

export function toggleLibraryFavorite(accountEmail: string, gameId: string) {
  const current = readLibraryFavorites(accountEmail);
  const next = current.includes(gameId) ? current.filter((id) => id !== gameId) : [...current, gameId];
  localStorage.setItem(storageKey(accountEmail), JSON.stringify(next));
  return next;
}
