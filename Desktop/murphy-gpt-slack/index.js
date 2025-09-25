// index.js
// MurphyGPT Slack app (DMs + @mentions) with Google Sheets FAQ + OpenAI fallback
// Folder expectations: .env, client_secret.json, token.json in project root

require('dotenv').config({ path: './.env' });
const fs = require('fs');
const { App, LogLevel } = require('@slack/bolt');
const { google } = require('googleapis');
const OpenAI = require('openai');

// =========================
// 0) ENV & sanity checks
// =========================
const REQUIRED = ['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN', 'OPENAI_API_KEY'];
const missing = REQUIRED.filter((k) => !process.env[k]);
if (missing.length) {
  console.error('❌ Missing env vars:', missing.join(', '));
  console.error('Set them in your shell or a local env file you source before `node index.js`.');
  process.exit(1);
}

// Optional (but recommended) FAQ envs (won’t hard-fail if missing)
if (!process.env.SHEET_ID || !process.env.SHEET_RANGE) {
  console.warn('⚠️  SHEET_ID or SHEET_RANGE missing. FAQ will be disabled until you set them in .env');
}

// =========================
// 1) Slack (Socket Mode)
// =========================
const app = new App({
  token: process.env.SLACK_BOT_TOKEN,      // xoxb-...
  appToken: process.env.SLACK_APP_TOKEN,   // xapp-...
  socketMode: true,
  logLevel: LogLevel.INFO,
});

// =========================
// 2) OpenAI (LLM fallback)
// =========================
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

async function llmAnswer({ text, userContext }) {
  const system = `
You are MurphyGPT, an assistant for The Murphy Group real estate team.
- Be concise, professional, and friendly.
- Prioritize Murphy Group SOPs and best practices (NJ & AZ specifics when relevant).
- If you don't have a confident answer, say what you CAN do or what info you need.
- Never share private data; never invent links.
`;

  const messages = [
    { role: 'system', content: system.trim() },
    ...(userContext ? [{ role: 'user', content: userContext }] : []),
    { role: 'user', content: text || '' },
  ];

  try {
    const resp = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages,
      temperature: 0.3,
    });
    const answer = resp.choices?.[0]?.message?.content?.trim();
    return answer || "I couldn't come up with a confident answer.";
  } catch (err) {
    console.error('OpenAI error:', err?.response?.data || err);
    return "I'm having trouble reaching the assistant right now.";
  }
}

// =========================
// 3) Google Sheets FAQ (OAuth desktop creds)
// =========================
let FAQ_CACHE = [];
let FAQ_CACHE_AT = 0;

function hasFaqConfig() {
  return !!(process.env.SHEET_ID && process.env.SHEET_RANGE && fs.existsSync('./client_secret.json') && fs.existsSync('./token.json'));
}

function getOAuth2Client() {
  const creds = JSON.parse(fs.readFileSync('./client_secret.json', 'utf8'));
  const cfg = creds.installed || creds.web;
  const oAuth2Client = new google.auth.OAuth2(cfg.client_id, cfg.client_secret, cfg.redirect_uris[0]);

  if (!fs.existsSync('./token.json')) {
    throw new Error('token.json not found. Run `node test-oauth.js` once to generate it.');
  }
  oAuth2Client.setCredentials(JSON.parse(fs.readFileSync('./token.json', 'utf8')));
  return oAuth2Client;
}

function getSheets() {
  const auth = getOAuth2Client();
  return google.sheets({ version: 'v4', auth });
}

async function fetchFaqRows() {
  if (!hasFaqConfig()) return [];
  const sheets = getSheets();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.SHEET_ID,
    range: process.env.SHEET_RANGE, // FAQ!A2:C  (A=Type, B=Question, C=Answer)
    valueRenderOption: 'UNFORMATTED_VALUE',
  });
  const rows = res.data.values ?? [];
  return rows
    .filter((r) => (r[1] ?? '').toString().trim() && (r[2] ?? '').toString().trim())
    .map((r, i) => ({
      id: `faq-${i + 1}`,
      type: String(r[0] ?? ''),   // A (Type)
      question: String(r[1]),     // B (Question)
      answer: String(r[2]),       // C (Answer)
    }));
}

async function refreshFaqCache() {
  try {
    const rows = await fetchFaqRows();
    FAQ_CACHE = rows;
    FAQ_CACHE_AT = Date.now();
    console.log(`✅ FAQ loaded: ${FAQ_CACHE.length} item(s) @ ${new Date(FAQ_CACHE_AT).toLocaleString()}`);
  } catch (e) {
    console.warn('⚠️  FAQ refresh failed:', e.message || e);
  }
}

function searchFaqs(query, limit = 3, wantedType = null) {
  const q = (query || '').toLowerCase();
  const terms = q.split(/\s+/).filter(Boolean);
  return FAQ_CACHE
    .map((item) => {
      const hay = `${item.type} ${item.question} ${item.answer}`.toLowerCase();
      let score = 0;
      if (hay.includes(q)) score += 10; // exact phrase boost
      for (const t of terms) if (hay.includes(t)) score += 1;
      return { item, score };
    })
    .filter((x) => x.score > 0)
    .map(({ item, score }) => ({ ...item, _score: score }))
    .filter((it) => !wantedType || (it.type || '').toLowerCase() === wantedType)
    .sort((a, b) => b._score - a._score)
    .slice(0, limit)
    .map(({ _score, ...rest }) => rest);
}

// =========================
/* 4) Helper utils */
// =========================
function parseTypePrefix(text) {
  const m = (text || '').match(/^\s*(buyer|seller|investor|agent|general):\s*(.*)$/i);
  return m ? { type: m[1].toLowerCase(), query: m[2] } : { type: null, query: text };
}

function formatFaqBlocks(hits, query) {
  const blocks = [];
  if (query) {
    blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `Query: *${query}*` }] });
  }
  for (const h of hits) {
    const ans = h.answer.length > 1800 ? h.answer.slice(0, 1800) + '…' : h.answer;
    blocks.push(
      { type: 'section', text: { type: 'mrkdwn', text: `*Q:* ${h.question}\n*A:* ${ans}` } },
      { type: 'context', elements: [{ type: 'mrkdwn', text: h.type ? `Type: ${h.type}` : ' ' }] },
      { type: 'divider' }
    );
  }
  return blocks;
}

// Try FAQ first; if handled, return true. Else false so the normal flow runs.
async function maybeAnswerFromFAQ({ rawText, client, channel, thread_ts, say }) {
  const raw = (rawText || '').trim();
  if (!raw) return false;

  // manual refresh by plain message
  if (/^(refresh|sync)\s+faq$/i.test(raw)) {
    await refreshFaqCache();
    const payload = { text: 'FAQ cache refreshed ✅' };
    if (say) await say(payload);
    else await client.chat.postMessage({ channel, thread_ts, ...payload });
    return true;
  }

  if (!FAQ_CACHE.length) return false; // cache empty or FAQ disabled

  const { type, query } = parseTypePrefix(raw);
  let hits = searchFaqs(query, 3, type);
  if (!hits.length) return false;

  const payload = { text: `Top results for: ${query}`, blocks: formatFaqBlocks(hits, query) };
  if (say) await say(payload);
  else await client.chat.postMessage({ channel, thread_ts, ...payload });
  return true;
}

// =========================
/* 5) Event handlers */
// =========================

// @mentions in channels
app.event('app_mention', async ({ event, client }) => {
  try {
    const raw = (event.text || '').replace(/<@[^>]+>/, '').trim();

    // 1) FAQ pass
    const handled = await maybeAnswerFromFAQ({
      rawText: raw,
      client,
      channel: event.channel,
      thread_ts: event.ts,
    });
    if (handled) return;

    // 2) LLM fallback
    const answer = await llmAnswer({ text: raw });
    await client.chat.postMessage({
      channel: event.channel,
      thread_ts: event.ts,
      text: answer,
    });
  } catch (e) {
    console.error('app_mention error:', e);
  }
});

// DMs to the bot
app.message(async ({ message, say }) => {
  try {
    if (!message || message.subtype || message.bot_id) return;
    if (message.channel_type !== 'im') return;

    const raw = message.text || '';

    // 1) FAQ pass
    const handled = await maybeAnswerFromFAQ({ rawText: raw, say });
    if (handled) return;

    // 2) LLM fallback
    const answer = await llmAnswer({ text: raw });
    await say(answer);
  } catch (e) {
    console.error('message handler error:', e);
  }
});

// =========================
/* 6) Boot */
// =========================
(async () => {
  // Warm FAQ cache (non-fatal if FAQ not configured)
  await refreshFaqCache();
  // Keep it fresh every 5 minutes
  setInterval(() => refreshFaqCache().catch(console.error), 5 * 60 * 1000);

  await app.start(process.env.PORT || 3000);
  console.log('🚀 MurphyGPT is running (DMs + @mentions). FAQ ready:', FAQ_CACHE.length, 'items');
})();
