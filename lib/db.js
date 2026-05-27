import { kv } from '@vercel/kv';

const TTL_SECONDS = 60 * 60 * 24 * 30;

export async function saveSubscription(id, data) {
  await kv.set(id, data, { ex: TTL_SECONDS });
  const lookupKey = `sublookup:${data.fcmToken}:${data.mastodonInstance}`;
  await kv.set(lookupKey, id, { ex: TTL_SECONDS });
}

export async function getSubscription(id) {
  return await kv.get(id);
}

export async function findSubscriptionId(fcmToken, mastodonInstance) {
  const lookupKey = `sublookup:${fcmToken}:${mastodonInstance}`;
  return await kv.get(lookupKey);
}

export async function deleteSubscription(id) {
  const sub = await kv.get(id);
  if (sub) {
    const lookupKey = `sublookup:${sub.fcmToken}:${sub.mastodonInstance}`;
    await kv.del(lookupKey);
  }
  await kv.del(id);
}

// Atomic dedup check: returns true if this is the first time we've seen
// (fcmToken, notificationId) within the TTL window. Mastodon stores one
// push subscription per access token, so a user with multiple logins
// receives the same webhook multiple times — this collapses them to one
// FCM send per device. NX makes the SET succeed only if the key didn't
// exist, so this is race-safe across concurrent Vercel function instances.
const DEDUP_TTL_SECONDS = 60;
export async function claimNotificationDelivery(fcmToken, notificationId) {
  if (!fcmToken || !notificationId) return true;
  const key = `dedup:${fcmToken}:${notificationId}`;
  const result = await kv.set(key, 1, { ex: DEDUP_TTL_SECONDS, nx: true });
  return result === "OK";
}
