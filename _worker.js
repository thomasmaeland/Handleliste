export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Handle scan API endpoint
    if (url.pathname === "/scan" && request.method === "POST") {
      try {
        const { image, mediaType, type } = await request.json();

        const prompt = type === "receipt"
          ? `Dette er en norsk dagligvarekvittering. List opp alle kjøpte varer med pris og finn datoen. Svar KUN med JSON:
{"dato":"2026-06-07","butikk":"Rema 1000","varer":[{"navn":"Melk","pris":29.90},{"navn":"Brød","pris":34.90}]}
- Korte norske varenavn (TINE LETTMELK 1L → Melk, NORVEGIA 500G → Ost)
- dato format: YYYY-MM-DD
- Ikke ta med rabatter eller poser
- butikk: butikknavnet fra kvitteringen`
          : `Se på dette kjøleskapet. List varer som er tomme eller nesten tomme. Svar KUN med JSON:
{"varer":[{"navn":"Melk","grunn":"nesten tom"},{"navn":"Smør","grunn":"lite igjen"}]}`;

        const response = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": env.ANTHROPIC_API_KEY,
            "anthropic-version": "2023-06-01",
          },
          body: JSON.stringify({
            model: "claude-haiku-4-5-20251001",
            max_tokens: 1000,
            messages: [{
              role: "user",
              content: [
                { type: "image", source: { type: "base64", media_type: mediaType, data: image }},
                { type: "text", text: prompt }
              ]
            }]
          })
        });

        const data = await response.json();
        const text = data.content?.[0]?.text || "";
        const clean = text.replace(/```json|```/g, "").trim();
        const parsed = JSON.parse(clean);

        return new Response(JSON.stringify(parsed), {
          headers: { "Content-Type": "application/json" }
        });

      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), {
          status: 500,
          headers: { "Content-Type": "application/json" }
        });
      }
    }

    // All other requests — serve static assets
    return env.ASSETS.fetch(request);
  }
};
