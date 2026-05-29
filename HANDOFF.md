# Mastodon → FCM Push Bridge — Handoff Document

> Context handoff for continuing work in Codex. This captures the full
> history, current state, what works, what's broken, and the open decisions.

## Project Paths
- **Bridge server**: `/Users/yppn/Desktop/BL/xemele-push-bridge/`
- **Mobile app**: `/Users/yppn/Desktop/BL/xemele-social-app/`
- **Bridge deployed at**: https://mastodon-fcm-bridge-six.vercel.app
- **GitHub**: https://github.com/yoonpyaepyaenyein/mastodon-fcm-bridge
- **Vercel project**: `mastodon-fcm-bridge` (Yoon Pyae's personal Hobby account)
- **Firebase project**: `ibram-museus` (production, Sender ID 287198422158)
- **Database**: Upstash Redis (Vercel KV), env var `KV_*` / `REDIS_URL`

## What This Is
A bridge so users who log into the mobile app via a **foreign Mastodon
instance** (not the app's own Ibram Museus / xemele instance) still get push
notifications. Mastodon uses Web Push (VAPID); mobile needs FCM/APNs. The
bridge translates one to the other.

- Own-instance login (xemele.social / Ibram Museus, Patchwork backend) →
  uses Patchwork's native FCM, **no bridge involved**.
- Foreign-instance login (Mastodon Login button → findout.media,
  csidnet.channel.org, qlub.social, etc.) → **uses the bridge**.

## Architecture
```
App (Mastodon Login) → POST /api/subscribe (fcmToken, instance, accessToken)
   → bridge generates VAPID keypair, stores in KV, registers webhook w/ Mastodon
Foreign Mastodon → POST /api/notify?id=<subId> (encrypted Web Push)
   → bridge decrypts, fetches full notification, sends FCM
App logout → removeAccount() → POST /api/unsubscribe
```

## Bridge Files
- `api/subscribe.js` — register device. Reuses subscriptionId+VAPID keys per
  (fcmToken, instance). Pre-deletes old Mastodon subscription before POST.
- `api/unsubscribe.js` — delete subscription (Mastodon + KV).
- `api/notify.js` — webhook receiver. Decrypts (http_ece + ECDH), fetches
  notification, builds Patchwork-format FCM data, sends via firebase-admin.
- `lib/db.js` — KV helpers + `claimNotificationDelivery(fcmToken, notifId)`
  dedup (SET NX, 60s TTL).
- `lib/firebase.js` — Firebase Admin init + `sendFcmNotification`. Sends
  hybrid message (notification + data + android.priority:high + apns headers).

## Mobile App Files Changed
- `src/services/pushBridge.service.ts` — NEW. `subscribeToPushBridge`,
  `unsubscribeFromPushBridge`. BRIDGE_BASE_URL defaults to deployed URL.
- `src/util/storage.ts` — added `bridgeSubscriptionId?: string` to AuthState;
  `removeAccount()` calls unsubscribe before deleting.
- `src/components/organisms/login/MastodonServerInstanceForm/MastodonServerInstanceForm.tsx`
  — iOS OAuth success: bridge subscribe.
- `src/screens/MastodonSignInWebView/MastodonSignInWebView.tsx`
  — Android WebView OAuth success: bridge subscribe. (Android uses this path,
  iOS uses MastodonServerInstanceForm via InAppBrowser.)

### Relevant App Notification Code (read-only, NOT changed)
- `src/util/helper/firebase.ts`:
  - `listenMessage()` = `messaging().onMessage(...)` — FOREGROUND only.
    Calls `checkIsConversationNoti`, `handleIncommingMessage`, `showNotification`.
  - `showNotification()` = `notifee.displayNotification(...)`.
- `src/navigators/Application.tsx`:
  - `setBackgroundMessageHandler(async _ => { onSetNotifcationCount(); })`
    — BACKGROUND handler only bumps count, does NOT call notifee. So in
    background, the OS auto-displays from the FCM `notification` block.
  - `notifee.onForegroundEvent` handles taps (PRESS) → routes by noti_type /
    conversation_request.
- `src/util/helper/conversation.ts`:
  - `checkIsConversationNoti` = `(noti_type=='mention' && visibility=='direct')
    || conversation_request==='true'`.

## FCM Data Format (Patchwork-compatible) — what notify.js sends
```
{
  noti_type: 'mention'|'follow'|'reblog'|'favourite'|'poll'|'follow_request',
  visibility: 'public'|'unlisted'|'private'|'direct',
  conversation_request: 'true'|'false',  // 'true' = stranger DM / message request
  destination_id: <status id, or account id for follow, or reblog target>,
  reblogged_id: <status id for reblog, else '0'>,
}
```

## ✅ What Works (verified via Vercel logs + device)
- iOS + Android notifications: follow, mention, reblog, favourite, poll.
- DM (direct visibility) notifications.
- conversation_request detection via `/api/v1/notifications/requests`
  (source of truth — Mastodon itself decides what's filtered).
  Logs confirm: `conversation request check ... -> true`, FCM sent with
  `conversation_request: 'true'`.
- Subscribe / unsubscribe.
- APNs headers for iOS delivery (apns-push-type: alert, apns-priority: 10).
- Duplicate (3x) notifications FIXED via pre-delete + per-device dedup.

## ❌ Two Open Problems (BOTH confirmed app-side / Mastodon-limitation,
## NOT bridge code — bridge sends correct FCM with 200 in all cases)

### Problem 1: Multi-device — only 1 of 2 phones gets the notification
- **Baseline**: Normal (Ibram) login → BOTH phones get noti. Bridge login →
  only 1 phone.
- **Key evidence**: With 2 phones logged into the SAME foreign account, a
  single mention produces only **1 webhook** to /api/notify (not 2).
- **Root cause (confirmed via Mastodon docs)**: "Each access token can have
  one push subscription. If you create a new subscription, the old one is
  deleted." Two devices on the same account get notifications ONLY IF they
  have DIFFERENT access tokens. Since only 1 webhook fires, the two phones
  must be sharing ONE access_token (or the 2nd login's subscribe POST
  replaced the 1st device's subscription on Mastodon).
- **Suspected contributing factor**: app reuses/share the Mastodon
  access_token across devices for the same account, OR bridge's pre-delete +
  Mastodon's "one-sub-per-token" means device B's subscribe kicks device A.
- **NOT YET fixed.** Likely needs app-side: ensure each device obtains its
  OWN Mastodon access_token (separate OAuth), so Mastodon keeps a separate
  push subscription per device. OR accept as Mastodon limitation.
- **NEXT STEP**: Confirm in the app whether 2 devices on the same foreign
  account share the same `mastodonAccessToken`. Check how Mastodon OAuth
  token is obtained/stored per device in the app (MastodonSignInWebView /
  authorizeInstance mutation, useAuthStore.mastodon.token, multi-account
  storage). Patchwork (normal login) works for multi-device because it
  likely keys push on fcmToken (per-device), not access_token.

### Problem 2: Message request (filter mode) — noti not received on bridge login
- **Baseline**: Normal (Ibram) login → filter-mode message request noti IS
  received. Bridge login → NOT received.
- **Evidence**: Bridge logs show FCM sent 200 with conversation_request:'true'.
  But phone shows nothing.
- **Test condition when it failed**: app was in **FOREGROUND**.
- When recipient policy = Accept (not filter) → noti received fine on bridge.
- When recipient policy = Filter → message request → noti not shown.
- **Root cause (suspected, app-side)**: In foreground, `onMessage` →
  `checkIsConversationNoti` returns true (conversation_request==='true') →
  `handleIncommingMessage` → then `if (isConversationRequest) showNotification`.
  Need to verify why showNotification doesn't display, OR whether the issue is
  only in foreground vs background.
- **NOT YET fixed.**
- **NEXT STEP**: Debug app-side `firebase.ts` onMessage path for a message
  request (conversation_request==='true') in foreground AND background. Compare
  the exact remoteMessage shape Patchwork sends vs what the bridge sends for a
  message request. The data payloads should match the Patchwork format above.

## Git History (bridge repo, most recent first)
```
(uncommitted) Removed self-heal block from notify.js; simplified dedup comment
76db23f Use /notifications/requests as source of truth for conversation_request
e0989a9 Self-heal orphan Mastodon subscriptions on webhook + keep dedup  [REVERTED in working tree]
626ff8c Pre-delete Mastodon push subscription to prevent duplicate webhooks
6d29fdd Use Patchwork FCM data format + stranger DM detection; clean up subscribe logs
e3941c6 fix: use boolean format for notification policy (Mastodon API actual format)
0fc4ac6 fix: refresh Mastodon push subscription + access token on every subscribe
a0c1c4e diag: log instance version + policy GET/PUT response bodies
f604f05 feat: set notification policy to accept-all to bypass Mastodon 4.3+ filtering
21142c6 feat: support DM (direct visibility) + update type + better fallback
45645ca fix(ios): add APNs headers for iOS 13+ delivery
```

## ⚠️ Uncommitted Change in Working Tree
`api/notify.js` — the **self-heal orphan-deletion block was REMOVED** (it was
breaking multi-device by deleting other devices' subscriptions when access
tokens differed). Kept per-device dedup keyed on (fcmToken, notificationId).
**This change is NOT yet committed or deployed.** Need to:
```
git add . && git commit -m "Remove self-heal orphan deletion (broke multi-device); keep per-device dedup" && git push
```
Then re-test multi-device (should still only fix if access tokens differ per
device — see Problem 1).

## Key Decisions Made
- Tech: Node serverless on Vercel, Upstash Redis (KV), firebase-admin, http_ece.
- conversation_request: use `/api/v1/notifications/requests` (Mastodon's own
  filtered list) — NOT relationship guessing. Mastodon source `notify_service.rb`
  checks `!recipient.following?(sender)` AND `!response_to_recipient?` AND
  NotificationPermission — too complex to replicate, so we query the requests
  inbox directly.
- Dedup keyed on (fcmToken, notificationId) so multi-device (different fcm
  tokens) each get one; same-device duplicates collapse.

## Important Gotchas Learned
- VAPID decrypt: must pass an ECDH OBJECT (createECDH + setPrivateKey) as
  `privateKey` to http_ece, NOT a raw Buffer. dh/salt passed as base64 strings.
- Firebase SenderId mismatch: bridge's service account MUST be the SAME
  Firebase project (`ibram-museus`) that issued the app's FCM tokens. A
  personal test Firebase project causes "SenderId mismatch" and FCM rejects.
- Mastodon stores one push subscription PER ACCESS TOKEN; new subscribe POST
  deletes the old one for that token.
- Background message handler does NOT call notifee.displayNotification — OS
  auto-displays from FCM `notification` block in background.

## Suggested Next Steps in Codex
1. Commit + deploy the self-heal removal (working tree change above).
2. Problem 1: Inspect app OAuth — does each device get a distinct Mastodon
   access_token for the same foreign account? If shared → fix app to get
   per-device tokens, OR document as limitation.
3. Problem 2: Debug app foreground/background handling of a
   conversation_request:'true' message; compare Patchwork vs bridge payload.
4. Consider cleaning up verbose `console.log` in notify.js / subscribe.js
   before final release.
5. When ready for other projects (e.g. Jacobin): fork bridge, new Vercel +
   Upstash + that project's Firebase service account; copy
   pushBridge.service.ts into the app and wire subscribe/unsubscribe.
