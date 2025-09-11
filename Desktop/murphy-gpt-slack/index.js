// index.js
require("dotenv").config();
const { App, LogLevel } = require("@slack/bolt");
const OpenAI = require("openai");

// Check env vars
const missing = ["SLACK_BOT_TOKEN", "SLACK_APP_TOKEN", "OPENAI_API_KEY"].filter(k => !process.env[k]);
if (missing.length) {
  console.error("❌ Missing env vars:", missing.join(", "));
  process.exit(1);
}

// Init Slack (Socket Mode)
const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  appToken: process.env.SLACK_APP_TOKEN,
  socketMode: true,
  logLevel: LogLevel.INFO,
});

// Init OpenAI
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const SYSTEM = `You are MurphyGPT for The Murphy Group.
Enforce: speed-to-lead <= 5 minutes; 7 attempts in 7 days; monthly past-client touches.
Be concise, action-oriented. End with "The Murphy Group | mgsells.com".`;

async function askOpenAI(text) {
  try {
    const resp = await openai.responses.create({
      model: "gpt-4.1-mini",
      input: [
        { role: "system", content: SYSTEM },
        { role: "user", content: text || "Help" },
      ],
    });
    return resp.output_text || "(No text output)";
  } catch (e) {
    console.error("❌ OpenAI error:", e.message);
    return "I hit an issue reaching OpenAI. The Murphy Group | mgsells.com";
  }
}

// @mentions in channels
app.event("app_mention", async ({ event, say }) => {
  console.log("ℹ️ app_mention:", event.text);
  const q = (event.text || "").replace(/<@\\w+>/g, "").trim();
  const a = await askOpenAI(q);
  await say({ thread_ts: event.ts, text: a });
});

// Direct messages
app.message(async ({ message, say }) => {
  if (message?.channel_type === "im" && !message.bot_id) {
    console.log("ℹ️ DM:", message.text);
    const a = await askOpenAI(message.text);
    await say(a);
  }
});

(async () => {
  try {
    await app.start(process.env.PORT || 3000);
    console.log("✅ MurphyGPT is running via Socket Mode. Invite it to a channel and DM it.");
  } catch (e) {
    console.error("❌ Bolt failed to start:", e);
    process.exit(1);
  }
})();
