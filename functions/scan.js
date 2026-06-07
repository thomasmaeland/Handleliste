const prompt = type === "receipt"
  ? `Dette er en norsk dagligvarekvittering. Les HELE varelinjen for hver kjøpte vare.

Svar KUN med gyldig JSON, ingen annen tekst:
{
  "dato": "2026-06-07",
  "butikk": "Rema 1000",
  "varer": [
    {
      "navn": "Melk",
      "linje": "2 X TINE LETTMELK 1L 29,90",
      "antall": 2,
      "enhet": "stk",
      "stkpris": 14.95,
      "pris": 29.90
    }
  ]
}

Viktig:
- "linje" skal være hele varelinjen slik den står på kvitteringen
- "pris" skal være total linjesum for varen
- "stkpris" skal være pris per enhet hvis mulig
- "antall" skal leses fra linjen, f.eks. 2 x, 3 STK, 0,846 KG
- "enhet" skal være stk, kg, g, l, dl eller pk
- Bruk korte norske varenavn
- datoformat: YYYY-MM-DD
- Ikke ta med rabatter, poser, pant, gebyrer eller betalingslinjer
- butikk: finn butikknavnet fra kvitteringen`
  : `Se på dette bildet av et kjøleskap. Identifiser varer som ser tomme, nesten tomme, eller mangler helt. Ikke nevn varer som ser fulle ut. Svar KUN med JSON på norsk, ingen annen tekst:
{"varer":[{"navn":"Melk","grunn":"nesten tom"},{"navn":"Smør","grunn":"lite igjen"}]}
Bruk korte, vanlige varenavn.`;
