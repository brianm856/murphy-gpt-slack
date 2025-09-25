// index.js
// MurphyGPT Slack app (DMs + @mentions) with Google Sheets FAQ + local SOP search + OpenAI fallback
// Works locally (client_secret.json/token.json) OR on Render using env-only creds.

require('dotenv').config({ path: './.env' });
const fs = require('fs');
const path = require('path');
const { App, LogLevel } = require('@slack/bolt');
const { google } = require('googleapis');
const OpenAI = require('openai');

// =========================
// 0) ENV checks
// =========================
const REQUIRED = ['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN', 'OPENAI_API_KEY'];
const missing = REQUIRED.filter((k) => !process.env[k]);
if (missing.length) {
  console.error('❌ Missing env vars:', missing.join(', '));
  process.exit(1);
}
if (!process.env.SHEET_ID || !process.env.SHEET_RANGE) {
  console.warn('⚠️  SHEET_ID or SHEET_RANGE missing. FAQ layer will be disabled until set.');
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
// 2) OpenAI fallback
// =========================
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

async function llmAnswer({ text }) {
  const system = `
You are MurphyGPT for The Murphy Group real estate team.
- Be concise, practical, and accurate.
- Prefer Murphy Group SOPs and local rules (NJ & AZ) when applicable.
- If unsure, say what you need, never invent links.
`.trim();

  try {
    const resp = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      temperature: 0.3,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: text || '' },
      ],
    });
    return resp.choices?.[0]?.message?.content?.trim() || "I couldn't find a confident answer.";
  } catch (err) {
    console.error('OpenAI error:', err?.response?.data || err);
    return "I'm having trouble reaching the assistant right now.";
  }
}

// =========================
// 3) Google Sheets FAQ
// =========================
let FAQ_CACHE = [];
let FAQ_CACHE_AT = 0;

function hasFaqConfig() {
  const hasSheet = !!(process.env.SHEET_ID && process.env.SHEET_RANGE);
  const hasFiles = fs.existsSync('./client_secret.json') && fs.existsSync('./token.json');
  const hasEnv = !!(process.env.GOOGLE_CLIENT_JSON && process.env.GOOGLE_TOKEN_JSON);
  return hasSheet && (hasFiles || hasEnv);
}

function getOAuth2Client() {
  // Prefer env vars in production (Render); fall back to local files for dev
  const clientJson = process.env.GOOGLE_CLIENT_JSON
    ? JSON.parse(process.env.GOOGLE_CLIENT_JSON)
    : JSON.parse(fs.readFileSync('./client_secret.json', 'utf8'));

  const token = process.env.GOOGLE_TOKEN_JSON
    ? JSON.parse(process.env.GOOGLE_TOKEN_JSON)
    : JSON.parse(fs.readFileSync('./token.json', 'utf8'));

  const cfg = clientJson.installed || clientJson.web;
  const oAuth2Client = new google.auth.OAuth2(cfg.client_id, cfg.client_secret, cfg.redirect_uris[0]);
  oAuth2Client.setCredentials(token);
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
    range: process.env.SHEET_RANGE, // e.g., FAQ!A2:C (A=Type, B=Question, C=Answer)
    valueRenderOption: 'UNFORMATTED_VALUE',
  });
  const rows = res.data.values ?? [];
  return rows
    .filter((r) => (r[1] ?? '').toString().trim() && (r[2] ?? '').toString().trim())
    .map((r, i) => ({
      id: `faq-${i + 1}`,
      type: String(r[0] ?? ''),
      question: String(r[1]),
      answer: String(r[2]),
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
      if (hay.includes(q)) score += 10;
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
// 4) Local SOP search (sops.json)
// =========================
const SOPS_PATH = path.resolve('./sops.json');
let SOPS = [];
let SOPS_AT = 0;

function loadSOPs() {
  if (!fs.existsSync(SOPS_PATH)) {
    console.warn('⚠️  sops.json not found. SOP layer disabled until you create it.');
    SOPS = [];
    return;
  }
  try {
    const raw = fs.readFileSync(SOPS_PATH, 'utf8');
    const data = JSON.parse(raw);
    if (!Array.isArray(data)) throw new Error('sops.json must be an array');
    SOPS = data;
    SOPS_AT = Date.now();
    console.log(`✅ SOPs loaded: ${SOPS.length} item(s) @ ${new Date(SOPS_AT).toLocaleString()}`);
  } catch (e) {
    console.error('❌ Failed to load sops.json:', e.message || e);
    SOPS = [];
  }
}
function searchSOPs(query, limit = 3) {
  if (!SOPS.length) return [];
  const q = (query || '').toLowerCase();
  const terms = q.split(/\s+/).filter(Boolean);

  return SOPS
    .map((s) => {
      const hay = `${s.title} ${s.summary || ''} ${(s.tags || []).join(' ')} ${s.content || ''}`.toLowerCase();
      let score = 0;
      if (hay.includes(q)) score += 10;
      for (const t of terms) if (hay.includes(t)) score += 1;
      return { s, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ s }) => s);
}

// =========================
// 5) Helpers
// =========================
function parseTypePrefix(text) {
  const m = (text || '').match(/^\s*(buyer|seller|investor|agent|general):\s*(.*)$/i);
  return m ? { type: m[1].toLowerCase(), query: m[2] } : { type: null, query: text };
}
function formatFaqBlocks(hits, query) {
  const blocks = [];
  if (query) blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `Query: *${query}*` }] });
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
function formatSopBlocks(hits, query) {
  const blocks = [];
  if (query) blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `Query: *${query}*` }] });
  for (const h of hits) {
    const lines = [];
    if (h.summary) lines.push(h.summary);
    const body = lines.join('\n');
    blocks.push(
      {
        type: 'section',
        text: { type: 'mrkdwn', text: `*${h.title}*\n${body}` },
        accessory: h.url ? { type: 'button', text: { type: 'plain_text', text: 'Open SOP' }, url: h.url } : undefined
      },
      { type: 'context', elements: [{ type: 'mrkdwn', text: h.tags?.length ? `Tags: ${h.tags.join(', ')}` : ' ' }] },
      { type: 'divider' }
    );
  }

function shouldPreferSOP(raw) {
  const q = (raw || '').toLowerCase();
  if (/^\s*sop:\s*/i.test(q)) return true;   // manual override via "sop: ..."
  const SOP_KEYS = [
    'listing to close','open house','circle calling','homelight','referral',
    'zillow flex','onboarding','exp az','exp nj','buyer pending','30/60/90',
    'success plan'
  ];
  return SOP_KEYS.some(k => q.includes(k));
}

  return blocks;
}

// Try FAQ; if not handled, try SOP; else fall back to LLM
async function handleQueryFlow({ rawText, client, channel, thread_ts, say }) {
  const raw = (rawText || '').trim();
  if (!raw) return;

  // maintenance commands
  if (/^(refresh|sync)\s+faq$/i.test(raw)) {
    await refreshFaqCache();
    const payload = { text: 'FAQ cache refreshed ✅' };
    if (say) await say(payload); else await client.chat.postMessage({ channel, thread_ts, ...payload });
    return;
  }
  if (/^(refresh|reload)\s+sops?$/i.test(raw)) {
    loadSOPs();
    const payload = { text: 'SOPs reloaded from sops.json ✅' };
    if (say) await say(payload); else await client.chat.postMessage({ channel, thread_ts, ...payload });
    return;
  }

  const preferSOP = shouldPreferSOP(raw);

  // If it looks like an SOP query, try SOPs first
  if (preferSOP) {
    const sHitsFirst = searchSOPs(raw, 3);
    if (sHitsFirst.length) {
      const payload = { text: `Top SOPs for: ${raw}`, blocks: formatSopBlocks(sHitsFirst, raw) };
      if (say) await say(payload); else await client.chat.postMessage({ channel, thread_ts, ...payload });
      return;
    }
  }

  // FAQ search
  if (FAQ_CACHE.length) {
    const { type, query } = parseTypePrefix(raw);
    const fHits = searchFaqs(query, 3, type);
    if (fHits.length) {
      const payload = { text: `Top results for: ${query}`, blocks: formatFaqBlocks(fHits, query) };
      if (say) await say(payload); else await client.chat.postMessage({ channel, thread_ts, ...payload });
      return;
    }
  }

  // SOP fallback (when not strongly SOP-looking)
  if (!preferSOP) {
    const sHits = searchSOPs(raw, 3);
    if (sHits.length) {
      const payload = { text: `Top SOPs for: ${raw}`, blocks: formatSopBlocks(sHits, raw) };
      if (say) await say(payload); else await client.chat.postMessage({ channel, thread_ts, ...payload });
      return;
    }
  }

  // LLM fallback
  const answer = await llmAnswer({ text: raw });
  if (say) await say(answer); else await client.chat.postMessage({ channel, thread_ts, text: answer });
}

// =========================
// 6) Slack event handlers
// =========================
app.event('app_mention', async ({ event, client }) => {
  try {
    const raw = (event.text || '').replace(/<@[^>]+>/, '').trim();
    await handleQueryFlow({ rawText: raw, client, channel: event.channel, thread_ts: event.ts });
  } catch (e) {
    console.error('app_mention error:', e);
  }
});

app.message(async ({ message, say }) => {
  try {
    if (!message || message.subtype || message.bot_id) return;
    if (message.channel_type !== 'im') return; // only DMs here
    const raw = message.text || '';
    await handleQueryFlow({ rawText: raw, say });
  } catch (e) {
    console.error('message handler error:', e);
  }
});

// =========================
// 7) Boot
// =========================
(async () => {
  // Load SOPs (from sops.json) and FAQs (from Google Sheet)
  loadSOPs();
  await refreshFaqCache();                      // non-fatal if FAQ not configured
  setInterval(() => refreshFaqCache().catch(console.error), 5 * 60 * 1000); // keep FAQs fresh

  await app.start(process.env.PORT || 3000);
  console.log('🚀 MurphyGPT running. FAQ items:', FAQ_CACHE.length, 'SOP items:', SOPS.length);
})();

