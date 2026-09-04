import { useState, type ReactNode } from "react";
import { ChevronDownIcon, DownloadIcon, HomeIcon, LibraryIcon, SettingsIcon } from "./Icons";

type View = "Home" | "Library" | "Downloads" | "Settings";

const navigation: { label: View; icon: ReactNode }[] = [
  { label: "Home", icon: <HomeIcon /> },
  { label: "Library", icon: <LibraryIcon /> },
  { label: "Downloads", icon: <DownloadIcon /> },
];

export default function App() {
  const [view, setView] = useState<View>("Home");

  return (
    <div className="launcher-shell">
      <a className="skip-link" href="#main-content">Skip to content</a>
      <aside className="sidebar" aria-label="Launcher navigation">
        <div className="brand">
          <img src="/logo.svg" alt="Nordiee" />
          <span>NORDIEE</span>
        </div>

        <nav className="navigation">
          {navigation.map((item) => (
            <button
              className={view === item.label ? "nav-item active" : "nav-item"}
              key={item.label}
              onClick={() => setView(item.label)}
              type="button"
            >
              <span className="nav-icon">{item.icon}</span>
              {item.label}
            </button>
          ))}
        </nav>

        <div className="sidebar-bottom">
          <button
            className={view === "Settings" ? "nav-item active" : "nav-item"}
            onClick={() => setView("Settings")}
            type="button"
          >
            <span className="nav-icon"><SettingsIcon /></span>
            Settings
          </button>
          <button className="profile" type="button" aria-label="Open account menu">
            <span className="avatar">N</span>
            <span><strong>Guest</strong><small>Not signed in</small></span>
            <ChevronDownIcon size={15} />
          </button>
        </div>
      </aside>

      <main id="main-content" className="content" tabIndex={-1}>
        <header className="topbar">
          <div>
            <p className="eyebrow">NORDIEE LAUNCHER</p>
            <h1>{view}</h1>
          </div>
          <div className="service-status"><span /> All systems operational</div>
        </header>

        {view === "Home" && <Home />}
        {view === "Library" && <EmptyState title="Your library is ready" text="Sign in to see games you own and manage installations." action="Sign in" />}
        {view === "Downloads" && <EmptyState title="No active downloads" text="Game installs, updates, and repairs will appear here." action="Browse library" />}
        {view === "Settings" && <Settings />}
      </main>
    </div>
  );
}

function Home() {
  return (
    <section className="home-grid" aria-label="Launcher overview">
      <article className="welcome-card">
        <p className="eyebrow">EARLY BUILD</p>
        <h2>Your games, one place.</h2>
        <p>Nordiee is getting ready. Sign in will connect your library, downloads, and account when the platform is live.</p>
        <button className="primary-button" type="button">Sign in to Nordiee</button>
      </article>
      <article className="panel">
        <p className="panel-label">DOWNLOADS</p>
        <h3>Nothing in queue</h3>
        <p>When games are available, their download and update progress will be shown here.</p>
      </article>
      <article className="panel full-width">
        <div className="panel-heading"><div><p className="panel-label">LIBRARY</p><h3>Ready when you are</h3></div><span className="count">0 games</span></div>
        <p>Your library will appear here after you sign in.</p>
      </article>
    </section>
  );
}

function EmptyState({ title, text, action }: { title: string; text: string; action: string }) {
  return <section className="empty-state"><div className="empty-mark" aria-hidden="true">N</div><h2>{title}</h2><p>{text}</p><button className="primary-button" type="button">{action}</button></section>;
}

function Settings() {
  return <section className="settings"><article className="panel"><p className="panel-label">LAUNCHER</p><h3>Application settings</h3><div className="setting-row"><div><strong>Launch at startup</strong><small>Start Nordiee when you sign in to Windows.</small></div><button className="toggle" type="button" aria-label="Launch at startup, disabled" /></div><div className="setting-row"><div><strong>Download limit</strong><small>No limit configured.</small></div><button className="select-button" type="button">Unlimited</button></div></article></section>;
}
