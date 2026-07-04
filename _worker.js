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

        const { image, mediaType, type } = await request.json();

        const prompt = type === "receipt"
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
    //  Alt annet: statiske filer
    // -------------------------------------------------------
    return env.ASSETS.fetch(request);
  }
};
