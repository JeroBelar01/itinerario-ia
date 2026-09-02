// Función serverless de Vercel: manda una notificación push al móvil (a través de
// Firebase Cloud Messaging) cuando a alguien le llega un "me gusta", un comentario,
// un mensaje de chat o una solicitud de seguimiento. Se ejecuta en el servidor,
// nunca en el navegador, porque usa una clave de administrador de Firebase que
// nunca debe estar en el código del cliente.

import { initializeApp, cert, getApps, getApp } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { getMessaging } from 'firebase-admin/messaging';
import { getAuth } from 'firebase-admin/auth';

function getAdminApp() {
  if (getApps().length) return getApp();
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) throw new Error('Falta configurar FIREBASE_SERVICE_ACCOUNT en Vercel');
  const serviceAccount = JSON.parse(raw);
  return initializeApp({ credential: cert(serviceAccount) });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método no permitido' });
  }

  // Antes esta función no comprobaba quién la llamaba: cualquiera que
  // supiera (o adivinara) el uid de otra persona podía mandarle una
  // notificación push con el título y el texto que quisiera, sin tener
  // siquiera una cuenta. Ahora hace falta haber iniciado sesión, igual que en
  // api/generate-itinerary.js.
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

  const { toUid, title, body, data, image } = req.body || {};
  if (!toUid || !title) {
    return res.status(400).json({ error: 'Faltan datos (toUid y title son obligatorios)' });
  }
  // Recorta el texto por si acaso, para que no se pueda mandar un "spam" de
  // texto gigante en una sola notificación.
  const safeTitle = String(title).slice(0, 100);
  const safeBody = body ? String(body).slice(0, 300) : '';

  try {
    const db = getFirestore();

    const userDoc = await db.collection('users').doc(toUid).get();
    const tokens = (userDoc.exists && userDoc.data().fcmTokens) || [];
    if (!tokens.length) {
      // Esta persona no tiene la app nativa instalada (o no ha aceptado las
      // notificaciones todavía): no hay nada que enviar, y no es un error.
      return res.status(200).json({ sent: 0 });
    }

    // FCM exige que todos los valores de "data" sean texto.
    const stringData = {};
    Object.entries(data || {}).forEach(([k, v]) => { stringData[k] = String(v); });

    const response = await getMessaging().sendEachForMulticast({
      tokens,
      notification: {
        title: safeTitle,
        body: safeBody,
        ...(image ? { imageUrl: image } : {})
      },
      data: stringData,
      android: { priority: 'high' }
    });

    // Limpia los tokens caducados o desinstalados para no acumular basura ni
    // reintentar en vano la próxima vez.
    const invalidTokens = [];
    response.responses.forEach((r, i) => {
      const code = r.error && r.error.code;
      if (!r.success && (code === 'messaging/invalid-registration-token' || code === 'messaging/registration-token-not-registered')) {
        invalidTokens.push(tokens[i]);
      }
    });
    if (invalidTokens.length) {
      await db.collection('users').doc(toUid).update({
        fcmTokens: FieldValue.arrayRemove(...invalidTokens)
      });
    }

    return res.status(200).json({ sent: response.successCount });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
