export async function onRequestPost(context) {
  try {
    const { image, mediaType, type } = await context.request.json();

    // Sjekk at API-nøkkelen finnes
    const apiKey = context.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return new Response(JSON.stringify({ error: "API-nøkkel mangler i environment" }), {
        status: 500,
        headers: { "Content-Type": "application/json" }
      });
    }

    const prompt = type === "receipt"
      ? `Dette er en norsk dagligvarekvittering. List opp alle kjøpte varer med pris og finn datoen på kvitteringen. Svar KUN med JSON, ingen annen tekst:
{"dato":"2026-06-07","butikk":"Rema 1000","varer":[{"navn":"Melk","pris":29.90},{"navn":"Brød","pris":34.90}]}
Viktig:
- Bruk korte norske varenavn (TINE LETTMELK 1L → Melk, NORVEGIA 500G → Ost, JACOBS KAFFE → Kaffe)
- dato format: YYYY-MM-DD
- Ikke ta med rabatter, poser eller gebyrer
- butikk: finn butikknavnet fra kvitteringen`
      : `Se på dette bildet av et kjøleskap. Identifiser varer som ser tomme, nesten tomme, eller mangler helt. Ikke nevn varer som ser fulle ut. Svar KUN med JSON på norsk, ingen annen tekst:
{"varer":[{"navn":"Melk","grunn":"nesten tom"},{"navn":"Smør","grunn":"lite igjen"}]}
Bruk korte, vanlige varenavn.`;

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

    // Logg Anthropic-svaret råt
    const rawText = await response.text();
    if (!response.ok) {
      return new Response(JSON.stringify({ 
        error: "Anthropic API feil", 
        status: response.status,
        detaljer: rawText 
      }), {
        status: 500,
        headers: { "Content-Type": "application/json" }
      });
    }

    const data = JSON.parse(rawText);
    const text = data.content?.[0]?.text || "";
    const clean = text.replace(/```json|```/g, "").trim();

    if (!clean.startsWith("{")) {
      const fallback = type === "receipt"
        ? { dato: null, butikk: null, varer: [], feil: "Kunne ikke lese kvitteringen. Prøv et klarere bilde." }
        : { varer: [], feil: "Kunne ikke analysere bildet. Prøv et klarere bilde." };
      return new Response(JSON.stringify(fallback), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }

    const parsed = JSON.parse(clean);
    return new Response(JSON.stringify(parsed), {
      headers: { "Content-Type": "application/json" }
    });

  } catch (err) {
    return new Response(JSON.stringify({ 
      error: err.message,
      varer: [] 
    }), {
      status: 500,
      headers: { "Content-Type": "application/json" }
    });
  }
}
