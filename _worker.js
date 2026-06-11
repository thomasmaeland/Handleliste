export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/scan" && request.method === "POST") {
      try {
        const apiKey = env.ANTHROPIC_API_KEY;
        if (!apiKey) {
          return new Response(JSON.stringify({ error: "API key not configured" }), {
            status: 500, headers: { "Content-Type": "application/json" }
          });
        }

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
      "navn": "Cola",
      "linje": "6 STK COLA 1,5L 89,00",
      "antall": 6,
      "enhet": "stk",
      "stkpris": 14.83,
      "pris": 89.00
    },
    {
      "navn": "Egg",
      "linje": "1 PK EGG 12 STK 39,90",
      "antall": 1,
      "enhet": "pk",
      "stkpris": 39.90,
      "pris": 39.90
    }
  ]
}

Regler:
- "linje": hele varelinjen slik den står på kvitteringen
- "pris": total linjesum for varen (det beløpet som trekkes fra totalen)
- "stkpris": pris per enhet (pris / antall)
- "antall": tallet FØR varenavnet er alltid antallet du kjøpte. "6 STK COLA" → antall=6, "2 X MELK" → antall=2, "3 PK YOGHURT" → antall=3, "0,846 KG BANAN" → antall=0.846. Hvis linjen starter med tall+enhet er det antallet, ikke en beskrivelse av pakningsstørrelse.
- "enhet": stk, kg, g, l, dl eller pk. Bruk pk kun hvis det er en pakke med flere enheter inni (f.eks. egg, wienerbrød).
- "total": kvitteringens totalbeløp (TOTALT / Å BETALE / SUM)
- "navn": kort norsk varenavn (TINE LETTMELK 1L → Melk, NORVEGIA 500G → Ost, MILLS MAJONES → Majones, COCA COLA 1,5L → Cola)
- "dato": YYYY-MM-DD format
- "butikk": butikknavnet fra kvitteringen
- IKKE ta med: rabatter, bonuspoeng, poser, pant, gebyrer, betalingslinjer, kortinfo`
          : `Se på dette kjøleskapet. List varer som er tomme eller nesten tomme. Svar KUN med JSON:
{"varer":[{"navn":"Melk","grunn":"nesten tom"}]}`;

        const response = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": apiKey,
            "anthropic-version": "2023-06-01",
          },
          body: JSON.stringify({
            model: "claude-haiku-4-5-20251001",
            max_tokens: 4096,
            system: "Du er en JSON-generator. Du svarer KUN med gyldig JSON, aldri med forklaringer eller annen tekst. Hvis du ikke kan analysere bildet, svar med tomt resultat i JSON-format.",
            messages: [{
              role: "user",
              content: [
                { type: "image", source: { type: "base64", media_type: mediaType, data: image } },
                { type: "text", text: prompt }
              ]
            }]
          })
        });

        const rawText = await response.text();

        if (!response.ok) {
          return new Response(JSON.stringify({
            error: "Anthropic API feil",
            status: response.status,
            detaljer: rawText
          }), {
            status: 500, headers: { "Content-Type": "application/json" }
          });
        }

        const data = JSON.parse(rawText);
        const text = data.content?.[0]?.text || "";

        // Fjern markdown-blokker og finn første/siste JSON-objekt
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
          return new Response(JSON.stringify(fallback), {
            status: 200, headers: { "Content-Type": "application/json" }
          });
        }

        const parsed = JSON.parse(clean);
        return new Response(JSON.stringify(parsed), {
          headers: { "Content-Type": "application/json" }
        });

      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), {
          status: 500, headers: { "Content-Type": "application/json" }
        });
      }
    }

    return env.ASSETS.fetch(request);
  }
};
