// Función serverless de Vercel. Se ejecuta en el servidor, NUNCA en el navegador,
// así que aquí es seguro usar la API key (se lee de una variable de entorno, nunca del código).

import { initializeApp, cert, getApps, getApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';

// Mismo patrón y misma variable de entorno que ya usa api/send-push.js — no
// hace falta configurar nada nuevo en Vercel, la clave de administrador de
// Firebase ya está puesta.
function getAdminApp() {
  if (getApps().length) return getApp();
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) throw new Error('Falta configurar FIREBASE_SERVICE_ACCOUNT en Vercel');
  const serviceAccount = JSON.parse(raw);
  return initializeApp({ credential: cert(serviceAccount) });
}

// Cuántos itinerarios gratis con IA puede generar cada persona al mes. Si
// algún día quieres cobrar por más, este es el número que hay que comparar
// contra si esa persona es premium o no (todavía no existe ese concepto en
// la app, así que por ahora el límite es el mismo para todo el mundo).
const FREE_MONTHLY_LIMIT = 5;

function currentMonthKey() {
  return new Date().toISOString().slice(0, 7); // "2026-09"
}

function nextMonthFirstDayIso() {
  const now = new Date();
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return next.toISOString().slice(0, 10); // "2026-10-01"
}

// Se llama ANTES de gastar nada de cuota de Gemini, para no desperdiciarla en
// una petición que de todas formas íbamos a rechazar. Guarda el contador en
// users/{uid}.aiUsage — si no existe todavía (cuentas de antes de este
// cambio) se trata como si llevara 0 usados este mes, sin tocar nada más de
// esa persona.
async function checkAiUsage(db, uid) {
  const snap = await db.collection('users').doc(uid).get();
  const usage = (snap.exists && snap.data().aiUsage) || {};
  const count = usage.monthKey === currentMonthKey() ? (usage.count || 0) : 0;
  if (count >= FREE_MONTHLY_LIMIT) {
    const err = new Error(`Has usado tus ${FREE_MONTHLY_LIMIT} itinerarios gratis de este mes.`);
    err.code = 'LIMITE_ALCANZADO';
    err.resetAt = nextMonthFirstDayIso();
    throw err;
  }
}

// Se llama SOLO cuando el itinerario se ha generado bien de verdad — un
// intento que falla (la IA se satura, se corta el tiempo, etc.) no debe
// gastar cuota del usuario, así que este incremento va siempre DESPUÉS de
// tener ya la respuesta buena de Gemini, nunca antes. Va en una transacción
// para que dos peticiones casi a la vez del mismo usuario no se pisen al
// leer y escribir el contador.
async function consumeAiUsage(db, uid) {
  const ref = db.collection('users').doc(uid);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const usage = (snap.exists && snap.data().aiUsage) || {};
    const monthKey = currentMonthKey();
    const count = usage.monthKey === monthKey ? (usage.count || 0) : 0;
    tx.set(ref, { aiUsage: { monthKey, count: count + 1 } }, { merge: true });
  });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método no permitido' });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'Falta configurar GEMINI_API_KEY en Vercel' });
  }

  // Quién eres — hace falta tanto para no dejar generar itinerarios a quien
  // no ha iniciado sesión, como para llevar la cuenta del límite gratis
  // mensual de arriba. ANTES esta función no comprobaba esto en absoluto:
  // cualquiera que conociera la URL podía llamarla directamente sin límite,
  // sin ni siquiera tener la app instalada.
  const authHeader = req.headers.authorization || '';
  const idToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!idToken) {
    return res.status(401).json({ error: 'Hace falta iniciar sesión para generar un itinerario.' });
  }
  let uid;
  try {
    getAdminApp();
    const decoded = await getAuth().verifyIdToken(idToken);
    uid = decoded.uid;
  } catch (e) {
    return res.status(401).json({ error: 'Tu sesión no es válida, vuelve a iniciar sesión e inténtalo de nuevo.' });
  }
  const db = getFirestore();
  try {
    await checkAiUsage(db, uid);
  } catch (err) {
    if (err.code === 'LIMITE_ALCANZADO') {
      return res.status(403).json({ error: err.message, code: err.code, resetAt: err.resetAt });
    }
    return res.status(500).json({ error: 'No se pudo comprobar tu límite de uso, inténtalo de nuevo.' });
  }

  const { adventure, dest, place, days, budget, budgetExact, interests, customRequest, currency, baseItinerary, foodPreferences, travelGroup, originCity, departDate, returnDate, foodBudgetPerDay, lodgingBudgetPerDay } = req.body || {};
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

  // Presupuesto MÁS concreto, por día y separado en comida/alojamiento (si el
  // viajero lo rellena) — se calcula aparte, como bloque de texto plano, para
  // no liarnos con condicionales anidados dentro del template literal grande
  // de systemPrompt de abajo.
  const foodLodgingParts = [];
  if (foodBudgetPerDay) foodLodgingParts.push(`${foodBudgetPerDay} ${currencyLabel} al día para comida (restaurantes y comidas)`);
  if (lodgingBudgetPerDay) foodLodgingParts.push(`${lodgingBudgetPerDay} ${currencyLabel} al día para alojamiento`);
  const foodLodgingBudgetBlock = foodLodgingParts.length
    ? `\n\nAdemás, el viajero te da un presupuesto MÁS CONCRETO por día: ${foodLodgingParts.join(' y ')}.
Ajusta tus sugerencias de restaurantes (que su precio típico encaje de verdad con esa cifra) y la
zona/tipo de alojamiento que propongas a esos importes exactos — sé realista sobre lo que se puede
conseguir con ese dinero en ese destino concreto, y refleja esas cifras en "coste_comida_estimado" y
"coste_alojamiento_estimado" de cada día.`
    : '';

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

Sobre "ciudad_principal": indica la ciudad concreta (o, si de verdad no hay una sola ciudad clara,
la región/zona principal) donde se basa la mayor parte del viaje, en español y con su nombre
habitual (ej: "París", "Ciudad de México", "Costa Rica – Guanacaste"). Esto es obligatorio y
distinto de "alojamiento_zona" de cada día (que es el barrio concreto): aquí es solo la ciudad, se
usa para buscar vuelos y alojamiento con un nombre útil aunque el viajero no haya escrito ninguno.

Sobre alojamiento: en "alojamiento_zona" describe siempre el barrio o tipo de zona (real, nunca
inventada). Además, intenta dar SIEMPRE que puedas, en "hotel_sugerido", el nombre de un hotel o
alojamiento concreto en esa zona — se usará para buscarlo directamente en Booking, así que cuanto
más a menudo lo rellenes, más útil es el enlace para el viajero. Si conoces un hotel independiente
real de esa zona, dalo; si no, una cadena grande con presencia habitual en ciudades de ese tamaño
(NH, Ibis, Meliá, Barceló, Accor, Marriott, Holiday Inn, etc.) que encaje con el tipo de zona y
presupuesto es una buena opción por defecto — es mejor un nombre de cadena real y plausible que
dejarlo vacío. Deja "hotel_sugerido" como cadena vacía "" únicamente cuando el destino sea tan
remoto o poco convencional (ej. una aldea junto a una selva) que ni siquiera una cadena grande
tenga sentido ahí; en ese caso, nunca inventes un nombre que suene real si no lo es.

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
para ese tipo de destino y actividad, y dilo de forma orientativa en "coste_alojamiento_estimado" y
"coste_comida_estimado", sin fingir una precisión que no tienes.`}${foodLodgingBudgetBlock}

Sobre CON QUIÉN VIAJA (si te lo dan): ajusta el tono y las propuestas a ese contexto — con niños,
prioriza actividades seguras y de duración razonable para ellos y evita planes muy exigentes
físicamente o con horarios nocturnos; en pareja, puedes incluir algún plan o cena con un toque más
especial de vez en cuando; en grupo de amigos o grupo grande, prioriza planes que funcionen bien
para varias personas a la vez (evita actividades muy limitadas de aforo); en solitario, ten en
cuenta que puede preferir alojamientos u actividades donde sea fácil coincidir con otros viajeros
si eso encaja con el resto de sus preferencias.

Sobre PREFERENCIAS DE COMIDA (si te las dan): respétalas siempre al proponer "restaurantes_sugeridos"
y cualquier mención de comida en "descripcion" — por ejemplo, con "vegano" o "vegetariano" no
sugieras un sitio centrado en carne o pescado; con "sin gluten" evita platos que típicamente lo
llevan salvo que menciones que ese sitio concreto tiene opción sin gluten; con "comida local
auténtica" prioriza sitios populares entre locales más que cadenas o sitios turísticos; con
"platos conocidos/seguros" prioriza cocina reconocible (evita vísceras, insectos u otros platos muy
específicos que puedan resultar arriesgados para un paladar poco aventurero). Si no te dan ninguna
preferencia, usa tu criterio normal.

Todos los precios y costes estimados que des ("coste_alojamiento_estimado", "coste_comida_estimado"
y cualquier cifra dentro de "descripcion") deben expresarse en ${currencyLabel}, con cifras realistas para esa economía y
esa moneda concreta (no hagas una conversión literal desde euros con una tasa exacta: usa tu
criterio para dar cifras que tengan sentido de verdad en esa moneda). Incluye siempre el símbolo
de la moneda junto a la cifra.

Para cada día debes indicar también, en "lugares", entre 2 y 4 sitios concretos y reales que se
visitan ese día (templos, barrios, playas, miradores, etc., SIN incluir aquí restaurantes — esos
van aparte en "restaurantes_sugeridos"), cada uno con su nombre y su latitud/longitud
aproximadas (número decimal, con la mejor precisión que puedas dar de memoria — no hace falta que
sea exacta al metro, pero debe corresponder de verdad a esa ciudad o zona del país, no inventes
coordenadas al azar). Este listado se usa para pintar un mapa, así que los nombres deben ser cortos
(2 a 5 palabras) y reconocibles.

Además, para cada día debes indicar en "restaurantes_sugeridos" ENTRE 2 Y 3 sitios distintos para
comer ese día (variedad real entre desayuno/almuerzo/cena y tipos de cocina), reales y concretos
si tienes alguno que encaje bien de verdad con la zona de ese día (nombre + 1-3 palabras de qué
tipo de sitio es, ej: "Trattoria da Enzo, pasta casera"); si no tienes nombres reales fiables para
esa zona concreta, describe el tipo de sitio en vez de inventar nombres (ej: "Puesto de pescado a
la brasa junto al puerto") — nunca inventes un nombre de restaurante que suene real si no lo es de
verdad, es mejor describir el tipo de sitio. No repitas el mismo restaurante ni el mismo tipo de
sitio en ningún otro día del itinerario.

También debes dar, para el conjunto del viaje (no por día), estos dos bloques (sé breve en los dos:
esto es texto fijo que se repite en cada itinerario, así que cuanto más corto, más rápido sale la
respuesta entera sin perder la información útil):
- "vuelos_info": 1 frase práctica sobre volar a ese destino — qué aeropuerto principal usar, y si
  te dan fechas concretas del viaje, un apunte muy breve sobre si esas fechas caen en temporada
  alta/baja para el precio de los vuelos. No inventes precios exactos de vuelos: no tienes acceso a
  precios en tiempo real, así que no digas cifras concretas, solo consejo práctico.
- "transporte": cómo moverse en el destino, con esta forma: { "resumen": "1 frase general sobre
  cómo se mueve la gente en ese destino (metro, autobús urbano, coche de alquiler...)",
  "opciones": [ { "tipo": "Tren/Autobús/Ferry/Vuelo doméstico/etc.", "detalle": "nombre real de la
  compañía o servicio si lo conoces con confianza, y qué ruta cubre; si no tienes un nombre real
  fiable, describe el tipo de servicio en vez de inventar una compañía", "busqueda": "2 a 6 palabras
  en español para buscar dónde comprar ese billete (ej: 'billetes tren Roma Nápoles')" } ] } — dame
  entre 1 y 3 "opciones", solo las que tengan sentido real para ese itinerario concreto (si todo el
  viaje es en una sola ciudad caminable, dilo así en el resumen y da como mucho una opción extra).

Sé conciso en cada campo de texto — esto es muy importante tanto para que la respuesta no se corte
como para que la IA responda más rápido: "descripcion" son 1-2 frases (nunca 3 o más), "resumen" y
"vuelos_info" son igual de breves, y ningún campo de texto se alarga más de lo pedido en su
descripción de arriba.${days > 10 ? `

ESTE VIAJE ES LARGO (${days} días): cuantos más días tenga que escribir, más tiempo tarda la
respuesta entera en generarse, así que para viajes de más de 10 días sé TODAVÍA más breve en cada
día (sin perder información real ni inventar nada): como mucho 2-3 "lugares" (en vez de hasta 4),
como mucho 2 "restaurantes_sugeridos" (en vez de hasta 3), y "descripcion" de una sola frase corta,
no dos. La calidad y lo concreto de cada dato debe seguir siendo igual de bueno, solo más resumido.` : ''}

Debes responder ÚNICAMENTE con un JSON válido (nada de texto antes o después, nada de
bloques de código con \`\`\`), con esta forma exacta:
{
  "resumen": "una frase corta (máximo 2 líneas) presentando el viaje en conjunto",
  "ciudad_principal": "ciudad (o región si no hay una ciudad clara) donde se basa el viaje, en español",
  "vuelos_info": "consejo práctico sobre vuelos a este destino (ver instrucciones arriba)",
  "transporte": {
    "resumen": "cómo se mueve la gente en general en este destino",
    "opciones": [
      { "tipo": "Tren", "detalle": "nombre real o tipo de servicio + ruta que cubre", "busqueda": "texto corto para buscar dónde comprarlo" }
    ]
  },
  "dias": [
    {
      "dia": 1,
      "titulo": "título corto de lo que se hace ese día (máximo 6 palabras)",
      "descripcion": "1 a 2 frases describiendo el plan del día, directo y práctico",
      "alojamiento_zona": "tipo de zona o barrio donde alojarse ese día",
      "hotel_sugerido": "nombre de un hotel real (o cadena conocida) en esa zona; cadena vacía solo si el destino es muy remoto",
      "coste_alojamiento_estimado": "coste estimado del alojamiento esa noche, acorde al presupuesto, en la moneda indicada",
      "coste_comida_estimado": "coste estimado de comida ese día, acorde al presupuesto, en la moneda indicada",
      "restaurantes_sugeridos": ["Sitio 1, con su tipo", "Sitio 2 distinto, con su tipo", "Sitio 3 distinto"],
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
${originCity ? `Ciudad de salida del viajero: ${originCity} (para tu consejo en "vuelos_info").` : ''}
${(departDate && returnDate) ? `Fechas del viaje: del ${departDate} al ${returnDate} (para tu consejo de temporada en "vuelos_info").` : ''}
${foodBudgetPerDay ? `Presupuesto de comida: ${foodBudgetPerDay} ${currencyLabel} al día.` : ''}
${lodgingBudgetPerDay ? `Presupuesto de alojamiento: ${lodgingBudgetPerDay} ${currencyLabel} al día.` : ''}
${place ? `El viajero tiene en mente esta zona/lugar concreto dentro del destino: "${place}". Prioriza el itinerario alrededor de ese lugar en la medida en que tenga sentido con los días disponibles; si no encaja bien, dilo brevemente y propone la mejor alternativa cercana.` : ''}
${customRequest ? `Instrucciones adicionales del viajero, en sus propias palabras (tenlas muy en cuenta, con prioridad sobre lo demás si hay conflicto): "${customRequest}"` : ''}${baseItineraryBlock}
Recuerda: responde solo con el JSON pedido, sin texto extra ni bloques de código, y sé conciso en cada campo para no cortar la respuesta.`;

  // Cuantos más días, más tokens hacen falta para que la respuesta no se corte
  // a mitad (lo cual generaba JSON inválido) — pero cuantos MÁS tokens le
  // pedimos de más margen, más tarda en generarse la respuesta entera (los
  // modelos van generando palabra a palabra, así que el texto de salida es
  // lo que más pesa en el tiempo total, mucho más que lo que escribe el
  // propio viajero en el formulario). Por eso, además de bajar el número de
  // restaurantes y el largo de las descripciones pedidas más arriba, este
  // techo también se ha ajustado a la baja acorde a ese texto más corto —
  // sigue dejando margen de sobra para que la respuesta no se corte a
  // mitad, solo que ya no de más de lo que ahora hace falta de verdad.
  const maxOutputTokens = Math.min(16000, 1400 + days * 750);

  // Además del texto de arriba explicando la forma del JSON, le damos a Gemini
  // un "responseSchema" de verdad: esto obliga a la API, a nivel estructural,
  // a devolver siempre ese formato exacto (tipos, campos obligatorios...) en
  // vez de depender solo de que el modelo "se acuerde" de seguir el ejemplo de
  // texto. Es el cambio con más impacto para evitar el error "la IA no
  // devolvió el itinerario en el formato esperado".
  const itinerarySchema = {
    type: 'OBJECT',
    properties: {
      resumen: { type: 'STRING' },
      ciudad_principal: { type: 'STRING' },
      vuelos_info: { type: 'STRING' },
      transporte: {
        type: 'OBJECT',
        properties: {
          resumen: { type: 'STRING' },
          opciones: {
            type: 'ARRAY',
            items: {
              type: 'OBJECT',
              properties: {
                tipo: { type: 'STRING' },
                detalle: { type: 'STRING' },
                busqueda: { type: 'STRING' }
              },
              required: ['tipo', 'detalle', 'busqueda']
            }
          }
        },
        required: ['resumen', 'opciones']
      },
      dias: {
        type: 'ARRAY',
        items: {
          type: 'OBJECT',
          properties: {
            dia: { type: 'INTEGER' },
            titulo: { type: 'STRING' },
            descripcion: { type: 'STRING' },
            alojamiento_zona: { type: 'STRING' },
            hotel_sugerido: { type: 'STRING' },
            coste_alojamiento_estimado: { type: 'STRING' },
            coste_comida_estimado: { type: 'STRING' },
            restaurantes_sugeridos: { type: 'ARRAY', items: { type: 'STRING' } },
            busqueda_foto: { type: 'STRING' },
            lugares: {
              type: 'ARRAY',
              items: {
                type: 'OBJECT',
                properties: {
                  nombre: { type: 'STRING' },
                  lat: { type: 'NUMBER' },
                  lng: { type: 'NUMBER' }
                },
                required: ['nombre', 'lat', 'lng']
              }
            }
          },
          required: ['dia', 'titulo', 'descripcion', 'alojamiento_zona', 'hotel_sugerido', 'coste_alojamiento_estimado', 'coste_comida_estimado', 'restaurantes_sugeridos', 'busqueda_foto', 'lugares']
        }
      }
    },
    required: ['resumen', 'ciudad_principal', 'vuelos_info', 'transporte', 'dias']
  };

  // Vercel corta esta función ELLA SOLA a los 300 segundos (5 minutos), pase
  // lo que pase — visto de verdad en los logs (504 "Task timed out after 300
  // seconds"). Antes, si una sola llamada a Gemini se quedaba colgada (pasa
  // a veces con la API bajo mucha carga), no había nada que la cortase, así
  // que se podía comer ella sola todo ese tiempo sin que ni siquiera
  // llegáramos a probar otro modelo. Ahora llevamos la cuenta de cuánto
  // tiempo real nos queda (con margen de sobra respecto a los 300s de
  // Vercel) y la usamos para: (1) que cada llamada individual a Gemini tenga
  // su propio límite, y (2) dejar de intentarlo en cuanto ya no quede tiempo
  // de verdad para otro intento — así el usuario siempre recibe una
  // respuesta clara nuestra bastante antes de que Vercel corte en seco, en
  // vez de un error de red genérico sin explicación.
  const REQUEST_START = Date.now();
  // Bajado de 260000 a 150000 al principio, y subido después a 210000: con
  // 150000 no quedaba margen real para un segundo modelo cuando el primero
  // agotaba su propio techo (subido ahora a 115s, ver más abajo) en un viaje
  // largo — visto en producción con el caso real de Japón (17 días). Con
  // 210000 sigue siendo bastante menos que los 260000 de antes (y mucho
  // menos que el peor caso de antes, que además reiniciaba todo hasta 3
  // veces), pero deja sitio de verdad para: una primera llamada larga que
  // sí puede necesitar hasta 115s en un viaje largo, MÁS una llamada de
  // reserva a otro modelo después.
  const OVERALL_DEADLINE_MS = 210000;
  function remainingBudgetMs() {
    return OVERALL_DEADLINE_MS - (Date.now() - REQUEST_START);
  }

  // ===== LOGS TEMPORALES DE DIAGNÓSTICO (quitar cuando ya no hagan falta) =====
  // Para averiguar de dónde sale de verdad el "hasta 2 minutos" que se ve
  // desde el móvil: un registro de cada llamada real a Gemini (uno por cada
  // combinación modelo+intento que se prueba), con cuánto ha tardado ESA
  // llamada en concreto y por qué ha fallado si ha fallado — así se puede ver
  // si el tiempo se va en la llamada que finalmente funciona (que
  // simplemente sería lenta de verdad) o en varias llamadas fallidas antes
  // de esa (reintentos/cuota agotada/modelos caídos), que es una causa muy
  // distinta y se arreglaría de forma distinta. No cambia ningún
  // comportamiento: solo apunta datos y los imprime.
  const attemptLog = [];
  let lastCallLogEntry = null; // la entrada de attemptLog de la llamada que SÍ respondió ok (si alguna lo ha hecho), para que generateOnce() le añada luego si el JSON venía válido y cuántos tokens tuvo.
  let currentIntentoNumber = 1; // qué vuelta del bucle exterior (formato inválido → reintentar desde cero) es esta, ver más abajo.

  function logGeminiAttempt(partial) {
    const entry = {
      intento: currentIntentoNumber,
      startedAtIso: new Date(partial.startedAt).toISOString(),
      elapsedDesdeElInicioSegundos: +((partial.startedAt - REQUEST_START) / 1000).toFixed(1),
      durationSegundos: +(partial.durationMs / 1000).toFixed(1),
      ...partial,
    };
    delete entry.startedAt; // ya está como startedAtIso/elapsedDesdeElInicioSegundos, más legible en los logs
    delete entry.durationMs; // ya está como durationSegundos
    attemptLog.push(entry);
    console.log('[generate-itinerary][TIMING] intento de Gemini:', JSON.stringify(entry));
    return entry;
  }

  // Se llama sí o sí al terminar la función entera (éxito o error) para
  // dejar un resumen fácil de leer en los logs de Vercel. OJO: si Vercel
  // llega a cortar la función en seco a los 300s (el límite duro que ya
  // conocemos), este resumen final NO llegaría a imprimirse — por eso cada
  // llamada individual ya se imprime en el momento (arriba), no solo aquí.
  function logFinalSummary() {
    const totalSegundos = +((Date.now() - REQUEST_START) / 1000).toFixed(1);
    const successEntry = attemptLog.find((e) => e.outcome === 'success' && e.jsonValid === true);
    const segundosEnIntentosDescartados = +attemptLog
      .filter((e) => e !== successEntry)
      .reduce((sum, e) => sum + e.durationSegundos, 0)
      .toFixed(1);
    console.log('[generate-itinerary][TIMING][RESUMEN]', JSON.stringify({
      totalSegundos,
      numeroDeLlamadasAGemini: attemptLog.length,
      segundosEnLlamadasDescartadas: segundosEnIntentosDescartados,
      segundosEnLaLlamadaQueFunciono: successEntry ? successEntry.durationSegundos : null,
      modeloQueFunciono: successEntry ? successEntry.model : null,
      eraModeloDeFallback: successEntry ? successEntry.isFallbackModel : null,
      llegoAFuncionarAlgunaLlamada: !!successEntry,
      detalle: attemptLog,
    }));
  }
  // ===== FIN LOGS TEMPORALES =====

  // Si el modelo principal está saturado (error 503 "high demand"), probamos
  // un par de veces más y, si sigue sin responder, caemos a otro modelo
  // estable en vez de dar el error directamente al usuario. El caso 429
  // (cuota gratuita agotada) se trata aparte: esa cuota es POR MODELO, no
  // compartida entre los tres, así que si "gemini-3.7-flash" se queda sin
  // cuota por hoy, en vez de insistir en él pasamos enseguida al siguiente
  // modelo de la lista, que normalmente todavía tiene cuota propia libre.
  //
  // "gemini-3.5-flash-lite" va el último, como último recurso: es una
  // versión más ligera pensada por Google para responder más rápido (y con
  // el doble de cuota gratis por minuto que los "flash" normales), pero al
  // ser más ligera la calidad puede notarse un poco peor (descripciones más
  // genéricas, menos fino con el conocimiento curado de destinos concretos
  // que le damos en systemPrompt). Por eso solo se usa si el modelo principal
  // ya ha fallado o se ha quedado sin cuota — así mejora el peor caso (que si
  // no, acabaría en un error tras agotar los dos) sin bajarle la calidad al
  // caso normal de cada día.
  //
  // Lista recortada de 4 a 3 modelos (se quitó "gemini-3.5-flash", que no
  // aportaba nada distinto de "gemini-3.6-flash" salvo alargar la cadena de
  // reintentos) — con el mismo objetivo de abajo: que el peor caso (todo
  // falla) tarde bastante menos en total, en vez de acumular el tiempo de
  // cuatro modelos distintos antes de rendirse.
  async function callGemini() {
    const models = ['gemini-3.7-flash', 'gemini-3.6-flash', 'gemini-3.5-flash-lite'];
    let lastErrText = 'Sin respuesta de la API';
    for (const model of models) {
      for (let attempt = 0; attempt < 2; attempt++) {
        if (remainingBudgetMs() < 20000) throw new Error('TIEMPO_AGOTADO');

        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
        // Límite propio de ESTA llamada. Antes era un tope fijo de 110s pasara
        // lo que pasara — así, si el modelo estaba simplemente colgado (no dando
        // ni siquiera un error), una sola llamada se podía comer casi 2 minutos
        // enteros antes de probar el siguiente modelo.
        // OJO, probado con un viaje real de 14 días: bajarlo a 45s fijos fue
        // demasiado agresivo — un itinerario largo (más ciudades, más lugares
        // reales, más restaurantes) simplemente NECESITA más de 45s para
        // generarse entero, así que el primer intento se abortaba a mitad
        // (sin estar realmente colgado, solo yendo más despacio de lo
        // esperado) y había que empezar de cero con el segundo intento —
        // sumando los dos tiempos en vez de ahorrar nada. Abortar un intento
        // que SÍ está avanzando es peor que dejarlo terminar: se pierde todo
        // el trabajo ya hecho y hay que repetirlo entero.
        // Ahora el cálculo es más generoso (más tokens de salida esperados por
        // día, ritmo más conservador) y el techo sube a 115s en vez de 45s —
        // sigue siendo mucho mejor que los 110s de antes para el caso de un
        // modelo de verdad colgado, pero ya no corta en seco un viaje largo
        // que solo iba un poco más lento de lo normal.
        //
        // FALLO REAL VISTO EN PRODUCCIÓN (viaje de 17 días a Japón): con
        // "250 + días*300" la propia fórmula ya calculaba que hacían falta
        // ~111s de generación, pero el techo de abajo lo cortaba en seco a
        // los 90s — es decir, abortábamos una llamada que NOSOTROS MISMOS
        // sabíamos que necesitaba más tiempo, perdiendo todo el trabajo ya
        // hecho. Para viajes de más de 10 días el systemPrompt de arriba ya
        // pide bastante menos detalle por día (menos lugares/restaurantes,
        // descripciones más cortas), así que aquí se refleja esa misma
        // rebaja en la estimación (300 tokens/día hasta el día 10, 220 a
        // partir de ahí) y se sube el techo a 115s para que, si aun así hace
        // falta ese tiempo, no se corte una llamada que sí iba a terminar.
        const expectedOutputTokens = days <= 10
          ? 250 + days * 300
          : 250 + 10 * 300 + (days - 10) * 220;
        const expectedGenerationMs = (expectedOutputTokens / 120) * 1000 * 2.5;
        const callTimeoutMs = Math.min(115000, Math.max(20000, Math.min(expectedGenerationMs, remainingBudgetMs() - 10000)));
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), callTimeoutMs);
        const isFallbackModel = model !== models[0]; // LOG TEMPORAL
        const attemptStartedAt = Date.now(); // LOG TEMPORAL

        let response;
        try {
          response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              systemInstruction: { parts: [{ text: systemPrompt }] },
              contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
              generationConfig: { maxOutputTokens, responseMimeType: 'application/json', responseSchema: itinerarySchema }
            }),
            signal: controller.signal
          });
        } catch (err) {
          clearTimeout(timeoutId);
          const isTimeout = err.name === 'AbortError'; // LOG TEMPORAL
          lastErrText = err.name === 'AbortError'
            ? `${model} ha tardado demasiado en responder (más de ${Math.round(callTimeoutMs / 1000)}s)`
            : String(err.message || err);
          logGeminiAttempt({ // LOG TEMPORAL
            model, attemptDelModelo: attempt + 1, isFallbackModel,
            startedAt: attemptStartedAt, durationMs: Date.now() - attemptStartedAt,
            outcome: isTimeout ? 'timeout' : 'network_error', httpStatus: null, errorReason: lastErrText,
          });
          // Si lo que ha pasado es que este modelo ha agotado su propio
          // tiempo (no que haya dado un error rápido), reintentarlo con el
          // MISMO modelo no suele ayudar: si ya ha ido lento para este
          // tamaño de viaje, lo más probable es que vuelva a ir lento —
          // así que en vez de gastar otro tanto de tiempo en él, pasamos
          // directamente al siguiente modelo de la lista. Esto es lo que más
          // acortaba el peor caso (itinerarios que se quedaban "colgados"
          // varios minutos): antes se probaba el mismo modelo lento DOS
          // veces seguidas antes de cambiar.
          if (isTimeout) break;
          continue; // fallo rápido (de red, no de tiempo): sí vale la pena reintentar una vez más
        }
        clearTimeout(timeoutId);

        if (response.ok) {
          lastCallLogEntry = logGeminiAttempt({ // LOG TEMPORAL
            model, attemptDelModelo: attempt + 1, isFallbackModel,
            startedAt: attemptStartedAt, durationMs: Date.now() - attemptStartedAt,
            outcome: 'success', httpStatus: response.status, errorReason: null,
          });
          return response;
        }
        lastErrText = await response.text();
        logGeminiAttempt({ // LOG TEMPORAL
          model, attemptDelModelo: attempt + 1, isFallbackModel,
          startedAt: attemptStartedAt, durationMs: Date.now() - attemptStartedAt,
          outcome: 'http_error', httpStatus: response.status, errorReason: String(lastErrText).slice(0, 300),
        });
        if (response.status === 429) {
          // Cuota agotada para ESTE modelo: reintentarlo no serviría de nada,
          // así que rompemos el bucle de intentos y probamos el modelo
          // siguiente directamente (bucle exterior).
          break;
        }
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
    // LOG TEMPORAL: tokens de entrada/salida de la llamada que acaba de
    // responder ok (si Gemini los manda — vienen en "usageMetadata") y si
    // su JSON resultó válido o no, apuntados sobre la misma entrada del
    // registro que ya dejó callGemini() para esta llamada.
    if (lastCallLogEntry) {
      lastCallLogEntry.inputTokens = data.usageMetadata?.promptTokenCount ?? null;
      lastCallLogEntry.outputTokens = data.usageMetadata?.candidatesTokenCount ?? null;
    }
    const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    const itinerary = parseItineraryJson(rawText);
    if (!itinerary) {
      const finishReason = data.candidates?.[0]?.finishReason || 'desconocido';
      if (lastCallLogEntry) { // LOG TEMPORAL
        lastCallLogEntry.jsonValid = false;
        lastCallLogEntry.finishReason = finishReason;
      }
      // Log a los logs de Vercel (Deployments → función → Logs) para poder
      // diagnosticar de verdad si esto vuelve a pasar: qué motivo dio Gemini
      // y cómo era el texto que no se pudo interpretar como JSON.
      console.error('[generate-itinerary] JSON inválido. finishReason:', finishReason, '| primeros 500 chars:', rawText.slice(0, 500));
      throw new Error(`No se pudo interpretar el JSON de la IA (motivo: ${finishReason})`);
    }
    if (lastCallLogEntry) lastCallLogEntry.jsonValid = true; // LOG TEMPORAL
    return itinerary;
  }

  try {
    // ANTES esto reintentaba desde cero (recorriendo otra vez los modelos)
    // hasta 3 veces si el JSON venía mal formado — era la causa más grande
    // del peor caso de "varios minutos sin terminar". Con el responseSchema
    // ya forzando la forma del JSON, ese fallo es raro; y para el caso
    // normal (saturación puntual), callGemini() de arriba ya prueba solución
    // rápida (mismo modelo con una pequeña pausa) y modelos de reserva antes
    // de llegar aquí. Así que ahora se prueba UNA vez todo el proceso: si
    // falla, se para y se devuelve el error claro al momento — la app ya
    // tiene un botón de "Reintentar" para que el viajero lo repita con un
    // toque si quiere, en vez de que el servidor se quede intentándolo solo
    // varios minutos más sin decir nada.
    currentIntentoNumber = 1; // LOG TEMPORAL
    const itinerary = await generateOnce();
    // Si esto fallara (poco probable), es mejor dejar pasar igualmente el
    // itinerario que la persona ya ha recibido de verdad que fastidiarle el
    // resultado por un problema de contador — a lo sumo ese uso concreto no
    // se le descuenta del límite mensual.
    await consumeAiUsage(db, uid).catch((e) => {
      console.error('[generate-itinerary] No se pudo actualizar aiUsage:', e.message);
    });
    return res.status(200).json({ itinerary });

  } catch (err) {
    if (String(err.message || '').startsWith('No se pudo interpretar el JSON')) {
      return res.status(502).json({ error: 'La IA no devolvió el itinerario en el formato esperado. Prueba a generarlo otra vez.' });
    }
    if (/RESOURCE_EXHAUSTED|"code":\s*429/i.test(String(err.message || ''))) {
      return res.status(429).json({ error: 'Se ha agotado la cuota gratuita de la IA por ahora (o está muy saturada en este momento). Espera unos minutos y prueba otra vez; si sigue igual, inténtalo más tarde.' });
    }
    if (String(err.message || '') === 'TIEMPO_AGOTADO') {
      return res.status(504).json({ error: 'La IA está tardando mucho más de lo normal ahora mismo (probablemente muy saturada). Prueba otra vez en un rato, o con menos días de viaje mientras tanto.' });
    }
    return res.status(500).json({ error: err.message });
  } finally {
    logFinalSummary(); // LOG TEMPORAL — se ejecuta pase lo que pase (éxito o cualquiera de los errores de arriba), salvo que Vercel corte la función en seco por los 300s (ver el aviso en logFinalSummary).
  }
}
