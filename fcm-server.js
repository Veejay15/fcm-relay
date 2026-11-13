const express = require('express');
const admin = require('firebase-admin');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

// Initialize Firebase Admin SDK.
// In the cloud (Render), the key is provided via the FIREBASE_SERVICE_ACCOUNT
// environment variable so the secret never lives in the Git repo.
// Locally, it falls back to the serviceAccountKey.json file.
const serviceAccount = process.env.FIREBASE_SERVICE_ACCOUNT
  ? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
  : require('./serviceAccountKey.json');

try {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: 'https://remotenotifications-8f06f-default-rtdb.firebaseio.com'
  });
  console.log('✅ Firebase initialized');
} catch (e) {
  console.error('❌ Firebase init error:', e.message);
}

const db = admin.database();

// Catch unhandled errors
process.on('uncaughtException', (error) => {
  console.error('❌ UNCAUGHT ERROR:', error.message);
  console.error(error.stack);
});

// Shared logic: send an FCM push to a device, with a database-write fallback.
async function sendToDevice(deviceId, type = 'couple') {
  const tokenSnapshot = await db.ref(`fcmTokens/${deviceId}`).get();
  const fcmToken = tokenSnapshot.val();

  // Always write to database as fallback (reaches the app only while it is running).
  await db.ref(`remoteSchedule/${deviceId}`).set('trigger');

  let fcmError = null;

  if (fcmToken) {
    try {
      // Data-only messages default to normal priority, which Android defers while
      // the device is dozing or the app is in standby - exactly the closed-app case.
      // A TTL keeps a stale push from landing hours later.
      const messageId = await admin.messaging().send({
        token: fcmToken,
        data: { type: type, deviceId: deviceId },
        android: { priority: 'high', ttl: 60 * 1000 }
      });
      console.log(`✅ FCM sent to ${deviceId} (${messageId})`);
      return { success: true, method: 'FCM', messageId };
    } catch (err) {
      fcmError = (err.errorInfo && err.errorInfo.code) || err.code || err.message;
      console.error(`⚠️ FCM error for ${deviceId}:`, fcmError, '-', err.message);

      // A token FCM has retired will never work again; drop it so the next app
      // launch re-registers instead of this failing silently forever.
      if (fcmError === 'messaging/registration-token-not-registered') {
        await db.ref(`fcmTokens/${deviceId}`).remove();
        console.log(`🗑️ Removed dead token for ${deviceId}`);
      }
    }
  } else {
    fcmError = 'no-token-stored';
    console.warn(`⚠️ No FCM token stored for ${deviceId}`);
  }

  console.log(`📝 Database trigger for ${deviceId}`);
  return { success: true, method: 'database', fcmError };
}

// Phone-to-phone: a phone writes to triggerRequests/{deviceId} and this listener
// sends the FCM push, then clears the request. No HTTP from the phone needed.
db.ref('triggerRequests').on('child_added', async (snapshot) => {
  const deviceId = snapshot.key;
  const req = snapshot.val() || {};
  const type = req.type || 'couple';
  console.log(`📨 Trigger request for ${deviceId} (type: ${type})`);
  try {
    await sendToDevice(deviceId, type);
  } catch (e) {
    console.error(`❌ Failed to process trigger for ${deviceId}:`, e.message);
  } finally {
    // Remove so the same request isn't re-fired and future writes re-trigger.
    await snapshot.ref.remove();
  }
});

// Endpoint to send FCM notification (desktop-triggered)
app.post('/api/send-notification', async (req, res) => {
  try {
    const { deviceId, type = 'couple' } = req.body;

    if (!deviceId) {
      return res.status(400).json({ error: 'Device ID is required' });
    }

    const result = await sendToDevice(deviceId, type);
    res.json({ ...result, deviceId });

  } catch (error) {
    console.error('❌ Error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Test endpoint
app.post('/api/test', (req, res) => {
  console.log('🔥 TEST ENDPOINT HIT!');
  res.json({ success: true, message: 'Server is receiving requests!' });
});

// Health check endpoint
app.get('/health', (req, res) => {
  console.log('✅ Health check');
  res.json({ status: 'Server is running' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`FCM Server running on http://localhost:${PORT}`);
  console.log('Make sure serviceAccountKey.json is in the same folder as this file');
});
