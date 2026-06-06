exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  try {
    const { image, mediaType, type } = JSON.parse(event.body);

    const prompt = type === "receipt"
      ? `Dette er en norsk dagligvarekvittering. List opp alle kjøpte varer med pris. Svar KUN med JSON, ingen annen tekst:
{"varer":[{"navn":"Melk","pris":25.90},{"navn":"Brød","pris":34.90}]}
Bruk kortere varenavn (ikke butikkens fulle produktnavn). Ikke ta med rabatter, poser eller andre gebyrer.`
      : `Se på dette bildet av et kjøleskap. Identifiser varer som ser tomme, nesten tomme, eller mangler helt. Ikke nevn varer som ser fulle ut. Svar KUN med JSON på norsk, ingen annen tekst:
{"varer":[{"navn":"Melk","grunn":"nesten tom"},{"navn":"Smør","grunn":"lite igjen"}]}
Bruk korte, vanlige varenavn.`;

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
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

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(parsed)
    };

  } catch (err) {
    console.error(err);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message })
    };
  }
};
