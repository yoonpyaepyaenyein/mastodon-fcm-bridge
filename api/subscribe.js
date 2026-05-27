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
    // Reuse subscriptionId + VAPID keys if we've subscribed for this
    // fcmToken+instance before, so the webhook URL & decryption keys stay
    // stable. But we always re-POST to Mastodon below to refresh the
    // push subscription (old access token may be revoked after logout).
    let subscriptionId;
    let keys;
    const existingId = await findSubscriptionId(fcmToken, normalizedInstance);
    if (existingId) {
      const existing = await getSubscription(existingId);
      if (existing && existing.keys?.privateKey && existing.keys?.auth) {
        subscriptionId = existingId;
        // Reuse existing private key + auth secret. Derive publicKey from
        // private key (needed to send to Mastodon as p256dh).
        const ecdh = crypto.createECDH('prime256v1');
        ecdh.setPrivateKey(Buffer.from(existing.keys.privateKey, 'base64'));
        const publicKey = ecdh.getPublicKey();
        keys = {
          publicKey: toUrlSafeBase64(publicKey),
          privateKey: existing.keys.privateKey,
          authSecret: toUrlSafeBase64(Buffer.from(existing.keys.auth, 'base64')),
          authSecretRaw: existing.keys.auth,
        };
        console.log('[subscribe] reusing existing subscription:', subscriptionId);
      }
    }

    if (!subscriptionId) {
      subscriptionId = randomUUID();
      keys = generateVapidKeys();
      console.log('[subscribe] creating new subscription:', subscriptionId);
    }

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

    // Diagnostic: log instance version to identify Mastodon vs Patchwork fork
    try {
      const instRes = await fetch(`${normalizedInstance}/api/v2/instance`);
      if (instRes.ok) {
        const inst = await instRes.json();
        console.log('[subscribe] instance:', normalizedInstance, 'version:', inst.version, 'source_url:', inst.source_url);
      } else {
        console.log('[subscribe] instance v2 fetch failed:', instRes.status);
      }
    } catch (e) {
      console.log('[subscribe] instance fetch error:', e.message);
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
      const policyBody = await policyRes.text();
      if (!policyRes.ok) {
        console.warn('[subscribe] policy update failed:', policyRes.status, policyBody);
      } else {
        console.log('[subscribe] policy PUT response:', policyBody);
      }

      // Verify what the server actually saved
      const verifyRes = await fetch(
        `${normalizedInstance}/api/v1/notifications/policy`,
        { headers: { Authorization: `Bearer ${mastodonAccessToken}` } }
      );
      const verifyBody = await verifyRes.text();
      console.log('[subscribe] policy GET verify:', verifyRes.status, verifyBody);
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
