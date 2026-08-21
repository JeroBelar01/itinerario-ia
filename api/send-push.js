// Función serverless de Vercel: manda una notificación push al móvil (a través de
// Firebase Cloud Messaging) cuando a alguien le llega un "me gusta", un comentario,
// un mensaje de chat o una solicitud de seguimiento. Se ejecuta en el servidor,
// nunca en el navegador, porque usa una clave de administrador de Firebase que
// nunca debe estar en el código del cliente.

import { initializeApp, cert, getApps, getApp } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { getMessaging } from 'firebase-admin/messaging';

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

  const { toUid, title, body, data, image } = req.body || {};
  if (!toUid || !title) {
    return res.status(400).json({ error: 'Faltan datos (toUid y title son obligatorios)' });
  }

  try {
    getAdminApp();
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
        title,
        body: body || '',
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
