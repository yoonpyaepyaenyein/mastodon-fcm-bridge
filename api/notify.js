import ece from 'http_ece';
import { createECDH } from 'crypto';
import { getSubscription, deleteSubscription } from '../lib/db.js';
import { sendFcmNotification } from '../lib/firebase.js';

export const config = {
  api: { bodyParser: false },
};

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function fromUrlSafeBase64(str) {
  let s = str.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return Buffer.from(s, 'base64');
}

function parseHeaderParam(header, key) {
  if (!header) return null;
  const parts = header.split(';').map((p) => p.trim());
  for (const part of parts) {
    const [k, v] = part.split('=');
    if (k === key) return v;
  }
  return null;
}

function buildNotificationContent(notification) {
  const type = notification.type;
  const account = notification.account?.display_name || notification.account?.username || 'Someone';

  switch (type) {
    case 'mention':
      return { title: `${account} mentioned you`, body: stripHtml(notification.status?.content || '') };
    case 'favourite':
      return { title: `${account} favourited your post`, body: stripHtml(notification.status?.content || '') };
    case 'reblog':
      return { title: `${account} boosted your post`, body: stripHtml(notification.status?.content || '') };
    case 'follow':
      return { title: `${account} followed you`, body: '' };
    case 'follow_request':
      return { title: `${account} requested to follow you`, body: '' };
    case 'poll':
      return { title: 'A poll has ended', body: stripHtml(notification.status?.content || '') };
    case 'status':
      return { title: `${account} posted`, body: stripHtml(notification.status?.content || '') };
    default:
      return { title: 'New notification', body: '' };
  }
}

function stripHtml(html) {
  return html.replace(/<[^>]*>/g, '').slice(0, 200);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { id } = req.query;
  if (!id) {
    return res.status(400).json({ error: 'Missing subscription id' });
  }

  try {
    console.log('[notify] Subscription id:', id);
    const sub = await getSubscription(id);
    if (!sub) {
      console.warn('[notify] Subscription not found in KV');
      return res.status(404).json({ error: 'Subscription not found' });
    }
    console.log('[notify] Found sub. instance:', sub.mastodonInstance, 'has fcmToken:', !!sub.fcmToken);

    const rawBody = await readRawBody(req);
    console.log('[notify] Raw body length:', rawBody.length);

    const cryptoKeyHeader = req.headers['crypto-key'];
    const encryptionHeader = req.headers['encryption'];
    console.log('[notify] crypto-key header:', cryptoKeyHeader);
    console.log('[notify] encryption header:', encryptionHeader);

    const dh = parseHeaderParam(cryptoKeyHeader, 'dh');
    const salt = parseHeaderParam(encryptionHeader, 'salt');

    if (!dh || !salt) {
      console.warn('[notify] Missing dh or salt');
      return res.status(400).json({ error: 'Missing dh or salt headers' });
    }

    const ecdh = createECDH('prime256v1');
    ecdh.setPrivateKey(Buffer.from(sub.keys.privateKey, 'base64'));

    let decrypted;
    try {
      decrypted = ece.decrypt(rawBody, {
        version: 'aesgcm',
        privateKey: ecdh,
        authSecret: Buffer.from(sub.keys.auth, 'base64'),
        dh: dh,
        salt: salt,
      });
    } catch (decryptErr) {
      console.error('[notify] DECRYPT FAILED:', decryptErr.message);
      console.error('[notify] Stack:', decryptErr.stack);
      return res.status(500).json({ error: 'Decrypt failed', message: decryptErr.message });
    }
    console.log('[notify] Decrypted length:', decrypted.length);

    const pushPayload = JSON.parse(decrypted.toString('utf-8'));
    console.log('[notify] Push payload:', JSON.stringify(pushPayload));

    const notificationId = pushPayload.notification_id;
    const accessToken = pushPayload.access_token || sub.mastodonAccessToken;

    const notifResponse = await fetch(
      `${sub.mastodonInstance}/api/v1/notifications/${notificationId}`,
      {
        headers: { Authorization: `Bearer ${accessToken}` },
      }
    );

    if (!notifResponse.ok) {
      const errText = await notifResponse.text();
      console.error('[notify] Mastodon fetch failed:', notifResponse.status, errText);
      return res.status(502).json({
        error: 'Failed to fetch notification from Mastodon',
        status: notifResponse.status,
      });
    }

    const notification = await notifResponse.json();
    console.log('[notify] Notification type:', notification.type);
    const { title, body } = buildNotificationContent(notification);
    console.log('[notify] Sending FCM. Title:', title);

    const fcmResult = await sendFcmNotification(sub.fcmToken, title, body, {
      notification_id: notification.id,
      notification_type: notification.type,
      status_id: notification.status?.id || '',
      account_id: notification.account?.id || '',
    });

    if (!fcmResult.success && fcmResult.isInvalidToken) {
      console.warn('[notify] FCM token invalid, removing subscription');
      await deleteSubscription(id);
      return res.status(200).json({ message: 'Token invalid, subscription removed' });
    }

    if (!fcmResult.success) {
      console.error('[notify] FCM send failed:', fcmResult.error);
      return res.status(500).json({ error: 'FCM send failed', details: fcmResult.error });
    }

    console.log('[notify] FCM sent. messageId:', fcmResult.messageId);
    return res.status(200).json({ message: 'Notification sent', messageId: fcmResult.messageId });
  } catch (error) {
    console.error('[notify] UNCAUGHT ERROR:', error.message);
    console.error('[notify] Stack:', error.stack);
    return res.status(500).json({
      error: 'Internal server error',
      message: error.message,
    });
  }
}
