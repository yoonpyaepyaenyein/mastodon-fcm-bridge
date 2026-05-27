import crypto from 'crypto';
import { randomUUID } from 'crypto';
import {
  saveSubscription,
  findSubscriptionId,
  getSubscription,
} from '../lib/db.js';

function toUrlSafeBase64(buffer) {
  return buffer
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function generateVapidKeys() {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  const publicKey = ecdh.getPublicKey();
  const privateKey = ecdh.getPrivateKey();
  const authSecret = crypto.randomBytes(16);

  return {
    publicKey: toUrlSafeBase64(publicKey),
    privateKey: privateKey.toString('base64'),
    authSecret: toUrlSafeBase64(authSecret),
    authSecretRaw: authSecret.toString('base64'),
  };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { fcmToken, mastodonInstance, mastodonAccessToken } = req.body || {};

  if (!fcmToken || !mastodonInstance || !mastodonAccessToken) {
    return res.status(400).json({
      error: 'Missing required fields: fcmToken, mastodonInstance, mastodonAccessToken',
    });
  }

  const normalizedInstance = mastodonInstance.replace(/\/$/, '');

  try {
    const existingId = await findSubscriptionId(fcmToken, normalizedInstance);
    if (existingId) {
      const existing = await getSubscription(existingId);
      if (existing) {
        return res.status(200).json({
          subscriptionId: existingId,
          message: 'Already subscribed',
        });
      }
    }

    const subscriptionId = randomUUID();
    const keys = generateVapidKeys();

    const bridgeBaseUrl = process.env.BRIDGE_BASE_URL;
    if (!bridgeBaseUrl) {
      return res.status(500).json({ error: 'BRIDGE_BASE_URL not configured' });
    }

    const webhookEndpoint = `${bridgeBaseUrl}/api/notify?id=${subscriptionId}`;

    const mastodonResponse = await fetch(
      `${normalizedInstance}/api/v1/push/subscription`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${mastodonAccessToken}`,
        },
        body: JSON.stringify({
          subscription: {
            endpoint: webhookEndpoint,
            keys: {
              p256dh: keys.publicKey,
              auth: keys.authSecret,
            },
          },
          data: {
            alerts: {
              follow: true,
              favourite: true,
              reblog: true,
              mention: true,
              poll: true,
              status: true,
              follow_request: true,
              update: true,
            },
            policy: 'all',
          },
        }),
      }
    );

    if (!mastodonResponse.ok) {
      const errorText = await mastodonResponse.text();
      return res.status(mastodonResponse.status).json({
        error: 'Failed to register with Mastodon',
        details: errorText,
      });
    }

    // Mastodon 4.3+: disable notification filtering so DMs/mentions from
    // strangers trigger push (otherwise they land silently in the request
    // inbox). Failure here must not break subscribe — older instances
    // don't expose this endpoint.
    try {
      const policyRes = await fetch(
        `${normalizedInstance}/api/v1/notifications/policy`,
        {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${mastodonAccessToken}`,
          },
          body: JSON.stringify({
            for_not_following: 'accept',
            for_not_followers: 'accept',
            for_new_accounts: 'accept',
            for_private_mentions: 'accept',
            for_limited_accounts: 'accept',
          }),
        }
      );
      if (!policyRes.ok) {
        console.warn('[subscribe] policy update failed:', policyRes.status, await policyRes.text());
      } else {
        console.log('[subscribe] notification policy set to accept-all');
      }
    } catch (policyErr) {
      console.warn('[subscribe] policy update error:', policyErr.message);
    }

    await saveSubscription(subscriptionId, {
      fcmToken,
      mastodonInstance: normalizedInstance,
      mastodonAccessToken,
      keys: {
        privateKey: keys.privateKey,
        auth: keys.authSecretRaw,
      },
      createdAt: new Date().toISOString(),
    });

    return res.status(200).json({
      subscriptionId,
      message: 'Subscription created successfully',
    });
  } catch (error) {
    return res.status(500).json({
      error: 'Internal server error',
      message: error.message,
    });
  }
}
