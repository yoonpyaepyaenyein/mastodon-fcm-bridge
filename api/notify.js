import ece from "http_ece";
import { createECDH } from "crypto";
import {
  getSubscription,
  deleteSubscription,
  claimNotificationDelivery,
} from "../lib/db.js";
import { sendFcmNotification } from "../lib/firebase.js";

export const config = {
  api: { bodyParser: false },
};

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function fromUrlSafeBase64(str) {
  let s = str.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  return Buffer.from(s, "base64");
}

function parseHeaderParam(header, key) {
  if (!header) return null;
  const parts = header.split(";").map((p) => p.trim());
  for (const part of parts) {
    const [k, v] = part.split("=");
    if (k === key) return v;
  }
  return null;
}

function buildNotificationContent(notification) {
  const type = notification.type;
  const account =
    notification.account?.display_name ||
    notification.account?.username ||
    "Someone";
  const statusContent = stripHtml(notification.status?.content || "");
  const isDirect = notification.status?.visibility === "direct";

  switch (type) {
    case "mention":
      if (isDirect) {
        return { title: `${account} sent you a message`, body: statusContent };
      }
      return { title: `${account} mentioned you`, body: statusContent };
    case "favourite":
      return { title: `${account} favourited your post`, body: statusContent };
    case "reblog":
      return { title: `${account} boosted your post`, body: statusContent };
    case "follow":
      return { title: `${account} followed you`, body: "" };
    case "follow_request":
      return { title: `${account} requested to follow you`, body: "" };
    case "poll":
      return { title: "A poll has ended", body: statusContent };
    case "status":
      return { title: `${account} posted`, body: statusContent };
    case "update":
      return { title: `${account} edited a post`, body: statusContent };
    default:
      return {
        title: `New notification from ${account}`,
        body: statusContent || type,
      };
  }
}

function stripHtml(html) {
  return html.replace(/<[^>]*>/g, "").slice(0, 200);
}

const PATCHWORK_NOTI_TYPES = new Set([
  "favourite",
  "mention",
  "follow",
  "reblog",
  "poll",
  "follow_request",
]);

async function isStrangerDM(
  notification,
  mastodonInstance,
  mastodonAccessToken,
) {
  if (
    notification.type !== "mention" ||
    notification.status?.visibility !== "direct"
  ) {
    return false;
  }

  const senderId = notification.account?.id;
  if (!senderId) return false;

  try {
    const relResp = await fetch(
      `${mastodonInstance}/api/v1/accounts/relationships?id[]=${senderId}`,
      { headers: { Authorization: `Bearer ${mastodonAccessToken}` } },
    );
    if (!relResp.ok) return false;
    const relationships = await relResp.json();
    const rel = Array.isArray(relationships) ? relationships[0] : null;
    return rel ? !rel.following : false;
  } catch (err) {
    console.warn("[notify] Relationship fetch failed:", err.message);
    return false;
  }
}

function buildPatchworkData(notification, isConversationRequest) {
  const type = notification.type;
  const noti_type = PATCHWORK_NOTI_TYPES.has(type) ? type : type;

  const status = notification.status;
  const visibility = status?.visibility || "public";

  let destination_id = "";
  let reblogged_id = "0";

  if (type === "follow" || type === "follow_request") {
    destination_id = notification.account?.id || "";
  } else if (type === "reblog") {
    destination_id = status?.reblog?.id || status?.id || "";
    reblogged_id = status?.id || "0";
  } else {
    destination_id = status?.id || "";
  }

  return {
    noti_type,
    visibility,
    destination_id,
    reblogged_id,
    conversation_request: isConversationRequest ? "true" : "false",
  };
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { id } = req.query;
  if (!id) {
    return res.status(400).json({ error: "Missing subscription id" });
  }

  try {
    console.log("[notify] Subscription id:", id);
    const sub = await getSubscription(id);
    if (!sub) {
      console.warn("[notify] Subscription not found in KV");
      return res.status(404).json({ error: "Subscription not found" });
    }
    console.log(
      "[notify] Found sub. instance:",
      sub.mastodonInstance,
      "has fcmToken:",
      !!sub.fcmToken,
    );

    const rawBody = await readRawBody(req);
    console.log("[notify] Raw body length:", rawBody.length);

    const cryptoKeyHeader = req.headers["crypto-key"];
    const encryptionHeader = req.headers["encryption"];
    console.log("[notify] crypto-key header:", cryptoKeyHeader);
    console.log("[notify] encryption header:", encryptionHeader);

    const dh = parseHeaderParam(cryptoKeyHeader, "dh");
    const salt = parseHeaderParam(encryptionHeader, "salt");

    if (!dh || !salt) {
      console.warn("[notify] Missing dh or salt");
      return res.status(400).json({ error: "Missing dh or salt headers" });
    }

    const ecdh = createECDH("prime256v1");
    ecdh.setPrivateKey(Buffer.from(sub.keys.privateKey, "base64"));

    let decrypted;
    try {
      decrypted = ece.decrypt(rawBody, {
        version: "aesgcm",
        privateKey: ecdh,
        authSecret: Buffer.from(sub.keys.auth, "base64"),
        dh: dh,
        salt: salt,
      });
    } catch (decryptErr) {
      console.error("[notify] DECRYPT FAILED:", decryptErr.message);
      console.error("[notify] Stack:", decryptErr.stack);
      return res
        .status(500)
        .json({ error: "Decrypt failed", message: decryptErr.message });
    }
    console.log("[notify] Decrypted length:", decrypted.length);

    const pushPayload = JSON.parse(decrypted.toString("utf-8"));
    console.log("[notify] Push payload:", JSON.stringify(pushPayload));

    const notificationId = pushPayload.notification_id;
    const incomingAccessToken = pushPayload.access_token;
    const accessToken = incomingAccessToken || sub.mastodonAccessToken;

    // Self-heal: Mastodon keeps a separate push subscription per access
    // token, so old logins leave behind orphan records that fire on every
    // notification. If this webhook came from a token we no longer track
    // as the user's current one, ask Mastodon to delete that subscription
    // and stop processing — the latest token's webhook will handle the
    // actual FCM send. Over a couple of mentions this cleans Mastodon's
    // database back to one subscription per user.
    if (
      incomingAccessToken &&
      sub.mastodonAccessToken &&
      incomingAccessToken !== sub.mastodonAccessToken
    ) {
      console.log(
        "[notify] Orphan subscription detected, requesting Mastodon to delete it",
      );
      try {
        const delRes = await fetch(
          `${sub.mastodonInstance}/api/v1/push/subscription`,
          {
            method: "DELETE",
            headers: { Authorization: `Bearer ${incomingAccessToken}` },
          },
        );
        console.log("[notify] Orphan delete status:", delRes.status);
      } catch (delErr) {
        console.warn("[notify] Orphan delete failed:", delErr.message);
      }
      return res
        .status(200)
        .json({ message: "Orphan subscription cleaned up" });
    }

    // Safety net: if Mastodon ever delivers the same notification twice
    // through the current subscription (network retry, etc.), collapse it.
    const isFirstDelivery = await claimNotificationDelivery(
      sub.fcmToken,
      notificationId,
    );
    if (!isFirstDelivery) {
      console.log(
        "[notify] Duplicate notification suppressed:",
        notificationId,
      );
      return res
        .status(200)
        .json({ message: "Duplicate notification suppressed" });
    }

    const notifResponse = await fetch(
      `${sub.mastodonInstance}/api/v1/notifications/${notificationId}`,
      {
        headers: { Authorization: `Bearer ${accessToken}` },
      },
    );

    if (!notifResponse.ok) {
      const errText = await notifResponse.text();
      console.error(
        "[notify] Mastodon fetch failed:",
        notifResponse.status,
        errText,
      );
      return res.status(502).json({
        error: "Failed to fetch notification from Mastodon",
        status: notifResponse.status,
      });
    }

    const notification = await notifResponse.json();
    console.log("[notify] Notification type:", notification.type);
    const { title, body } = buildNotificationContent(notification);

    const isConversationRequest = await isStrangerDM(
      notification,
      sub.mastodonInstance,
      accessToken,
    );
    const patchworkData = buildPatchworkData(
      notification,
      isConversationRequest,
    );
    console.log("[notify] Sending FCM. Title:", title, "data:", patchworkData);

    const fcmResult = await sendFcmNotification(
      sub.fcmToken,
      title,
      body,
      patchworkData,
    );

    if (!fcmResult.success && fcmResult.isInvalidToken) {
      console.warn("[notify] FCM token invalid, removing subscription");
      await deleteSubscription(id);
      return res
        .status(200)
        .json({ message: "Token invalid, subscription removed" });
    }

    if (!fcmResult.success) {
      console.error("[notify] FCM send failed:", fcmResult.error);
      return res
        .status(500)
        .json({ error: "FCM send failed", details: fcmResult.error });
    }

    console.log("[notify] FCM sent. messageId:", fcmResult.messageId);
    return res
      .status(200)
      .json({ message: "Notification sent", messageId: fcmResult.messageId });
  } catch (error) {
    console.error("[notify] UNCAUGHT ERROR:", error.message);
    console.error("[notify] Stack:", error.stack);
    return res.status(500).json({
      error: "Internal server error",
      message: error.message,
    });
  }
}
