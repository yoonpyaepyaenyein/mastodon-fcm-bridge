import { getSubscription, deleteSubscription } from '../lib/db.js';

export default async function handler(req, res) {
  if (req.method !== 'POST' && req.method !== 'DELETE') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { subscriptionId } = req.body || {};

  if (!subscriptionId) {
    return res.status(400).json({ error: 'Missing subscriptionId' });
  }

  try {
    const sub = await getSubscription(subscriptionId);

    if (!sub) {
      return res.status(200).json({ message: 'Already unsubscribed' });
    }

    try {
      await fetch(`${sub.mastodonInstance}/api/v1/push/subscription`, {
        method: 'DELETE',
        headers: {
          Authorization: `Bearer ${sub.mastodonAccessToken}`,
        },
      });
    } catch (mastodonError) {
      console.warn('Failed to unregister from Mastodon:', mastodonError.message);
    }

    await deleteSubscription(subscriptionId);

    return res.status(200).json({ message: 'Unsubscribed successfully' });
  } catch (error) {
    return res.status(500).json({
      error: 'Internal server error',
      message: error.message,
    });
  }
}
