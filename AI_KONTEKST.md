# Handleliste – AI-kontekst

## Hva appen gjør
Norsk handlelisteapp for husholdninger. Brukere logger inn med Google, deler en
felles handleliste, scanner kvitteringer, fører familietavle (oppgaver/aktiviteter/
påminnelser) og ser handlehistorikk med statistikk. Varer kan legges til fra en norsk
produktdatabase med fuzzy matching.

## Tech stack
- **Frontend:** Vanilla JS / HTML (ingen rammeverk) — deployet på **Cloudflare Pages**
- **Backend/DB:** Firebase (Firestore)
- **Auth:** Firebase Authentication (Google-innlogging, `signInWithPopup`)
- **Push:** Firebase Cloud Messaging + service worker (`firebase-messaging-sw.js`, VAPID)
- **AI:** Claude API via `_worker.js` på `/scan`-endepunktet — kvitteringsscanning og kjøleskap-analyse
  - **Modell i bruk:** `claude-sonnet-4-6`, `max_tokens: 4096`
  - ⚠️ NB: tidligere notater nevnte Haiku. Koden kjører nå Sonnet 4.6 (bedre OCR, men dyrere). Avklar om dette er ønsket valg.
- **Produktdatabase:** `products.js` — ~502 norske dagligvarer med fuzzy matching + `PRICE_DB` for prisestimat

## Deploy / repo
- Live: **handleliste.pages.dev** (Cloudflare Pages)
- Repo: **github.com/thomasmaeland/Handleliste**
- Firebase-prosjekt: `handleliste-64ec3`
- Husholdningsdata under `lists/{LIST_ID}` (LIST_ID = `"hjem"`)

## Arkitektur
- **Innlogging:** Google-konto per bruker (`currentUser.uid` / `displayName` brukes gjennom hele appen)
- **Deling:** husholdning deles via en **tilgangskode** (delekode-flyt i UI) — koden er potensielt gjetbar (kjent sikkerhetsrisiko)
- **Firestore-struktur:**
  - `lists/{LIST_ID}/items` — handlelistevarer
  - `lists/{LIST_ID}/tasks` — familietavle (oppgaver, aktiviteter, påminnelser, gjentakelse, varsler)
  - `lists/{LIST_ID}/history` — lagrede handleturer med kategorisummer
  - `lists/{LIST_ID}/meta/history2` — kjøpshistorikk / prishukommelse
  - `users/{uid}` — push-token o.l.
- **`_worker.js` overstyrer `functions/`-mappa i Cloudflare Pages** — alltid rediger `_worker.js` for API-ruting.

## Viktige funksjoner (bygget)
- **Handlemodus:** fullskjerm i butikk, store avkrysninger, sanntids Firestore-sync, løpende prissum
- **Sveipegester:** høyre = ferdig, venstre = slett, med rubber-band, fly-out-animasjon og 4-sek angre-toast
- **Kvitteringsscanning:** ett-stegs Claude Vision-pipeline via `/scan`; prompt håndterer norsk staving, antall-prefiks vs. pakningsbeskrivelse, og `BX`-enhet
- **Familietavle:** oppgaver/aktiviteter/påminnelser med ansvarlig, person-filter, gjentakelse og varsler
- **Historikk + statistikk:** månedssammendrag, topp produkter, topp butikker
- **Push-varsler:** Firebase Messaging + service worker
- **Tema + tekststørrelse:** mørk navy/gull + lyst tema, tilgjengelighetsfokusert fontskalering

## Bildehåndtering (frontend → /scan)
- Bildet skaleres ned til **MAX 2200px** og JPEG-kvalitet **0.92** før sending (under Anthropics ~8000px-grense)
- JSON fra Claude renses med `firstBrace`/`lastBrace`-uttrekk for å takle markdown-wrapping / vrøvl rundt objektet

## Utestående oppgaver / neste steg
- [ ] **Fikse Firestore Security Rules (kritisk)** — appens sikkerhet hviler på reglene, ikke på frontend-koden. `firestore.rules` finnes med `isHouseholdMember()`-hjelper, men må verifiseres/strammes.
- [ ] **Løse gjetbare husholdningskoder** (delekoden)
- [ ] **Avklar AI-modell:** Sonnet 4.6 vs Haiku 4.5 for `/scan` — kvalitet vs. kostnad
- [ ] **Rydde i `/scan`-kontrakt:** frontend sender et `instructions`-felt som `_worker.js` ikke leser (`{ image, mediaType, type }`). Enten fjern feltet fra frontend, eller bruk det i worker.
- [ ] **Robusthet i worker:** legg til `if (!image)`-sjekk før kall til Anthropic, så manglende bilde gir pen feilmelding i stedet for kryptisk API-feil
- [ ] Vurdere tredje bruker (kollega) i husholdningen
- [ ] Åpent spørsmål: utvide appen utover privat bruk (da blir GDPR relevant)

## Viktige beslutninger tatt
- Migrert fra Netlify til Cloudflare Pages (kvitteringsscanner fungerer nå)
- Valgt Firebase fremfor Supabase for denne appen spesifikt
- `confirm()`-dialogen på `deleteBoardTask` fjernet med vilje — sveip fungerer som bevisst bekreftelse
- Firebase API-nøkkel i frontend er ikke en sikkerhetsrisiko; beskyttelse kommer fra Firestore-reglene

## Siste gjennomgang (denne økten)
- Gikk gjennom `index.html` og `_worker.js`. Begge ser strukturelt solide ut.
- Funn: modell er Sonnet 4.6 (ikke Haiku), ubrukt `instructions`-felt, mangler `if (!image)`-guard. Lagt inn som utestående punkter over.
- Notatet er oppdatert til å gjenspeile faktisk kode (Google-auth, push, familietavle, historikk/statistikk var ikke nevnt før).

## Filer å laste opp i ny Claude-samtale
- `firestore.rules`
- `products.js`
- `index.html` og/eller `_worker.js` for det du jobber med
- Denne `AI_KONTEKST.md`

## Ikke endre uten grunn
- Produktdatabasestrukturen i `products.js`
- Det mørke navy/gull-temaet

## Arbeidsmåte (preferanser)
- Komplette, oppdaterte filer fremfor delvise utdrag
- `str_replace`-stil for små, målrettede endringer
- Iterativ feilsøking via DevTools (Network + Console)
- Hold løsninger så enkle som mulig
