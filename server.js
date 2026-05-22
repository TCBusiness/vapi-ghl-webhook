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
const GHL_LOCATION_ID = process.env.GHL_LOCATION_ID;

/* ===========================
   BASIC ROOT + HEALTH CHECK
=========================== */
app.get("/", (req, res) => res.status(200).send("OK"));
app.head("/", (req, res) => res.sendStatus(200));
app.get("/health", (req, res) => res.status(200).send("OK"));

/* ===========================
   HELPERS
=========================== */
function normalizeArgs(maybeArgs) {
  if (maybeArgs == null) return {};
  if (typeof maybeArgs === "object") return maybeArgs;
  if (typeof maybeArgs === "string") {
    try {
      const parsed = JSON.parse(maybeArgs);
      return typeof parsed === "object" && parsed != null ? parsed : {};
    } catch {
      return {};
    }
  }
  return {};
}

function toE164(phoneRaw) {
  const digits = String(phoneRaw || "").replace(/[^\d]/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  if (digits.length >= 11 && digits.length <= 15) return `+${digits}`;
  return "";
}

function epochMsInTimeZone(ymd, hh, mm, tz) {
  const utcGuessMs = Date.UTC(
    Number(ymd.slice(0, 4)),
    Number(ymd.slice(5, 7)) - 1,
    Number(ymd.slice(8, 10)),
    hh,
    mm,
    0
  );

  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(utcGuessMs));

  const gotY = Number(parts.find((p) => p.type === "year")?.value);
  const gotM = Number(parts.find((p) => p.type === "month")?.value);
  const gotD = Number(parts.find((p) => p.type === "day")?.value);
  const gotH = Number(parts.find((p) => p.type === "hour")?.value);
  const gotMin = Number(parts.find((p) => p.type === "minute")?.value);

  const wantY = Number(ymd.slice(0, 4));
  const wantM = Number(ymd.slice(5, 7));
  const wantD = Number(ymd.slice(8, 10));

  if (
    [gotY, gotM, gotD, gotH, gotMin, wantY, wantM, wantD].some((x) =>
      Number.isNaN(x)
    )
  ) {
    return utcGuessMs;
  }

  const gotTotal =
    (((gotY * 12 + gotM) * 31 + gotD) * 24 + gotH) * 60 + gotMin;
  const wantTotal =
    (((wantY * 12 + wantM) * 31 + wantD) * 24 + hh) * 60 + mm;

  const deltaMinutes = gotTotal - wantTotal;
  const correctedMs = utcGuessMs - deltaMinutes * 60 * 1000;

  return correctedMs;
}

function safeGet(obj, path) {
  try {
    return path.split(".").reduce((acc, k) => (acc ? acc[k] : undefined), obj);
  } catch {
    return undefined;
  }
}

function collectCandidateArrays(payload, ymd) {
  const candidates = [];
  const pushIfArray = (x) => {
    if (Array.isArray(x)) candidates.push(x);
  };

  const pushObjectValueArrays = (obj) => {
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) return;
    for (const value of Object.values(obj)) {
      if (Array.isArray(value)) candidates.push(value);
    }
  };

  pushIfArray(payload?.suggestedSlots);
  pushIfArray(payload?.slots);
  pushIfArray(payload?.data?.suggestedSlots);
  pushIfArray(payload?.data?.slots);

  pushIfArray(payload?.[ymd]);
  pushIfArray(payload?.[ymd]?.slots);
  pushIfArray(payload?.[ymd]?.freeSlots);
  pushIfArray(payload?.[ymd]?.suggestedSlots);
  pushIfArray(payload?.[ymd]?.data?.slots);
  pushIfArray(payload?.[ymd]?.data?.freeSlots);
  pushIfArray(payload?.[ymd]?.data?.suggestedSlots);
  pushObjectValueArrays(payload?.[ymd]);

  pushIfArray(payload?.data?.[ymd]);
  pushIfArray(payload?.freeSlots?.[ymd]);
  pushIfArray(payload?.data?.freeSlots?.[ymd]);
  pushIfArray(payload?.freeSlots?.slots);
  pushIfArray(payload?.data?.freeSlots?.slots);

  pushIfArray(safeGet(payload, "data.freeSlots.freeSlots"));
  pushIfArray(safeGet(payload, "data.freeSlots.suggestedSlots"));
  pushIfArray(safeGet(payload, "data.freeSlots.slots"));

  if (!candidates.length) return [];
  return candidates.sort((a, b) => b.length - a.length)[0] || [];
}

function toIso(v) {
  if (v == null) return null;
  if (typeof v === "string") return v;
  if (typeof v === "number") {
    const ms = v < 1e12 ? v * 1000 : v;
    return new Date(ms).toISOString();
  }
  return null;
}

function minutesFromMidnightInTz(iso, tz) {
  try {
    const d = new Date(iso);
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).formatToParts(d);

    const hh = parseInt(parts.find((p) => p.type === "hour")?.value, 10);
    const mm = parseInt(parts.find((p) => p.type === "minute")?.value, 10);
    if (Number.isNaN(hh) || Number.isNaN(mm)) return null;
    return hh * 60 + mm;
  } catch {
    return null;
  }
}

async function fetchCleaningAvailability({
  date,
  timezone,
  preferredTime,
  toolCallId = "debug",
}) {
  const calendarId = "y53J9Fbsd5Xz0bwUiE4K";
  const logPrefix = `[ghl_check_cleaning_availability_webhook] toolCallId=${toolCallId}`;

  if (!GHL_API_KEY || !GHL_LOCATION_ID) {
    throw new Error("Server misconfigured: missing GHL_API_KEY or GHL_LOCATION_ID");
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error("Invalid date format. Expected YYYY-MM-DD");
  }

  const startDate = epochMsInTimeZone(date, 9, 0, "America/New_York");
  const endDate = epochMsInTimeZone(date, 18, 0, "America/New_York");

  const preferredMinutes =
    preferredTime &&
    Number.isFinite(Number(preferredTime.hour)) &&
    Number.isFinite(Number(preferredTime.minute))
      ? Number(preferredTime.hour) * 60 + Number(preferredTime.minute)
      : null;

  console.log(`${logPrefix} start/end (ms)`, {
    startDate,
    endDate,
    startDateDigits: String(startDate).length,
    endDateDigits: String(endDate).length,
  });

  console.log(`${logPrefix} Checking free slots`, {
    calendarId,
    date,
    timezone,
    startDate,
    endDate,
    preferredTime,
    preferredMinutes,
  });

  const resp = await axios.get(
    `https://services.leadconnectorhq.com/calendars/${calendarId}/free-slots`,
    {
      headers: {
        Authorization: `Bearer ${GHL_API_KEY}`,
        Version: "2023-02-21",
      },
      params: {
        startDate,
        endDate,
        timezone,
      },
    }
  );

  const payload = resp.data || {};
  const rawSlots = collectCandidateArrays(payload, date);

  console.log(`${logPrefix} Raw response keys`, {
    topKeys: Object.keys(payload || {}),
    rawSlotCount: Array.isArray(rawSlots) ? rawSlots.length : 0,
    rawSlotSample: Array.isArray(rawSlots) ? rawSlots.slice(0, 3) : null,
  });

  const dateNode = payload?.[date];
  const dateNodeType = typeof dateNode;
  const dateNodeIsArray = Array.isArray(dateNode);
  const dateNodeKeys =
    dateNode && typeof dateNode === "object" && !Array.isArray(dateNode)
      ? Object.keys(dateNode)
      : [];

  console.log(`${logPrefix} DEBUG payload`, payload);
  console.log(`${logPrefix} DEBUG payload[date]`, dateNode);
  console.log(`${logPrefix} DEBUG typeof payload[date]`, dateNodeType);
  console.log(`${logPrefix} DEBUG Array.isArray(payload[date])`, dateNodeIsArray);
  if (dateNode && typeof dateNode === "object" && !Array.isArray(dateNode)) {
    console.log(`${logPrefix} DEBUG Object.keys(payload[date])`, dateNodeKeys);
  }

  const normalized = [];

  for (const item of rawSlots) {
    if (item == null) continue;

    if (typeof item === "string" || typeof item === "number") {
      const startIso = toIso(item);
      if (!startIso) continue;
      normalized.push({ start: startIso });
      continue;
    }

    if (typeof item === "object") {
      const startIso =
        toIso(item.start) ||
        toIso(item.startTime) ||
        toIso(item.startDate) ||
        toIso(item.start_date);

      if (startIso) {
        normalized.push({ start: startIso });
      }
    }
  }

  console.log(`${logPrefix} Slots normalized`, {
    normalizedCount: normalized.length,
    sample: normalized.slice(0, 3),
  });

  let picked = [];
  if (preferredMinutes != null) {
    const scored = normalized
      .map((slot) => {
        const slotMins = minutesFromMidnightInTz(slot.start, timezone);
        const dist =
          slotMins == null
            ? Number.POSITIVE_INFINITY
            : Math.abs(slotMins - preferredMinutes);
        return { slot, dist };
      })
      .sort((a, b) => a.dist - b.dist);

    picked = scored.slice(0, 2).map((x) => x.slot);
  } else {
    picked = normalized.slice(0, 2);
  }

  const finalResult = {
    success: true,
    date,
    timezone,
    slots: picked.map((s) => ({ start: s.start })),
  };

  return {
    startDate,
    endDate,
    payload,
    dateNode,
    dateNodeType,
    dateNodeIsArray,
    dateNodeKeys,
    rawSlots,
    normalized,
    picked,
    finalResult,
  };
}

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
      const toolCallId = tc.id || tc.toolCallId;
      const name = tc.function?.name;
      const args = normalizeArgs(tc.function?.arguments);

      if (!toolCallId || !name) {
        results.push({
          toolCallId: toolCallId || "unknown",
          result: {
            success: false,
            error: "Missing toolCallId or tool name in tool call payload",
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

      if (name === "ghl_find_or_create_contact_webhook") {
        const phoneRaw = (args.phone || "").toString();
        const email = (args.email || "").toString().trim().toLowerCase();
        const fullName = (args.fullName || "").toString().trim();
        const firstName = (args.firstName || "").toString().trim();
        const lastName = (args.lastName || "").toString().trim();

        const phoneE164 = toE164(phoneRaw);

        if (!phoneE164) {
          results.push({
            toolCallId,
            result: { success: false, error: "Invalid phone", phoneRaw },
          });
          continue;
        }

        let fn = firstName;
        let ln = lastName;
        if (!fn && !ln && fullName) {
          const parts = fullName.split(/\s+/).filter(Boolean);
          fn = parts[0] || "";
          ln = parts.slice(1).join(" ");
        }

        const logPrefix = `[ghl_find_or_create_contact_webhook] toolCallId=${toolCallId}`;

        try {
          const dupResp = await axios.get(
            "https://services.leadconnectorhq.com/contacts/search/duplicate",
            {
              headers: {
                Authorization: `Bearer ${GHL_API_KEY}`,
                Version: "2023-02-21",
              },
              params: {
                locationId: GHL_LOCATION_ID,
                number: phoneE164,
              },
            }
          );

          const found = dupResp.data?.contact || null;
          const foundId = found?.id;

          if (foundId) {
            results.push({
              toolCallId,
              result: {
                success: true,
                action: "found",
                contactId: foundId,
                phone: phoneE164,
                contact: found,
              },
            });
            continue;
          }

          const createResp = await axios.post(
            "https://services.leadconnectorhq.com/contacts/",
            {
              locationId: GHL_LOCATION_ID,
              phone: phoneE164,
              ...(email ? { email } : {}),
              ...(fn ? { firstName: fn } : {}),
              ...(ln ? { lastName: ln } : {}),
            },
            {
              headers: {
                Authorization: `Bearer ${GHL_API_KEY}`,
                Version: "2023-02-21",
                "Content-Type": "application/json",
              },
            }
          );

          const contactId =
            createResp.data?.contact?.id ||
            createResp.data?.contactId ||
            createResp.data?.id;

          results.push({
            toolCallId,
            result: {
              success: true,
              action: "created",
              contactId: contactId || "",
              phone: phoneE164,
              raw: createResp.data,
            },
          });
        } catch (error) {
          const details = error.response?.data || error.message;
          console.error(`${logPrefix} Error`, details);

          results.push({
            toolCallId,
            result: {
              success: false,
              error: "ghl_find_or_create_contact_webhook failed",
              details,
              phone: phoneE164,
            },
          });
        }

        continue;
      }

      if (name === "ghl_check_cleaning_availability_webhook") {
        try {
          const timezone = (args.timezone || "America/New_York").toString();
          const date = (args.date || "").toString().trim();
          const preferredTime =
            args.preferredTime && typeof args.preferredTime === "object"
              ? args.preferredTime
              : null;

          const availability = await fetchCleaningAvailability({
            date,
            timezone,
            preferredTime,
            toolCallId,
          });

          results.push({
            toolCallId,
            result: availability.finalResult,
          });
        } catch (error) {
          const details = error.response?.data || error.message;
          console.error(
            `[ghl_check_cleaning_availability_webhook] toolCallId=${toolCallId} Error`,
            details
          );

          results.push({
            toolCallId,
            result: {
              success: false,
              error: "ghl_check_cleaning_availability_webhook failed",
              details,
            },
          });
        }

        continue;
      }

      if (name === "ghl_create_cleaning_appointment_webhook") {
        const contactId = String(args?.contactId || "").trim();
        const startDateTime = String(args?.startDateTime || "").trim();
        const calendarId = String(args?.calendarId || "").trim();
        const timezone =
          String(args?.timezone || "America/New_York").trim() ||
          "America/New_York";

        console.log("[booking] function.name:", name);
        console.log("[booking] contactId:", contactId);
        console.log("[booking] calendarId:", calendarId);
        console.log("[booking] startDateTime:", startDateTime);

        if (!contactId) {
          results.push({
            toolCallId,
            result: {
              success: false,
              error: "Missing required argument: contactId",
            },
          });
          continue;
        }

        if (!startDateTime) {
          results.push({
            toolCallId,
            result: {
              success: false,
              error: "Missing required argument: startDateTime",
            },
          });
          continue;
        }

        if (!calendarId) {
          results.push({
            toolCallId,
            result: {
              success: false,
              error: "Missing required argument: calendarId",
            },
          });
          continue;
        }

        const start = new Date(startDateTime);
        if (Number.isNaN(start.getTime())) {
          results.push({
            toolCallId,
            result: {
              success: false,
              error: "Invalid startDateTime (must be ISO datetime)",
            },
          });
          continue;
        }

        const DURATION_MINUTES = 60;
        const end = new Date(start.getTime() + DURATION_MINUTES * 60 * 1000);
        const endTime = end.toISOString();

        if (!GHL_API_KEY) {
          results.push({
            toolCallId,
            result: {
              success: false,
              error: "Missing server env var: GHL_API_KEY",
            },
          });
          continue;
        }

        const bodyPayload = {
          calendarId,
          contactId,
          startTime: startDateTime,
          endTime,
          timezone,
          ...(GHL_LOCATION_ID ? { locationId: GHL_LOCATION_ID } : {}),
          title: "Cleaning",
          appointmentStatus: "confirmed",
        };

        try {
          const ghlResp = await axios.post(
            "https://services.leadconnectorhq.com/calendars/events/appointments",
            bodyPayload,
            {
              headers: {
                Authorization: `Bearer ${GHL_API_KEY}`,
                Version: "2023-02-21",
                "Content-Type": "application/json",
              },
            }
          );

          console.log("[booking] ghlResp.status:", ghlResp.status);
          console.log(
            "[booking] responseText:",
            JSON.stringify(ghlResp.data || {}, null, 2)
          );

          const responseJson = ghlResp.data || {};
          const appointmentId =
            responseJson?.id ||
            responseJson?.appointment?.id ||
            responseJson?.event?.id ||
            responseJson?.data?.id ||
            "";

          results.push({
            toolCallId,
            result: {
              success: true,
              appointmentId,
              calendarId,
              startDateTime,
              timezone,
            },
          });
        } catch (error) {
          const status = error.response?.status || 500;
          const responseText =
            typeof error.response?.data === "string"
              ? error.response.data
              : JSON.stringify(error.response?.data || error.message);

          console.log("[booking] ghlResp.status:", status);
          console.log("[booking] responseText:", responseText);

          results.push({
            toolCallId,
            result: {
              success: false,
              error: `GHL ${status}: ${responseText}`,
            },
          });
        }

        continue;
      }

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
   TEMP DEBUG ENDPOINT
=========================== */
app.get("/debug/free-slots", async (req, res) => {
  try {
    const timezone = (req.query.timezone || "America/New_York").toString();
    const date = (req.query.date || "").toString().trim();

    const hour =
      req.query.hour !== undefined && req.query.hour !== ""
        ? Number(req.query.hour)
        : null;
    const minute =
      req.query.minute !== undefined && req.query.minute !== ""
        ? Number(req.query.minute)
        : null;

    const preferredTime =
      hour != null &&
      minute != null &&
      Number.isFinite(hour) &&
      Number.isFinite(minute)
        ? { hour: Number(hour), minute: Number(minute) }
        : null;

    const availability = await fetchCleaningAvailability({
      date,
      timezone,
      preferredTime,
      toolCallId: "debug-endpoint",
    });

    return res.status(200).json({
      date,
      timezone,
      preferredTime,
      startDate: availability.startDate,
      endDate: availability.endDate,
      rawPayload: availability.payload,
      dateNode: availability.dateNode,
      dateNodeType: availability.dateNodeType,
      dateNodeIsArray: availability.dateNodeIsArray,
      dateNodeKeys: availability.dateNodeKeys,
      rawSlots: availability.rawSlots,
      normalized: availability.normalized,
      picked: availability.picked,
      finalResult: availability.finalResult,
    });
  } catch (error) {
    const details = error.response?.data || error.message;
    return res.status(500).json({ error: "debug/free-slots failed", details });
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
          Version: "2023-02-21",
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
          Version: "2023-02-21",
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

