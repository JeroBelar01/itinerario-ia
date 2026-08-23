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

  const { adventure, dest, place, days, budget, budgetExact, interests, customRequest, currency, baseItinerary, foodPreferences, travelGroup } = req.body || {};
  if (!adventure || !days) {
    return res.status(400).json({ error: 'Faltan datos del formulario' });
  }

  // Nombre de la moneda en la que le pedimos a la IA que exprese todos los precios,
  // según la moneda detectada/elegida por el viajero en su perfil (por defecto, euros).
  const CURRENCY_NAMES = {
    EUR: 'euros (€)', USD: 'dólares estadounidenses ($)', GBP: 'libras esterlinas (£)',
    MXN: 'pesos mexicanos (MX$)', ARS: 'pesos argentinos (AR$)', COP: 'pesos colombianos (COL$)',
    CLP: 'pesos chilenos (CLP$)', PEN: 'soles peruanos (S/)', BRL: 'reales brasileños (R$)',
    UYU: 'pesos uruguayos ($U)', CRC: 'colones costarricenses (₡)', GTQ: 'quetzales guatemaltecos (Q)',
    DOP: 'pesos dominicanos (RD$)', CHF: 'francos suizos (Fr)', CAD: 'dólares canadienses (C$)'
  };
  const currencyLabel = CURRENCY_NAMES[currency] || CURRENCY_NAMES.EUR;

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
No inventes nombres de hoteles concretos; describe la zona o el tipo de alojamiento.

Si el viajero te da instrucciones adicionales en sus propias palabras, tenlas en cuenta con
prioridad alta: ajusta el orden, el ritmo, lo que incluyes o evitas según lo que pida, siempre
que sea razonable con los días disponibles.

Sobre el PRESUPUESTO: ${budgetExact
    ? `la cifra que te doy ahora es EXACTA, dada a mano por el propio viajero — trátala como un
límite real, no orientativo. El alojamiento y las actividades que propongas deben poder pagarse de
verdad con esa cifra por persona para todo el viaje (no solo "quedar cerca"); si con esa cifra no
llega para algo especialmente caro que pediría el tipo de aventura elegido, dilo brevemente en la
descripción del día en vez de ignorarlo.`
    : `el viajero no ha dado una cifra exacta, así que usa tu mejor criterio con un rango medio
para ese tipo de destino y actividad, y dilo de forma orientativa en "coste_estimado", sin fingir
una precisión que no tienes.`}

Sobre CON QUIÉN VIAJA (si te lo dan): ajusta el tono y las propuestas a ese contexto — con niños,
prioriza actividades seguras y de duración razonable para ellos y evita planes muy exigentes
físicamente o con horarios nocturnos; en pareja, puedes incluir algún plan o cena con un toque más
especial de vez en cuando; en grupo de amigos o grupo grande, prioriza planes que funcionen bien
para varias personas a la vez (evita actividades muy limitadas de aforo); en solitario, ten en
cuenta que puede preferir alojamientos u actividades donde sea fácil coincidir con otros viajeros
si eso encaja con el resto de sus preferencias.

Sobre PREFERENCIAS DE COMIDA (si te las dan): respétalas siempre al proponer "restaurante_sugerido"
y cualquier mención de comida en "descripcion" — por ejemplo, con "vegano" o "vegetariano" no
sugieras un sitio centrado en carne o pescado; con "sin gluten" evita platos que típicamente lo
llevan salvo que menciones que ese sitio concreto tiene opción sin gluten; con "comida local
auténtica" prioriza sitios populares entre locales más que cadenas o sitios turísticos; con
"platos conocidos/seguros" prioriza cocina reconocible (evita vísceras, insectos u otros platos muy
específicos que puedan resultar arriesgados para un paladar poco aventurero). Si no te dan ninguna
preferencia, usa tu criterio normal.

Todos los precios y costes estimados que des ("coste_estimado" y cualquier cifra dentro de
"descripcion") deben expresarse en ${currencyLabel}, con cifras realistas para esa economía y
esa moneda concreta (no hagas una conversión literal desde euros con una tasa exacta: usa tu
criterio para dar cifras que tengan sentido de verdad en esa moneda). Incluye siempre el símbolo
de la moneda junto a la cifra.

Para cada día debes indicar también, en "lugares", entre 2 y 4 sitios concretos y reales que se
visitan ese día (templos, barrios, playas, miradores, etc., SIN incluir aquí el restaurante del
día — ese va aparte en "restaurante_sugerido"), cada uno con su nombre y su latitud/longitud
aproximadas (número decimal, con la mejor precisión que puedas dar de memoria — no hace falta que
sea exacta al metro, pero debe corresponder de verdad a esa ciudad o zona del país, no inventes
coordenadas al azar). Este listado se usa para pintar un mapa, así que los nombres deben ser cortos
(2 a 5 palabras) y reconocibles.

Además, para cada día debes indicar en "restaurante_sugerido" UN restaurante o sitio para comer,
real y concreto si tienes uno que encaje bien de verdad con la zona de ese día (nombre + 1-3
palabras de qué tipo de sitio es, ej: "Trattoria da Enzo, pasta casera"); si no tienes un nombre
real fiable para esa zona concreta, describe el tipo de sitio en vez de inventar un nombre (ej:
"Puesto de pescado a la brasa junto al puerto") — nunca inventes un nombre de restaurante que
suene real si no lo es de verdad, es mejor describir el tipo de sitio.

Sé conciso en cada campo de texto: esto es muy importante para que la respuesta no se corte.

Debes responder ÚNICAMENTE con un JSON válido (nada de texto antes o después, nada de
bloques de código con \`\`\`), con esta forma exacta:
{
  "resumen": "una frase corta (máximo 2 líneas) presentando el viaje en conjunto",
  "dias": [
    {
      "dia": 1,
      "titulo": "título corto de lo que se hace ese día (máximo 6 palabras)",
      "descripcion": "2 a 3 frases describiendo el plan del día, directo y práctico",
      "alojamiento_zona": "tipo de zona o barrio donde alojarse ese día",
      "coste_estimado": "rango de coste de alojamiento + comida ese día, acorde al presupuesto, en la moneda indicada",
      "restaurante_sugerido": "nombre real y tipo de sitio para comer ese día, o una descripción del tipo de sitio si no tienes un nombre real fiable (ver instrucciones arriba)",
      "busqueda_foto": "2 a 4 palabras EN INGLÉS describiendo visualmente el momento más icónico de ese día, pensadas para buscar una foto de stock (ej: 'rainforest canopy walk', 'volcanic waterfall hike')",
      "lugares": [
        { "nombre": "Nombre del sitio", "lat": 0.0, "lng": 0.0 }
      ]
    }
  ]
}
El array "dias" debe tener exactamente un objeto por cada día del itinerario, ni uno más ni uno menos.`;

  const baseItineraryBlock = baseItinerary ? `

ESTE NO ES UN ITINERARIO NUEVO DESDE CERO: es la ADAPTACIÓN de un itinerario que ya existe y que
otro viajero creó. Aquí tienes el original (resumen y plan día a día):
---
Resumen original: ${baseItinerary.resumen || '(sin resumen)'}
${(baseItinerary.dias || []).map(d => `Día ${d.dia}${d.titulo ? ' — ' + d.titulo : ''}: ${d.descripcion || ''}`).join('\n')}
---
Tu trabajo es CONSERVAR el espíritu, la ruta y los lugares recomendados de este itinerario
original en la medida en que tengan sentido con los nuevos requisitos de abajo (días, presupuesto,
instrucciones). Si hay que quitar o recolocar días porque el viaje ahora es más corto o más largo,
prioriza mantener los puntos más icónicos del original. No lo copies literalmente palabra por
palabra: redáctalo de nuevo, adaptado, con tu propio criterio.` : '';

  const userPrompt = `Genera un itinerario de ${days} días para un viaje de tipo "${adventure}"
en ${dest || 'un destino a definir'}. Presupuesto por persona: ${budget}.
Intereses del viajero: ${(interests || []).join(', ') || 'sin preferencia especial'}.
¿Con quién viaja?: ${travelGroup || 'no especificado'}.
Preferencias de comida: ${(foodPreferences || []).join(', ') || 'sin preferencia especial'}.
Moneda del viajero: expresa TODOS los precios en ${currencyLabel}.
${place ? `El viajero tiene en mente esta zona/lugar concreto dentro del destino: "${place}". Prioriza el itinerario alrededor de ese lugar en la medida en que tenga sentido con los días disponibles; si no encaja bien, dilo brevemente y propone la mejor alternativa cercana.` : ''}
${customRequest ? `Instrucciones adicionales del viajero, en sus propias palabras (tenlas muy en cuenta, con prioridad sobre lo demás si hay conflicto): "${customRequest}"` : ''}${baseItineraryBlock}
Recuerda: responde solo con el JSON pedido, sin texto extra ni bloques de código, y sé conciso en cada campo para no cortar la respuesta.`;

  // Cuantos más días, más tokens hacen falta para que la respuesta no se corte
  // a mitad (lo cual generaba JSON inválido). Escalamos el límite con los días
  // (subido un poco respecto a antes porque ahora cada día también lleva
  // "lugares" y, desde ahora, también "restaurante_sugerido").
  const maxOutputTokens = Math.min(8000, 650 + days * 500);

  // Si el modelo principal está saturado (error 503 "high demand"), probamos
  // un par de veces más y, si sigue sin responder, caemos a otro modelo
  // estable en vez de dar el error directamente al usuario.
  async function callGemini() {
    const models = ['gemini-3.7-flash', 'gemini-3.6-flash', 'gemini-3.5-flash'];
    let lastErrText = 'Sin respuesta de la API';
    for (const model of models) {
      for (let attempt = 0; attempt < 2; attempt++) {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: systemPrompt }] },
            contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
            generationConfig: { maxOutputTokens, responseMimeType: 'application/json' }
          })
        });
        if (response.ok) return response;
        lastErrText = await response.text();
        if (response.status !== 503) {
          throw new Error(`Error de la API de Gemini: ${lastErrText}`);
        }
        await new Promise(r => setTimeout(r, 700));
      }
    }
    throw new Error(`Error de la API de Gemini: ${lastErrText}`);
  }

  // Intenta parsear el JSON de la respuesta de forma tolerante: primero tal
  // cual, y si falla (por ejemplo por texto extra alrededor), recorta hasta
  // el primer "{" y el último "}" y lo intenta otra vez.
  function parseItineraryJson(rawText) {
    const cleaned = (rawText || '')
      .replace(/^```json\s*/i, '')
      .replace(/^```\s*/i, '')
      .replace(/```\s*$/i, '')
      .trim();

    const tryParse = (text) => {
      try {
        const obj = JSON.parse(text);
        if (obj && Array.isArray(obj.dias) && obj.dias.length) return obj;
      } catch (e) { /* seguimos probando */ }
      return null;
    };

    let result = tryParse(cleaned);
    if (result) return result;

    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start !== -1 && end !== -1 && end > start) {
      result = tryParse(cleaned.slice(start, end + 1));
      if (result) return result;
    }
    return null;
  }

  async function generateOnce() {
    const response = await callGemini();
    const data = await response.json();
    const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    const itinerary = parseItineraryJson(rawText);
    if (!itinerary) {
      const finishReason = data.candidates?.[0]?.finishReason || 'desconocido';
      throw new Error(`No se pudo interpretar el JSON de la IA (motivo: ${finishReason})`);
    }
    return itinerary;
  }

  try {
    let itinerary;
    try {
      itinerary = await generateOnce();
    } catch (firstErr) {
      // Un formato inválido suele ser un fallo puntual: probamos una vez más
      // antes de rendirnos y dar el error al usuario.
      itinerary = await generateOnce();
    }
    return res.status(200).json({ itinerary });

  } catch (err) {
    if (String(err.message || '').startsWith('No se pudo interpretar el JSON')) {
      return res.status(502).json({ error: 'La IA no devolvió el itinerario en el formato esperado. Prueba a generarlo otra vez.' });
    }
    return res.status(500).json({ error: err.message });
  }
}
