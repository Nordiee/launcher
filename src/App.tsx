import { FormEvent, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { AccountIcon, ArrowRightIcon, BellIcon, ChevronDownIcon, CloseIcon, DownloadIcon, HomeIcon, LibraryIcon, MaximizeIcon, MinimizeIcon, PauseIcon, PlayIcon, PlusIcon, SettingsIcon, TrashIcon } from "./Icons";
import { activeAccountEmail, clearActiveAccount, getAccountSession, listSavedAccounts, migrateLegacyAccounts, removeSavedAccount, saveAccountSession, type AccountSecret, type SavedAccount } from "./accountStore";
import { readLibraryCache, saveLibraryCache, type LibraryGame } from "./libraryCache";
import { applyAvailableUpdate, checkForLauncherUpdate, type ManualUpdateState, type UpdateState } from "./updates";
import { readNotifications, saveNotifications, type LauncherNotification } from "./notificationStore";
import { activateTransferQueue, clearTransferQueue as clearQueuedTransfers, enqueueTransfer as enqueueQueuedTransfer, listenForTransferQueue, moveTransferInQueue, readTransferQueue, removeTransferFromQueue, takeNextTransfer, type QueuedTransfer, type TransferKind } from "./transferQueue";
import { clearRecentGames, readRecentGames, recordRecentGame, type RecentGame } from "./recentGames";
import { readLibraryFavorites, toggleLibraryFavorite } from "./libraryFavorites";
import { addPlaytime, readPlaytime, type PlaytimeByGame } from "./playtimeStore";

type View = "Home" | "Library" | "Downloads" | "Friends" | "Profile" | "Settings";
type AuthMode = "sign-in" | "sign-up";
type Session = SavedAccount & AccountSecret;
type AuthResponse = { accessToken: string; refreshToken: string; username: string; email: string };
type AccessView = "accounts" | "credentials";
type VerificationState = "verifying" | "verified" | "repair";
type DownloadActivity = { gameId: string; title: string; phase: string; downloadedBytes?: number; totalBytes?: number; speedBytesPerSecond?: number; sampledAt?: number };
type DiagnosticResult = "idle" | "checking" | "pass" | "fail";
type NotificationKind = LauncherNotification["kind"];
type ServiceStatus = "checking" | "operational" | "unavailable";
type LibraryFilter = "all" | "installed" | "not-installed" | "favorites" | "recent";
type GameUpdateMode = "always" | "on-launch" | "never";
type LibrarySort = "title" | "installed" | "favorites" | "recent" | "playtime";
const API_BASE_URL = "https://api.nordiee.com/api/v1/auth";
const LIBRARY_API_URL = "https://api.nordiee.com/api/v1/library";
const FRIENDS_API_URL = "https://api.nordiee.com/api/v1/friends";
const PROFILE_API_URL = "https://api.nordiee.com/api/v1/profile";
const HEALTH_API_URL = "https://api.nordiee.com/health";

async function installRoot() {
  const saved = localStorage.getItem("nordiee.installRoot");
  return saved?.trim() || invoke<string>("default_install_root");
}

async function installRoots() {
  try {
    const saved = JSON.parse(localStorage.getItem("nordiee.installRoots") ?? "[]") as unknown;
    if (Array.isArray(saved)) {
      const roots = [...new Set(saved.filter((root): root is string => typeof root === "string" && root.trim().length > 0).map((root) => root.trim()))];
      if (roots.length) return roots;
    }
  } catch { /* fall back to the legacy location */ }
  const legacyRoot = await installRoot();
  localStorage.setItem("nordiee.installRoots", JSON.stringify([legacyRoot]));
  return [legacyRoot];
}

function rememberInstallRoot(root: string) {
  const normalized = root.trim();
  if (!normalized) return;
  void installRoots().then((roots) => localStorage.setItem("nordiee.installRoots", JSON.stringify([...new Set([...roots, normalized])])));
}

function readGameInstallRoots(email: string): Record<string, string> {
  try { return JSON.parse(localStorage.getItem(`nordiee.gameInstallRoots.${email.toLocaleLowerCase()}`) ?? "{}"); }
  catch { return {}; }
}

function configuredDownloadLimitMbps(): number | null {
  const value = Number(localStorage.getItem("nordiee.downloadLimitMbps"));
  return [10, 25, 50, 100].includes(value) ? value : null;
}

function parseLaunchOptions(value: string): string[] {
  return (value.match(/(?:[^\s"]+|"[^"]*")+/g) ?? []).map((part) => part.startsWith('"') && part.endsWith('"') ? part.slice(1, -1) : part);
}

function updateSummary(version: string, changedFiles: number) {
  return `${changedFiles} ${changedFiles === 1 ? "file" : "files"} updated to ${version}.`;
}

const navigation: { label: View; icon: ReactNode }[] = [
  { label: "Home", icon: <HomeIcon /> },
  { label: "Library", icon: <LibraryIcon /> },
  { label: "Downloads", icon: <DownloadIcon /> },
  { label: "Friends", icon: <AccountIcon /> },
];

function toSession(response: AuthResponse): Session {
  return { displayName: response.username, email: response.email, accessToken: response.accessToken, refreshToken: response.refreshToken };
}

function notificationTime(createdAt: number) {
  const elapsed = Math.max(0, Date.now() - createdAt);
  if (elapsed < 60_000) return "Just now";
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m ago`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)}h ago`;
  return `${Math.floor(elapsed / 86_400_000)}d ago`;
}

export default function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [accounts, setAccounts] = useState<SavedAccount[]>(listSavedAccounts);
  const [updateState, setUpdateState] = useState<UpdateState>("checking");
  const [sessionReady, setSessionReady] = useState(false);
  const [accessView, setAccessView] = useState<AccessView>(accounts.length ? "accounts" : "credentials");
  const [prefilledEmail, setPrefilledEmail] = useState("");
  useEffect(() => { void applyAvailableUpdate(setUpdateState); }, []);
  useEffect(() => {
    const restoreSession = async () => {
      try {
        await migrateLegacyAccounts();
        const savedAccounts = listSavedAccounts();
        setAccounts(savedAccounts);
        const activeEmail = activeAccountEmail();
        if (!activeEmail) return;
        const stored = await getAccountSession(activeEmail);
        if (!stored) { clearActiveAccount(); return; }
        const response = await fetch(`${API_BASE_URL}/refresh`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ refreshToken: stored.refreshToken }) });
        const body = await response.json() as AuthResponse & { error?: string };
        if (!response.ok) throw new Error(body.error ?? "Session expired");
        const nextSession = toSession(body);
        await saveAccountSession(nextSession, nextSession);
        setAccounts(listSavedAccounts());
        setSession(nextSession);
      } catch {
        clearActiveAccount();
      } finally {
        setSessionReady(true);
      }
    };
    void restoreSession();
  }, []);
  const endRemoteSession = async (currentSession: Session) => {
    void fetch(`${API_BASE_URL}/logout`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${currentSession.accessToken}` }, body: JSON.stringify({ refreshToken: currentSession.refreshToken }) });
  };
  const logOff = async () => {
    const currentSession = session;
    clearActiveAccount();
    setSession(null);
    setAccessView("accounts");
    if (currentSession) await endRemoteSession(currentSession);
  };
  const switchAccount = () => { clearActiveAccount(); setSession(null); setAccessView("accounts"); };
  const removeAccount = async (account: SavedAccount) => { const savedSession = await getAccountSession(account.email); await removeSavedAccount(account.email); const remaining = listSavedAccounts(); setAccounts(remaining); if (session?.email === account.email) setSession(null); if (savedSession) await endRemoteSession(savedSession); setAccessView(remaining.length ? "accounts" : "credentials"); };
  const removeAllAccounts = async () => {
    const savedAccounts = listSavedAccounts();
    for (const account of savedAccounts) {
      const savedSession = await getAccountSession(account.email);
      await removeSavedAccount(account.email);
      if (savedSession) await endRemoteSession(savedSession);
    }
    clearActiveAccount();
    setAccounts([]);
    setSession(null);
    setAccessView("credentials");
  };
  const startSession = async (nextSession: Session) => { await saveAccountSession(nextSession, nextSession); setAccounts(listSavedAccounts()); setSession(nextSession); };
  const selectAccount = async (account: SavedAccount) => {
    const savedSession = await getAccountSession(account.email);
    if (!savedSession) { clearActiveAccount(); setPrefilledEmail(account.email); setAccessView("credentials"); return; }
    const response = await fetch(`${API_BASE_URL}/refresh`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ refreshToken: savedSession.refreshToken }) });
    const body = await response.json() as AuthResponse & { error?: string };
    if (!response.ok) { clearActiveAccount(); setPrefilledEmail(account.email); setAccessView("credentials"); return; }
    await startSession(toSession(body));
  };
  return <div className="app-window"><Titlebar />{updateState !== "ready" ? <UpdateGate state={updateState} /> : !sessionReady ? <StartupGate /> : session ? <Launcher session={session} onSwitchAccount={switchAccount} onLogOff={logOff} onRemoveAccount={removeAccount} /> : accessView === "accounts" && accounts.length ? <AccountPicker accounts={accounts} onSelect={selectAccount} onAdd={() => setAccessView("credentials")} onRemove={removeAccount} onRemoveAll={removeAllAccounts} /> : <AuthScreen initialEmail={prefilledEmail} onBack={accounts.length ? () => setAccessView("accounts") : undefined} onSession={startSession} />}</div>;
}

function UpdateGate({ state }: { state: UpdateState }) { return <StartupScreen label={state === "checking" ? "STARTUP CHECK" : "UPDATE READY"} title={state === "checking" ? "Preparing Nordiee" : "Installing the latest build"} text={state === "checking" ? "Checking your launcher version before we let you in." : "Your update is being verified and installed. Nordiee will reopen automatically."} activeStep={state === "checking" ? 1 : 2} />; }
function StartupGate() { return <StartupScreen label="ACCOUNT SESSION" title="Restoring your session" text="Verifying your saved Nordiee account." activeStep={2} />; }

function Titlebar() {
  const appWindow = getCurrentWindow();
  return <header className="titlebar" data-tauri-drag-region>
    <div className="titlebar-brand" data-tauri-drag-region><img src="/logo.svg" alt="" /><span data-tauri-drag-region>NORDIEE</span></div>
    <div className="window-controls" aria-label="Window controls">
      <button type="button" aria-label="Minimize launcher" onClick={() => appWindow.minimize()}><MinimizeIcon /></button>
      <button type="button" aria-label="Maximize or restore launcher" onClick={() => appWindow.toggleMaximize()}><MaximizeIcon /></button>
      <button className="close-control" type="button" aria-label="Close launcher" onClick={() => appWindow.close()}><CloseIcon /></button>
    </div>
  </header>;
}

function StartupScreen({ label, title, text, activeStep }: { label: string; title: string; text: string; activeStep: 1 | 2 }) {
  return <main className="startup-shell"><section className="startup-card" aria-live="polite"><div className="startup-brand"><img src="/logo.svg" alt="Nordiee" /><span>NORDIEE</span></div><div className="startup-orbit" aria-hidden="true"><span /><span /><i /></div><p className="eyebrow">{label}</p><h1>{title}</h1><p className="startup-copy">{text}</p><div className="startup-steps"><div className={activeStep >= 1 ? "complete" : ""}><span>01</span><p>Check build</p></div><div className={activeStep >= 2 ? "complete" : ""}><span>02</span><p>Open launcher</p></div></div></section><p className="startup-footer">NORDIEE LAUNCHER <span>•</span> SYSTEM READY</p></main>;
}

function AccountPicker({ accounts, onSelect, onAdd, onRemove, onRemoveAll }: { accounts: SavedAccount[]; onSelect: (account: SavedAccount) => Promise<void>; onAdd: () => void; onRemove: (account: SavedAccount) => Promise<void>; onRemoveAll: () => Promise<void> }) {
  const [busyEmail, setBusyEmail] = useState<string | null>(null);
  const [removingAll, setRemovingAll] = useState(false);
  const [message, setMessage] = useState("");
  const choose = async (account: SavedAccount) => { setMessage(""); setBusyEmail(account.email); try { await onSelect(account); } catch { setMessage("We could not reach Nordiee accounts. Check your connection and try again."); } finally { setBusyEmail(null); } };
  const remove = async (account: SavedAccount) => { if (!window.confirm(`Remove ${account.displayName} from this computer?`)) return; setBusyEmail(account.email); try { await onRemove(account); } finally { setBusyEmail(null); } };
  const removeAll = async () => { if (!window.confirm("Remove every Nordiee account from this computer? You will need to sign in again.")) return; setRemovingAll(true); try { await onRemoveAll(); } finally { setRemovingAll(false); } };
  const busy = busyEmail !== null || removingAll;
  return <main className="account-picker"><section className="account-picker-card" aria-labelledby="choose-account-title"><div className="picker-heading"><img src="/logo.svg" alt="Nordiee" /><div><p className="eyebrow">NORDIEE LAUNCHER</p><h1 id="choose-account-title">Choose an account</h1><p>Accounts signed in on this computer.</p></div></div><div className="saved-accounts" role="list">{accounts.map((account) => <article className="saved-account" key={account.email} role="listitem"><button className="saved-account-main" type="button" disabled={busy} onClick={() => void choose(account)}><span className="account-avatar">{account.displayName[0]?.toUpperCase()}</span><span><strong>{account.displayName}</strong><small>{account.email}</small></span><ArrowRightIcon /></button><button className="remove-account" type="button" disabled={busy} aria-label={`Remove ${account.displayName} from this computer`} onClick={() => void remove(account)}><TrashIcon /></button>{busyEmail === account.email && <span className="account-working">Connecting</span>}</article>)}</div>{message && <p className="picker-message" role="alert">{message}</p>}<button className="add-account" type="button" disabled={busy} onClick={onAdd}><PlusIcon />Sign in with another account</button><button className="remove-all-accounts" type="button" disabled={busy} onClick={() => void removeAll()}>{removingAll ? "Removing accounts" : "Remove all accounts from this computer"}</button></section></main>;
}

function AuthScreen({ initialEmail, onBack, onSession }: { initialEmail: string; onBack?: () => void; onSession: (session: Session) => Promise<void> }) {
  const [mode, setMode] = useState<AuthMode>("sign-in");
  const [message, setMessage] = useState("");
  const changeMode = (next: AuthMode) => { setMode(next); setMessage(""); };
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const payload = { email: String(data.get("email")), password: String(data.get("password")), username: mode === "sign-up" ? String(data.get("display-name")) : undefined };
    try {
      const response = await fetch(`${API_BASE_URL}/${mode === "sign-in" ? "login" : "signup"}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      const body = await response.json() as AuthResponse & { error?: string };
      if (!response.ok) throw new Error(body.error ?? "Unable to authenticate");
      await onSession(toSession(body));
    } catch (error) { setMessage(error instanceof Error ? error.message : "Unable to reach Nordiee accounts."); }
  };
  return <main className="auth-shell">
    <section className="auth-intro"><img src="/logo.svg" alt="Nordiee" className="auth-logo" /><p className="eyebrow">NORDIEE LAUNCHER</p><h1>Everything you play, in one place.</h1><p>Sign in to access your library, installations and downloads. Launcher access stays locked until an account session is verified.</p><div className="auth-status"><span /> Secure account access</div></section>
    <section className="auth-panel" aria-labelledby="auth-heading">
      <div className="auth-tabs" role="tablist" aria-label="Account access"><button className={mode === "sign-in" ? "active" : ""} type="button" role="tab" aria-selected={mode === "sign-in"} onClick={() => changeMode("sign-in")}>Sign in</button><button className={mode === "sign-up" ? "active" : ""} type="button" role="tab" aria-selected={mode === "sign-up"} onClick={() => changeMode("sign-up")}>Create account</button></div>
      <div className="auth-form-wrap"><p className="eyebrow">{mode === "sign-in" ? "WELCOME BACK" : "JOIN NORDIEE"}</p><h2 id="auth-heading">{mode === "sign-in" ? "Sign in to Nordiee" : "Create your account"}</h2><p className="auth-copy">{mode === "sign-in" ? "Use your Nordiee account to continue." : "Your library will be ready when you are."}</p>
        <form onSubmit={submit}>{mode === "sign-up" && <label>Display name<input name="display-name" autoComplete="nickname" required minLength={3} placeholder="Your Nordiee name" /></label>}<label>Email<input name="email" type="email" autoComplete="email" required defaultValue={initialEmail} placeholder="you@example.com" /></label><label>Password<input name="password" type="password" autoComplete={mode === "sign-in" ? "current-password" : "new-password"} required minLength={8} placeholder="At least 8 characters" /></label>{message && <p className="auth-message" role="status">{message}</p>}<button className="primary-button auth-submit" type="submit">{mode === "sign-in" ? "Sign in" : "Create account"}</button></form>
        <p className="auth-switch">{mode === "sign-in" ? "New to Nordiee?" : "Already have an account?"} <button type="button" onClick={() => changeMode(mode === "sign-in" ? "sign-up" : "sign-in")}>{mode === "sign-in" ? "Create one" : "Sign in"}</button>{onBack && <><span> · </span><button type="button" onClick={onBack}>Back to accounts</button></>}</p>
      </div>
    </section>
  </main>;
}

function Launcher({ session, onSwitchAccount, onLogOff, onRemoveAccount }: { session: Session; onSwitchAccount: () => void; onLogOff: () => void; onRemoveAccount: (account: SavedAccount) => Promise<void> }) {
  const [view, setView] = useState<View>("Home");
  const [librarySearchRequest, setLibrarySearchRequest] = useState(0);
  const [accountOpen, setAccountOpen] = useState(false);
  const [download, setDownload] = useState<DownloadActivity | null>(null);
  const [downloadsPaused, setDownloadsPaused] = useState(false);
  const [runningGameIds, setRunningGameIds] = useState<string[]>([]);
  const [notifications, setNotifications] = useState<LauncherNotification[]>(readNotifications);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [queuedTransfers, setQueuedTransfers] = useState<QueuedTransfer[]>(readTransferQueue);
  const [serviceStatus, setServiceStatus] = useState<ServiceStatus>("checking");
  const [recentGames, setRecentGames] = useState<RecentGame[]>(() => readRecentGames(session.email));
  const [favoriteGameIds, setFavoriteGameIds] = useState<string[]>(() => readLibraryFavorites(session.email));
  const [playtimeByGame, setPlaytimeByGame] = useState<PlaytimeByGame>(() => readPlaytime(session.email));
  const [pauseDownloadsWhilePlaying, setPauseDownloadsWhilePlaying] = useState(() => localStorage.getItem("nordiee.pauseDownloadsWhilePlaying") === "true");
  const [manualUpdateState, setManualUpdateState] = useState<ManualUpdateState>("idle");
  const [launcherNotificationsEnabled, setLauncherNotificationsEnabled] = useState(() => localStorage.getItem("nordiee.launcherNotifications") !== "false");
  const [reduceMotion, setReduceMotion] = useState(() => localStorage.getItem("nordiee.reduceMotion") === "true" || window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  const autoPausedForGameRef = useRef(false);
  const gameStartedAtRef = useRef<Record<string, number>>({});
  const knownFriendRequestIdsRef = useRef<Set<string> | null>(null);
  const addNotification = useCallback((title: string, message: string, kind: NotificationKind = "info", action?: LauncherNotification["action"]) => {
    if (!launcherNotificationsEnabled) return;
    setNotifications((current) => {
    const next = [{ id: crypto.randomUUID(), title, message, kind, action, createdAt: Date.now(), read: false }, ...current].slice(0, 30);
    saveNotifications(next);
    return next;
    });
  }, [launcherNotificationsEnabled]);
  const markNotificationsRead = useCallback(() => setNotifications((current) => {
    const next = current.map((notification) => ({ ...notification, read: true }));
    saveNotifications(next);
    return next;
  }), []);
  const clearNotifications = useCallback(() => { setNotifications([]); saveNotifications([]); }, []);
  useEffect(() => {
    const openLibrarySearch = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLocaleLowerCase() === "k") {
        event.preventDefault();
        setView("Library");
        setLibrarySearchRequest((current) => current + 1);
      }
    };
    window.addEventListener("keydown", openLibrarySearch);
    return () => window.removeEventListener("keydown", openLibrarySearch);
  }, []);
  useEffect(() => {
    const unlisten = listen<{ gameId: string; downloadedBytes: number; totalBytes: number }>("game-download-progress", (event) => setDownload((current) => {
      const now = Date.now();
      const isSameGame = current?.gameId === event.payload.gameId;
      const elapsed = isSameGame && current.sampledAt ? now - current.sampledAt : 0;
      const speedBytesPerSecond = elapsed > 0 && isSameGame && current.downloadedBytes !== undefined ? Math.max(0, (event.payload.downloadedBytes - current.downloadedBytes) * 1000 / elapsed) : current?.speedBytesPerSecond;
      return { ...event.payload, title: isSameGame ? current.title : event.payload.gameId, phase: current?.phase ?? "Downloading", speedBytesPerSecond, sampledAt: now };
    }));
    return () => { void unlisten.then((cleanup) => cleanup()); };
  }, []);
  useEffect(() => {
    const unlisten = listen<{ gameId: string; running: boolean }>("game-running-state", (event) => {
      setRunningGameIds((current) => event.payload.running ? [...new Set([...current, event.payload.gameId])] : current.filter((id) => id !== event.payload.gameId));
      if (event.payload.running) gameStartedAtRef.current[event.payload.gameId] = Date.now();
      else {
        const startedAt = gameStartedAtRef.current[event.payload.gameId];
        delete gameStartedAtRef.current[event.payload.gameId];
        if (startedAt) setPlaytimeByGame(addPlaytime(session.email, event.payload.gameId, (Date.now() - startedAt) / 1_000));
      }
    });
    return () => { void unlisten.then((cleanup) => cleanup()); };
  }, [session.email]);
  useEffect(() => {
    const interval = window.setInterval(() => {
      const now = Date.now();
      for (const [gameId, startedAt] of Object.entries(gameStartedAtRef.current)) {
        gameStartedAtRef.current[gameId] = now;
        setPlaytimeByGame(addPlaytime(session.email, gameId, (now - startedAt) / 1_000));
      }
    }, 60_000);
    return () => window.clearInterval(interval);
  }, [session.email]);
  useEffect(() => {
    const shouldPause = pauseDownloadsWhilePlaying && runningGameIds.length > 0;
    if (shouldPause && download && !downloadsPaused) {
      autoPausedForGameRef.current = true;
      setDownloadsPaused(true);
      void invoke("pause_downloads").catch(() => { autoPausedForGameRef.current = false; setDownloadsPaused(false); });
    } else if (!shouldPause && autoPausedForGameRef.current) {
      autoPausedForGameRef.current = false;
      setDownloadsPaused(false);
      void invoke("resume_downloads").catch(() => setDownloadsPaused(true));
    }
  }, [download, downloadsPaused, pauseDownloadsWhilePlaying, runningGameIds.length]);
  useEffect(() => listenForTransferQueue(setQueuedTransfers), []);
  useEffect(() => {
    const restoredQueue = activateTransferQueue(session.email);
    setQueuedTransfers(restoredQueue);
    if (restoredQueue.length) addNotification("Transfer queue restored", `${restoredQueue.length} ${restoredQueue.length === 1 ? "game is" : "games are"} ready to resume.`, "info");
  }, [addNotification, session.email]);
  useEffect(() => setRecentGames(readRecentGames(session.email)), [session.email]);
  useEffect(() => setFavoriteGameIds(readLibraryFavorites(session.email)), [session.email]);
  useEffect(() => setPlaytimeByGame(readPlaytime(session.email)), [session.email]);
  useEffect(() => {
    if (reduceMotion) document.documentElement.dataset.reduceMotion = "true";
    else delete document.documentElement.dataset.reduceMotion;
  }, [reduceMotion]);
  useEffect(() => {
    let active = true;
    const checkHealth = async () => {
      try {
        const response = await fetch(HEALTH_API_URL, { cache: "no-store" });
        if (!response.ok) throw new Error("Health check failed");
        if (active) setServiceStatus("operational");
      } catch {
        if (active) setServiceStatus("unavailable");
      }
    };
    void checkHealth();
    const interval = window.setInterval(() => void checkHealth(), 60_000);
    return () => { active = false; window.clearInterval(interval); };
  }, []);
  useEffect(() => {
    let active = true;
    const checkFriendRequests = async () => {
      try {
        const response = await fetch(`${FRIENDS_API_URL}/requests`, { headers: { Authorization: `Bearer ${session.accessToken}` } });
        if (!response.ok) return;
        const requests = await response.json() as IncomingFriendRequest[];
        const incomingIds = new Set(requests.map((request) => request.id));
        const known = knownFriendRequestIdsRef.current;
        if (known) for (const request of requests.filter((request) => !known.has(request.id))) addNotification("Friend request", `${request.from.username} sent you a friend request.`, "info", "friends");
        if (active) knownFriendRequestIdsRef.current = incomingIds;
      } catch { /* Friends stays available from its own screen when the API is offline. */ }
    };
    knownFriendRequestIdsRef.current = null;
    void checkFriendRequests();
    const interval = window.setInterval(() => void checkFriendRequests(), 60_000);
    return () => { active = false; window.clearInterval(interval); };
  }, [addNotification, session.accessToken]);
  useEffect(() => {
    const unlisten = listen<{ paused?: boolean; cancelled?: boolean }>("download-transfer-state", (event) => {
      if (event.payload.cancelled) { setDownloadsPaused(false); setDownload(null); }
      else if (event.payload.paused !== undefined) setDownloadsPaused(event.payload.paused);
    });
    return () => { void unlisten.then((cleanup) => cleanup()); };
  }, []);
  useEffect(() => {
    const unlisten = listen<{ gameId: string }>("game-download-complete", (event) => setDownload((current) => {
      if (current?.gameId === event.payload.gameId) {
        addNotification("Download complete", `${current.title} is ready in your library.`, "success");
        return null;
      }
      return current;
    }));
    return () => { void unlisten.then((cleanup) => cleanup()); };
  }, [addNotification]);
  const toggleDownloadsPaused = async () => {
    const next = !downloadsPaused;
    setDownloadsPaused(next);
    try { await invoke(next ? "pause_downloads" : "resume_downloads"); }
    catch { setDownloadsPaused(!next); }
  };
  const remove = async () => { if (!window.confirm(`Remove ${session.displayName} from this computer?`)) return; await onRemoveAccount(session); };
  const unreadCount = notifications.filter((notification) => !notification.read).length;
  const serviceLabel = serviceStatus === "checking" ? "Checking services" : serviceStatus === "operational" ? "Nordiee API online" : "Nordiee API unavailable";
  const savePauseDownloadsWhilePlaying = (enabled: boolean) => { setPauseDownloadsWhilePlaying(enabled); localStorage.setItem("nordiee.pauseDownloadsWhilePlaying", String(enabled)); };
  const saveLauncherNotificationsEnabled = (enabled: boolean) => { setLauncherNotificationsEnabled(enabled); localStorage.setItem("nordiee.launcherNotifications", String(enabled)); };
  const saveReduceMotion = (enabled: boolean) => { setReduceMotion(enabled); localStorage.setItem("nordiee.reduceMotion", String(enabled)); };
  if (view === "Friends") return <div className="launcher-shell"><a className="skip-link" href="#friends-content">Skip to content</a><aside className="sidebar" aria-label="Launcher navigation"><div className="sidebar-brand"><img src="/logo.svg" alt="Nordiee" /><span>NORDIEE</span></div><nav className="navigation">{navigation.map((item) => <button className={view === item.label ? "nav-item active" : "nav-item"} key={item.label} onClick={() => setView(item.label)} type="button"><span className="nav-icon">{item.icon}</span>{item.label}</button>)}</nav><div className="sidebar-bottom"><button className="nav-item" onClick={() => setView("Settings")} type="button"><span className="nav-icon"><SettingsIcon /></span>Settings</button></div></aside><Friends accessToken={session.accessToken} onBack={() => setView("Home")} /></div>;
  return <div className="launcher-shell">
    <a className="skip-link" href="#main-content">Skip to content</a>
    <aside className="sidebar" aria-label="Launcher navigation">
      <div className="sidebar-brand"><img src="/logo.svg" alt="Nordiee" /><span>NORDIEE</span></div>
      <nav className="navigation">{navigation.map((item) => <button className={view === item.label ? "nav-item active" : "nav-item"} key={item.label} onClick={() => setView(item.label)} type="button"><span className="nav-icon">{item.icon}</span>{item.label}</button>)}</nav>
      <div className="sidebar-bottom">
        <button className={view === "Settings" ? "nav-item active" : "nav-item"} onClick={() => setView("Settings")} type="button"><span className="nav-icon"><SettingsIcon /></span>Settings</button>
        <div className="account-menu"><button className="profile" type="button" aria-expanded={accountOpen} aria-haspopup="menu" onClick={() => setAccountOpen(!accountOpen)}><span className="avatar">{session.displayName[0]?.toUpperCase()}</span><span><strong>{session.displayName}</strong><small>{session.email}</small></span><ChevronDownIcon size={15} /></button>{accountOpen && <div className="account-popover" role="menu"><button type="button" role="menuitem" onClick={() => { setAccountOpen(false); setView("Profile"); }}>Profile</button><button type="button" role="menuitem" onClick={onSwitchAccount}>Switch account</button><button type="button" role="menuitem" onClick={() => void onLogOff()}>Log off</button><button className="danger-action" type="button" role="menuitem" onClick={() => void remove()}>Remove this account</button></div>}</div>
      </div>
    </aside>
    <main id="main-content" className="content" tabIndex={-1}>
      <header className="topbar"><div><p className="eyebrow">NORDIEE LAUNCHER</p><h1>{view}</h1></div><div className="topbar-actions"><div className={`service-status ${serviceStatus}`} role="status"><span /> {serviceLabel}</div><NotificationCenter notifications={notifications} open={notificationsOpen} unreadCount={unreadCount} onToggle={() => { const next = !notificationsOpen; setNotificationsOpen(next); if (next) markNotificationsRead(); }} onClear={clearNotifications} onOpenFriends={() => { setNotificationsOpen(false); setView("Friends"); }} /></div></header>
      {view === "Home" && <Home download={download} onClearRecent={() => setRecentGames(clearRecentGames(session.email))} playtimeByGame={playtimeByGame} queuedTransfers={queuedTransfers} recentGames={recentGames} onOpenLibrary={() => setView("Library")} onOpenDownloads={() => setView("Downloads")} />}
      {view === "Library" && <Library accessToken={session.accessToken} favoriteGameIds={favoriteGameIds} recentGames={recentGames} searchRequest={librarySearchRequest} playtimeByGame={playtimeByGame} onDownload={setDownload} onNotify={addNotification} onFavoriteToggle={(gameId) => setFavoriteGameIds(toggleLibraryFavorite(session.email, gameId))} onGameLaunched={(game) => setRecentGames(recordRecentGame(session.email, game))} runningGameIds={runningGameIds} />}
      {view === "Downloads" && <Downloads download={download} queuedTransfers={queuedTransfers} paused={downloadsPaused} onTogglePaused={() => void toggleDownloadsPaused()} />}
      {view === "Profile" && <Profile accessToken={session.accessToken} displayName={session.displayName} email={session.email} />}
      {view === "Settings" && <Settings launcherNotificationsEnabled={launcherNotificationsEnabled} manualUpdateState={manualUpdateState} onLauncherNotificationsEnabledChange={saveLauncherNotificationsEnabled} onManualUpdateCheck={() => void checkForLauncherUpdate(setManualUpdateState)} onReduceMotionChange={saveReduceMotion} pauseDownloadsWhilePlaying={pauseDownloadsWhilePlaying} reduceMotion={reduceMotion} onPauseDownloadsWhilePlayingChange={savePauseDownloadsWhilePlaying} />}
    </main>
  </div>;
}

function NotificationCenter({ notifications, open, unreadCount, onToggle, onClear, onOpenFriends }: { notifications: LauncherNotification[]; open: boolean; unreadCount: number; onToggle: () => void; onClear: () => void; onOpenFriends: () => void }) {
  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape" && open) onToggle(); };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [open, onToggle]);
  return <div className="notification-menu"><button className="notification-trigger" type="button" aria-label={unreadCount ? `${unreadCount} unread notifications` : "Notifications"} aria-expanded={open} aria-haspopup="dialog" onClick={onToggle}><BellIcon />{unreadCount > 0 && <span className="notification-badge" aria-hidden="true">{unreadCount > 9 ? "9+" : unreadCount}</span>}</button>{open && <section className="notification-popover" role="dialog" aria-label="Notifications"><header><div><p className="panel-label">NOTIFICATIONS</p><h2>Activity</h2></div>{notifications.length > 0 && <button className="text-button" type="button" onClick={onClear}>Clear all</button>}</header>{notifications.length ? <div className="notification-list">{notifications.map((notification) => notification.action === "friends" ? <button className={`notification-item notification-link ${notification.kind}`} type="button" key={notification.id} onClick={onOpenFriends}><div><strong>{notification.title}</strong><p>{notification.message}</p></div><time dateTime={new Date(notification.createdAt).toISOString()}>{notificationTime(notification.createdAt)}</time></button> : <article className={`notification-item ${notification.kind}`} key={notification.id}><div><strong>{notification.title}</strong><p>{notification.message}</p></div><time dateTime={new Date(notification.createdAt).toISOString()}>{notificationTime(notification.createdAt)}</time></article>)}</div> : <div className="notification-empty"><BellIcon size={22} /><p>No activity yet</p><small>Completed downloads and important launcher events will appear here.</small></div>}</section>}</div>;
}

function Home({ download, onClearRecent, playtimeByGame, queuedTransfers, recentGames, onOpenLibrary, onOpenDownloads }: { download: DownloadActivity | null; onClearRecent: () => void; playtimeByGame: PlaytimeByGame; queuedTransfers: QueuedTransfer[]; recentGames: RecentGame[]; onOpenLibrary: () => void; onOpenDownloads: () => void }) {
  const percentage = download?.totalBytes ? Math.min(100, Math.round(((download.downloadedBytes ?? 0) / download.totalBytes) * 100)) : null;
  const recentGame = recentGames[0];
  const lastPlayed = recentGame ? new Intl.RelativeTimeFormat(undefined, { numeric: "auto" }).format(Math.round((recentGame.lastPlayedAt - Date.now()) / 86_400_000), "day") : null;
  const recentPlaytime = recentGame ? playtimeByGame[recentGame.id] ?? 0 : 0;
  const playtimeLabel = recentPlaytime ? recentPlaytime >= 3600 ? `${Math.floor(recentPlaytime / 3600)}h ${Math.floor((recentPlaytime % 3600) / 60)}m played` : `${Math.floor(recentPlaytime / 60)}m played` : "";
  return <section className="home-grid" aria-label="Launcher overview"><article className="welcome-card"><p className="eyebrow">{recentGame ? "CONTINUE PLAYING" : "NORDIEE LAUNCHER"}</p><h2>{recentGame ? recentGame.title : "Your games, one place."}</h2><p>{recentGame ? `Last played ${lastPlayed}.${playtimeLabel ? ` ${playtimeLabel}.` : ""}` : "Library, updates and verified installs are ready from one focused workspace."}</p><button className="primary-button" type="button" onClick={onOpenLibrary}>{recentGame ? "Continue in library" : "View your library"}</button></article><article className="panel home-download"><p className="panel-label">DOWNLOADS</p>{download ? <><div className="home-download-heading"><h3>{download.title}</h3><strong>{percentage === null ? "Starting" : `${percentage}%`}</strong></div><div className="download-progress" role="progressbar" aria-label={`${download.title} download progress`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percentage ?? undefined}><span style={{ width: `${percentage ?? 4}%` }} /></div><button className="text-button" type="button" onClick={onOpenDownloads}>Open Downloads</button></> : queuedTransfers.length ? <><h3>{queuedTransfers.length} {queuedTransfers.length === 1 ? "game waiting" : "games waiting"}</h3><p>{queuedTransfers[0].game.title} is next in the transfer queue.</p><button className="text-button" type="button" onClick={onOpenDownloads}>Manage queue</button></> : <><h3>Nothing in queue</h3><p>Game installs, updates and repairs will appear here.</p></>}</article><article className="panel full-width"><div className="panel-heading"><div><p className="panel-label">RECENT GAMES</p><h3>{recentGames.length ? "Your latest launches" : "Ready when you are"}</h3></div><span>{recentGames.length ? <button className="text-button" type="button" onClick={onClearRecent}>Clear recent</button> : null}<button className="text-button" type="button" onClick={onOpenLibrary}>Open Library</button></span></div><p>{recentGames.length ? recentGames.slice(0, 3).map((game) => game.title).join(" • ") : "Installed games stay updated and can be verified or repaired from your library."}</p></article></section>;
}

type PresenceStatus = "ONLINE" | "AWAY" | "BUSY" | "INVISIBLE" | "OFFLINE";
type FriendProfile = { id: string; username: string; presenceStatus: PresenceStatus };
type IncomingFriendRequest = { id: string; from: FriendProfile; createdAt: string };

function Friends({ accessToken, onBack }: { accessToken: string; onBack: () => void }) {
  const [friends, setFriends] = useState<FriendProfile[]>([]);
  const favoriteFriendsKey = `nordiee.favoriteFriends.${(activeAccountEmail() ?? "guest").trim().toLocaleLowerCase()}`;
  const [favoriteFriendIds, setFavoriteFriendIds] = useState<string[]>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(favoriteFriendsKey) ?? "[]");
      return Array.isArray(saved) ? saved.filter((value): value is string => typeof value === "string") : [];
    } catch { return []; }
  });
  const [incoming, setIncoming] = useState<IncomingFriendRequest[]>([]);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [username, setUsername] = useState("");
  const [message, setMessage] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [presenceStatus, setPresenceStatus] = useState<PresenceStatus>("ONLINE");
  const [savingPresence, setSavingPresence] = useState(false);
  useEffect(() => {
    const page = document.querySelector<HTMLElement>(".friends-page");
    page?.setAttribute("id", "friends-content");
  }, []);
  const load = useCallback(async () => {
    setStatus("loading");
    try {
      const headers = { Authorization: `Bearer ${accessToken}` };
      const [friendsResponse, requestsResponse, profileResponse] = await Promise.all([fetch(FRIENDS_API_URL, { headers }), fetch(`${FRIENDS_API_URL}/requests`, { headers }), fetch(`${PROFILE_API_URL}/me`, { headers })]);
      if (!friendsResponse.ok || !requestsResponse.ok || !profileResponse.ok) throw new Error("Friends request failed");
      setFriends(await friendsResponse.json() as FriendProfile[]);
      setIncoming(await requestsResponse.json() as IncomingFriendRequest[]);
      const profile = await profileResponse.json() as { presenceStatus: PresenceStatus };
      setPresenceStatus(profile.presenceStatus);
      setStatus("ready");
    } catch {
      setStatus("error");
    }
  }, [accessToken]);
  useEffect(() => { void load(); }, [load]);
  const sendRequest = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!username.trim()) return;
    setSubmitting(true);
    setMessage("");
    try {
      const response = await fetch(`${FRIENDS_API_URL}/requests`, { method: "POST", headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" }, body: JSON.stringify({ username: username.trim() }) });
      if (!response.ok) { const body = await response.json().catch(() => null) as { error?: string } | null; throw new Error(body?.error ?? "Could not send that friend request."); }
      setUsername("");
      setMessage("Friend request sent.");
    } catch (error) { setMessage(error instanceof Error ? error.message : "Could not send that friend request."); }
    finally { setSubmitting(false); }
  };
  const accept = async (requestId: string) => {
    try {
      const response = await fetch(`${FRIENDS_API_URL}/requests/${requestId}/accept`, { method: "POST", headers: { Authorization: `Bearer ${accessToken}` } });
      if (!response.ok) throw new Error();
      setMessage("Friend request accepted.");
      await load();
    } catch { setMessage("Could not accept that request. Try again."); }
  };
  const decline = async (requestId: string) => {
    try {
      const response = await fetch(`${FRIENDS_API_URL}/requests/${requestId}`, { method: "DELETE", headers: { Authorization: `Bearer ${accessToken}` } });
      if (!response.ok) throw new Error();
      setIncoming((current) => current.filter((request) => request.id !== requestId));
    } catch { setMessage("Could not decline that request. Try again."); }
  };
  const removeFriend = async (friend: FriendProfile) => {
    if (!window.confirm(`Remove ${friend.username} from your friends?`)) return;
    try {
      const response = await fetch(`${FRIENDS_API_URL}/${friend.id}`, { method: "DELETE", headers: { Authorization: `Bearer ${accessToken}` } });
      if (!response.ok) throw new Error();
      setFriends((current) => current.filter((candidate) => candidate.id !== friend.id));
      setMessage(`${friend.username} was removed from your friends.`);
    } catch { setMessage("Could not remove that friend. Try again."); }
  };
  const updatePresence = async (nextStatus: PresenceStatus) => {
    const previousStatus = presenceStatus;
    setPresenceStatus(nextStatus);
    setSavingPresence(true);
    try {
      const response = await fetch(`${PROFILE_API_URL}/me/presence`, { method: "PATCH", headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" }, body: JSON.stringify({ presenceStatus: nextStatus }) });
      if (!response.ok) throw new Error();
      setMessage(`Your status is ${nextStatus.toLocaleLowerCase()}.`);
    } catch {
      setPresenceStatus(previousStatus);
      setMessage("Could not update your status. Try again.");
    } finally { setSavingPresence(false); }
  };
  const toggleFavorite = (friendId: string) => {
    setFavoriteFriendIds((current) => {
      const next = current.includes(friendId) ? current.filter((candidate) => candidate !== friendId) : [...current, friendId];
      localStorage.setItem(favoriteFriendsKey, JSON.stringify(next));
      return next;
    });
  };
  const orderedFriends = [...friends].sort((left, right) => Number(favoriteFriendIds.includes(right.id)) - Number(favoriteFriendIds.includes(left.id)));
  return <main className="friends-page">
    <header className="friends-header"><div><p className="eyebrow">SOCIAL</p><h1>Friends</h1><p>Keep your Nordiee people in one place.</p></div><button className="text-button" type="button" onClick={onBack}>Back to Home</button></header>
    <section className="friends-grid">
      <article className="panel add-friend-card"><p className="panel-label">YOUR STATUS</p><h2>How do you appear?</h2><label className="presence-picker">Presence<select value={presenceStatus} disabled={savingPresence} onChange={(event) => void updatePresence(event.target.value as PresenceStatus)}><option value="ONLINE">Online</option><option value="AWAY">Away</option><option value="BUSY">Busy</option><option value="INVISIBLE">Invisible</option><option value="OFFLINE">Offline</option></select></label><p className="presence-hint">Invisible appears offline to other players.</p><div className="add-friend-divider" /><p className="panel-label">ADD FRIEND</p><h2>Find a player</h2><form onSubmit={(event) => void sendRequest(event)}><label>Nordiee username<input value={username} onChange={(event) => setUsername(event.target.value)} placeholder="Username" minLength={3} maxLength={24} required autoComplete="off" /></label><button className="primary-button" type="submit" disabled={submitting}>{submitting ? "Sending" : "Send request"}</button></form>{message && <p className={message.endsWith("sent.") || message.endsWith("accepted.") || message.includes("was removed") || message.startsWith("Your status") ? "friends-message success" : "friends-message"} role="status">{message}</p>}</article>
      <article className="panel"><div className="panel-heading"><div><p className="panel-label">REQUESTS</p><h2>Incoming</h2></div><span className="count">{incoming.length}</span></div>{status === "loading" ? <p>Loading friend requests...</p> : incoming.length ? <ul className="friends-list">{incoming.map((request) => <li key={request.id}><span className="friend-avatar">{request.from.username[0]?.toUpperCase()}</span><strong>{request.from.username}</strong><small>{notificationTime(new Date(request.createdAt).getTime())}</small><div><button className="select-button" type="button" onClick={() => void accept(request.id)}>Accept</button><button className="text-button" type="button" onClick={() => void decline(request.id)}>Decline</button></div></li>)}</ul> : <p>No pending requests.</p>}</article>
      <article className="panel friends-list-card"><div className="panel-heading"><div><p className="panel-label">YOUR FRIENDS</p><h2>{friends.length ? `${friends.length} connected` : "No friends yet"}</h2></div></div>{status === "error" ? <><p>We could not load Friends. Check your connection, then try again.</p><button className="text-button" type="button" onClick={() => void load()}>Try again</button></> : status === "loading" ? <p>Loading friends...</p> : friends.length ? <ul className="friends-list">{orderedFriends.map((friend) => { const isFavorite = favoriteFriendIds.includes(friend.id); return <li key={friend.id}><span className={`friend-avatar presence-${friend.presenceStatus.toLocaleLowerCase()}`}>{friend.username[0]?.toUpperCase()}</span><strong>{friend.username}</strong><small>{friend.presenceStatus.toLocaleLowerCase()}</small><div><button className={`text-button favorite-friend${isFavorite ? " active" : ""}`} type="button" aria-pressed={isFavorite} onClick={() => toggleFavorite(friend.id)}>{isFavorite ? "Favorited" : "Favorite"}</button><button className="text-button" type="button" onClick={() => void removeFriend(friend)}>Remove</button></div></li>; })}</ul> : <p>Send a request by Nordiee username to start your list.</p>}</article>
    </section>
  </main>;
}
type ProfileVisibility = "PUBLIC" | "FRIENDS" | "PRIVATE";
type EditableProfile = { bio: string | null; avatarUrl: string | null; profileVisibility: ProfileVisibility };

function Profile({ accessToken, displayName, email }: { accessToken: string; displayName: string; email: string }) {
  const [profile, setProfile] = useState<EditableProfile>({ bio: null, avatarUrl: null, profileVisibility: "PUBLIC" });
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const load = useCallback(async () => {
    setState("loading");
    try {
      const response = await fetch(`${PROFILE_API_URL}/me/details`, { headers: { Authorization: `Bearer ${accessToken}` } });
      if (!response.ok) throw new Error();
      const next = await response.json() as EditableProfile;
      setProfile(next);
      setState("ready");
    } catch { setState("error"); }
  }, [accessToken]);
  useEffect(() => { void load(); }, [load]);
  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSaving(true);
    setMessage("");
    try {
      const response = await fetch(`${PROFILE_API_URL}/me`, { method: "PATCH", headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" }, body: JSON.stringify(profile) });
      if (!response.ok) { const body = await response.json().catch(() => null) as { error?: string } | null; throw new Error(body?.error ?? "Could not save profile."); }
      setProfile(await response.json() as EditableProfile);
      setMessage("Profile saved.");
    } catch (error) { setMessage(error instanceof Error ? error.message : "Could not save profile."); }
    finally { setSaving(false); }
  };
  const initials = displayName.slice(0, 1).toUpperCase();
  return <section className="profile-page" aria-label="Profile settings"><header className="profile-hero"><span className="profile-avatar-large" style={profile.avatarUrl ? { backgroundImage: `url(${profile.avatarUrl})` } : undefined}>{profile.avatarUrl ? <span className="sr-only">{displayName}</span> : initials}</span><div><p className="eyebrow">ACCOUNT PROFILE</p><h2>{displayName}</h2><p>{email}</p></div></header>{state === "loading" ? <p>Loading profile...</p> : state === "error" ? <div className="panel profile-error"><p>We could not load your profile.</p><button className="text-button" type="button" onClick={() => void load()}>Try again</button></div> : <form className="panel profile-form" onSubmit={(event) => void save(event)}><div className="panel-heading"><div><p className="panel-label">PUBLIC IDENTITY</p><h3>How people see you</h3></div></div><label>Avatar image URL<input type="url" value={profile.avatarUrl ?? ""} onChange={(event) => setProfile((current) => ({ ...current, avatarUrl: event.target.value || null }))} placeholder="https://..." autoComplete="url" /></label><label>Bio<textarea value={profile.bio ?? ""} onChange={(event) => setProfile((current) => ({ ...current, bio: event.target.value || null }))} maxLength={280} rows={4} placeholder="Tell your friends a little about yourself." /></label><div className="profile-field-row"><label>Profile visibility<select value={profile.profileVisibility} onChange={(event) => setProfile((current) => ({ ...current, profileVisibility: event.target.value as ProfileVisibility }))}><option value="PUBLIC">Public</option><option value="FRIENDS">Friends only</option><option value="PRIVATE">Private</option></select></label><p>Only a secure HTTPS avatar URL is accepted. Image upload comes with the R2 media flow.</p></div><footer><button className="primary-button" type="submit" disabled={saving}>{saving ? "Saving" : "Save profile"}</button>{message && <span className={message === "Profile saved." ? "profile-message success" : "profile-message"} role="status">{message}</span>}</footer></form>}</section>;
}

function Library({ accessToken, favoriteGameIds, recentGames, searchRequest, playtimeByGame, onDownload, onNotify, onFavoriteToggle, onGameLaunched, runningGameIds }: { accessToken: string; favoriteGameIds: string[]; recentGames: RecentGame[]; searchRequest: number; playtimeByGame: PlaytimeByGame; onDownload: (download: DownloadActivity | null) => void; onNotify: (title: string, message: string, kind?: NotificationKind) => void; onFavoriteToggle: (gameId: string) => void; onGameLaunched: (game: Omit<RecentGame, "lastPlayedAt">) => void; runningGameIds: string[] }) {
  const email = activeAccountEmail() ?? "";
  const cachedLibrary = readLibraryCache(email);
  const [status, setStatus] = useState<"loading" | "ready" | "offline" | "error">("loading");
  const [games, setGames] = useState<LibraryGame[]>([]);
  const [libraryFilter, setLibraryFilter] = useState<LibraryFilter>("all");
  const [libraryQuery, setLibraryQuery] = useState("");
  const librarySearchRef = useRef<HTMLInputElement>(null);
  const [librarySort, setLibrarySort] = useState<LibrarySort>("title");
  const [installingId, setInstallingId] = useState<string | null>(null);
  const [installedIds, setInstalledIds] = useState<string[]>([]);
  const [installedSizes, setInstalledSizes] = useState<Record<string, number>>({});
  const [gameInstallRoots, setGameInstallRoots] = useState<Record<string, string>>(() => readGameInstallRoots(email));
  const [launchOptions, setLaunchOptions] = useState<Record<string, string>>(() => {
    try { return JSON.parse(localStorage.getItem("nordiee.launchOptions") ?? "{}"); }
    catch { return {}; }
  });
  const [gameUpdateModes, setGameUpdateModes] = useState<Record<string, GameUpdateMode>>(() => {
    try { return JSON.parse(localStorage.getItem(`nordiee.gameUpdateModes.${email.toLocaleLowerCase()}`) ?? "{}"); }
    catch { return {}; }
  });
  const [editingLaunchOptions, setEditingLaunchOptions] = useState<string | null>(null);
  const [installError, setInstallError] = useState("");
  const [verification, setVerification] = useState<Record<string, VerificationState>>({});
  const [updateStatus, setUpdateStatus] = useState<Record<string, string>>({});
  const [downloadProgress, setDownloadProgress] = useState<{ gameId: string; downloadedBytes: number; totalBytes: number } | null>(null);
  const [queuedTransfers, setQueuedTransfers] = useState<QueuedTransfer[]>(readTransferQueue);
  const processingTransferRef = useRef(false);
  const [installDialog, setInstallDialog] = useState<{ game: LibraryGame; root: string; freeBytes: number } | null>(null);
  const [detailGameId, setDetailGameId] = useState<string | null>(null);
  useEffect(() => { if (searchRequest) librarySearchRef.current?.focus(); }, [searchRequest]);
  const saveGameInstallRoot = (gameId: string, root: string) => setGameInstallRoots((current) => {
    if (current[gameId] === root) return current;
    const next = { ...current, [gameId]: root };
    localStorage.setItem(`nordiee.gameInstallRoots.${email.toLocaleLowerCase()}`, JSON.stringify(next));
    return next;
  });
  const rootForGame = async (gameId: string) => gameInstallRoots[gameId] ?? installRoot();
  useEffect(() => {
    const handleLocatedInstallation = (event: Event) => {
      const detail = (event as CustomEvent<{ gameId: string; root: string }>).detail;
      if (!detail?.gameId || !detail.root) return;
      saveGameInstallRoot(detail.gameId, detail.root);
      setInstalledIds((current) => [...new Set([...current, detail.gameId])]);
      void invoke<number | null>("installed_game_size", { gameId: detail.gameId, installRoot: detail.root }).then((size) => {
        if (size !== null) setInstalledSizes((current) => ({ ...current, [detail.gameId]: size }));
      });
    };
    window.addEventListener("nordiee-existing-installation-located", handleLocatedInstallation);
    return () => window.removeEventListener("nordiee-existing-installation-located", handleLocatedInstallation);
  }, [email]);
  const loadLibrary = async () => {
    setStatus("loading");
    try {
      const response = await fetch(LIBRARY_API_URL, { headers: { Authorization: `Bearer ${accessToken}` } });
      if (!response.ok) throw new Error("Library request failed");
      const nextGames = await response.json() as LibraryGame[];
      saveLibraryCache(email, nextGames);
      setGames(nextGames);
      setStatus("ready");
    } catch {
      if (cachedLibrary) {
        setGames(cachedLibrary.games);
        setStatus("offline");
      } else setStatus("error");
    }
  };
  useEffect(() => { void loadLibrary(); }, [accessToken, email]);
  useEffect(() => {
    const unlisten = listen<{ gameId: string; downloadedBytes: number; totalBytes: number }>("game-download-progress", (event) => setDownloadProgress(event.payload));
    return () => { void unlisten.then((cleanup) => cleanup()); };
  }, []);
  useEffect(() => listenForTransferQueue(setQueuedTransfers), []);
  const startDownload = (game: LibraryGame, phase: string) => onDownload({ gameId: game.id, title: game.title, phase });
  useEffect(() => {
    let active = true;
    const findInstalledGames = async () => {
      try {
        const roots = await installRoots();
        const checks = await Promise.all(games.map(async (game) => {
          const knownRoot = gameInstallRoots[game.id];
          const candidates = knownRoot ? [knownRoot, ...roots.filter((root) => root !== knownRoot)] : roots;
          for (const root of candidates) {
            const version = await invoke<string | null>("installed_game_version", { gameId: game.id, installRoot: root });
            if (version) {
              const size = await invoke<number | null>("installed_game_size", { gameId: game.id, installRoot: root });
              return { id: game.id, version, size, root };
            }
          }
          return { id: game.id, version: null, size: null, root: null };
        }));
        const installedGameIds = checks.filter((check) => check.version).map((check) => check.id);
        for (const check of checks) if (check.root) saveGameInstallRoot(check.id, check.root);
        if (active) setInstalledIds(installedGameIds);
        if (active) setInstalledSizes(Object.fromEntries(checks.flatMap((check) => check.size === null ? [] : [[check.id, check.size]])));
        if (localStorage.getItem("nordiee.autoUpdateGames") !== "false") {
          for (const game of games.filter((game) => installedGameIds.includes(game.id) && (gameUpdateModes[game.id] ?? "always") === "always")) {
            try {
              const response = await fetch(`${LIBRARY_API_URL}/${game.id}/manifest`, { headers: { Authorization: `Bearer ${accessToken}` } });
              if (!response.ok) continue;
              const manifest = await response.json();
              const result = await invoke<{ version: string; changedFiles: number }>("update_game", { manifestJson: JSON.stringify(manifest), installRoot: await rootForGame(game.id), downloadLimitMbps: configuredDownloadLimitMbps() });
              if (active && result.changedFiles) {
                setUpdateStatus((current) => ({ ...current, [game.id]: updateSummary(result.version, result.changedFiles) }));
                onNotify("Game updated", `${game.title}: ${updateSummary(result.version, result.changedFiles)}`, "success");
              }
            } catch {
              continue;
            }
          }
        }
      } catch {
        if (active) setInstalledIds([]);
      }
    };
    if (games.length) void findInstalledGames();
    return () => { active = false; };
  }, [accessToken, gameInstallRoots, gameUpdateModes, games]);
  const runInstall = async (game: LibraryGame, selectedRoot?: string) => {
    setInstallError("");
    setInstallingId(game.id);
    setDownloadProgress(null);
    startDownload(game, "Installing");
    try {
      const response = await fetch(`${LIBRARY_API_URL}/${game.id}/manifest`, { headers: { Authorization: `Bearer ${accessToken}` } });
      if (!response.ok) throw new Error("This game does not have an active install build yet.");
      const manifest = await response.json();
      const destinationRoot = selectedRoot ?? await installRoot();
      await invoke("install_game", { manifestJson: JSON.stringify(manifest), installRoot: destinationRoot, downloadLimitMbps: configuredDownloadLimitMbps() });
      saveGameInstallRoot(game.id, destinationRoot);
      setInstalledIds((current) => [...new Set([...current, game.id])]);
      onNotify("Game installed", `${game.title} is ready to play.`, "success");
    } catch (error) {
      const message = error instanceof Error ? error.message : "We could not install this game.";
      setInstallError(message);
      onNotify("Install failed", `${game.title}: ${message}`, "error");
    } finally {
      setInstallingId(null);
      setDownloadProgress(null);
      onDownload(null);
    }
  };
  const verify = async (game: LibraryGame) => {
    setInstallError("");
    setVerification((current) => ({ ...current, [game.id]: "verifying" }));
    try {
      const result = await invoke<{ verified: boolean }>("verify_game", { gameId: game.id, installRoot: await rootForGame(game.id) });
      setVerification((current) => ({ ...current, [game.id]: result.verified ? "verified" : "repair" }));
      onNotify(result.verified ? "Files verified" : "Repair required", result.verified ? `${game.title} files are healthy.` : `${game.title} has files that need repair.`, result.verified ? "success" : "error");
    } catch (error) {
      setVerification((current) => { const next = { ...current }; delete next[game.id]; return next; });
      setInstallError(error instanceof Error ? error.message : "We could not verify this game.");
    }
  };
  const runRepair = async (game: LibraryGame) => {
    setInstallError("");
    setInstallingId(game.id);
    setDownloadProgress(null);
    startDownload(game, "Repairing");
    try {
      await invoke("repair_game", { gameId: game.id, installRoot: await rootForGame(game.id), downloadLimitMbps: configuredDownloadLimitMbps() });
      setVerification((current) => ({ ...current, [game.id]: "verified" }));
      onNotify("Files repaired", `${game.title} is ready to play.`, "success");
    } catch (error) {
      const message = error instanceof Error ? error.message : "We could not repair this game.";
      setInstallError(message);
      onNotify("Repair failed", `${game.title}: ${message}`, "error");
    } finally {
      setInstallingId(null);
      setDownloadProgress(null);
      onDownload(null);
    }
  };
  const uninstall = async (game: LibraryGame) => {
    if (!window.confirm(`Uninstall ${game.title}? This removes its files from NordieeApps.`)) return;
    setInstallError("");
    setInstallingId(game.id);
    try {
      await invoke("uninstall_game", { gameId: game.id, installRoot: await rootForGame(game.id) });
      setInstalledIds((current) => current.filter((id) => id !== game.id));
      setVerification((current) => { const next = { ...current }; delete next[game.id]; return next; });
    } catch (error) {
      setInstallError(error instanceof Error ? error.message : "We could not uninstall this game.");
    } finally {
      setInstallingId(null);
    }
  };
  const openFolder = async (game: LibraryGame) => {
    setInstallError("");
    try {
      await invoke("open_game_folder", { gameId: game.id, installRoot: await rootForGame(game.id) });
    } catch (error) {
      setInstallError(error instanceof Error ? error.message : "We could not open this game folder.");
    }
  };
  const saveLaunchOptions = (gameId: string, value: string) => {
    const next = { ...launchOptions, [gameId]: value.slice(0, 2048) };
    setLaunchOptions(next);
    localStorage.setItem("nordiee.launchOptions", JSON.stringify(next));
  };
  const saveGameUpdateMode = (gameId: string, mode: GameUpdateMode) => {
    const next = { ...gameUpdateModes, [gameId]: mode };
    setGameUpdateModes(next);
    localStorage.setItem(`nordiee.gameUpdateModes.${email.toLocaleLowerCase()}`, JSON.stringify(next));
  };
  const play = async (game: LibraryGame) => {
    setInstallError("");
    setInstallingId(game.id);
    setDownloadProgress(null);
    startDownload(game, "Checking for updates");
    try {
      if ((gameUpdateModes[game.id] ?? "always") !== "never") try {
        const response = await fetch(`${LIBRARY_API_URL}/${game.id}/manifest`, { headers: { Authorization: `Bearer ${accessToken}` } });
        if (!response.ok) throw new Error("We could not check this game for updates.");
        const manifest = await response.json();
        const updateResult = await invoke<{ version: string; changedFiles: number }>("update_game", { manifestJson: JSON.stringify(manifest), installRoot: await rootForGame(game.id), downloadLimitMbps: configuredDownloadLimitMbps() });
        if (updateResult.changedFiles) {
          setUpdateStatus((current) => ({ ...current, [game.id]: updateSummary(updateResult.version, updateResult.changedFiles) }));
          onNotify("Game updated", `${game.title}: ${updateSummary(updateResult.version, updateResult.changedFiles)}`, "success");
        }
      } catch (error) {
        if (!(error instanceof TypeError)) throw error;
        setUpdateStatus((current) => ({ ...current, [game.id]: "Offline - starting the installed version." }));
      }
      await invoke("launch_game", { gameId: game.id, installRoot: await rootForGame(game.id), launchArguments: parseLaunchOptions(launchOptions[game.id] ?? "") });
      onGameLaunched({ id: game.id, title: game.title });
    } catch (error) {
      const message = error instanceof Error ? error.message : "We could not launch this game.";
      setInstallError(message);
      onNotify("Could not start game", `${game.title}: ${message}`, "error");
    } finally {
      setInstallingId(null);
      setDownloadProgress(null);
      onDownload(null);
    }
  };
  const runUpdate = async (game: LibraryGame) => {
    setInstallError("");
    setInstallingId(game.id);
    setDownloadProgress(null);
    startDownload(game, "Checking for updates");
    try {
      const response = await fetch(`${LIBRARY_API_URL}/${game.id}/manifest`, { headers: { Authorization: `Bearer ${accessToken}` } });
      if (!response.ok) throw new Error("We could not check this game for updates.");
      const manifest = await response.json();
      const result = await invoke<{ version: string; changedFiles: number }>("update_game", { manifestJson: JSON.stringify(manifest), installRoot: await rootForGame(game.id), downloadLimitMbps: configuredDownloadLimitMbps() });
      setUpdateStatus((current) => ({ ...current, [game.id]: result.changedFiles ? updateSummary(result.version, result.changedFiles) : "Already up to date." }));
      setVerification((current) => ({ ...current, [game.id]: "verified" }));
      onNotify(result.changedFiles ? "Game updated" : "Game is up to date", result.changedFiles ? `${game.title}: ${updateSummary(result.version, result.changedFiles)}` : `${game.title} already has the latest files.`, "success");
    } catch (error) {
      const message = error instanceof Error ? error.message : "We could not update this game.";
      setInstallError(message);
      onNotify("Update failed", `${game.title}: ${message}`, "error");
    } finally {
      setInstallingId(null);
      setDownloadProgress(null);
      onDownload(null);
    }
  };
  const processTransferQueue = async () => {
    if (processingTransferRef.current) return;
    processingTransferRef.current = true;
    const next = takeNextTransfer();
    if (!next) { processingTransferRef.current = false; return; }
    try {
      if (next.kind === "install") await runInstall(next.game, next.installRoot);
      else if (next.kind === "repair") await runRepair(next.game);
      else await runUpdate(next.game);
    } finally {
      processingTransferRef.current = false;
      void processTransferQueue();
    }
  };
  const enqueueTransfer = (game: LibraryGame, kind: TransferKind, selectedRoot?: string) => {
    const alreadyQueued = readTransferQueue().some((transfer) => transfer.game.id === game.id);
    if (installingId === game.id || alreadyQueued) return;
    enqueueQueuedTransfer({ id: crypto.randomUUID(), game, kind, installRoot: selectedRoot });
    if (processingTransferRef.current) onNotify("Added to queue", `${game.title} will ${kind === "install" ? "install" : kind === "repair" ? "repair" : "update"} after the active transfer.`, "info");
    void processTransferQueue();
  };
  const clearTransferQueue = () => {
    if (!readTransferQueue().length) return;
    clearQueuedTransfers();
    onNotify("Transfer queue cleared", "The active transfer continues and partial files stay safe.", "info");
  };
  useEffect(() => {
    if (games.length && readTransferQueue().length) void processTransferQueue();
  }, [games]);
  const openInstallDialog = async (game: LibraryGame) => {
    setInstallError("");
    try {
      const root = (await installRoots())[0];
      const freeBytes = await invoke<number>("install_location_free_space", { installRoot: root });
      setInstallDialog({ game, root, freeBytes });
    } catch (error) {
      setInstallError(error instanceof Error ? error.message : "We could not check the install location.");
    }
  };
  const moveInstalledGame = async (game: LibraryGame) => {
    const sourceRoot = await rootForGame(game.id);
    const roots = (await installRoots()).filter((root) => root !== sourceRoot);
    if (!roots.length) { setInstallError("Add another game library from Install before moving this game."); return; }
    const destinationRoot = window.prompt(`Move ${game.title} to this NordieeApps folder:`, roots[0] ?? "");
    if (!destinationRoot?.trim() || destinationRoot.trim() === sourceRoot) return;
    if (!window.confirm(`Move ${game.title} without reinstalling? Nordiee will verify the destination has enough free space first.`)) return;
    setInstallingId(game.id);
    setInstallError("");
    try {
      const result = await invoke<{ bytesMoved: number; destinationRoot: string }>("move_game", { gameId: game.id, sourceRoot, destinationRoot: destinationRoot.trim() });
      saveGameInstallRoot(game.id, result.destinationRoot);
      rememberInstallRoot(result.destinationRoot);
      onNotify("Game moved", `${game.title} was moved without reinstalling.`, "success");
    } catch (error) {
      const message = error instanceof Error ? error.message : "We could not move this game.";
      setInstallError(message);
      onNotify("Move failed", `${game.title}: ${message}`, "error");
    } finally { setInstallingId(null); }
  };
  const detailGame = detailGameId ? games.find((game) => game.id === detailGameId) : null;
  if (detailGame) return <GameDetails game={detailGame} installed={installedIds.includes(detailGame.id) || detailGame.installState === "INSTALLED"} installedBytes={installedSizes[detailGame.id] ?? detailGame.installSizeBytes ?? null} location={gameInstallRoots[detailGame.id] ?? "Default NordieeApps library"} playtimeSeconds={playtimeByGame[detailGame.id] ?? 0} lastPlayedAt={recentGames.find((game) => game.id === detailGame.id)?.lastPlayedAt ?? null} updateMessage={updateStatus[detailGame.id] ?? null} updateMode={gameUpdateModes[detailGame.id] ?? "always"} onBack={() => setDetailGameId(null)} />;
  if (status === "loading") return <section className="library-state" aria-live="polite"><span className="library-loader" aria-hidden="true" /><h2>Loading your library</h2><p>Fetching the games connected to this account.</p></section>;
  if (status === "error") return <section className="library-state"><div className="empty-mark" aria-hidden="true">N</div><h2>We could not load your library</h2><p>Check your connection, then try again.</p><button className="primary-button" type="button" onClick={() => void loadLibrary()}>Try again</button></section>;
  const offlineNotice = status === "offline" ? <p className="offline-notice" role="status">Offline mode - showing the last library saved on this device.</p> : null;
  if (!games.length) return <>{offlineNotice}<section className="empty-state"><div className="empty-mark" aria-hidden="true">N</div><h2>Your library is ready</h2><p>Games connected to your Nordiee account will appear here.</p></section></>;
  const queueNotice = queuedTransfers.length ? <div className="queue-notice" role="status"><span>{queuedTransfers.length} {queuedTransfers.length === 1 ? "game is" : "games are"} waiting in the transfer queue.</span><button className="text-button" type="button" onClick={clearTransferQueue}>Clear queue</button></div> : null;
  const normalizedQuery = libraryQuery.trim().toLocaleLowerCase();
  const recentOrder = new Map(recentGames.map((game, index) => [game.id, index]));
  const recentById = new Map(recentGames.map((game) => [game.id, game]));
  const visibleGames = games.filter((game) => {
    const isInstalled = installedIds.includes(game.id) || game.installState === "INSTALLED";
    if (libraryFilter === "installed" && !isInstalled) return false;
    if (libraryFilter === "not-installed" && isInstalled) return false;
    if (libraryFilter === "favorites" && !favoriteGameIds.includes(game.id)) return false;
    if (libraryFilter === "recent" && !recentOrder.has(game.id)) return false;
    return !normalizedQuery || game.title.toLocaleLowerCase().includes(normalizedQuery);
  }).sort((left, right) => {
    if (librarySort === "recent") {
      const recentDifference = (recentOrder.get(left.id) ?? Number.MAX_SAFE_INTEGER) - (recentOrder.get(right.id) ?? Number.MAX_SAFE_INTEGER);
      if (recentDifference) return recentDifference;
    }
    if (librarySort === "playtime") {
      const playtimeDifference = (playtimeByGame[right.id] ?? 0) - (playtimeByGame[left.id] ?? 0);
      if (playtimeDifference) return playtimeDifference;
    }
    if (librarySort === "favorites") {
      const favoriteDifference = Number(favoriteGameIds.includes(right.id)) - Number(favoriteGameIds.includes(left.id));
      if (favoriteDifference) return favoriteDifference;
    }
    if (librarySort === "installed") {
      const installedDifference = Number(installedIds.includes(right.id) || right.installState === "INSTALLED") - Number(installedIds.includes(left.id) || left.installState === "INSTALLED");
      if (installedDifference) return installedDifference;
    }
    return left.title.localeCompare(right.title);
  });
  return <>{offlineNotice}{queueNotice}{installError && <p className="install-error" role="alert">{installError}</p>}<section className="library-toolbar" aria-label="Library filters"><label><span className="sr-only">Search your library</span><input ref={librarySearchRef} value={libraryQuery} onChange={(event) => setLibraryQuery(event.target.value)} placeholder="Search your library" type="search" /></label><div role="group" aria-label="Game filter">{(["all", "installed", "not-installed", "favorites", "recent"] as const).map((filter) => <button className={libraryFilter === filter ? "active" : ""} key={filter} type="button" onClick={() => setLibraryFilter(filter)}>{filter === "all" ? "All games" : filter === "installed" ? "Installed" : filter === "not-installed" ? "Not installed" : filter === "favorites" ? "Favorites" : "Recently played"}</button>)}</div><label className="library-sort"><span className="sr-only">Sort library</span><select className="select-button" value={librarySort} onChange={(event) => setLibrarySort(event.target.value as LibrarySort)}><option value="title">A to Z</option><option value="recent">Recently played</option><option value="playtime">Most played</option><option value="installed">Installed first</option><option value="favorites">Favorites first</option></select></label></section>{visibleGames.length ? <section className="library-grid" aria-label="Your game library">{visibleGames.map((game) => {
    const isInstalling = installingId === game.id;
    const isQueued = queuedTransfers.some((transfer) => transfer.game.id === game.id);
    const transferInProgress = installingId !== null;
    const isInstalled = installedIds.includes(game.id) || game.installState === "INSTALLED";
    const isRunning = runningGameIds.includes(game.id);
    const percentage = isInstalling && downloadProgress?.gameId === game.id && downloadProgress.totalBytes ? Math.round((downloadProgress.downloadedBytes / downloadProgress.totalBytes) * 100) : null;
    const checkState = verification[game.id];
    const statusLabel = isRunning ? "RUNNING" : isQueued ? "QUEUED" : isInstalled ? checkState === "repair" ? "REPAIR REQUIRED" : "INSTALLED" : isInstalling ? "DOWNLOADING" : game.installState;
    const installedSize = installedSizes[game.id];
    const displaySize = installedSize ?? game.installSizeBytes;
    const playtimeSeconds = playtimeByGame[game.id] ?? 0;
    const lastPlayedAt = recentById.get(game.id)?.lastPlayedAt;
    const lastPlayedLabel = lastPlayedAt ? `Last played ${new Intl.RelativeTimeFormat(undefined, { numeric: "auto" }).format(Math.round((lastPlayedAt - Date.now()) / 86_400_000), "day")}` : "";
    const playtimeLabel = [lastPlayedLabel, playtimeSeconds >= 3600 ? `${Math.floor(playtimeSeconds / 3600)}h ${Math.floor((playtimeSeconds % 3600) / 60)}m played` : `${Math.floor(playtimeSeconds / 60)}m played`].filter(Boolean).join(" • ");
    const detail = isInstalling && percentage !== null ? `${percentage}% downloaded` : updateStatus[game.id] ?? (checkState === "verified" ? "All installed files verified." : checkState === "repair" ? "One or more files need repair." : displaySize ? `${isInstalled ? "Installed" : "Download"} · ${(displaySize / 1_000_000_000).toFixed(1)} GB` : "Size will be available soon");
    const primaryLabel = !isInstalled ? isQueued ? "Queued to install" : isInstalling ? percentage !== null ? `Downloading ${percentage}%` : "Preparing" : "Install" : checkState === "verifying" ? "Verifying" : checkState === "repair" ? isQueued ? "Queued to repair" : isInstalling ? percentage !== null ? `Repairing ${percentage}%` : "Preparing repair" : "Repair files" : "Verify files";
    const primaryAction = () => { if (!isInstalled) return void openInstallDialog(game); if (checkState === "repair") return enqueueTransfer(game, "repair"); return verify(game); };
    const isFavorite = favoriteGameIds.includes(game.id);
    return <article className="library-card" key={game.id}><div className="library-cover" aria-hidden="true">N</div><div><p className="panel-label">{statusLabel}</p><h2>{game.title}</h2><p>{detail}</p>{isInstalled && playtimeSeconds > 0 && <small className="library-playtime">{playtimeLabel}</small>}<div className="library-actions"><button className="library-action" type="button" onClick={() => setDetailGameId(game.id)}>Details</button><button className={isFavorite ? "library-action favorite-action active" : "library-action favorite-action"} type="button" aria-pressed={isFavorite} onClick={() => onFavoriteToggle(game.id)}>{isFavorite ? "Favorited" : "Favorite"}</button>{isInstalled && <button className="library-action play-action" type="button" disabled={transferInProgress || isRunning || checkState === "repair"} onClick={() => void play(game)}>{isRunning ? "Running" : isInstalling ? percentage !== null ? `Updating ${percentage}%` : "Checking update" : "Play"}</button>}{isInstalled && <button className="library-action" type="button" disabled={isInstalling || isQueued || isRunning || checkState === "repair"} onClick={() => enqueueTransfer(game, "update")}>{isQueued ? "Queued" : "Check update"}</button>}<button className="library-action" type="button" disabled={isInstalling || isQueued || isRunning || checkState === "verifying"} onClick={primaryAction}>{primaryLabel}</button>{isInstalled && <button className="library-action" type="button" disabled={transferInProgress} onClick={() => void openFolder(game)}>Open folder</button>}{isInstalled && <button className="library-action" type="button" disabled={transferInProgress || isRunning} onClick={() => void moveInstalledGame(game)}>Move game</button>}{isInstalled && <button className="library-action" type="button" disabled={transferInProgress || isRunning} onClick={() => setEditingLaunchOptions(editingLaunchOptions === game.id ? null : game.id)}>Launch options</button>}{isInstalled && <button className="library-action uninstall-action" type="button" disabled={transferInProgress || isRunning} onClick={() => void uninstall(game)}>Uninstall</button>}</div>{isInstalled && <label className="launch-options update-mode"><span>Updates</span><select value={gameUpdateModes[game.id] ?? "always"} onChange={(event) => saveGameUpdateMode(game.id, event.target.value as GameUpdateMode)}><option value="always">Always update</option><option value="on-launch">Update when launched</option><option value="never">Never auto update</option></select></label>}{editingLaunchOptions === game.id && <label className="launch-options"><span>Launch options</span><input value={launchOptions[game.id] ?? ""} onChange={(event) => saveLaunchOptions(game.id, event.target.value)} placeholder='Example: -windowed -log' spellCheck="false" /><small>Options are passed directly to this game only.</small></label>}</div></article>;
  })}</section> : <section className="library-no-results"><div className="empty-mark" aria-hidden="true">N</div><h2>No games found</h2><p>Try a different title or library filter.</p></section>}{installDialog && <InstallDialog game={installDialog.game} root={installDialog.root} freeBytes={installDialog.freeBytes} onCancel={() => setInstallDialog(null)} onConfirm={() => { enqueueTransfer(installDialog.game, "install"); setInstallDialog(null); }} />}</>;
}

function GameDetails({ game, installed, installedBytes, location, playtimeSeconds, lastPlayedAt, updateMessage, updateMode, onBack }: { game: LibraryGame; installed: boolean; installedBytes: number | null; location: string; playtimeSeconds: number; lastPlayedAt: number | null; updateMessage: string | null; updateMode: GameUpdateMode; onBack: () => void }) {
  const playtime = playtimeSeconds >= 3600 ? `${Math.floor(playtimeSeconds / 3600)}h ${Math.floor((playtimeSeconds % 3600) / 60)}m` : playtimeSeconds ? `${Math.floor(playtimeSeconds / 60)}m` : "Not played yet";
  const lastPlayed = lastPlayedAt ? new Intl.RelativeTimeFormat(undefined, { numeric: "auto" }).format(Math.round((lastPlayedAt - Date.now()) / 86_400_000), "day") : "Never";
  const size = installedBytes === null ? "Size pending" : `${(installedBytes / 1_000_000_000).toFixed(1)} GB`;
  return <section className="game-details" aria-label={`${game.title} details`}><header className="game-details-hero"><button className="text-button" type="button" onClick={onBack}>Back to Library</button><p className="eyebrow">GAME OVERVIEW</p><h2>{game.title}</h2><p>{installed ? "Installed and ready in your Nordiee library." : "Not installed on this device."}</p></header><div className="game-details-grid"><article className="panel"><p className="panel-label">ACTIVITY</p><dl className="game-details-list"><div><dt>Playtime</dt><dd>{playtime}</dd></div><div><dt>Last played</dt><dd>{lastPlayed}</dd></div><div><dt>Installed size</dt><dd>{size}</dd></div></dl></article><article className="panel"><p className="panel-label">INSTALLATION</p><dl className="game-details-list"><div><dt>Status</dt><dd>{installed ? "Installed" : "Not installed"}</dd></div><div><dt>Library</dt><dd title={location}>{location}</dd></div><div><dt>Updates</dt><dd>{updateMode === "always" ? "Automatic" : updateMode === "on-launch" ? "On launch" : "Manual"}</dd></div></dl></article><article className="panel game-details-history"><p className="panel-label">UPDATE HISTORY</p><h3>{updateMessage ?? "No recent updates"}</h3><p>{updateMessage ? "This device recorded the latest file update for this game." : "Future game updates will be recorded here after a successful check."}</p></article><article className="panel"><p className="panel-label">GAME SETTINGS</p><h3>Manage from Library</h3><p>Launch options, update preference, verify, repair and library move controls remain available on the game card.</p></article></div></section>;
}

function InstallDialog({ game, root, freeBytes, onCancel, onConfirm }: { game: LibraryGame; root: string; freeBytes: number; onCancel: () => void; onConfirm: () => void }) {
  const [roots, setRoots] = useState<string[]>([root]);
  const [selectedRoot, setSelectedRoot] = useState(root);
  const [availableBytes, setAvailableBytes] = useState(freeBytes);
  const [customRoot, setCustomRoot] = useState("");
  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape") onCancel(); };
    window.addEventListener("keydown", closeOnEscape);
    void installRoots().then((savedRoots) => { setRoots(savedRoots); if (savedRoots[0]) setSelectedRoot(savedRoots[0]); });
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onCancel]);
  useEffect(() => { void invoke<number>("install_location_free_space", { installRoot: selectedRoot }).then(setAvailableBytes).catch(() => setAvailableBytes(0)); }, [selectedRoot]);
  const requiredBytes = game.installSizeBytes ?? 0;
  const hasSpace = availableBytes >= requiredBytes;
  const gigabytes = (bytes: number) => `${(bytes / 1_000_000_000).toFixed(1)} GB`;
  const addLocation = async () => {
    const next = customRoot.trim();
    if (!next) return;
    rememberInstallRoot(next);
    setRoots((current) => [...new Set([...current, next])]);
    setSelectedRoot(next);
    setCustomRoot("");
    const version = await invoke<string | null>("installed_game_version", { gameId: game.id, installRoot: next }).catch(() => null);
    if (version) window.dispatchEvent(new CustomEvent("nordiee-existing-installation-located", { detail: { gameId: game.id, root: next } }));
  };
  const queueInstall = () => { localStorage.setItem("nordiee.installRoot", selectedRoot); rememberInstallRoot(selectedRoot); onConfirm(); };
  return <div className="install-dialog-overlay" role="presentation" onMouseDown={onCancel}><section className="install-dialog" role="dialog" aria-modal="true" aria-labelledby="install-dialog-title" onMouseDown={(event) => event.stopPropagation()}><p className="eyebrow">INSTALL GAME</p><h2 id="install-dialog-title">Install {game.title}</h2><p className="install-dialog-copy">Choose a library location. Add an existing NordieeApps folder and Nordiee will recognize this game without downloading it again.</p><dl><div><dt>Location</dt><dd><select value={selectedRoot} onChange={(event) => setSelectedRoot(event.target.value)} aria-label="Install location">{roots.map((location) => <option key={location} value={location}>{location}</option>)}</select></dd></div><div><dt>Required</dt><dd>{requiredBytes ? gigabytes(requiredBytes) : "Size pending"}</dd></div><div><dt>Available</dt><dd className={hasSpace ? "space-ready" : "space-low"}>{gigabytes(availableBytes)}</dd></div></dl><div className="install-location-add"><label>Add or locate another NordieeApps folder<input value={customRoot} onChange={(event) => setCustomRoot(event.target.value)} placeholder="D:\\NordieeApps" spellCheck="false" /></label><button className="library-action" type="button" onClick={() => void addLocation()}>Add</button></div>{!hasSpace && <p className="install-dialog-error" role="alert">Not enough free disk space for this game.</p>}<div className="install-dialog-actions"><button className="library-action" type="button" onClick={onCancel}>Cancel</button><button className="primary-button" type="button" disabled={!hasSpace} onClick={queueInstall}>Add to queue</button></div></section></div>;
}
function Downloads({ download, queuedTransfers, paused, onTogglePaused }: { download: DownloadActivity | null; queuedTransfers: QueuedTransfer[]; paused: boolean; onTogglePaused: () => void }) {
  if (!download && !queuedTransfers.length) return <EmptyState title="No active downloads" text="Game installs, updates and repairs will appear here." action="Browse library" />;
  if (!download) return <section className="downloads-panel" aria-label="Download queue"><article className="download-card queue-card"><p className="panel-label">TRANSFER QUEUE</p><h2>{queuedTransfers.length} {queuedTransfers.length === 1 ? "game is" : "games are"} waiting</h2><p>Transfers start one at a time to protect your installed files.</p><QueuedTransfers transfers={queuedTransfers} /></article></section>;
  const percentage = download.totalBytes ? Math.min(100, Math.round(((download.downloadedBytes ?? 0) / download.totalBytes) * 100)) : null;
  const transferred = download.downloadedBytes && download.totalBytes ? `${Math.round(download.downloadedBytes / 1_000_000)} MB of ${Math.round(download.totalBytes / 1_000_000)} MB` : "Preparing file transfer";
  const speed = download.speedBytesPerSecond ? `${(download.speedBytesPerSecond / 1_000_000).toFixed(1)} MB/s` : "Calculating speed";
  const remainingSeconds = download.speedBytesPerSecond && download.totalBytes && download.downloadedBytes !== undefined ? Math.max(0, Math.round((download.totalBytes - download.downloadedBytes) / download.speedBytesPerSecond)) : null;
  const eta = remainingSeconds === null ? null : remainingSeconds >= 3600 ? `${Math.floor(remainingSeconds / 3600)}h ${Math.ceil((remainingSeconds % 3600) / 60)}m left` : remainingSeconds >= 60 ? `${Math.ceil(remainingSeconds / 60)}m left` : "Less than a minute left";
  const cancel = async () => { if (window.confirm(`Cancel ${download.title}? The files already downloaded will be kept for a later resume.`)) await invoke("cancel_downloads"); };
  return <section className="downloads-panel" aria-label="Active downloads"><article className="download-card"><div className="download-card-heading"><div><p className="panel-label">{paused ? "PAUSED" : download.phase}</p><h2>{download.title}</h2></div><strong>{percentage === null ? "Starting" : `${percentage}%`}</strong></div><div className="download-progress" role="progressbar" aria-label={`${download.title} download progress`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percentage ?? undefined}><span style={{ width: `${percentage ?? 4}%` }} /></div><div className="download-meta"><p>{paused ? "Transfer paused. Your partial download is kept safely." : transferred}</p><strong>{paused ? "Waiting" : eta ? `${speed} · ${eta}` : speed}</strong></div><div className="download-controls"><button className="library-action" type="button" aria-pressed={paused} onClick={onTogglePaused}>{paused ? <><PlayIcon />Resume download</> : <><PauseIcon />Pause download</>}</button><button className="library-action download-cancel" type="button" onClick={() => void cancel()}>Cancel download</button></div></article>{queuedTransfers.length ? <QueuedTransfers transfers={queuedTransfers} /> : null}</section>;
}
function QueuedTransfers({ transfers }: { transfers: QueuedTransfer[] }) {
  const actionLabel = (kind: TransferKind) => kind === "install" ? "Install" : kind === "repair" ? "Repair" : "Update";
  return <section className="queued-transfers" aria-label="Transfers waiting in queue"><div className="queued-transfers-heading"><p className="panel-label">UP NEXT</p><span>{transfers.length} waiting</span><button className="text-button" type="button" onClick={clearQueuedTransfers}>Clear queue</button></div><ol>{transfers.map((transfer, index) => <li key={transfer.id}><span className="queue-position">{index + 1}</span><span className="queue-game"><strong>{transfer.game.title}</strong><small>{actionLabel(transfer.kind)}</small></span><span className="queue-actions"><button type="button" aria-label={`Move ${transfer.game.title} up`} disabled={index === 0} onClick={() => moveTransferInQueue(transfer.id, -1)}>Up</button><button type="button" aria-label={`Move ${transfer.game.title} down`} disabled={index === transfers.length - 1} onClick={() => moveTransferInQueue(transfer.id, 1)}>Down</button><button className="queue-remove" type="button" aria-label={`Remove ${transfer.game.title} from queue`} onClick={() => removeTransferFromQueue(transfer.id)}>Remove</button></span></li>)}</ol></section>;
}
function EmptyState({ title, text, action }: { title: string; text: string; action: string }) { return <section className="empty-state"><div className="empty-mark" aria-hidden="true">N</div><h2>{title}</h2><p>{text}</p><button className="primary-button" type="button">{action}</button></section>; }
function Settings({ launcherNotificationsEnabled, manualUpdateState, onLauncherNotificationsEnabledChange, onManualUpdateCheck, onReduceMotionChange, pauseDownloadsWhilePlaying, reduceMotion, onPauseDownloadsWhilePlayingChange }: { launcherNotificationsEnabled: boolean; manualUpdateState: ManualUpdateState; onLauncherNotificationsEnabledChange: (enabled: boolean) => void; onManualUpdateCheck: () => void; onReduceMotionChange: (enabled: boolean) => void; pauseDownloadsWhilePlaying: boolean; reduceMotion: boolean; onPauseDownloadsWhilePlayingChange: (enabled: boolean) => void }) {
  const [installRootValue, setInstallRootValue] = useState(() => localStorage.getItem("nordiee.installRoot") ?? "");
  const [launchAtStartup, setLaunchAtStartup] = useState(false);
  const [startupSaving, setStartupSaving] = useState(false);
  const [autoUpdateGames, setAutoUpdateGames] = useState(() => localStorage.getItem("nordiee.autoUpdateGames") !== "false");
  const [downloadLimitMbps, setDownloadLimitMbps] = useState<number | null>(configuredDownloadLimitMbps);
  const [diagnostics, setDiagnostics] = useState<Record<string, DiagnosticResult>>({ api: "idle", downloads: "idle", storage: "idle" });
  const [diagnosticReport, setDiagnosticReport] = useState<{ message: string; error: boolean } | null>(null);
  useEffect(() => { if (!installRootValue) void installRoot().then(setInstallRootValue); }, [installRootValue]);
  useEffect(() => { void invoke<boolean>("launch_at_startup_enabled").then(setLaunchAtStartup).catch(() => setLaunchAtStartup(false)); }, []);
  const saveInstallRoot = (value: string) => { setInstallRootValue(value); if (value.trim()) localStorage.setItem("nordiee.installRoot", value.trim()); else localStorage.removeItem("nordiee.installRoot"); };
  const setAutoUpdate = (enabled: boolean) => { setAutoUpdateGames(enabled); localStorage.setItem("nordiee.autoUpdateGames", String(enabled)); };
  const toggleLaunchAtStartup = async () => { const next = !launchAtStartup; setStartupSaving(true); try { await invoke("set_launch_at_startup", { enabled: next }); setLaunchAtStartup(next); } finally { setStartupSaving(false); } };
  const saveDownloadLimit = (value: string) => { const next = value === "unlimited" ? null : Number(value); setDownloadLimitMbps(next); if (next) localStorage.setItem("nordiee.downloadLimitMbps", String(next)); else localStorage.removeItem("nordiee.downloadLimitMbps"); };
  const runDiagnostics = async () => {
    setDiagnostics({ api: "checking", downloads: "checking", storage: "checking" });
    const root = await installRoot();
    const [api, downloads, storage] = await Promise.all([
      invoke<boolean>("diagnostics_check_endpoint", { target: "api" }).catch(() => false),
      invoke<boolean>("diagnostics_check_endpoint", { target: "downloads" }).catch(() => false),
      invoke<boolean>("diagnostics_check_install_root", { installRoot: root }).catch(() => false),
    ]);
    setDiagnostics({ api: api ? "pass" : "fail", downloads: downloads ? "pass" : "fail", storage: storage ? "pass" : "fail" });
  };
  const diagnosticLabel = (result: DiagnosticResult) => result === "checking" ? "Checking" : result === "pass" ? "Available" : result === "fail" ? "Unavailable" : "Not checked";
  const exportReport = async () => {
    setDiagnosticReport(null);
    try {
      const path = await invoke<string>("export_diagnostic_report", { api: diagnosticLabel(diagnostics.api), downloads: diagnosticLabel(diagnostics.downloads), storage: diagnosticLabel(diagnostics.storage) });
      setDiagnosticReport({ message: `Saved to ${path}`, error: false });
    } catch {
      setDiagnosticReport({ message: "We could not export the diagnostic report. Try again.", error: true });
    }
  };
  const updateMessage = manualUpdateState === "checking" ? "Checking for an update" : manualUpdateState === "latest" ? "You have the latest launcher." : manualUpdateState === "installing" ? "Downloading and installing the update." : manualUpdateState === "unavailable" ? "We could not reach the update service." : "Check for the latest Nordiee Launcher release.";
  return <section className="settings"><article className="panel"><p className="panel-label">LAUNCHER</p><h3>Application settings</h3><div className="setting-row"><div><strong>Launch at startup</strong><small>Start Nordiee when you sign in to Windows.</small></div><button className={launchAtStartup ? "toggle enabled" : "toggle"} type="button" disabled={startupSaving} aria-pressed={launchAtStartup} aria-label={`Launch at startup, ${launchAtStartup ? "enabled" : "disabled"}`} onClick={() => void toggleLaunchAtStartup()} /></div><div className="setting-row"><div><strong>Game install location</strong><small>Games install beside Nordiee in the NordieeApps folder by default.</small></div><label className="path-field"><span className="sr-only">Game install location</span><input value={installRootValue} onChange={(event) => saveInstallRoot(event.target.value)} spellCheck="false" /></label></div><div className="setting-row"><div><strong>Automatically update games</strong><small>Check installed games when Nordiee opens and download changed files.</small></div><button className={autoUpdateGames ? "toggle enabled" : "toggle"} type="button" aria-pressed={autoUpdateGames} aria-label="Automatically update games" onClick={() => setAutoUpdate(!autoUpdateGames)} /></div><div className="setting-row"><div><strong>Launcher notifications</strong><small>Show completed downloads and important launcher events in the notification center.</small></div><button className={launcherNotificationsEnabled ? "toggle enabled" : "toggle"} type="button" aria-pressed={launcherNotificationsEnabled} aria-label="Launcher notifications" onClick={() => onLauncherNotificationsEnabledChange(!launcherNotificationsEnabled)} /></div><div className="setting-row"><div><strong>Pause downloads while playing</strong><small>Automatically pause transfers while a Nordiee game is running.</small></div><button className={pauseDownloadsWhilePlaying ? "toggle enabled" : "toggle"} type="button" aria-pressed={pauseDownloadsWhilePlaying} aria-label="Pause downloads while playing" onClick={() => onPauseDownloadsWhilePlayingChange(!pauseDownloadsWhilePlaying)} /></div><div className="setting-row"><div><strong>Download limit</strong><small>{downloadLimitMbps ? `Cap game downloads at ${downloadLimitMbps} MB/s.` : "Use all available bandwidth."}</small></div><label><span className="sr-only">Download limit</span><select className="select-button" value={downloadLimitMbps ?? "unlimited"} onChange={(event) => saveDownloadLimit(event.target.value)}><option value="unlimited">Unlimited</option><option value="10">10 MB/s</option><option value="25">25 MB/s</option><option value="50">50 MB/s</option><option value="100">100 MB/s</option></select></label></div><div className="setting-row"><div><strong>Launcher updates</strong><small>{updateMessage}</small></div><button className="select-button" type="button" disabled={manualUpdateState === "checking" || manualUpdateState === "installing"} onClick={onManualUpdateCheck}>{manualUpdateState === "checking" ? "Checking" : manualUpdateState === "installing" ? "Updating" : "Check now"}</button></div></article><article className="panel diagnostics"><div className="panel-heading"><div><p className="panel-label">DIAGNOSTICS</p><h3>System checks</h3></div><button className="select-button" type="button" onClick={() => void runDiagnostics()}>Run checks</button></div><p>Test Nordiee API, downloads and write permission before troubleshooting a game.</p><div className="diagnostic-list">{(["api", "downloads", "storage"] as const).map((key) => <div className="diagnostic-row" key={key}><span>{key === "api" ? "Nordiee API" : key === "downloads" ? "Download service" : "NordieeApps write access"}</span><strong className={`diagnostic-${diagnostics[key]}`}>{diagnosticLabel(diagnostics[key])}</strong></div>)}</div><div className="diagnostic-export"><button className="text-button" type="button" onClick={() => void exportReport()}>Export diagnostic report</button>{diagnosticReport && <small className={diagnosticReport.error ? "diagnostic-export-error" : ""}>{diagnosticReport.message}</small>}</div></article></section>;
}
