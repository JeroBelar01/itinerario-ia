// Función serverless de Vercel. Se ejecuta en el servidor, NUNCA en el navegador,
// así que aquí es seguro usar la API key (se lee de una variable de entorno, nunca del código).

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método no permitido' });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'Falta configurar GEMINI_API_KEY en Vercel' });
  }

  const { adventure, dest, place, days, budget, interests } = req.body || {};
  if (!adventure || !days) {
    return res.status(400).json({ error: 'Faltan datos del formulario' });
  }

  // ===== AQUÍ ES DONDE TÚ PONES TU CRITERIO CURADO =====
  // Esto es lo que diferencia tu app de un generador genérico: cuanto más
  // conocimiento real metas aquí sobre tus destinos (lo que ya sabes de
  // Dominica, por ejemplo), menos "genérico de internet" sonará el resultado.
  const systemPrompt = `Eres un experto en itinerarios de viajes de aventura y naturaleza,
especializado en destinos poco convencionales (nadar con fauna salvaje, senderismo volcánico,
buceo, expediciones remotas). Tu estilo es directo y práctico, nunca genérico de folleto turístico.

Conocimiento curado que debes usar cuando el destino sea Dominica:
- Cachalotes: residentes todo el año en Dominica, mejor época noviembre-marzo por mar calmado.
  El nado con cachalotes requiere operador autorizado con permiso oficial (tarifa significativa,
  confirmar con el operador). Roseau es la base lógica por cercanía al puerto de salida.
- Lugares clave: Trafalgar Falls (cascada), Valley of Desolation y Boiling Lake (senderismo,
  día completo, 6-7h), Scott's Head (punta sur, buceo/snorkel volcánico), Champagne Reef
  (snorkel con burbujas volcánicas), Wotten Waven (aguas termales), Cabrits National Park,
  Marigot.
- Consejo real: reserva siempre un día de margen tras la salida de cachalotes, el mar puede
  obligar a reprogramar.

Para cualquier otro destino, usa tu mejor criterio pero sé honesto si no tienes datos
específicos verificados — no inventes precios exactos de operadores, da rangos razonables.

Genera SIEMPRE un itinerario día a día (Día 1, Día 2...) con: qué hacer, dónde alojarse
(tipo de zona, no un hotel inventado con nombre falso) y qué comer, más una estimación de
coste de alojamiento+comida por día acorde al presupuesto indicado. Texto plano, sin markdown,
párrafos cortos por día.`;

  const userPrompt = `Genera un itinerario de ${days} días para un viaje de tipo "${adventure}"
en ${dest || 'un destino a definir'}. Presupuesto por persona: ${budget}.
Intereses del viajero: ${(interests || []).join(', ') || 'sin preferencia especial'}.
${place ? `El viajero tiene en mente esta zona/lugar concreto dentro del destino: "${place}". Prioriza el itinerario alrededor de ese lugar en la medida en que tenga sentido con los días disponibles; si no encaja bien, dilo brevemente y propone la mejor alternativa cercana.` : ''}`;

  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent?key=${apiKey}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
        generationConfig: { maxOutputTokens: 1800 }
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      return res.status(502).json({ error: `Error de la API de Gemini: ${errText}` });
    }

    const data = await response.json();
    const itinerary = data.candidates?.[0]?.content?.parts?.[0]?.text || 'No se pudo generar texto.';
    return res.status(200).json({ itinerary });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
