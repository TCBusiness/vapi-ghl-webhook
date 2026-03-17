const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

const GHL_API_KEY = process.env.GHL_API_KEY;
const GHL_LOCATION_ID = process.env.GHL_LOCATION_ID;

/* =====================================================
   ✅ HEALTH CHECK (prevents Render issues)
===================================================== */
app.get("/health", (req, res) => {
  res.status(200).send("OK");
});

/* =====================================================
   ✅ VAPI WEBHOOK
===================================================== */
app.post("/vapi-webhook", async (req, res) => {
  console.log("✅ Webhook received");

  // Respond immediately (prevents Vapi timeout)
  res.status(200).json({ received: true });

  try {
    const body = req.body;

    console.log("📦 Payload:", JSON.stringify(body, null, 2));

    const phone =
      body.message?.call?.customer?.number ||
      body.message?.customer?.number ||
      body.customer?.number;

    console.log("📞 Extracted phone:", phone);

    if (!phone) {
      console.log("❌ No phone number found");
      return;
    }

    const success =
      body.message?.analysis?.successEvaluation === "true";

    console.log("✅ successEvaluation:", success);

    if (success) {
      console.log("✅ Appointment created. No SMS needed.");
      return;
    }

    console.log("⚠️ Sending follow-up SMS...");
    await sendFollowUpSMS(phone);

  } catch (err) {
    console.error("❌ Webhook error:", err.message);
  }
});

/* =====================================================
   ✅ SEND FOLLOW-UP SMS VIA GHL
===================================================== */
async function sendFollowUpSMS(phone) {
  try {
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

    const contact = contactResponse.data.contact;

    if (!contact) {
      console.log("❌ Contact not found in GHL");
      return;
    }

    console.log("✅ Contact found:", contact.id);

    await axios.post(
      "https://services.leadconnectorhq.com/conversations/messages",
      {
        type: "SMS",
        contactId: contact.id,
        message:
          "Hi 👋 It looks like your call ended before booking was completed. You can schedule here: https://YOUR_BOOKING_LINK.com",
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
      "❌ GHL error:",
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
