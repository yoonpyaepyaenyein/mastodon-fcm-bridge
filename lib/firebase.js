import admin from "firebase-admin";

let app;

function getApp() {
  if (app) return app;

  const base64 = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64;
  if (!base64) {
    throw new Error("FIREBASE_SERVICE_ACCOUNT_BASE64 env var is not set");
  }

  const serviceAccount = JSON.parse(
    Buffer.from(base64, "base64").toString("utf-8"),
  );

  app = admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });

  return app;
}

export async function sendFcmNotification(fcmToken, title, body, data = {}) {
  const messaging = admin.messaging(getApp());

  const message = {
    notification: { title, body },
    token: fcmToken,
    data: Object.fromEntries(
      Object.entries(data).map(([k, v]) => [k, String(v ?? "")]),
    ),
    android: {
      priority: "high",
      notification: { sound: "default" },
    },
    apns: {
      headers: {
        "apns-push-type": "alert",
        "apns-priority": "10",
      },
      payload: {
        aps: {
          alert: { title, body },
          sound: "default",
          badge: 1,
          "mutable-content": 1,
        },
      },
    },
  };

  try {
    const result = await messaging.send(message);
    return { success: true, messageId: result };
  } catch (error) {
    const isInvalidToken =
      error.code === "messaging/registration-token-not-registered" ||
      error.code === "messaging/invalid-registration-token";
    return { success: false, error: error.message, isInvalidToken };
  }
}
