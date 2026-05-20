const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const GHL_API_KEY = process.env.GHL_API_KEY;
const GHL_LOCATION_ID = process.env.GHL_LOCATION_ID;

/* ===========================
   HEALTH CHECK
=========================== */
app.get("/health", (req, res) => {
  res.status(200).send("OK");
});

/* ===========================
   VAPI WEBHOOK
=========================== */
app.post("/vapi-webhook", async (req, res) => {
  console.log("✅ Webhook received");

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
/* ===========================
   VAPI TOOL CALLS (LIVE)
=========================== */
app.post("/tool-calls", async (req, res) => {
  try {
    const body = req.body;

    const toolCalls = body?.message?.toolCallList || [];
    if (!toolCalls.length) {
      return res.status(200).json({ results: [] });
    }

    const results = [];

    for (const tc of toolCalls) {
      const toolCallId = tc.toolCallId;
      const name = tc.function?.name;
      const args = tc.function?.arguments || {};

      if (!toolCallId || !name) continue;

      if (name === "parse_datetime_ny") {
        results.push({
          toolCallId,
          result: {
            success: false,
            error: "parse_datetime_ny not implemented yet",
            receivedArgs: args
          }
        });
        continue;
      }

      if (name === "parse_datetime_ny") {
  const text = (args.text || "").toString();
  const timezone = (args.timezone || "America/New_York").toString();

  // Very simple parser: handles "mañana" / "tomorrow" and "lunes" / "monday"
  // and common times like "6", "6pm", "6 pm", "18:00", "6 de la tarde".
  // (We can expand after first test.)

  const now = new Date();
  const fmtDate = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });

  // helper to add days
  const addDays = (d, n) => {
    const x = new Date(d.getTime());
    x.setDate(x.getDate() + n);
    return x;
  };

  const lower = text.toLowerCase();

  // Determine target day
  let target = now;

  const daysMap = {
    domingo: 0, sunday: 0,
    lunes: 1, monday: 1,
    martes: 2, tuesday: 2,
    miercoles: 3, miércoles: 3, wednesday: 3,
    jueves: 4, thursday: 4,
    viernes: 5, friday: 5,
    sabado: 6, sábado: 6, saturday: 6,
  };

  if (lower.includes("mañana") || lower.includes("tomorrow")) {
    target = addDays(now, 1);
  } else {
    // find weekday mention
    const found = Object.keys(daysMap).find(k => lower.includes(k));
    if (found) {
      const desired = daysMap[found];
      const currentDow = new Date(new Intl.DateTimeFormat("en-US", { timeZone: timezone, weekday: "short" }).format(now) + " 01 2000").getDay();
      let delta = (desired - currentDow + 7) % 7;
      if (delta === 0) delta = 7; // next same weekday
      target = addDays(now, delta);
    }
  }

  // Determine hour/min
  let hour = null;
  let minute = 0;

  // 18:30, 6:30
  const hm = lower.match(/\b(\d{1,2})\s*[:h]\s*(\d{2})\b/);
  if (hm) {
    hour = parseInt(hm[1], 10);
    minute = parseInt(hm[2], 10);
  } else {
    const h = lower.match(/\b(\d{1,2})\b/);
    if (h) hour = parseInt(h[1], 10);
  }

  // am/pm inference
  const hasPM =
    lower.includes("pm") ||
    lower.includes("tarde") ||
    lower.includes("noche");
  const hasAM =
    lower.includes("am") ||
    lower.includes("mañana ") || // morning context, not "tomorrow" only
    lower.includes("morning");

  if (hour !== null) {
    if (hasPM && hour < 12) hour += 12;
    if (hasAM && hour === 12) hour = 0;
  }

  // Build ISO-like in timezone by formatting components
  const parts = fmtDate.formatToParts(target);
  const mm = parts.find(p => p.type === "month")?.value;
  const dd = parts.find(p => p.type === "day")?.value;
  const yyyy = parts.find(p => p.type === "year")?.value;

  const dateMMDDYYYY = `${mm}-${dd}-${yyyy}`;

  results.push({
    toolCallId,
    result: {
      success: true,
      timezone,
      originalText: text,
      dateMMDDYYYY,
      preferredTime: hour === null ? null : { hour, minute }
    }
  });
  continue;
}

      results.push({
        toolCallId,
        result: { success: false, error: `Unknown tool: ${name}` }
      });
    }

    return res.status(200).json({ results });
  } catch (err) {
    console.error("❌ /tool-calls error:", err.message);
    return res.status(200).json({
      results: [
        {
          toolCallId: req.body?.message?.toolCallList?.[0]?.toolCallId,
          result: { success: false, error: err.message }
        }
      ]
    });
  }
});

/* ===========================
   SEND SMS FUNCTION
=========================== */
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

/* ===========================
   START SERVER
=========================== */
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
