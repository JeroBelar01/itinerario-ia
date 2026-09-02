// Función serverless de Vercel. Busca una foto de stock real (Pexels) para
// acompañar cada día del itinerario. La clave de Pexels se queda en el
// servidor, nunca llega al navegador del usuario.

import { initializeApp, cert, getApps, getApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';

// Mismo patrón y misma variable de entorno que ya usan generate-itinerary.js
// y send-push.js — no hace falta configurar nada nuevo en Vercel.
function getAdminApp() {
  if (getApps().length) return getApp();
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) throw new Error('Falta configurar FIREBASE_SERVICE_ACCOUNT en Vercel');
  const serviceAccount = JSON.parse(raw);
  return initializeApp({ credential: cert(serviceAccount) });
}

export default async function handler(req, res) {
  const apiKey = process.env.PEXELS_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'Falta configurar PEXELS_API_KEY en Vercel' });
  }

  // Antes cualquiera podía llamar a este endpoint sin ni siquiera tener
  // cuenta (ni la app instalada) y gastar de la cuota gratuita de Pexels
  // compartida por toda la app. Ahora, igual que en generate-itinerary.js y
  // send-push.js, hace falta haber iniciado sesión.
  const authHeader = req.headers.authorization || '';
  const idToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!idToken) {
    return res.status(401).json({ error: 'Hace falta iniciar sesión.' });
  }
  try {
    getAdminApp();
    await getAuth().verifyIdToken(idToken);
  } catch (e) {
    return res.status(401).json({ error: 'Tu sesión no es válida.' });
  }

  const query = (req.query.q || '').toString().trim().slice(0, 100);
  if (!query) {
    return res.status(400).json({ error: 'Falta el parámetro q (qué buscar)' });
  }

  // "orientation": las fotos de cada día del itinerario se enseñan en una
  // tarjeta apaisada (16:9), así que siguen pidiendo landscape por defecto;
  // la portada, en cambio, se enseña en tarjetas y cuadrículas más altas que
  // anchas, así que StepResult.js/communityPublish.js piden portrait para
  // esa. Cualquier otro valor raro se ignora y se usa landscape.
  const rawOrientation = (req.query.orientation || '').toString().trim().toLowerCase();
  const orientation = ['portrait', 'landscape', 'square'].includes(rawOrientation) ? rawOrientation : 'landscape';

  // "count": cuántas fotos candidatas devolver (no solo la más relevante).
  // Antes esto solo devolvía UNA foto por búsqueda, así que dos días con una
  // búsqueda parecida (o la propia portada) acababan enseñando la misma foto
  // — con varias candidatas, el que llama puede elegir la primera que no
  // haya usado ya dentro del mismo itinerario (ver lib/stockPhoto.js).
  // Tope de 10 para no pedirle a Pexels páginas enormes de golpe.
  const rawCount = parseInt(req.query.count, 10);
  const count = Number.isInteger(rawCount) && rawCount > 0 ? Math.min(rawCount, 10) : 1;

  // Si Pexels tarda demasiado en responder (o se queda colgado), no dejamos la
  // petición esperando para siempre: se aborta a los 6 segundos y devolvemos
  // "sin foto" enseguida, para que la app pueda seguir sin quedarse pillada.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6000);

  try {
    const url = `https://api.pexels.com/v1/search?query=${encodeURIComponent(query)}&per_page=${count}&orientation=${orientation}`;
    const response = await fetch(url, {
      headers: { Authorization: apiKey },
      signal: controller.signal
    });

    if (!response.ok) {
      return res.status(200).json({ urls: [], url: null });
    }

    const data = await response.json();
    const photos = Array.isArray(data.photos) ? data.photos : [];
    const urls = photos.map((p) => p?.src?.medium).filter(Boolean);

    return res.status(200).json({ urls, url: urls[0] || null });

  } catch (err) {
    // Devolvemos 200 con "sin fotos" (en vez de un error 500) para que el
    // navegador reciba siempre una respuesta válida y quite el aviso de
    // "Cargando foto…" sin tener que esperar a que la conexión falle sola.
    return res.status(200).json({ urls: [], url: null });
  } finally {
    clearTimeout(timer);
  }
}
