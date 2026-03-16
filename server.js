{ const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

const GHL_API_KEY = process.env.GHL_API_KEY;
const GHL_LOCATION_ID = process.env.GHL_LOCATION_ID;

/* =====================================================
   ✅ VAPI WEBHOOK ENDPOINT
===================================================== */

app.post("/vapi-webhook", async (req, res) => {
  console.log("✅ Webhook received from Vapi");

  // ✅ RESPOND IMMEDIATELY (prevents 20s timeout)
  res.status(200).json({ received: true });

  // ✅ PROCESS IN BACKGROUND
  try {
    const body = req.body;

    console.log("📦 Incoming payload:", JSON.stringify(body, null, 2));

    if (body.message?.type !== "end-of-call-report") {
      console.log("ℹ️ Not an end-of-call-report event");
      return;
    }

    const success =
      body.message.analysis?.successEvaluation === "true";

    if (success) {
      console.log("✅ Appointment was created. No SMS needed.");
      return;
    }

    const phone = body.message.call?.customer?.number;

    if (!phone) {
      console.log("❌ No phone number found in payload.");
      return;
    }

    console.log("⚠️ No appointment created. Sending follow-up SMS to:", phone);

    await sendFollowUpSMS(phone);

  } catch (error) {
    console.error("❌ Error processing webhook:", error.message);
  }
});

/* =====================================================
   ✅ SEND FOLLOW-UP SMS VIA GHL
===================================================== */

async function sendFollowUpSMS(phone) {
  try {
    // 1️⃣ Search for contact in GHL
    const contactResponse = await axios.get(
      "https://services.leadconnectorhq.com/contacts/search/duplicate",
      {
        headers: {
          Authorization: `Bearer ${GHL_API_KEY}`,
          Version: "2021-07-28",
        },
        params: {
          locationId: GHL_LOCATION_ID,
          number: phone,
        },
      }
    );

    let contactId;

    if (contactResponse.data.contact) {
      contactId = contactResponse.data.contact.id;
      console.log("✅ Contact found:", contactId);
    } else {
      console.log("⚠️ Contact not found. SMS not sent.");
      return;
    }

    // 2️⃣ Send SMS
    await axios.post(
      "https://services.leadconnectorhq.com/conversations/messages",
      {
        type: "SMS",
        contactId: contactId,
        message:
          "Hi 👋 It looks like the call ended before your appointment was booked. You can schedule here: https://YOUR_BOOKING_LINK.com",
      },
      {
        headers: {
          Authorization: `Bearer ${GHL_API_KEY}`,
          Version: "2021-07-28",
          "Content-Type": "application/json",
        },
      }
    );

    console.log("✅ SMS sent successfully");

  } catch (error) {
    console.error(
      "❌ Error sending SMS:",
      error.response?.data || error.message
    );
  }
}

/* =====================================================
   ✅ START SERVER
===================================================== */

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
