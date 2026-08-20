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

  try {
    const url = `https://api.pexels.com/v1/search?query=${encodeURIComponent(query)}&per_page=1&orientation=landscape`;
    const response = await fetch(url, {
      headers: { Authorization: apiKey }
    });

    if (!response.ok) {
      return res.status(502).json({ error: 'Error de la API de Pexels' });
    }

    const data = await response.json();
    const photo = data.photos?.[0];
    const url_img = photo?.src?.medium || null;

    return res.status(200).json({ url: url_img });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
