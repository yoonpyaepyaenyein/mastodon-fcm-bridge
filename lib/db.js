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
