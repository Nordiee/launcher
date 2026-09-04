import { FormEvent, useEffect, useState, type ReactNode } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ChevronDownIcon, CloseIcon, DownloadIcon, HomeIcon, LibraryIcon, MaximizeIcon, MinimizeIcon, SettingsIcon } from "./Icons";
import { applyAvailableUpdate, type UpdateState } from "./updates";

type View = "Home" | "Library" | "Downloads" | "Settings";
type AuthMode = "sign-in" | "sign-up";
type Session = { displayName: string; email: string; accessToken: string; refreshToken: string };
type AuthResponse = { accessToken: string; refreshToken: string; username: string; email: string };

const API_BASE_URL = "https://api.nordiee.com/api/v1/auth";
const SESSION_STORAGE_KEY = "nordiee.account-session.v1";

const navigation: { label: View; icon: ReactNode }[] = [
  { label: "Home", icon: <HomeIcon /> },
  { label: "Library", icon: <LibraryIcon /> },
  { label: "Downloads", icon: <DownloadIcon /> },
];

function toSession(response: AuthResponse): Session {
  return { displayName: response.username, email: response.email, accessToken: response.accessToken, refreshToken: response.refreshToken };
}

function readStoredSession(): Session | null {
  try {
    const value = localStorage.getItem(SESSION_STORAGE_KEY);
    if (!value) return null;
    const session = JSON.parse(value) as Partial<Session>;
    if (!session.displayName || !session.email || !session.accessToken || !session.refreshToken) return null;
    return session as Session;
  } catch {
    return null;
  }
}

function persistSession(session: Session) { localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(session)); }
function clearStoredSession() { localStorage.removeItem(SESSION_STORAGE_KEY); }

export default function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [updateState, setUpdateState] = useState<UpdateState>("checking");
  const [sessionReady, setSessionReady] = useState(false);
  useEffect(() => { void applyAvailableUpdate(setUpdateState); }, []);
  useEffect(() => {
    const restoreSession = async () => {
      const stored = readStoredSession();
      if (!stored) { setSessionReady(true); return; }
      try {
        const response = await fetch(`${API_BASE_URL}/refresh`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ refreshToken: stored.refreshToken }) });
        const body = await response.json() as AuthResponse & { error?: string };
        if (!response.ok) throw new Error(body.error ?? "Session expired");
        const nextSession = toSession(body);
        persistSession(nextSession);
        setSession(nextSession);
      } catch {
        clearStoredSession();
      } finally {
        setSessionReady(true);
      }
    };
    void restoreSession();
  }, []);
  const signOut = async () => {
    const currentSession = session;
    clearStoredSession();
    setSession(null);
    if (!currentSession) return;
    void fetch(`${API_BASE_URL}/logout`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${currentSession.accessToken}` }, body: JSON.stringify({ refreshToken: currentSession.refreshToken }) });
  };
  const startSession = (nextSession: Session) => { persistSession(nextSession); setSession(nextSession); };
  return <div className="app-window"><Titlebar />{updateState !== "ready" ? <UpdateGate state={updateState} /> : !sessionReady ? <StartupGate /> : session ? <Launcher session={session} onLogOff={signOut} /> : <AuthScreen onSession={startSession} />}</div>;
}

function UpdateGate({ state }: { state: UpdateState }) { return <main className="update-gate"><img src="/logo.svg" alt="Nordiee" /><div className="update-spinner" aria-hidden="true" /><h1>{state === "checking" ? "Checking for updates" : "Updating Nordiee"}</h1><p>{state === "checking" ? "Making sure you are on the latest version." : "Installing the latest version. Nordiee will reopen automatically."}</p></main>; }
function StartupGate() { return <main className="update-gate"><img src="/logo.svg" alt="Nordiee" /><div className="update-spinner" aria-hidden="true" /><h1>Restoring your session</h1><p>Checking your Nordiee account securely.</p></main>; }

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

function AuthScreen({ onSession }: { onSession: (session: Session) => void }) {
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
      onSession(toSession(body));
    } catch (error) { setMessage(error instanceof Error ? error.message : "Unable to reach Nordiee accounts."); }
  };
  return <main className="auth-shell">
    <section className="auth-intro"><img src="/logo.svg" alt="Nordiee" className="auth-logo" /><p className="eyebrow">NORDIEE LAUNCHER</p><h1>Everything you play, in one place.</h1><p>Sign in to access your library, installations and downloads. Launcher access stays locked until an account session is verified.</p><div className="auth-status"><span /> Secure account access</div></section>
    <section className="auth-panel" aria-labelledby="auth-heading">
      <div className="auth-tabs" role="tablist" aria-label="Account access"><button className={mode === "sign-in" ? "active" : ""} type="button" role="tab" aria-selected={mode === "sign-in"} onClick={() => changeMode("sign-in")}>Sign in</button><button className={mode === "sign-up" ? "active" : ""} type="button" role="tab" aria-selected={mode === "sign-up"} onClick={() => changeMode("sign-up")}>Create account</button></div>
      <div className="auth-form-wrap"><p className="eyebrow">{mode === "sign-in" ? "WELCOME BACK" : "JOIN NORDIEE"}</p><h2 id="auth-heading">{mode === "sign-in" ? "Sign in to Nordiee" : "Create your account"}</h2><p className="auth-copy">{mode === "sign-in" ? "Use your Nordiee account to continue." : "Your library will be ready when you are."}</p>
        <form onSubmit={submit}>{mode === "sign-up" && <label>Display name<input name="display-name" autoComplete="nickname" required minLength={3} placeholder="Your Nordiee name" /></label>}<label>Email<input name="email" type="email" autoComplete="email" required placeholder="you@example.com" /></label><label>Password<input name="password" type="password" autoComplete={mode === "sign-in" ? "current-password" : "new-password"} required minLength={8} placeholder="At least 8 characters" /></label>{message && <p className="auth-message" role="status">{message}</p>}<button className="primary-button auth-submit" type="submit">{mode === "sign-in" ? "Sign in" : "Create account"}</button></form>
        <p className="auth-switch">{mode === "sign-in" ? "New to Nordiee?" : "Already have an account?"} <button type="button" onClick={() => changeMode(mode === "sign-in" ? "sign-up" : "sign-in")}>{mode === "sign-in" ? "Create one" : "Sign in"}</button></p>
      </div>
    </section>
  </main>;
}

function Launcher({ session, onLogOff }: { session: Session; onLogOff: () => void }) {
  const [view, setView] = useState<View>("Home");
  const [accountOpen, setAccountOpen] = useState(false);
  return <div className="launcher-shell"><a className="skip-link" href="#main-content">Skip to content</a><aside className="sidebar" aria-label="Launcher navigation"><div className="sidebar-brand"><img src="/logo.svg" alt="Nordiee" /><span>NORDIEE</span></div><nav className="navigation">{navigation.map((item) => <button className={view === item.label ? "nav-item active" : "nav-item"} key={item.label} onClick={() => setView(item.label)} type="button"><span className="nav-icon">{item.icon}</span>{item.label}</button>)}</nav><div className="sidebar-bottom"><button className={view === "Settings" ? "nav-item active" : "nav-item"} onClick={() => setView("Settings")} type="button"><span className="nav-icon"><SettingsIcon /></span>Settings</button><div className="account-menu"><button className="profile" type="button" aria-expanded={accountOpen} aria-haspopup="menu" onClick={() => setAccountOpen(!accountOpen)}><span className="avatar">{session.displayName[0]?.toUpperCase()}</span><span><strong>{session.displayName}</strong><small>{session.email}</small></span><ChevronDownIcon size={15} /></button>{accountOpen && <div className="account-popover" role="menu"><button type="button" role="menuitem" onClick={onLogOff}>Switch account</button><button type="button" role="menuitem" onClick={onLogOff}>Log off</button><button className="danger-action" type="button" role="menuitem" onClick={onLogOff}>Remove this account</button></div>}</div></div></aside><main id="main-content" className="content" tabIndex={-1}><header className="topbar"><div><p className="eyebrow">NORDIEE LAUNCHER</p><h1>{view}</h1></div><div className="service-status"><span /> All systems operational</div></header>{view === "Home" && <Home />}{view === "Library" && <EmptyState title="Your library is ready" text="Games you own and their installation state will be shown here." action="Browse library" />}{view === "Downloads" && <EmptyState title="No active downloads" text="Game installs, updates and repairs will appear here." action="Browse library" />}{view === "Settings" && <Settings />}</main></div>;
}

function Home() { return <section className="home-grid" aria-label="Launcher overview"><article className="welcome-card"><p className="eyebrow">EARLY BUILD</p><h2>Your games, one place.</h2><p>Nordiee is getting ready. Your verified account will connect your library, downloads and settings.</p><button className="primary-button" type="button">View your library</button></article><article className="panel"><p className="panel-label">DOWNLOADS</p><h3>Nothing in queue</h3><p>Game installs, updates and repairs will appear here.</p></article><article className="panel full-width"><div className="panel-heading"><div><p className="panel-label">LIBRARY</p><h3>Ready when you are</h3></div><span className="count">0 games</span></div><p>Your library will appear here after your account has games.</p></article></section>; }
function EmptyState({ title, text, action }: { title: string; text: string; action: string }) { return <section className="empty-state"><div className="empty-mark" aria-hidden="true">N</div><h2>{title}</h2><p>{text}</p><button className="primary-button" type="button">{action}</button></section>; }
function Settings() { return <section className="settings"><article className="panel"><p className="panel-label">LAUNCHER</p><h3>Application settings</h3><div className="setting-row"><div><strong>Launch at startup</strong><small>Start Nordiee when you sign in to Windows.</small></div><button className="toggle" type="button" aria-label="Launch at startup, disabled" /></div><div className="setting-row"><div><strong>Download limit</strong><small>No limit configured.</small></div><button className="select-button" type="button">Unlimited</button></div></article></section>; }
