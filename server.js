const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json({ limit: "2mb" }));

/* ===========================
   GLOBAL REQUEST LOGGER
=========================== */
app.use((req, res, next) => {
  const start = Date.now();
  res.on("finish", () => {
    console.log(
      `🌐 ${req.method} ${req.path} -> ${res.statusCode} (${Date.now() - start}ms)`
    );
  });
  next();
});

const PORT = process.env.PORT || 3000;
const GHL_API_KEY = process.env.GHL_API_KEY;
const GHL_LOCATION_ID = process.env.GHL_LOCATION_ID; // used for SMS/contact search

/* ===========================
   HEALTH CHECK
=========================== */
app.get("/health", (req, res) => {
  res.status(200).send("OK");
});

/* ===========================
   VAPI WEBHOOK (END-OF-CALL)
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

    const success = body.message?.analysis?.successEvaluation === "true";
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
   HELPERS
=========================== */

function parseMMDDYYYY(dateStr) {
  const parts = (dateStr || "").split("-");
  if (parts.length !== 3) return null;
  const mm = parseInt(parts[0], 10);
  const dd = parseInt(parts[1], 10);
  const yyyy = parseInt(parts[2], 10);
  if (!mm || !dd || !yyyy) return null;
  return { mm, dd, yyyy };
}

// Business window 9am–6pm (returns epoch ms)
function buildBusinessWindowEpochMs(dateMMDDYYYY) {
  const parsed = parseMMDDYYYY(dateMMDDYYYY);
  if (!parsed) return null;

  const { mm, dd, yyyy } = parsed;

  const isoDate = `${yyyy}-${String(mm).padStart(2, "0")}-${String(dd).padStart(
    2,
    "0"
  )}`;
  const startLocal = new Date(`${isoDate}T09:00:00`);
  const endLocal = new Date(`${isoDate}T18:00:00`);

  return { startDateMs: startLocal.getTime(), endDateMs: endLocal.getTime() };
}

function normalizeArgs(maybeArgs) {
  // Vapi can send arguments as an object OR as a JSON string.
  if (maybeArgs == null) return {};
  if (typeof maybeArgs === "object") return maybeArgs;
  if (typeof maybeArgs === "string") {
    try {
      const parsed = JSON.parse(maybeArgs);
      return typeof parsed === "object" && parsed != null ? parsed : {};
    } catch (e) {
      return {};
    }
  }
  return {};
}

/* ===========================
   VAPI TOOL CALLS (LIVE)
=========================== */
app.post("/tool-calls", async (req, res) => {
  try {
    const body = req.body;

    console.log(
      "📩 /tool-calls payload:",
      JSON.stringify(body?.message?.toolCallList || [], null, 2)
    );

    const toolCalls = body?.message?.toolCallList || [];
    if (!toolCalls.length) {
      return res.status(200).json({ results: [] });
    }

    const results = [];

    for (const tc of toolCalls) {
      // ✅ FIX (safe): Vapi uses tc.id (OpenAI-style). Keep tc.toolCallId as fallback.
      const toolCallId = tc.id || tc.toolCallId;

      const name = tc.function?.name;

      // ✅ normalize arguments
      const args = normalizeArgs(tc.function?.arguments);

      if (!toolCallId || !name) {
        results.push({
          toolCallId: toolCallId || "unknown",
          result: {
            success: false,
            error: "Missing toolCallId or tool name in tool call payload",
            receivedToolCall: tc,
          },
        });
        continue;
      }

      console.log(
        "🛠️ Tool call:",
        name,
        "toolCallId:",
        toolCallId,
        "args:",
        JSON.stringify(args)
      );

      /* ---------------------------
         1) parse_datetime_ny
      --------------------------- */
      if (name === "parse_datetime_ny") {
        const text = (args.text || "").toString();
        const timezone = (args.timezone || "America/New_York").toString();

        if (!text) {
          results.push({
            toolCallId,
            result: {
              success: false,
              error: "Missing 'text' argument for parse_datetime_ny",
              receivedArgs: args,
              receivedRawArguments: tc.function?.arguments,
            },
          });
          continue;
        }

        const addDays = (d, n) => {
          const x = new Date(d.getTime());
          x.setDate(x.getDate() + n);
          return x;
        };

        const lower = text.toLowerCase();
        const now = new Date();

        let target = now;

        const daysMap = {
          domingo: 0,
          sunday: 0,
          lunes: 1,
          monday: 1,
          martes: 2,
          tuesday: 2,
          miercoles: 3,
          miércoles: 3,
          wednesday: 3,
          jueves: 4,
          thursday: 4,
          viernes: 5,
          friday: 5,
          sabado: 6,
          sábado: 6,
          saturday: 6,
        };

        if (lower.includes("mañana") || lower.includes("tomorrow")) {
          target = addDays(now, 1);
        } else {
          const found = Object.keys(daysMap).find((k) => lower.includes(k));
          if (found) {
            const desired = daysMap[found];

            const currentWeekdayShort = new Intl.DateTimeFormat("en-US", {
              timeZone: timezone,
              weekday: "short",
            }).format(now);

            const shortMap = {
              Sun: 0,
              Mon: 1,
              Tue: 2,
              Wed: 3,
              Thu: 4,
              Fri: 5,
              Sat: 6,
            };
            const currentDow =
              shortMap[currentWeekdayShort] ?? new Date().getDay();

            let delta = (desired - currentDow + 7) % 7;
            if (delta === 0) delta = 7;
            target = addDays(now, delta);
          }
        }

        // hour/minute
        let hour = null;
        let minute = 0;

        const hm = lower.match(/\b(\d{1,2})\s*[:h]\s*(\d{2})\b/);
        if (hm) {
          hour = parseInt(hm[1], 10);
          minute = parseInt(hm[2], 10);
        } else {
          const h = lower.match(/\b(\d{1,2})\b/);
          if (h) hour = parseInt(h[1], 10);
        }

        const hasPM =
          lower.includes("pm") ||
          lower.includes("tarde") ||
          lower.includes("noche") ||
          lower.includes("evening");
        const hasAM = lower.includes("am") || lower.includes("morning");

        if (hour !== null) {
          if (hasPM && hour < 12) hour += 12;
          if (hasAM && hour === 12) hour = 0;
        }

        const parts = new Intl.DateTimeFormat("en-US", {
          timeZone: timezone,
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
        }).formatToParts(target);

        const mm = parts.find((p) => p.type === "month")?.value;
        const dd = parts.find((p) => p.type === "day")?.value;
        const yyyy = parts.find((p) => p.type === "year")?.value;

        const dateMMDDYYYY = `${mm}-${dd}-${yyyy}`;

        results.push({
          toolCallId,
          result: {
            success: true,
            timezone,
            originalText: text,
            dateMMDDYYYY,
            preferredTime: hour === null ? null : { hour, minute },
          },
        });
        continue;
      }

      /* ---------------------------
         2) ghl_availability_day
      --------------------------- */
      if (name === "ghl_availability_day") {
        const calendarId = (args.calendarId || "").toString();
        const dateText = (args.dateText || "").toString();
        const timezone = (args.timezone || "America/New_York").toString();
        const durationMinutes = Number(args.durationMinutes || 60);

        if (!calendarId || !dateText || !durationMinutes) {
          results.push({
            toolCallId,
            result: {
              success: false,
              error:
                "Missing required params: calendarId, dateText, durationMinutes",
              receivedArgs: args,
              receivedRawArguments: tc.function?.arguments,
            },
          });
          continue;
        }

        const dateMMDDYYYY = dateText;

        const window = buildBusinessWindowEpochMs(dateMMDDYYYY);
        if (!window || !window.startDateMs || !window.endDateMs) {
          results.push({
            toolCallId,
            result: {
              success: false,
              error: "Invalid dateText. Expected MM-DD-YYYY like 05-21-2026",
              receivedDateText: dateText,
            },
          });
          continue;
        }

        // ✅ GHL expects seconds (not ms) for startDate/endDate on this endpoint
        const startDateSeconds = Math.floor(window.startDateMs / 1000);
        const endDateSeconds = Math.floor(window.endDateMs / 1000);

        try {
          const resp = await axios.get(
            `https://services.leadconnectorhq.com/calendars/${calendarId}/free-slots`,
            {
              headers: {
                Authorization: `Bearer ${GHL_API_KEY}`,
                Version: "2021-07-28",
              },
              params: {
                startDate: startDateSeconds,
                endDate: endDateSeconds,
                timezone,
              },
            }
          );

          results.push({
            toolCallId,
            result: {
              success: true,
              calendarId,
              date: dateMMDDYYYY,
              timezone,
              businessHours: "09:00-18:00",
              startDateSeconds,
              endDateSeconds,
              data: resp.data,
            },
          });
        } catch (error) {
          const details = error.response?.data || error.message;
          console.error("❌ ghl_availability_day error:", details);

          results.push({
            toolCallId,
            result: {
              success: false,
              error: "ghl_availability_day failed",
              details,
              calendarId,
              date: dateMMDDYYYY,
              timezone,
              businessHours: "09:00-18:00",
              startDateSeconds,
              endDateSeconds,
            },
          });
        }

        continue;
      }

      /* ---------------------------
         Unknown tool
      --------------------------- */
      results.push({
        toolCallId,
        result: { success: false, error: `Unknown tool: ${name}` },
      });
    }

    return res.status(200).json({ results });
  } catch (err) {
    console.error("❌ /tool-calls error:", err.message);
    return res.status(200).json({
      results: [
        {
          toolCallId:
            req.body?.message?.toolCallList?.[0]?.id ||
            req.body?.message?.toolCallList?.[0]?.toolCallId ||
            "unknown",
          result: { success: false, error: err.message },
        },
      ],
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
    console.error("❌ GHL error:", error.response?.data || error.message);
  }
}

/* ===========================
   START SERVER
=========================== */
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
