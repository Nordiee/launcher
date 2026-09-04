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

## Aktivno

- Presence, profile i multiple-library UI/API commitovi čekaju GitHub push, čim mrežna veza agenta bude dostupna.

## Sledeći alpha prioriteti

1. Locate existing installation bez novog download-a
2. Move game između biblioteka bez reinstalacije
3. Game detail strana: overview, activity, update history i settings
4. Friend request i game update obaveštenja u launcher notification centru
5. Poliranje prema finalnom Figma dizajnu

## Pravila isporuke

- Svaka izmena se pushuje u GitHub pre deploya.
- Launcher update ide samo kroz verzionisani signed GitHub release tag.
- Pre push-a se pokreću relevantni build i testovi.
