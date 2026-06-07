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
          : `Se på
