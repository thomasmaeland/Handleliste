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
          ? `Dette er en norsk dagligvarekvittering. List opp alle kjøpte varer med pris og finn datoen. Svar KUN med JSON:
{"dato":"2026-06-07","butikk":"Rema 1000","varer":[{"navn":"Melk","pris":29.90},{"navn":"Brød","pris":34.90}]}
- Korte norske varenavn (TINE LETTMELK 1L → Melk, NORVEGIA 500G → Ost)
- dato format: YYYY-MM-DD
- Ikke ta med rabatter eller poser`
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
            max_tokens: 1000,
            system: "Du er en JSON-generator. Du svarer KUN med gyldig JSON, aldri med forklaringer eller annen tekst. Hvis du ikke kan analysere bildet, svar med tomt resultat i JSON-format.",
            messages: [{
              role: "user",
              content: [
                { type: "image", source: { type: "base64", media_type: mediaType, data: image }},
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
        let clean = text.replace(/```json|```/g, "").trim();

        // Kutt ut alt utenfor første { og siste }
        const firstBrace = clean.indexOf("{");
        const lastBrace = clean.lastIndexOf("}");
        if (firstBrace !== -1 && lastBrace !== -1) {
          clean = clean.substring(firstBrace, lastBrace + 1);
        }

        if (!clean.startsWith("{")) {
          const fallback = type === "receipt"
            ? { dato: null, butikk: null, varer: [], feil: "Kunne ikke lese kvitteringen. Prøv et klarere bilde." }
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
