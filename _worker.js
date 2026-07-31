// ============================================================
//  Handleliste – Cloudflare Worker (API-proxy mot Anthropic)
//  Endepunkter:
//    POST /suggest-packing  – AI-pakkeforslag for en tur
//    POST /scan             – kvitteringsscanning / kjøleskap-analyse
//    POST /parse-menu       – tolker ukesmeny (tekst eller bilde) til struktur
//  Alt annet serveres som statiske filer (ASSETS).
// ============================================================

// Reparerer JSON som ble avkuttet (f.eks. ved max_tokens).
// Kutter tilbake til siste komplette objekt og lukker åpne arrays/objekter i riktig rekkefølge.
function repairTruncatedJson(s) {
  let lastComplete = s.lastIndexOf("}");
  if (lastComplete === -1) return null;
  let candidate = s.substring(0, lastComplete + 1);

  for (let attempt = 0; attempt < 200; attempt++) {
    try {
      return JSON.parse(candidate);
    } catch (e) {
      // Bygg en stack over åpne strukturer for å lukke i riktig nestingsrekkefølge
      const stack = [];
      let inStr = false, esc = false;
      for (const ch of candidate) {
        if (esc) { esc = false; continue; }
        if (ch === "\\") { esc = true; continue; }
        if (ch === '"') { inStr = !inStr; continue; }
        if (inStr) continue;
        if (ch === "{") stack.push("}");
        else if (ch === "[") stack.push("]");
        else if (ch === "}" || ch === "]") stack.pop();
      }
      // Fjern henge-komma, lukk i omvendt rekkefølge (innerst først)
      candidate = candidate.replace(/,\s*$/, "");
      if (stack.length > 0) {
        candidate = candidate + stack.reverse().join("");
      } else {
        // Ingen åpne strukturer men fortsatt ugyldig – kutt til forrige "}"
        const prev = candidate.lastIndexOf("}", candidate.length - 2);
        if (prev === -1) return null;
        candidate = candidate.substring(0, prev + 1);
      }
    }
  }
  return null;
}

// Liten hjelper: standard JSON-respons
function jsonRes(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

// Kaller Anthropic Messages API og returnerer rå tekst + status
async function callAnthropic(apiKey, payload) {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(payload)
  });
  const rawText = await response.text();
  return { ok: response.ok, status: response.status, rawText };
}

// Firebase Web API key (offentlig verdi, samme som i frontend firebaseConfig).
// Brukes KUN til å verifisere idToken via Identity Toolkit, ikke en hemmelighet.
const FIREBASE_WEB_API_KEY = "AIzaSyCoWYFF9JxVxMFNlwnLzrulSkHmTjh46uY";

// ============================================================
//  Google service-account-auth (for Firestore + FCM fra worker)
//  Krever secrets: FIREBASE_SA_EMAIL, FIREBASE_SA_PRIVATE_KEY, FIREBASE_PROJECT_ID
// ============================================================
function base64url(bytesOrStr) {
  const str = typeof bytesOrStr === "string"
    ? btoa(bytesOrStr)
    : btoa(String.fromCharCode(...new Uint8Array(bytesOrStr)));
  return str.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function pemToArrayBuffer(pem) {
  const clean = pem
    .replace(/-----BEGIN PRIVATE KEY-----/, "")
    .replace(/-----END PRIVATE KEY-----/, "")
    .replace(/\s+/g, "");
  const binary = atob(clean);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

let cachedAccessToken = null; // { token, exp } – gjenbrukes mens worker-instansen er "varm"

async function getGoogleAccessToken(env) {
  if (cachedAccessToken && cachedAccessToken.exp > Date.now() + 30000) {
    return cachedAccessToken.token;
  }

  const email = env.FIREBASE_SA_EMAIL;
  const rawKey = env.FIREBASE_SA_PRIVATE_KEY;
  if (!email || !rawKey) {
    throw new Error("Google service-account ikke konfigurert (FIREBASE_SA_EMAIL / FIREBASE_SA_PRIVATE_KEY mangler som secrets)");
  }
  const privateKeyPem = rawKey.replace(/\\n/g, "\n");

  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const claims = {
    iss: email,
    scope: "https://www.googleapis.com/auth/datastore https://www.googleapis.com/auth/firebase.messaging",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600
  };

  const encHeader = base64url(JSON.stringify(header));
  const encClaims = base64url(JSON.stringify(claims));
  const unsigned = `${encHeader}.${encClaims}`;

  const cryptoKey = await crypto.subtle.importKey(
    "pkcs8",
    pemToArrayBuffer(privateKeyPem),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sigBuffer = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    cryptoKey,
    new TextEncoder().encode(unsigned)
  );
  const jwt = `${unsigned}.${base64url(sigBuffer)}`;

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=${encodeURIComponent("urn:ietf:params:oauth:grant-type:jwt-bearer")}&assertion=${encodeURIComponent(jwt)}`
  });
  const data = await res.json();
  if (!res.ok || !data.access_token) {
    throw new Error("Kunne ikke hente Google-token: " + JSON.stringify(data));
  }

  cachedAccessToken = { token: data.access_token, exp: Date.now() + (data.expires_in || 3600) * 1000 };
  return data.access_token;
}

// Verifiserer en Firebase Auth idToken via Identity Toolkit REST-endepunkt.
// Enklere og mer robust enn å implementere JWKS/RS256-verifisering selv i workeren.
async function verifyFirebaseIdToken(idToken) {
  if (!idToken) return null;
  try {
    const res = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${FIREBASE_WEB_API_KEY}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ idToken })
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.users?.[0]?.localId || null;
  } catch (e) {
    return null;
  }
}

// ============================================================
//  Firestore REST-hjelpere (bruker service-account-token, går utenom Security Rules —
//  kun til bruk internt i worker, ALDRI eksponert direkte til klienten)
// ============================================================
function fsBase(env) {
  const project = env.FIREBASE_PROJECT_ID || "handleliste-64ec3";
  return `https://firestore.googleapis.com/v1/projects/${project}/databases/(default)/documents`;
}

function fsValueToJs(v) {
  if (!v) return null;
  if ("stringValue" in v) return v.stringValue;
  if ("integerValue" in v) return Number(v.integerValue);
  if ("doubleValue" in v) return v.doubleValue;
  if ("booleanValue" in v) return v.booleanValue;
  if ("nullValue" in v) return null;
  if ("timestampValue" in v) return v.timestampValue;
  if ("mapValue" in v) return fsFieldsToJs(v.mapValue.fields || {});
  if ("arrayValue" in v) return (v.arrayValue.values || []).map(fsValueToJs);
  return null;
}
function fsFieldsToJs(fields) {
  const out = {};
  for (const k in fields) out[k] = fsValueToJs(fields[k]);
  return out;
}
function jsToFsValue(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === "boolean") return { booleanValue: v };
  if (typeof v === "number") return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(jsToFsValue) } };
  if (typeof v === "object") return { mapValue: { fields: fsFieldsFromJs(v) } };
  return { stringValue: String(v) };
}
function fsFieldsFromJs(obj) {
  const out = {};
  for (const k in obj) out[k] = jsToFsValue(obj[k]);
  return out;
}

async function firestoreGetDoc(env, accessToken, path) {
  const res = await fetch(`${fsBase(env)}/${path}`, {
    headers: { "Authorization": "Bearer " + accessToken }
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error("Firestore GET feilet: " + res.status);
  const data = await res.json();
  return data.fields ? fsFieldsToJs(data.fields) : {};
}

async function firestoreListDocs(env, accessToken, collectionPath) {
  const out = [];
  let pageToken = "";
  do {
    const url = `${fsBase(env)}/${collectionPath}?pageSize=200${pageToken ? "&pageToken=" + pageToken : ""}`;
    const res = await fetch(url, { headers: { "Authorization": "Bearer " + accessToken } });
    if (!res.ok) throw new Error("Firestore LIST feilet: " + res.status);
    const data = await res.json();
    for (const d of (data.documents || [])) {
      const id = d.name.split("/").pop();
      out.push({ id, ...fsFieldsToJs(d.fields || {}) });
    }
    pageToken = data.nextPageToken || "";
  } while (pageToken);
  return out;
}

// dottedFields: f.eks. { "notification.pushSentAt": 12345, "pushEnabled": false }
async function firestorePatchDoc(env, accessToken, path, dottedFields) {
  const topLevel = {};
  const maskPaths = [];
  for (const dottedKey in dottedFields) {
    maskPaths.push(dottedKey);
    const parts = dottedKey.split(".");
    let cursor = topLevel;
    for (let i = 0; i < parts.length - 1; i++) {
      cursor[parts[i]] = cursor[parts[i]] || {};
      cursor = cursor[parts[i]];
    }
    cursor[parts[parts.length - 1]] = dottedFields[dottedKey];
  }
  const maskQuery = maskPaths.map(p => `updateMask.fieldPaths=${encodeURIComponent(p)}`).join("&");
  const res = await fetch(`${fsBase(env)}/${path}?${maskQuery}`, {
    method: "PATCH",
    headers: { "Authorization": "Bearer " + accessToken, "Content-Type": "application/json" },
    body: JSON.stringify({ fields: fsFieldsFromJs(topLevel) })
  });
  return res.ok;
}

// ============================================================
//  FCM – send push via HTTP v1 API
// ============================================================
async function sendFcmPush(env, accessToken, pushToken, title, body, data) {
  const project = env.FIREBASE_PROJECT_ID || "handleliste-64ec3";
  const res = await fetch(`https://fcm.googleapis.com/v1/projects/${project}/messages:send`, {
    method: "POST",
    headers: { "Authorization": "Bearer " + accessToken, "Content-Type": "application/json" },
    body: JSON.stringify({
      message: {
        token: pushToken,
        notification: { title, body },
        data: data || {},
        webpush: { fcm_options: { link: "https://handleliste.pages.dev/" } }
      }
    })
  });
  const rawText = await res.text();
  return { ok: res.ok, status: res.status, rawText };
}

// Går gjennom alle husstander og sender push for påminnelser som forfaller nå.
// Kalles fra scheduled()-handleren (Cron Trigger).
async function checkAndSendReminders(env) {
  const accessToken = await getGoogleAccessToken(env);
  const now = Date.now();
  const graceWindowMs = 30 * 60 * 1000; // ikke send for påminnelser eldre enn 30 min (unngå spam etter nedetid)

  const households = await firestoreListDocs(env, accessToken, "households");

  for (const hh of households) {
    const members = hh.members || {};
    if (Array.isArray(members)) continue; // gammelt format uten navn – hopp over
    const nameToUid = {};
    for (const uid in members) nameToUid[String(members[uid]).trim()] = uid;

    let tasks;
    try {
      tasks = await firestoreListDocs(env, accessToken, `lists/${hh.id}/tasks`);
    } catch (e) {
      continue; // ingen tavle for denne husstanden ennå
    }

    for (const task of tasks) {
      if (task.completed) continue;
      if (!task.notification || !task.notification.enabled) continue;
      if (task.notification.pushSentAt) continue;
      if (!task.dueDate) continue;

      const minutesBefore = Number(task.notification.minutesBefore || 0);
      const dueDateTime = new Date(`${task.dueDate}T${task.dueTime || "08:00"}:00`);
      if (isNaN(dueDateTime.getTime())) continue;
      const notifyAt = dueDateTime.getTime() - minutesBefore * 60000;

      if (now >= notifyAt && (now - notifyAt) <= graceWindowMs) {
        const targetUid = nameToUid[String(task.assignedTo || "").trim()];

        if (targetUid) {
          try {
            const targetUser = await firestoreGetDoc(env, accessToken, `users/${targetUid}`);
            if (targetUser && targetUser.pushEnabled && targetUser.pushToken) {
              const fcmRes = await sendFcmPush(
                env, accessToken, targetUser.pushToken,
                "Påminnelse: " + task.title,
                task.dueTime ? `I dag kl. ${task.dueTime}` : "I dag",
                { tag: "reminder-" + task.id }
              );
              if (!fcmRes.ok && (fcmRes.status === 404 || fcmRes.status === 400)) {
                await firestorePatchDoc(env, accessToken, `users/${targetUid}`, { pushEnabled: false });
              }
            }
          } catch (e) {
            // fortsett til neste oppgave selv om én sending feiler
          }
        }

        // Marker som sendt uansett, så vi ikke prøver igjen hvert 5. minutt
        try {
          await firestorePatchDoc(env, accessToken, `lists/${hh.id}/tasks/${task.id}`, {
            "notification.pushSentAt": now
          });
        } catch (e) { /* ignorer */ }
      }
    }
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const apiKey = env.ANTHROPIC_API_KEY;

    // -------------------------------------------------------
    //  /suggest-packing – AI-pakkeforslag
    // -------------------------------------------------------
    if (url.pathname === "/suggest-packing" && request.method === "POST") {
      try {
        if (!apiKey) return jsonRes({ error: "API key not configured" }, 500);

        const { beskrivelse, personer } = await request.json();
        const personListe = Array.isArray(personer) && personer.length
          ? personer.join(", ")
          : "(ingen personer oppgitt)";

        const prompt = `Du planlegger pakkeliste for en familietur. Lag forslag til hva hver person bør pakke.

Turbeskrivelse: ${beskrivelse || "(ingen beskrivelse)"}
Personer på turen: ${personListe}

Svar KUN med gyldig JSON, ingen annen tekst:
{
  "forslag": [
    {
      "person": "Katrine",
      "ting": [
        { "navn": "Solkrem", "antall": 1, "kategori": "toalett" },
        { "navn": "Pass", "antall": 1, "kategori": "dokumenter" }
      ]
    }
  ]
}

Regler:
- Bruk EKSAKT personnavnene fra listen over som "person"-verdi
- "kategori" må være én av: klar, toalett, dokumenter, elektronikk, barn, diverse
- Tilpass til alder og turlengde: spedbarn trenger bleier/skift/våtservietter, småbarn trenger egne ting, voksne andre ting
- Tilpass til destinasjon og årstid hvis det fremgår (sol/bad/varme vs kulde)
- "antall": fornuftig mengde for turlengden (f.eks. flere bleiepakker for lang tur med baby)
- Vær praktisk og dekkende, men ikke overdriv med urealistiske mengder
- Norsk stavemåte med æøå`;

        const { ok, status, rawText } = await callAnthropic(apiKey, {
          model: "claude-sonnet-4-6",
          max_tokens: 8000,
          system: "Du er en JSON-generator. Du svarer KUN med gyldig JSON, aldri med forklaringer eller annen tekst.",
          messages: [{ role: "user", content: [{ type: "text", text: prompt }] }]
        });

        if (!ok) return jsonRes({ error: "Anthropic API feil", status, detaljer: rawText }, 500);

        const data = JSON.parse(rawText);
        const text = data.content?.[0]?.text || "";
        let clean = text.replace(/```json|```/g, "").trim();
        const firstBrace = clean.indexOf("{");
        if (firstBrace !== -1) clean = clean.substring(firstBrace);

        if (!clean.startsWith("{")) {
          return jsonRes({ forslag: [], feil: "Kunne ikke lage forslag. Prøv en tydeligere beskrivelse." });
        }

        let parsed;
        try {
          const lastBrace = clean.lastIndexOf("}");
          parsed = JSON.parse(clean.substring(0, lastBrace + 1));
        } catch (e1) {
          parsed = repairTruncatedJson(clean);
        }

        if (!parsed || !parsed.forslag) {
          return jsonRes({ forslag: [], feil: "Forslaget ble for langt og kunne ikke leses helt. Prøv færre personer om gangen." });
        }

        return jsonRes(parsed);

      } catch (err) {
        return jsonRes({ error: err.message }, 500);
      }
    }

    // -------------------------------------------------------
    //  /scan – kvitteringsscanning / kjøleskap-analyse
    // -------------------------------------------------------
    if (url.pathname === "/scan" && request.method === "POST") {
      try {
        if (!apiKey) return jsonRes({ error: "API key not configured" }, 500);

        const { image, mediaType, type, instructions } = await request.json();

        // Robusthet: gi en tydelig feilmelding hvis bildet mangler,
        // i stedet for en kryptisk feil fra Anthropic-kallet lenger ned.
        if (!image) {
          return jsonRes({ error: "Mangler bilde. Ta bildet på nytt og prøv igjen." }, 400);
        }
        if (!mediaType) {
          return jsonRes({ error: "Mangler bildeformat (mediaType)." }, 400);
        }

        let prompt = type === "receipt"
          ? `Dette er en norsk dagligvarekvittering. Les HELE varelinjen for hver kjøpte vare.

Svar KUN med gyldig JSON, ingen annen tekst:
{
  "dato": "2026-06-07",
  "butikk": "Rema 1000",
  "total": 349.50,
  "varer": [
    {
      "navn": "Melk",
      "linje": "2 X TINE LETTMELK 1L 29,90",
      "antall": 2,
      "enhet": "stk",
      "stkpris": 14.95,
      "pris": 29.90
    },
    {
      "navn": "Bananer",
      "linje": "0,846 KG BANAN 19,90",
      "antall": 0.846,
      "enhet": "kg",
      "stkpris": 23.52,
      "pris": 19.90
    },
    {
      "navn": "Cola Zero",
      "linje": "6BX COLA ZERO 1,5L 87,00",
      "antall": 6,
      "enhet": "stk",
      "stkpris": 14.50,
      "pris": 87.00
    },
    {
      "navn": "Hamburger",
      "linje": "BURGER 2X180G 49,00",
      "antall": 1,
      "enhet": "pk",
      "stkpris": 49.00,
      "pris": 49.00
    },
    {
      "navn": "Løk",
      "linje": "LOK 0,532 KG 12,90",
      "antall": 0.532,
      "enhet": "kg",
      "stkpris": 24.25,
      "pris": 12.90
    }
  ]
}

Regler:
- "linje": hele varelinjen slik den står på kvitteringen
- "pris": total linjesum for varen (det beløpet som trekkes fra totalen)
- "stkpris": pris per enhet (pris / antall)
- "antall": skill nøye mellom antall kjøpt og pakningsbeskrivelse:
  - Tall FØR varenavnet = antall kjøpt: "6 STK COLA" → antall=6, "2 X MELK" → antall=2, "6BX COLA ZERO" → antall=6, "0,846 KG BANAN" → antall=0.846
  - Tall INNE I varenavnet = pakningsbeskrivelse, antall kjøpt = 1: "BURGER 2X180G" → antall=1, "EGG 12STK" → antall=1, "COLA 6PK" → antall=1
  - BX betyr boks, samme som STK
- "enhet": stk, kg, g, l, dl eller pk
- "total": kvitteringens totalbeløp (TOTALT / Å BETALE / SUM)
- "navn": nøyaktig varenavn slik det fremgår av kvitteringen, med korrekt norsk stavemåte og æøå. lok → Løk, brod → Brød. IKKE forkorte eller forenkle: jordbærsorbet forblir jordbærsorbet, helfet kulturmelk forblir helfet kulturmelk, appelsinjuice forblir appelsinjuice. Behold kjente produktnavn eksakt: Cola Zero, Pepsi Max, Kvikk Lunsj, Grandiosa.
- "dato": YYYY-MM-DD format
- "butikk": butikknavnet fra kvitteringen
- IKKE ta med: rabatter, bonuspoeng, poser, pant, gebyrer, betalingslinjer, kortinfo`
          : `Se på dette kjøleskapet. List varer som er tomme eller nesten tomme. Svar KUN med JSON:
{"varer":[{"navn":"Melk","grunn":"nesten tom"}]}`;

        // Bruk "instructions" fra frontend hvis den er sendt med, i stedet for
        // å la feltet ligge urørt i forespørselen. Gir brukeren mulighet til å
        // sende en ekstra hint/presisering sammen med bildet.
        if (instructions && String(instructions).trim()) {
          prompt += `\n\nEkstra instruksjoner fra brukeren (ta hensyn til disse): ${String(instructions).trim()}`;
        }

        const { ok, status, rawText } = await callAnthropic(apiKey, {
          model: "claude-sonnet-4-6",
          max_tokens: 4096,
          system: "Du er en JSON-generator. Du svarer KUN med gyldig JSON, aldri med forklaringer eller annen tekst. Hvis du ikke kan analysere bildet, svar med tomt resultat i JSON-format.",
          messages: [{
            role: "user",
            content: [
              { type: "image", source: { type: "base64", media_type: mediaType, data: image } },
              { type: "text", text: prompt }
            ]
          }]
        });

        if (!ok) return jsonRes({ error: "Anthropic API feil", status, detaljer: rawText }, 500);

        const data = JSON.parse(rawText);
        const text = data.content?.[0]?.text || "";
        let clean = text.replace(/```json|```/g, "").trim();
        const firstBrace = clean.indexOf("{");
        const lastBrace = clean.lastIndexOf("}");
        if (firstBrace !== -1 && lastBrace !== -1) {
          clean = clean.substring(firstBrace, lastBrace + 1);
        }

        if (!clean.startsWith("{")) {
          const fallback = type === "receipt"
            ? { dato: null, butikk: null, total: null, varer: [], feil: "Kunne ikke lese kvitteringen. Prøv et klarere bilde." }
            : { varer: [], feil: "Kunne ikke analysere bildet. Prøv et klarere bilde." };
          return jsonRes(fallback);
        }

        const parsed = JSON.parse(clean);
        return jsonRes(parsed);

      } catch (err) {
        return jsonRes({ error: err.message }, 500);
      }
    }

    // -------------------------------------------------------
    //  /parse-menu – tolker ukesmeny (tekst eller bilde)
    // -------------------------------------------------------
    if (url.pathname === "/parse-menu" && request.method === "POST") {
      try {
        if (!apiKey) return jsonRes({ error: "API key not configured" }, 500);

        const { tekst, bilde, mediaType } = await request.json();

        const prompt = `Du tolker en norsk ukesmeny og gjør den om til strukturerte data.

Svar KUN med gyldig JSON, ingen annen tekst:
{
  "dager": [
    {
      "dag": "mandag",
      "rett": "Laks teriyaki-bowl",
      "ingredienser": [
        { "navn": "Laks", "antall": 1, "enhet": "pk" },
        { "navn": "Fullkornsris", "antall": 1, "enhet": "pk" },
        { "navn": "Avokado", "antall": 2, "enhet": "stk" }
      ]
    }
  ]
}

Regler:
- "dag" MÅ være et norsk ukedagsnavn med små bokstaver: mandag, tirsdag, onsdag, torsdag, fredag, lørdag eller søndag
- Ta KUN med retter som har en tydelig ukedag. Ikke dikt opp dager som ikke står i menyen
- "rett": kort, gjenkjennelig navn på retten (ikke hele beskrivelsen)
- "ingredienser": hovedingrediensene med kort norsk varenavn og korrekt æøå
- "antall" og "enhet": sett fornuftige verdier hvis det fremgår, ellers antall 1 og enhet "stk"
- "enhet" må være én av: stk, kg, g, l, dl, pk
- IKKE ta med krydder/vann/salt/pepper med mindre det er en tydelig hovedingrediens
- Norsk stavemåte med æøå`;

        const content = bilde
          ? [
              { type: "image", source: { type: "base64", media_type: mediaType || "image/png", data: bilde } },
              { type: "text", text: "Dette er et bilde av en ukesmeny. " + prompt }
            ]
          : [{ type: "text", text: prompt + "\n\nUkesmeny:\n" + (tekst || "(tom)") }];

        const { ok, status, rawText } = await callAnthropic(apiKey, {
          model: "claude-sonnet-4-6",
          max_tokens: 8000,
          system: "Du er en JSON-generator. Du svarer KUN med gyldig JSON, aldri med forklaringer eller annen tekst.",
          messages: [{ role: "user", content }]
        });

        if (!ok) return jsonRes({ error: "Anthropic API feil", status, detaljer: rawText }, 500);

        const data = JSON.parse(rawText);
        const text = data.content?.[0]?.text || "";
        let clean = text.replace(/```json|```/g, "").trim();
        const firstBrace = clean.indexOf("{");
        if (firstBrace !== -1) clean = clean.substring(firstBrace);

        if (!clean.startsWith("{")) {
          return jsonRes({ dager: [], feil: "Kunne ikke tolke menyen. Prøv å lime inn tydeligere tekst." });
        }

        let parsed;
        try {
          const lastBrace = clean.lastIndexOf("}");
          parsed = JSON.parse(clean.substring(0, lastBrace + 1));
        } catch (e1) {
          parsed = repairTruncatedJson(clean);
        }

        if (!parsed || !parsed.dager) {
          return jsonRes({ dager: [], feil: "Menyen ble for lang til å leses helt. Prøv færre dager om gangen." });
        }

        return jsonRes(parsed);

      } catch (err) {
        return jsonRes({ error: err.message }, 500);
      }
    }

    // -------------------------------------------------------
    //  /price-lookup – slå opp priser på varenavn via Kassalapp
    // -------------------------------------------------------
    // -------------------------------------------------------
    //  /ean-search – søk vare, hent EAN, sammenlign pris i alle butikker
    // -------------------------------------------------------
    if (url.pathname === "/ean-search" && request.method === "POST") {
      try {
        const kassalKey = env.KASSALAPP_API_KEY;
        if (!kassalKey) return jsonRes({ error: "Kassalapp ikke konfigurert" }, 500);

        const { query, ean } = await request.json();

        // STEG 1: Hvis vi allerede har EAN, hopp rett til prisoversikt
        if (ean) {
          const priceRes = await fetch(
            `https://kassal.app/api/v1/products/ean/${encodeURIComponent(ean)}`,
            { headers: { "Authorization": "Bearer " + kassalKey, "Accept": "application/json" } }
          );
          if (!priceRes.ok) return jsonRes({ error: "Kassalapp-feil ved EAN-oppslag", status: priceRes.status }, 500);
          const priceData = await priceRes.json();

          // data kan være array direkte eller nestet
          let produktliste = [];
          if (Array.isArray(priceData.data)) produktliste = priceData.data;
          else if (priceData.data && Array.isArray(priceData.data.products)) produktliste = priceData.data.products;
          else if (Array.isArray(priceData)) produktliste = priceData;

          let butikker = produktliste
            .map(p => ({
              store: p.store?.name || "Ukjent",
              price: p.current_price != null ? Number(p.current_price) : null,
              name: p.name || ""
            }))
            .filter(p => p.price != null && p.price > 0)
            .sort((a, b) => a.price - b.price);

          // Fallback: hvis EAN gir tomt, prøv navnesøk
          if (butikker.length === 0 && produktliste.length > 0) {
            const navn = produktliste[0]?.name || "";
            if (navn) {
              const fbRes = await fetch(
                `https://kassal.app/api/v1/products?search=${encodeURIComponent(navn)}&size=20`,
                { headers: { "Authorization": "Bearer " + kassalKey, "Accept": "application/json" } }
              );
              if (fbRes.ok) {
                const fbData = await fbRes.json();
                butikker = (Array.isArray(fbData.data) ? fbData.data : [])
                  .map(p => ({ store: p.store?.name || "Ukjent", price: p.current_price != null ? Number(p.current_price) : null, name: p.name || "" }))
                  .filter(p => p.price != null && p.price > 0)
                  .sort((a, b) => a.price - b.price);
              }
            }
          }

          return jsonRes({ type: "priser", ean, butikker });
        }

        // STEG 2: Søk på navn — hent unike produkter (én per EAN), sorter på relevans
        if (!query) return jsonRes({ error: "Mangler query eller ean" }, 400);
        const searchRes = await fetch(
          `https://kassal.app/api/v1/products?search=${encodeURIComponent(query)}&size=40`,
          { headers: { "Authorization": "Bearer " + kassalKey, "Accept": "application/json" } }
        );
        if (!searchRes.ok) return jsonRes({ error: "Kassalapp-feil ved søk" }, 500);
        const searchData = await searchRes.json();

        const q = query.toLowerCase().trim();
        const qOrd = q.split(/\s+/);

        // Relevans: 0=første ord starter med søkeordet (best), 1=søkeordet er ett av første 2 ord, 999=ikke relevant
        function relevansSkaar(navn) {
          const n = navn.toLowerCase();
          const navnOrd = n.split(" ");
          if (qOrd.length === 1) {
            if (navnOrd[0].startsWith(q)) return 0;
            // Andre ord eksakt søkeord (f.eks. "Hvitt Sukker") — men IKKE "0% Sukker Ispinne" pga. tall/% som første ord
            const andreOrd = navnOrd[1];
            if (andreOrd && andreOrd === q && /^[a-zA-Z]/.test(navnOrd[0])) return 1;
            return 999;
          }
          if (qOrd.every(o => n.includes(o))) return 0;
          return 999;
        }

        const medSkaar = (searchData.data || [])
          .filter(p => p.ean)
          .map(p => {
            const pris = typeof p.current_price === "number" ? p.current_price : p.current_price?.price;
            return {
              name: p.name || "",
              ean: p.ean,
              price: pris,
              store: p.store?.name || "",
              vendor: p.vendor || "",
              skaar: relevansSkaar(p.name || "")
            };
          })
          .filter(p => p.price != null && p.price > 0 && p.skaar < 999);

        // Dedupliser på EAN — laveste pris
        const sett = {};
        medSkaar.forEach(p => {
          if (!sett[p.ean] || p.price < sett[p.ean].price) sett[p.ean] = { ...p };
        });

        const produkter = Object.values(sett)
          .sort((a, b) => a.skaar - b.skaar || a.price - b.price)
          .slice(0, 8)
          .map(({ skaar, ...rest }) => rest);

        // Fallback: hvis relevansfilter gir 0 treff, vis de 5 beste råtreffene
        // slik at brukeren ser noe heller enn ingenting
        const sluttProdukt = produkter.length > 0 ? produkter : (() => {
          const raSett = {};
          (searchData.data || []).filter(p => p.ean).forEach(p => {
            const pris = typeof p.current_price === "number" ? p.current_price : p.current_price?.price;
            if (pris && pris > 0 && (!raSett[p.ean] || pris < raSett[p.ean].price)) {
              raSett[p.ean] = { name: p.name || "", ean: p.ean, price: pris, store: p.store?.name || "", vendor: p.vendor || "" };
            }
          });
          return Object.values(raSett).slice(0, 6);
        })();
        return jsonRes({ type: "produkter", produkter: sluttProdukt, ingenRelevante: produkter.length === 0 });

      } catch (err) {
        return jsonRes({ error: err.message }, 500);
      }
    }

    // -------------------------------------------------------
    //  /price-lookup – beholdt for bakoverkompatibilitet med Dagens priser
    // -------------------------------------------------------
    if (url.pathname === "/price-lookup" && request.method === "POST") {
      try {
        const kassalKey = env.KASSALAPP_API_KEY;
        if (!kassalKey) return jsonRes({ error: "Kassalapp er ikke konfigurert" }, 500);
        const { queries } = await request.json();
        if (!Array.isArray(queries) || queries.length === 0) return jsonRes({ error: "Ingen varer" }, 400);
        const limited = queries.slice(0, 15).map(q => String(q || "").trim()).filter(Boolean);
        const lookupOne = async (q) => {
          const res = await fetch(`https://kassal.app/api/v1/products?search=${encodeURIComponent(q)}&size=8`, {
            headers: { "Authorization": "Bearer " + kassalKey, "Accept": "application/json" }
          });
          if (!res.ok) return { query: q, matches: [] };
          const data = await res.json();
          const matches = (data.data || []).map(p => ({
            name: p.name || "", store: p.store?.name || "Ukjent",
            price: typeof p.current_price === "number" ? p.current_price : (p.current_price?.price ?? null),
            ean: p.ean || null
          })).filter(m => m.price != null && m.price > 0);
          return { query: q, matches };
        };
        const results = [];
        for (let i = 0; i < limited.length; i += 5) {
          const batch = limited.slice(i, i + 5);
          const res = await Promise.all(batch.map(lookupOne));
          results.push(...res);
        }
        return jsonRes({ results });
      } catch (err) {
        return jsonRes({ error: err.message }, 500);
      }
    }

    // -------------------------------------------------------
    //  /send-push – send push-varsel til et husstandsmedlem
    // -------------------------------------------------------
    if (url.pathname === "/send-push" && request.method === "POST") {
      try {
        const idToken = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
        const callerUid = await verifyFirebaseIdToken(idToken);
        if (!callerUid) return jsonRes({ error: "Ikke innlogget" }, 401);

        const { householdId, targetUid, title, body, tag } = await request.json();
        if (!householdId || !targetUid || !title) {
          return jsonRes({ error: "Mangler householdId, targetUid eller title" }, 400);
        }
        if (targetUid === callerUid) {
          return jsonRes({ sent: false, reason: "self" });
        }

        const accessToken = await getGoogleAccessToken(env);

        // Bekreft at både avsender og mottaker faktisk er medlemmer av oppgitt husstand,
        // slik at endepunktet ikke kan misbrukes til å varsle vilkårlige uid-er.
        const household = await firestoreGetDoc(env, accessToken, `households/${householdId}`);
        const members = household?.members || {};
        if (!members[callerUid] || !members[targetUid]) {
          return jsonRes({ error: "Ugyldig husstand/medlem" }, 403);
        }

        const targetUser = await firestoreGetDoc(env, accessToken, `users/${targetUid}`);
        if (!targetUser?.pushEnabled || !targetUser?.pushToken) {
          return jsonRes({ sent: false, reason: "not_enabled" });
        }

        const safeTitle = String(title).slice(0, 120);
        const safeBody = String(body || "").slice(0, 200);

        const fcmRes = await sendFcmPush(env, accessToken, targetUser.pushToken, safeTitle, safeBody, { tag: String(tag || "") });

        if (!fcmRes.ok) {
          if (fcmRes.status === 404 || fcmRes.status === 400) {
            await firestorePatchDoc(env, accessToken, `users/${targetUid}`, { pushEnabled: false });
          }
          return jsonRes({ sent: false, error: "FCM-feil", status: fcmRes.status, detaljer: fcmRes.rawText });
        }

        return jsonRes({ sent: true });
      } catch (err) {
        return jsonRes({ error: err.message }, 500);
      }
    }

    // -------------------------------------------------------
    //  Alt annet: statiske filer
    // -------------------------------------------------------
    return env.ASSETS.fetch(request);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(checkAndSendReminders(env));
  }
};
