import { invoke } from "@tauri-apps/api/core";

export type SavedAccount = { displayName: string; email: string };
export type AccountSecret = { accessToken: string; refreshToken: string };
export type LegacySession = SavedAccount & AccountSecret;

const ACCOUNTS_KEY = "nordiee.accounts.v2";
const ACTIVE_ACCOUNT_KEY = "nordiee.active-account.v2";
const LEGACY_ACCOUNTS_KEY = "nordiee.accounts.v1";
const LEGACY_ACTIVE_KEY = "nordiee.account-session.v1";
const isNative = "__TAURI_INTERNALS__" in window;

function readJson<T>(key: string): T | null {
  try { const value = localStorage.getItem(key); return value ? JSON.parse(value) as T : null; } catch { return null; }
}

function validLegacy(value: unknown): value is LegacySession {
  const account = value as Partial<LegacySession> | null;
  return Boolean(account?.displayName && account.email && account.accessToken && account.refreshToken);
}

export function listSavedAccounts(): SavedAccount[] {
  const accounts = readJson<unknown[]>(ACCOUNTS_KEY);
  return Array.isArray(accounts) ? accounts.filter((account): account is SavedAccount => {
    const candidate = account as Partial<SavedAccount> | null;
    return Boolean(candidate?.displayName && candidate.email);
  }) : [];
}

export function activeAccountEmail(): string | null { return localStorage.getItem(ACTIVE_ACCOUNT_KEY); }

async function saveSecret(email: string, secret: AccountSecret) {
  const serialized = JSON.stringify(secret);
  if (isNative) await invoke("save_account_secret", { email, secret: serialized });
  else localStorage.setItem(`nordiee.dev-secret.${email}`, serialized);
}

async function loadSecret(email: string): Promise<AccountSecret | null> {
  const serialized = isNative ? await invoke<string | null>("load_account_secret", { email }) : localStorage.getItem(`nordiee.dev-secret.${email}`);
  if (!serialized) return null;
  const value = JSON.parse(serialized) as Partial<AccountSecret>;
  return value.accessToken && value.refreshToken ? value as AccountSecret : null;
}

async function removeSecret(email: string) {
  if (isNative) await invoke("remove_account_secret", { email });
  else localStorage.removeItem(`nordiee.dev-secret.${email}`);
}

export async function migrateLegacyAccounts() {
  if (localStorage.getItem(ACCOUNTS_KEY)) return;
  const legacyAccounts = readJson<unknown[]>(LEGACY_ACCOUNTS_KEY) ?? [readJson<unknown>(LEGACY_ACTIVE_KEY)].filter(Boolean);
  const validAccounts = legacyAccounts.filter(validLegacy);
  for (const account of validAccounts) await saveSecret(account.email, account);
  localStorage.setItem(ACCOUNTS_KEY, JSON.stringify(validAccounts.map(({ displayName, email }) => ({ displayName, email }))));
  const active = readJson<unknown>(LEGACY_ACTIVE_KEY);
  if (validLegacy(active)) localStorage.setItem(ACTIVE_ACCOUNT_KEY, active.email);
  localStorage.removeItem(LEGACY_ACCOUNTS_KEY);
  localStorage.removeItem(LEGACY_ACTIVE_KEY);
}

export async function saveAccountSession(account: SavedAccount, secret: AccountSecret) {
  await saveSecret(account.email, secret);
  const others = listSavedAccounts().filter((candidate) => candidate.email.toLowerCase() !== account.email.toLowerCase());
  localStorage.setItem(ACCOUNTS_KEY, JSON.stringify([account, ...others]));
  localStorage.setItem(ACTIVE_ACCOUNT_KEY, account.email);
}

export async function getAccountSession(email: string): Promise<LegacySession | null> {
  const account = listSavedAccounts().find((candidate) => candidate.email.toLowerCase() === email.toLowerCase());
  const secret = await loadSecret(email);
  return account && secret ? { ...account, ...secret } : null;
}

export function clearActiveAccount() { localStorage.removeItem(ACTIVE_ACCOUNT_KEY); }

export async function removeSavedAccount(email: string) {
  await removeSecret(email);
  localStorage.setItem(ACCOUNTS_KEY, JSON.stringify(listSavedAccounts().filter((account) => account.email.toLowerCase() !== email.toLowerCase())));
  if (activeAccountEmail()?.toLowerCase() === email.toLowerCase()) clearActiveAccount();
}
