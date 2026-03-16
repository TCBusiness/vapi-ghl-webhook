const express = require("express");
const fetch = require("node-fetch");

const app = express();
app.use(express.json());

const GHL_API_KEY = process.env.GHL_API_KEY;
const GHL_LOCATION_ID = process.env.GHL_LOCATION_ID;

app.post("/vapi-webhook", async (req, res) => {
  console.log("✅ Webhook recibido de Vapi");

  // ✅ RESPONDER INMEDIATAMENTE
  res.status(200).json({ received: true });

  // ✅ PROCESAR EN BACKGROUND
  try {
    const body = req.body;

    if (body.message?.type !== "end-of-call-report") return;

    const success = body.message.analysis?.successEvaluation === "true";

    if (success) {
      console.log("✅ Appointment creado. No se envía SMS.");
      return;
    }

    console.log("⚠️ No hubo appointment. Enviando SMS...");

    await sendSMSLogic(body); // tu función actual que llama GHL

  } catch (error) {
    console.error("❌ Error procesando webhook:", error);
  }
});
