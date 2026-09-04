import { FormEvent, useState, type ReactNode } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ChevronDownIcon, CloseIcon, DownloadIcon, HomeIcon, LibraryIcon, MaximizeIcon, MinimizeIcon, SettingsIcon } from "./Icons";

type View = "Home" | "Library" | "Downloads" | "Settings";
type AuthMode = "sign-in" | "sign-up";
type Session = { displayName: string; email: string };

const navigation: { label: View; icon: ReactNode }[] = [
  { label: "Home", icon: <HomeIcon /> },
  { label: "Library", icon: <LibraryIcon /> },
  { label: "Downloads", icon: <DownloadIcon /> },
];

export default function App() {
  const [session, setSession] = useState<Session | null>(null);
  return <div className="app-window"><Titlebar />{session ? <Launcher session={session} onLogOff={() => setSession(null)} /> : <AuthScreen />}</div>;
}

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

function AuthScreen() {
  const [mode, setMode] = useState<AuthMode>("sign-in");
  const [message, setMessage] = useState("");
  const changeMode = (next: AuthMode) => { setMode(next); setMessage(""); };
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setMessage("Nordiee account service is not connected yet. This screen will use the production account API before launcher access is enabled.");
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
