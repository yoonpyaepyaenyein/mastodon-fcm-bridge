import ece from 'http_ece';
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
    const sub = await getSubscription(id);
    if (!sub) {
      return res.status(404).json({ error: 'Subscription not found' });
    }

    const rawBody = await readRawBody(req);

    const cryptoKeyHeader = req.headers['crypto-key'];
    const encryptionHeader = req.headers['encryption'];

    const dh = parseHeaderParam(cryptoKeyHeader, 'dh');
    const salt = parseHeaderParam(encryptionHeader, 'salt');

    if (!dh || !salt) {
      return res.status(400).json({ error: 'Missing dh or salt headers' });
    }

    const decrypted = ece.decrypt(rawBody, {
      version: 'aesgcm',
      privateKey: Buffer.from(sub.keys.privateKey, 'base64'),
      dh: fromUrlSafeBase64(dh),
      salt: fromUrlSafeBase64(salt),
      authSecret: fromUrlSafeBase64(sub.keys.auth),
    });

    const pushPayload = JSON.parse(decrypted.toString('utf-8'));

    const notificationId = pushPayload.notification_id;
    const accessToken = pushPayload.access_token || sub.mastodonAccessToken;

    const notifResponse = await fetch(
      `${sub.mastodonInstance}/api/v1/notifications/${notificationId}`,
      {
        headers: { Authorization: `Bearer ${accessToken}` },
      }
    );

    if (!notifResponse.ok) {
      return res.status(502).json({
        error: 'Failed to fetch notification from Mastodon',
        status: notifResponse.status,
      });
    }

    const notification = await notifResponse.json();
    const { title, body } = buildNotificationContent(notification);

    const fcmResult = await sendFcmNotification(sub.fcmToken, title, body, {
      notification_id: notification.id,
      notification_type: notification.type,
      status_id: notification.status?.id || '',
      account_id: notification.account?.id || '',
    });

    if (!fcmResult.success && fcmResult.isInvalidToken) {
      await deleteSubscription(id);
      return res.status(200).json({ message: 'Token invalid, subscription removed' });
    }

    if (!fcmResult.success) {
      return res.status(500).json({ error: 'FCM send failed', details: fcmResult.error });
    }

    return res.status(200).json({ message: 'Notification sent', messageId: fcmResult.messageId });
  } catch (error) {
    return res.status(500).json({
      error: 'Internal server error',
      message: error.message,
    });
  }
}
