// ARCHIVO TEMPORAL DE PRUEBA — sirve solo para comparar la velocidad y la
// calidad de Cerebras (modelo gpt-oss-120b, en chips especializados mucho más
// rápidos que las tarjetas gráficas normales) frente a Gemini, antes de
// decidir si lo integramos de verdad en generate-itinerary.js. No toca nada
// de la lógica que ya funciona en producción — se puede borrar sin ningún
// problema en cuanto hayamos terminado de comparar.
//
// Se llama con un simple GET (para poder probarlo abriendo la URL desde el
// navegador), sin necesidad de mandar ningún dato: usa un caso de prueba fijo
// (3 días en Roma) para poder comparar con lo que ya conocemos de Gemini en
// igualdad de condiciones.

export default async function handler(req, res) {
  const apiKey = process.env.CEREBRAS_API_KEY;
  if (!apiKey) {
    return res.status(500).json({
      error: 'Falta configurar CEREBRAS_API_KEY en Vercel (Settings → Environment Variables), igual que se hizo con GEMINI_API_KEY.',
    });
  }

  const systemPrompt = `Eres un experto en itinerarios de viaje. Responde ÚNICAMENTE con JSON válido
que cumpla exactamente el esquema indicado, en español, con descripciones concisas (1-2 frases por
campo de texto). No inventes coordenadas al azar: deben corresponder de verdad a la ciudad del viaje.`;

  const userPrompt = `Genera un itinerario de 3 días en Roma, Italia, para una pareja con presupuesto
medio, interesada en cultura, historia y comida local. Para cada día incluye 2-4 lugares concretos
(con nombre y latitud/longitud aproximadas reales) y 2-3 restaurantes sugeridos distintos.`;

  const schema = {
    type: 'object',
    properties: {
      resumen: { type: 'string' },
      ciudad_principal: { type: 'string' },
      dias: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            dia: { type: 'integer' },
            titulo: { type: 'string' },
            descripcion: { type: 'string' },
            restaurantes_sugeridos: { type: 'array', items: { type: 'string' } },
            lugares: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  nombre: { type: 'string' },
                  lat: { type: 'number' },
                  lng: { type: 'number' },
                },
                required: ['nombre', 'lat', 'lng'],
                additionalProperties: false,
              },
            },
          },
          required: ['dia', 'titulo', 'descripcion', 'restaurantes_sugeridos', 'lugares'],
          additionalProperties: false,
        },
      },
    },
    required: ['resumen', 'ciudad_principal', 'dias'],
    additionalProperties: false,
  };

  const startedAt = Date.now();
  try {
    const response = await fetch('https://api.cerebras.ai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'gpt-oss-120b',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        response_format: {
          type: 'json_schema',
          json_schema: { name: 'itinerario_prueba', strict: true, schema },
        },
      }),
    });

    const durationSegundos = +((Date.now() - startedAt) / 1000).toFixed(2);
    const data = await response.json();

    if (!response.ok) {
      return res.status(500).json({ ok: false, durationSegundos, httpStatus: response.status, error: data });
    }

    const rawText = data.choices?.[0]?.message?.content || '';
    let itinerary = null;
    try {
      itinerary = JSON.parse(rawText);
    } catch (e) {
      // se deja null si no parsea, y se devuelve el texto crudo abajo para poder inspeccionarlo
    }

    return res.status(200).json({
      ok: true,
      proveedor: 'Cerebras',
      modelo: 'gpt-oss-120b',
      durationSegundos,
      inputTokens: data.usage?.prompt_tokens ?? null,
      outputTokens: data.usage?.completion_tokens ?? null,
      jsonValido: !!itinerary,
      itinerary,
      rawTextIfInvalid: itinerary ? undefined : rawText.slice(0, 1500),
    });
  } catch (err) {
    const durationSegundos = +((Date.now() - startedAt) / 1000).toFixed(2);
    return res.status(500).json({ ok: false, durationSegundos, error: String(err.message || err) });
  }
}
