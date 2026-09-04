import { FormEvent, useEffect, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ArrowRightIcon, ChevronDownIcon, CloseIcon, DownloadIcon, HomeIcon, LibraryIcon, MaximizeIcon, MinimizeIcon, PlusIcon, SettingsIcon, TrashIcon } from "./Icons";
import { activeAccountEmail, clearActiveAccount, getAccountSession, listSavedAccounts, migrateLegacyAccounts, removeSavedAccount, saveAccountSession, type AccountSecret, type SavedAccount } from "./accountStore";
import { readLibraryCache, saveLibraryCache, type LibraryGame } from "./libraryCache";
import { applyAvailableUpdate, type UpdateState } from "./updates";

type View = "Home" | "Library" | "Downloads" | "Settings";
type AuthMode = "sign-in" | "sign-up";
type Session = SavedAccount & AccountSecret;
type AuthResponse = { accessToken: string; refreshToken: string; username: string; email: string };
type AccessView = "accounts" | "credentials";
type VerificationState = "verifying" | "verified" | "repair";

const API_BASE_URL = "https://api.nordiee.com/api/v1/auth";
const LIBRARY_API_URL = "https://api.nordiee.com/api/v1/library";

async function installRoot() {
  const saved = localStorage.getItem("nordiee.installRoot");
  return saved?.trim() || invoke<string>("default_install_root");
}

const navigation: { label: View; icon: ReactNode }[] = [
  { label: "Home", icon: <HomeIcon /> },
  { label: "Library", icon: <LibraryIcon /> },
  { label: "Downloads", icon: <DownloadIcon /> },
];

function toSession(response: AuthResponse): Session {
  return { displayName: response.username, email: response.email, accessToken: response.accessToken, refreshToken: response.refreshToken };
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
  const startSession = async (nextSession: Session) => { await saveAccountSession(nextSession, nextSession); setAccounts(listSavedAccounts()); setSession(nextSession); };
  const selectAccount = async (account: SavedAccount) => {
    const savedSession = await getAccountSession(account.email);
    if (!savedSession) { clearActiveAccount(); setPrefilledEmail(account.email); setAccessView("credentials"); return; }
    const response = await fetch(`${API_BASE_URL}/refresh`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ refreshToken: savedSession.refreshToken }) });
    const body = await response.json() as AuthResponse & { error?: string };
    if (!response.ok) { clearActiveAccount(); setPrefilledEmail(account.email); setAccessView("credentials"); return; }
    await startSession(toSession(body));
  };
  return <div className="app-window"><Titlebar />{updateState !== "ready" ? <UpdateGate state={updateState} /> : !sessionReady ? <StartupGate /> : session ? <Launcher session={session} onSwitchAccount={switchAccount} onLogOff={logOff} onRemoveAccount={removeAccount} /> : accessView === "accounts" && accounts.length ? <AccountPicker accounts={accounts} onSelect={selectAccount} onAdd={() => setAccessView("credentials")} onRemove={removeAccount} /> : <AuthScreen initialEmail={prefilledEmail} onBack={accounts.length ? () => setAccessView("accounts") : undefined} onSession={startSession} />}</div>;
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

function AccountPicker({ accounts, onSelect, onAdd, onRemove }: { accounts: SavedAccount[]; onSelect: (account: SavedAccount) => Promise<void>; onAdd: () => void; onRemove: (account: SavedAccount) => Promise<void> }) {
  const [busyEmail, setBusyEmail] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const choose = async (account: SavedAccount) => { setMessage(""); setBusyEmail(account.email); try { await onSelect(account); } catch { setMessage("We could not reach Nordiee accounts. Check your connection and try again."); } finally { setBusyEmail(null); } };
  const remove = async (account: SavedAccount) => { if (!window.confirm(`Remove ${account.displayName} from this computer?`)) return; setBusyEmail(account.email); try { await onRemove(account); } finally { setBusyEmail(null); } };
  return <main className="account-picker"><section className="account-picker-card" aria-labelledby="choose-account-title"><div className="picker-heading"><img src="/logo.svg" alt="Nordiee" /><div><p className="eyebrow">NORDIEE LAUNCHER</p><h1 id="choose-account-title">Choose an account</h1><p>Accounts signed in on this computer.</p></div></div><div className="saved-accounts" role="list">{accounts.map((account) => <article className="saved-account" key={account.email} role="listitem"><button className="saved-account-main" type="button" disabled={busyEmail !== null} onClick={() => void choose(account)}><span className="account-avatar">{account.displayName[0]?.toUpperCase()}</span><span><strong>{account.displayName}</strong><small>{account.email}</small></span><ArrowRightIcon /></button><button className="remove-account" type="button" disabled={busyEmail !== null} aria-label={`Remove ${account.displayName} from this computer`} onClick={() => void remove(account)}><TrashIcon /></button>{busyEmail === account.email && <span className="account-working">Connecting</span>}</article>)}</div>{message && <p className="picker-message" role="alert">{message}</p>}<button className="add-account" type="button" onClick={onAdd}><PlusIcon />Sign in with another account</button></section></main>;
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
  const [accountOpen, setAccountOpen] = useState(false);
  const remove = async () => { if (!window.confirm(`Remove ${session.displayName} from this computer?`)) return; await onRemoveAccount(session); };
  return <div className="launcher-shell"><a className="skip-link" href="#main-content">Skip to content</a><aside className="sidebar" aria-label="Launcher navigation"><div className="sidebar-brand"><img src="/logo.svg" alt="Nordiee" /><span>NORDIEE</span></div><nav className="navigation">{navigation.map((item) => <button className={view === item.label ? "nav-item active" : "nav-item"} key={item.label} onClick={() => setView(item.label)} type="button"><span className="nav-icon">{item.icon}</span>{item.label}</button>)}</nav><div className="sidebar-bottom"><button className={view === "Settings" ? "nav-item active" : "nav-item"} onClick={() => setView("Settings")} type="button"><span className="nav-icon"><SettingsIcon /></span>Settings</button><div className="account-menu"><button className="profile" type="button" aria-expanded={accountOpen} aria-haspopup="menu" onClick={() => setAccountOpen(!accountOpen)}><span className="avatar">{session.displayName[0]?.toUpperCase()}</span><span><strong>{session.displayName}</strong><small>{session.email}</small></span><ChevronDownIcon size={15} /></button>{accountOpen && <div className="account-popover" role="menu"><button type="button" role="menuitem" onClick={onSwitchAccount}>Switch account</button><button type="button" role="menuitem" onClick={() => void onLogOff()}>Log off</button><button className="danger-action" type="button" role="menuitem" onClick={() => void remove()}>Remove this account</button></div>}</div></div></aside><main id="main-content" className="content" tabIndex={-1}><header className="topbar"><div><p className="eyebrow">NORDIEE LAUNCHER</p><h1>{view}</h1></div><div className="service-status"><span /> All systems operational</div></header>{view === "Home" && <Home />}{view === "Library" && <Library accessToken={session.accessToken} />}{view === "Downloads" && <EmptyState title="No active downloads" text="Game installs, updates and repairs will appear here." action="Browse library" />}{view === "Settings" && <Settings />}</main></div>;
}

function Home() { return <section className="home-grid" aria-label="Launcher overview"><article className="welcome-card"><p className="eyebrow">EARLY BUILD</p><h2>Your games, one place.</h2><p>Nordiee is getting ready. Your verified account will connect your library, downloads and settings.</p><button className="primary-button" type="button">View your library</button></article><article className="panel"><p className="panel-label">DOWNLOADS</p><h3>Nothing in queue</h3><p>Game installs, updates and repairs will appear here.</p></article><article className="panel full-width"><div className="panel-heading"><div><p className="panel-label">LIBRARY</p><h3>Ready when you are</h3></div><span className="count">0 games</span></div><p>Your library will appear here after your account has games.</p></article></section>; }
function Library({ accessToken }: { accessToken: string }) {
  const email = activeAccountEmail() ?? "";
  const cachedLibrary = readLibraryCache(email);
  const [status, setStatus] = useState<"loading" | "ready" | "offline" | "error">("loading");
  const [games, setGames] = useState<LibraryGame[]>([]);
  const [installingId, setInstallingId] = useState<string | null>(null);
  const [installedIds, setInstalledIds] = useState<string[]>([]);
  const [installError, setInstallError] = useState("");
  const [verification, setVerification] = useState<Record<string, VerificationState>>({});
  const [downloadProgress, setDownloadProgress] = useState<{ gameId: string; downloadedBytes: number; totalBytes: number } | null>(null);
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
  useEffect(() => {
    let active = true;
    const findInstalledGames = async () => {
      try {
        const root = await installRoot();
        const checks = await Promise.all(games.map(async (game) => ({ id: game.id, version: await invoke<string | null>("installed_game_version", { gameId: game.id, installRoot: root }) })));
        if (active) setInstalledIds(checks.filter((check) => check.version).map((check) => check.id));
      } catch {
        if (active) setInstalledIds([]);
      }
    };
    if (games.length) void findInstalledGames();
    return () => { active = false; };
  }, [games]);
  const install = async (game: LibraryGame) => {
    setInstallError("");
    setInstallingId(game.id);
    setDownloadProgress(null);
    try {
      const response = await fetch(`${LIBRARY_API_URL}/${game.id}/manifest`, { headers: { Authorization: `Bearer ${accessToken}` } });
      if (!response.ok) throw new Error("This game does not have an active install build yet.");
      const manifest = await response.json();
      await invoke("install_game", { manifestJson: JSON.stringify(manifest), installRoot: await installRoot() });
      setInstalledIds((current) => [...new Set([...current, game.id])]);
    } catch (error) {
      setInstallError(error instanceof Error ? error.message : "We could not install this game.");
    } finally {
      setInstallingId(null);
      setDownloadProgress(null);
    }
  };
  const verify = async (game: LibraryGame) => {
    setInstallError("");
    setVerification((current) => ({ ...current, [game.id]: "verifying" }));
    try {
      const result = await invoke<{ verified: boolean }>("verify_game", { gameId: game.id, installRoot: await installRoot() });
      setVerification((current) => ({ ...current, [game.id]: result.verified ? "verified" : "repair" }));
    } catch (error) {
      setVerification((current) => { const next = { ...current }; delete next[game.id]; return next; });
      setInstallError(error instanceof Error ? error.message : "We could not verify this game.");
    }
  };
  const repair = async (game: LibraryGame) => {
    setInstallError("");
    setInstallingId(game.id);
    setDownloadProgress(null);
    try {
      await invoke("repair_game", { gameId: game.id, installRoot: await installRoot() });
      setVerification((current) => ({ ...current, [game.id]: "verified" }));
    } catch (error) {
      setInstallError(error instanceof Error ? error.message : "We could not repair this game.");
    } finally {
      setInstallingId(null);
      setDownloadProgress(null);
    }
  };
  if (status === "loading") return <section className="library-state" aria-live="polite"><span className="library-loader" aria-hidden="true" /><h2>Loading your library</h2><p>Fetching the games connected to this account.</p></section>;
  if (status === "error") return <section className="library-state"><div className="empty-mark" aria-hidden="true">N</div><h2>We could not load your library</h2><p>Check your connection, then try again.</p><button className="primary-button" type="button" onClick={() => void loadLibrary()}>Try again</button></section>;
  const offlineNotice = status === "offline" ? <p className="offline-notice" role="status">Offline mode - showing the last library saved on this device.</p> : null;
  if (!games.length) return <>{offlineNotice}<section className="empty-state"><div className="empty-mark" aria-hidden="true">N</div><h2>Your library is ready</h2><p>Games connected to your Nordiee account will appear here.</p></section></>;
  return <>{offlineNotice}{installError && <p className="install-error" role="alert">{installError}</p>}<section className="library-grid" aria-label="Your game library">{games.map((game) => {
    const isInstalling = installingId === game.id;
    const isInstalled = installedIds.includes(game.id) || game.installState === "INSTALLED";
    const percentage = isInstalling && downloadProgress?.gameId === game.id && downloadProgress.totalBytes ? Math.round((downloadProgress.downloadedBytes / downloadProgress.totalBytes) * 100) : null;
    const checkState = verification[game.id];
    return <article className="library-card" key={game.id}><div className="library-cover" aria-hidden="true">N</div><div><p className="panel-label">{isInstalled ? checkState === "repair" ? "REPAIR REQUIRED" : "INSTALLED" : isInstalling ? "DOWNLOADING" : game.installState}</p><h2>{game.title}</h2><p>{isInstalling && percentage !== null ? `${percentage}% downloaded` : checkState === "verified" ? "All installed files verified." : checkState === "repair" ? "One or more files need repair." : game.installSizeBytes ? `${Math.round(game.installSizeBytes / 1_000_000_000)} GB` : "Size will be available soon"}</p><button className="library-action" type="button" disabled={isInstalling || checkState === "verifying"} onClick={() => void (isInstalled ? checkState === "repair" ? repair(game) : verify(game) : install(game))}>{isInstalled ? checkState === "verifying" ? "Verifying" : checkState === "repair" ? isInstalling ? percentage !== null ? `Repairing ${percentage}%` : "Preparing repair" : "Repair files" : "Verify files" : isInstalling ? percentage !== null ? `Downloading ${percentage}%` : "Preparing" : "Install"}</button></div></article>;
  })}</section></>;
}
function EmptyState({ title, text, action }: { title: string; text: string; action: string }) { return <section className="empty-state"><div className="empty-mark" aria-hidden="true">N</div><h2>{title}</h2><p>{text}</p><button className="primary-button" type="button">{action}</button></section>; }
function Settings() {
  const [installRootValue, setInstallRootValue] = useState(() => localStorage.getItem("nordiee.installRoot") ?? "");
  useEffect(() => { if (!installRootValue) void installRoot().then(setInstallRootValue); }, [installRootValue]);
  const saveInstallRoot = (value: string) => { setInstallRootValue(value); if (value.trim()) localStorage.setItem("nordiee.installRoot", value.trim()); else localStorage.removeItem("nordiee.installRoot"); };
  return <section className="settings"><article className="panel"><p className="panel-label">LAUNCHER</p><h3>Application settings</h3><div className="setting-row"><div><strong>Launch at startup</strong><small>Start Nordiee when you sign in to Windows.</small></div><button className="toggle" type="button" aria-label="Launch at startup, disabled" /></div><div className="setting-row"><div><strong>Game install location</strong><small>Games install beside Nordiee in the NordieeApps folder by default.</small></div><label className="path-field"><span className="sr-only">Game install location</span><input value={installRootValue} onChange={(event) => saveInstallRoot(event.target.value)} spellCheck="false" /></label></div><div className="setting-row"><div><strong>Download limit</strong><small>No limit configured.</small></div><button className="select-button" type="button">Unlimited</button></div></article></section>;
}
