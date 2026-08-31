// ARCHIVO TEMPORAL DE PRUEBA — igual que test-fast-model.js pero para probar
// Claude (Anthropic) en vez de Cerebras, usando la misma ANTHROPIC_API_KEY que
// ya se configuró en Vercel en su día. No toca nada de generate-itinerary.js
// (que sigue usando Gemini) — se puede borrar en cuanto terminemos de comparar.
//
// Se llama con un simple GET, sin datos, usando el mismo caso de prueba fijo
// (3 días en Roma) que la prueba de Cerebras, para comparar en igualdad de
// condiciones.

export default async function handler(req, res) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({
      error: 'Falta configurar ANTHROPIC_API_KEY en Vercel (Settings → Environment Variables). Si la tenías puesta de cuando la app usaba Claude, comprueba que la variable siga ahí.',
    });
  }

  const systemPrompt = `Eres un experto en itinerarios de viaje. Debes llamar SIEMPRE a la
herramienta "generar_itinerario" con el itinerario completo, en español, con descripciones
concisas (1-2 frases por campo de texto). No inventes coordenadas al azar: deben corresponder de
verdad a la ciudad del viaje.`;

  const userPrompt = `Genera un itinerario de 3 días en Roma, Italia, para una pareja con presupuesto
medio, interesada en cultura, historia y comida local. Para cada día incluye 2-4 lugares concretos
(con nombre y latitud/longitud aproximadas reales) y 2-3 restaurantes sugeridos distintos.`;

  const inputSchema = {
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
              },
            },
          },
          required: ['dia', 'titulo', 'descripcion', 'restaurantes_sugeridos', 'lugares'],
        },
      },
    },
    required: ['resumen', 'ciudad_principal', 'dias'],
  };

  const startedAt = Date.now();
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 4000,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
        tools: [
          {
            name: 'generar_itinerario',
            description: 'Registra el itinerario de viaje generado, con esta forma exacta.',
            input_schema: inputSchema,
          },
        ],
        tool_choice: { type: 'tool', name: 'generar_itinerario' },
      }),
    });

    const durationSegundos = +((Date.now() - startedAt) / 1000).toFixed(2);
    const data = await response.json();

    if (!response.ok) {
      return res.status(500).json({ ok: false, durationSegundos, httpStatus: response.status, error: data });
    }

    const toolBlock = (data.content || []).find((b) => b.type === 'tool_use');

    return res.status(200).json({
      ok: true,
      proveedor: 'Anthropic',
      modelo: 'claude-haiku-4-5-20251001',
      durationSegundos,
      inputTokens: data.usage?.input_tokens ?? null,
      outputTokens: data.usage?.output_tokens ?? null,
      jsonValido: !!toolBlock,
      itinerary: toolBlock ? toolBlock.input : null,
      rawIfInvalid: toolBlock ? undefined : data,
    });
  } catch (err) {
    const durationSegundos = +((Date.now() - startedAt) / 1000).toFixed(2);
    return res.status(500).json({ ok: false, durationSegundos, error: String(err.message || err) });
  }
}
