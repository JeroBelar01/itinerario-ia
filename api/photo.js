// Función serverless de Vercel. Busca una foto de stock real (Pexels) para
// acompañar cada día del itinerario. La clave de Pexels se queda en el
// servidor, nunca llega al navegador del usuario.

export default async function handler(req, res) {
  const apiKey = process.env.PEXELS_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'Falta configurar PEXELS_API_KEY en Vercel' });
  }

  const query = (req.query.q || '').toString().trim().slice(0, 100);
  if (!query) {
    return res.status(400).json({ error: 'Falta el parámetro q (qué buscar)' });
  }

  // Si Pexels tarda demasiado en responder (o se queda colgado), no dejamos la
  // petición esperando para siempre: se aborta a los 6 segundos y devolvemos
  // "sin foto" enseguida, para que la app pueda seguir sin quedarse pillada.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6000);

  try {
    const url = `https://api.pexels.com/v1/search?query=${encodeURIComponent(query)}&per_page=1&orientation=landscape`;
    const response = await fetch(url, {
      headers: { Authorization: apiKey },
      signal: controller.signal
    });

    if (!response.ok) {
      return res.status(200).json({ url: null });
    }

    const data = await response.json();
    const photo = data.photos?.[0];
    const url_img = photo?.src?.medium || null;

    return res.status(200).json({ url: url_img });

  } catch (err) {
    // Devolvemos 200 con url:null (en vez de un error 500) para que el navegador
    // reciba siempre una respuesta válida y quite el aviso de "Cargando foto…"
    // sin tener que esperar a que la conexión falle por su cuenta.
    return res.status(200).json({ url: null });
  } finally {
    clearTimeout(timer);
  }
}
