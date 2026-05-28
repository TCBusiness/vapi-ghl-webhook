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
   SERVICE CONFIG (UNIFIED)
=========================== */
const SERVICE_CONFIG = {
  cleaning: {
    calendarId: "xxu2BJu9id2CZNCHVznf",
    title: "Cleaning",
    durationMinutes: 60,
  },
  whitening: {
    calendarId: "1V3YhiECFKwKjhyAYNyG",
    title: "Whitening",
    durationMinutes: 90,
  },
  implants: {
    calendarId: "1V3YhiECFKwKjhyAYNyG",
    title: "Implants",
    durationMinutes: 120,
  },
  crown: {
    calendarId: "1V3YhiECFKwKjhyAYNyG",
    title: "Crown",
    durationMinutes: 120,
  },
  veneer: {
    calendarId: "1V3YhiECFKwKjhyAYNyG",
    title: "Veneer",
    durationMinutes: 120,
  },
  extractions: {
    calendarId: "1V3YhiECFKwKjhyAYNyG",
    title: "Extractions",
    durationMinutes: 120,
  },
  emergency: {
    calendarId: "1V3YhiECFKwKjhyAYNyG",
    title: "Emergency",
    durationMinutes: 60,
  },
  mouthguard: {
    calendarId: "1V3YhiECFKwKjhyAYNyG",
    title: "Mouthguard",
    durationMinutes: 60,
  },
  denture: {
    calendarId: "1V3YhiECFKwKjhyAYNyG",
    title: "Denture",
    durationMinutes: 60,
  },
  composite: {
    calendarId: "1V3YhiECFKwKjhyAYNyG",
    title: "Composite",
    durationMinutes: 60,
  },
  bridge: {
    calendarId: "1V3YhiECFKwKjhyAYNyG",
    title: "Bridge",
    durationMinutes: 120,
  },
  root_canal: {
    calendarId: "1V3YhiECFKwKjhyAYNyG",
    title: "Root Canal",
    durationMinutes: 120,
  },
};

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

const DOB_MMDDYYYY_REGEX = /^(0[1-9]|1[0-2])\/(0[1-9]|[12]\d|3[01])\/(19|20)\d\d$/;

function isValidMMDDYYYY(s) {
  if (typeof s !== "string" || !DOB_MMDDYYYY_REGEX.test(s)) return false;
  const [mm, dd, yyyy] = s.split("/").map(Number);
  const dt = new Date(Date.UTC(yyyy, mm - 1, dd));
  return (
    dt.getUTCFullYear() === yyyy &&
    dt.getUTCMonth() === mm - 1 &&
    dt.getUTCDate() === dd
  );
}

function mmddyyyyToYyyyMmDd(s) {
  const [mm, dd, yyyy] = s.split("/");
  return `${yyyy}-${mm}-${dd}`;
}

function toE164(phoneRaw) {
  const digits = String(phoneRaw || "").replace(/[^\d]/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  if (digits.length >= 11 && digits.length <= 15) return `+${digits}`;
  return "";
}

function isValidYYYYMMDD(s) {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [year, month, day] = s.split("-").map(Number);
  const dt = new Date(Date.UTC(year, month - 1, day));
  return (
    dt.getUTCFullYear() === year &&
    dt.getUTCMonth() === month - 1 &&
    dt.getUTCDate() === day
  );
}

function ymdInTimeZone(tz = "America/New_York") {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());

  const year = parts.find((p) => p.type === "year")?.value;
  const month = parts.find((p) => p.type === "month")?.value;
  const day = parts.find((p) => p.type === "day")?.value;

  if (!year || !month || !day) {
    throw new Error(`Failed to derive current date for timezone: ${tz}`);
  }

  return `${year}-${month}-${day}`;
}

function compareYYYYMMDD(a, b) {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function invalidDateFinalResult({ date, timezone, serviceType }) {
  const base = {
    success: false,
    errorCode: "invalid_date",
    message:
      "The requested date is invalid or unclear. Please provide a valid future date in YYYY-MM-DD format.",
    date,
    timezone: timezone || "America/New_York",
    slots: [],
  };

  return serviceType ? { ...base, serviceType } : base;
}

function dateInPastFinalResult({ date, timezone, serviceType }) {
  const base = {
    success: false,
    errorCode: "date_in_past",
    message:
      "The requested date is in the past. Please provide a future date.",
    date,
    timezone: timezone || "America/New_York",
    slots: [],
  };

  return serviceType ? { ...base, serviceType } : base;
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
  const calendarId = SERVICE_CONFIG.cleaning.calendarId;
  const logPrefix = `[ghl_check_cleaning_availability_webhook] toolCallId=${toolCallId}`;

  if (!GHL_API_KEY || !GHL_LOCATION_ID) {
    throw new Error("Server misconfigured: missing GHL_API_KEY or GHL_LOCATION_ID");
  }

  if (!isValidYYYYMMDD(date)) {
    console.log(`${logPrefix} rejected invalid date`, { date, timezone });
    return {
      finalResult: invalidDateFinalResult({
        date,
        timezone,
        serviceType: "cleaning",
      }),
    };
  }

  const todayYMD = ymdInTimeZone("America/New_York");
  if (compareYYYYMMDD(date, todayYMD) < 0) {
    console.log(`${logPrefix} rejected past date`, {
      date,
      todayYMD,
      timezone,
    });
    return {
      finalResult: dateInPastFinalResult({
        date,
        timezone,
        serviceType: "cleaning",
      }),
    };
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

async function fetchServiceAvailability({
  serviceType,
  date,
  timezone,
  preferredTime,
  toolCallId = "debug",
}) {
  const cfg = SERVICE_CONFIG[serviceType];
  if (!cfg) {
    throw new Error(`Unknown serviceType: ${serviceType}`);
  }

  const calendarId = cfg.calendarId;
  const logPrefix = `[ghl_check_availability_webhook] serviceType=${serviceType} toolCallId=${toolCallId}`;

  if (!GHL_API_KEY || !GHL_LOCATION_ID) {
    throw new Error("Server misconfigured: missing GHL_API_KEY or GHL_LOCATION_ID");
  }

  if (!isValidYYYYMMDD(date)) {
    console.log(`${logPrefix} rejected invalid date`, { date, timezone, serviceType });
    return {
      finalResult: invalidDateFinalResult({
        date,
        timezone,
        serviceType,
      }),
    };
  }

  const todayYMD = ymdInTimeZone("America/New_York");
  if (compareYYYYMMDD(date, todayYMD) < 0) {
    console.log(`${logPrefix} rejected past date`, {
      date,
      todayYMD,
      timezone,
      serviceType,
    });
    return {
      finalResult: dateInPastFinalResult({
        date,
        timezone,
        serviceType,
      }),
    };
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
    durationMinutes: cfg.durationMinutes,
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
    serviceType,
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

      if (name === "ghl_check_availability_webhook") {
        try {
          const serviceType = String(args.serviceType || "").trim();
          const timezone = (args.timezone || "America/New_York").toString();
          const date = (args.date || "").toString().trim();
          const preferredTime =
            args.preferredTime && typeof args.preferredTime === "object"
              ? args.preferredTime
              : null;

          if (!serviceType) {
            results.push({
              toolCallId,
              result: { success: false, error: "Missing required argument: serviceType" },
            });
            continue;
          }

          if (!SERVICE_CONFIG[serviceType]) {
            results.push({
              toolCallId,
              result: { success: false, error: `Unknown serviceType: ${serviceType}` },
            });
            continue;
          }

          const availability = await fetchServiceAvailability({
            serviceType,
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
            `[ghl_check_availability_webhook] toolCallId=${toolCallId} Error`,
            details
          );

          results.push({
            toolCallId,
            result: {
              success: false,
              error: "ghl_check_availability_webhook failed",
              details,
            },
          });
        }

        continue;
      }

      if (name === "ghl_create_appointment_webhook") {
        const serviceType = String(args?.serviceType || "").trim();
        const contactId = String(args?.contactId || "").trim();
        const startDateTime = String(args?.startDateTime || "").trim();
        const timezone =
          String(args?.timezone || "America/New_York").trim() || "America/New_York";

        if (!serviceType) {
          results.push({
            toolCallId,
            result: { success: false, error: "Missing required argument: serviceType" },
          });
          continue;
        }

        const cfg = SERVICE_CONFIG[serviceType];
        if (!cfg) {
          results.push({
            toolCallId,
            result: { success: false, error: `Unknown serviceType: ${serviceType}` },
          });
          continue;
        }

        console.log("[booking-unified] function.name:", name);
        console.log("[booking-unified] serviceType:", serviceType);
        console.log("[booking-unified] contactId:", contactId);
        console.log("[booking-unified] calendarId (resolved):", cfg.calendarId);
        console.log("[booking-unified] startDateTime:", startDateTime);

        if (!contactId) {
          results.push({
            toolCallId,
            result: { success: false, error: "Missing required argument: contactId" },
          });
          continue;
        }

        if (!startDateTime) {
          results.push({
            toolCallId,
            result: { success: false, error: "Missing required argument: startDateTime" },
          });
          continue;
        }

        const start = new Date(startDateTime);
        if (Number.isNaN(start.getTime())) {
          results.push({
            toolCallId,
            result: { success: false, error: "Invalid startDateTime (must be ISO datetime)" },
          });
          continue;
        }

        const DURATION_MINUTES = Number(cfg.durationMinutes);
        const end = new Date(start.getTime() + DURATION_MINUTES * 60 * 1000);
        const endTime = end.toISOString();

        if (!GHL_API_KEY) {
          results.push({
            toolCallId,
            result: { success: false, error: "Missing server env var: GHL_API_KEY" },
          });
          continue;
        }

        const bodyPayload = {
          calendarId: cfg.calendarId,
          contactId,
          startTime: startDateTime,
          endTime,
          timezone,
          ...(GHL_LOCATION_ID ? { locationId: GHL_LOCATION_ID } : {}),
          title: cfg.title,
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

          console.log("[booking-unified] ghlResp.status:", ghlResp.status);
          console.log(
            "[booking-unified] responseText:",
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
              calendarId: cfg.calendarId,
              startDateTime,
              endDateTime: endTime,
              durationMinutes: DURATION_MINUTES,
              timezone,
              serviceType,
            },
          });
        } catch (error) {
          const status = error.response?.status || 500;
          const responseText =
            typeof error.response?.data === "string"
              ? error.response.data
              : JSON.stringify(error.response?.data || error.message);

          console.log("[booking-unified] ghlResp.status:", status);
          console.log("[booking-unified] responseText:", responseText);

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

      if (name === "ghl_update_contact_dob_webhook") {
        const contactId = String(args?.contactId || "").trim();
        const dateOfBirth = String(args?.dateOfBirth || "").trim();

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

        if (!dateOfBirth) {
          results.push({
            toolCallId,
            result: {
              success: false,
              error: "Missing required argument: dateOfBirth",
            },
          });
          continue;
        }

        if (!isValidMMDDYYYY(dateOfBirth)) {
          results.push({
            toolCallId,
            result: {
              success: false,
              contactId,
              error: "Invalid dateOfBirth format. Expected MM/DD/YYYY",
            },
          });
          continue;
        }

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

        const targetDob = mmddyyyyToYyyyMmDd(dateOfBirth);

        try {
          const getResp = await axios.get(
            `https://services.leadconnectorhq.com/contacts/${contactId}`,
            {
              headers: {
                Authorization: `Bearer ${GHL_API_KEY}`,
                Version: "2023-02-21",
              },
            }
          );

          const existingContact =
            getResp.data?.contact ||
            getResp.data?.data?.contact ||
            getResp.data?.data ||
            getResp.data ||
            {};

          const existingDobRaw = existingContact?.dateOfBirth || "";
          const existingDob =
            typeof existingDobRaw === "string" && existingDobRaw.length >= 10
              ? existingDobRaw.slice(0, 10)
              : "";

          if (existingDob === targetDob) {
            results.push({
              toolCallId,
              result: {
                success: true,
                contactId,
                inputDateOfBirth: dateOfBirth,
                storedDateOfBirth: existingDob,
                noOp: true,
              },
            });
            continue;
          }

          const updateResp = await axios.put(
            `https://services.leadconnectorhq.com/contacts/${contactId}`,
            {
              dateOfBirth: targetDob,
            },
            {
              headers: {
                Authorization: `Bearer ${GHL_API_KEY}`,
                Version: "2023-02-21",
                "Content-Type": "application/json",
              },
            }
          );

          const updatedContact =
            updateResp.data?.contact ||
            updateResp.data?.data?.contact ||
            updateResp.data?.data ||
            updateResp.data ||
            {};

          const storedDobRaw = updatedContact?.dateOfBirth || targetDob;
          const storedDateOfBirth =
            typeof storedDobRaw === "string" && storedDobRaw.length >= 10
              ? storedDobRaw.slice(0, 10)
              : targetDob;

          results.push({
            toolCallId,
            result: {
              success: true,
              contactId,
              inputDateOfBirth: dateOfBirth,
              storedDateOfBirth,
              noOp: false,
            },
          });
        } catch (error) {
          const details = error.response?.data || error.message;
          console.error(
            `[ghl_update_contact_dob_webhook] toolCallId=${toolCallId} Error`,
            details
          );

          results.push({
            toolCallId,
            result: {
              success: false,
              contactId,
              error: "ghl_update_contact_dob_webhook failed",
              details,
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
