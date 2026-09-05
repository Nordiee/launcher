# Nordiee Launcher Roadmap

Detaljna platform vizija je u workspace dokumentu `NORDIEE — Complete Product & Feature Blueprint.md`. Ovaj fajl prati implementaciono stanje launchera.

## Završeno

- Custom Tauri window chrome
- Signup, sign-in, encrypted lokalne session kredencijale
- Account switcher, log off i uklanjanje naloga sa računara
- Signed launcher update preko verzionisanih GitHub release tagova
- Offline library cache i dijagnostika
- Install, update, verify, repair, uninstall i open-folder
- Resumable transferi: pause, resume, cancel i obnovljen transfer queue
- Bandwidth limit, pause downloads while playing i per-game auto-update režimi
- Launch options po igri
- Favorites, recent games, playtime i last played
- Library filteri i sortiranje, uključujući Recently played i Most played
- `Ctrl + K` Library search
- Zaštita od path traversal-a pri instalaciji
- Friends ekran: add request, incoming requests, accept, decline i unfriend
- Friends presence: Online, Away, Busy, Invisible i Offline
- Profile: bio, HTTPS avatar URL i Public/Friends/Private privacy kontrole
- Multiple game libraries i izbor diska pri instalaciji
- Locate existing installation bez novog download-a
- Move game između biblioteka bez reinstalacije
- Game detail strana: overview, activity, update history i settings
- Launcher notification centar za friend request i game update
- Favorite Friends: lokalno po nalogu, uvek na vrhu Friends liste
- Friend Notes: privatne lokalne beleške uz prijatelja
- Friend Code: trajni `ND-XXXX-XXXX-XXXX` kod za deljenje i slanje zahteva
- Friends lista: Favorites, Online, Away, Busy i Offline sekcije
- Outgoing Requests: pregled poslatih zahteva i otkazivanje
- In-game presence: heartbeat pri igranju, automatski expiry i Friends prikaz aktivne igre
- Friend Profile Preview: bio, avatar i presence uz postojeća privacy pravila
- Friend Code Copy: kopiranje ličnog koda direktno iz Friends ekrana
- Friends resilience: bezbedan prikaz API odgovora, recovery ekran i trajne notifikacije za pending zahteve
- Download Schedule: lokalni vremenski prozor koji automatski pauzira i nastavlja transfere
- Performance Mode: manje background provera i reduced-motion dok igra radi
- Startup Page: izbor Home, Library, Downloads ili Friends pri pokretanju launchera
- Opt-in support reports: lokalno redigovani crash detalji i autentifikovan dijagnostički upload

## Aktivno

- Praćenje produkcionih support reportova i poliranje prema finalnom Figma dizajnu.

## Sledeći alpha prioriteti

1. Poliranje prema finalnom Figma dizajnu

## Pravila isporuke

- Svaka izmena se pushuje u GitHub pre deploya.
- Launcher update ide samo kroz verzionisani signed GitHub release tag.
- Pre push-a se pokreću relevantni build i testovi.
