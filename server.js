{ app.post("/vapi-webhook", async (req, res) => {
  console.log("✅ Webhook received from Vapi");

  // Respond immediately (prevents timeout)
  res.status(200).json({ received: true });

  try {
    const body = req.body;

    console.log("📦 Full payload:", JSON.stringify(body, null, 2));

    const phone =
      body.message?.call?.customer?.number ||
      body.message?.customer?.number ||
      body.customer?.number;

    console.log("📞 Extracted phone:", phone);

    if (!phone) {
      console.log("❌ No phone number found.");
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
    console.error("❌ Webhook processing error:", err);
  }
});;
