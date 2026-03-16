const express = require("express");
const fetch = require("node-fetch");

const app = express();
app.use(express.json());

const GHL_API_KEY = process.env.GHL_API_KEY;
const GHL_LOCATION_ID = process.env.GHL_LOCATION_ID;

app.post("/vapi-webhook", async (req, res) => {
  const body = req.body;

  if (body.type !== "end-of-call-report") {
    return res.sendStatus(200);
  }

  const phone = body.call?.customer?.number;
  if (!phone) return res.sendStatus(200);

  const search = await fetch(
    `https://services.leadconnectorhq.com/contacts/?locationId=${GHL_LOCATION_ID}&query=${encodeURIComponent(phone)}`,
    {
      headers: {
        Authorization: `Bearer ${GHL_API_KEY}`,
        Version: "2021-07-28"
      }
    }
  );

  const data = await search.json();
  const contact = data.contacts?.[0];
  if (!contact) return res.sendStatus(200);

  const message =
    "Hi there, it looks like we weren’t able to finish your appointment by phone. Reply here and I can help you continue booking.";

  await fetch(
    "https://services.leadconnectorhq.com/conversations/messages",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${GHL_API_KEY}`,
        Version: "2021-07-28",
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        type: "SMS",
        contactId: contact.id,
        message
      })
    }
  );

  res.sendStatus(200);
});

app.listen(3000, () => console.log("Webhook running"));
