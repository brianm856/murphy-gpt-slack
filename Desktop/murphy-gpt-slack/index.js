// index.js
// MurphyGPT Slack app: Google Sheets FAQ + Google Drive SOPs + OpenAI fallback
// Works locally (client_secret.json/token.json) OR on Render via env-only creds.

require('dotenv').config();
const fs = require('fs');
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
/** 2) OpenAI fallback */
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
// 2b) Hybrid doc-grounded answer (LLM presenter, SOP/FAQ brain)
// =========================
function tokenize(s) { return (s || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean); }

function scoreItem(q, item) {
  const qTokens = new Set(tokenize(q));
  const fields = [
    { text: item.title,   w: 4 },
    { text: item.summary, w: 3 },
    { text: item.content, w: 1 },
  ];
  let score = 0;
  for (const { text, w } of fields) {
    const toks = tokenize(text);
    for (const t of toks) if (qTokens.has(t)) score += w;
  }
  if ((item.title || '').toLowerCase().includes(q.toLowerCase())) score += 6;   // verbatim boost
  if ((item.content || '').toLowerCase().includes(q.toLowerCase())) score += 2;
  return score;
}

function bestMatchFrom(arr, q) {
  if (!Array.isArray(arr) || !arr.length) return null;
  let best = null;
  for (const it of arr) {
    const s = scoreItem(q, it);
    if (!best || s > best.score) best = { item: it, score: s };
  }
  return best;
}

async function docGroundedAnswer({ text, force }) {
  const q = (text || '').trim();
  if (!q) return "What would you like to know?";

  const wantSOP = !force || force === 'sop';
  const wantFAQ = !force || force === 'faq';

  let cand = null;
  if (wantSOP && typeof SOP_CACHE !== 'undefined' && SOP_CACHE.length) {
    const b = bestMatchFrom(SOP_CACHE, q);
    if (b && b.score >= 6) cand = { type: 'sop', ...b };
  }
  if (!cand && wantFAQ && typeof FAQ_CACHE !== 'undefined' && FAQ_CACHE.length) {
    const b = bestMatchFrom(FAQ_CACHE, q);
    if (b && b.score >= 6) cand = { type: 'faq', ...b };
  }

  if (cand) {
    const doc = cand.item;
    const link = doc.url && doc.url !== '#' ? doc.url : '';
    const label = cand.type === 'sop' ? 'SOP' : 'FAQ';

    // Ask the LLM to present a short, grounded answer (no drift)
    const system = `
You are MurphyGPT. Give a SHORT, conversational answer grounded ONLY in the provided document.
- If the question is directly answered in the doc, answer in 1–2 sentences.
- Begin with "Per the ${label}: ${doc.title}, ..." when it fits naturally.
- Include specific numbers/steps if present (deadlines, fees, forms).
- Then add a new line: "Link: ${link || 'N/A'}".
- Do not invent facts or links. If not in the doc, don't claim it.
`.trim();

    const user = `Question: ${q}\n\nDocument Title: ${doc.title}\nSummary: ${doc.summary || ''}\nContent:\n${(doc.content || '').slice(0, 7000)}`;

    try {
      const resp = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        temperature: 0.2,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      });
      const content = resp.choices?.[0]?.message?.content?.trim();
      if (content) return content;
    } catch (e) {
      console.error('docGroundedAnswer LLM error:', e?.response?.data || e);
    }

    // Plain fallback if the LLM call fails
    return `Per the ${label}: *${doc.title}* — ${doc.summary || 'see details in the document.'}${link ? `\nLink: ${link}` : ''}`;
  }

  // No doc match → pure LLM fallback
  return await llmAnswer({ text: q });
}


// =========================
/** 3) Google OAuth helper (env-first, file fallback) */
// =========================
async function getOAuth() {
  // Load Google client (from Render env, or local file)
  let creds;
  try {
    if (process.env.GOOGLE_CLIENT_JSON) {
      creds = JSON.parse(process.env.GOOGLE_CLIENT_JSON);
    } else if (fs.existsSync('client_secret.json')) {
      creds = JSON.parse(fs.readFileSync('client_secret.json', 'utf8'));
    } else {
      throw new Error('Missing Google client JSON. Set GOOGLE_CLIENT_JSON or include client_secret.json');
    }
  } catch (e) {
    console.error('Invalid GOOGLE_CLIENT_JSON / client_secret.json:', e.message || e);
    throw e;
  }

  const cfg = creds.installed || creds.web;
  if (!cfg || !cfg.client_id || !cfg.client_secret) {
    throw new Error('Google client JSON must include .installed or .web with client_id and client_secret');
  }

  const oAuth2Client = new google.auth.OAuth2(
    cfg.client_id,
    cfg.client_secret,
    (cfg.redirect_uris && cfg.redirect_uris[0]) || 'http://localhost'
  );

  // Load token (from Render env, or local file)
  let token;
  try {
    if (process.env.GOOGLE_TOKEN_JSON) {
      token = JSON.parse(process.env.GOOGLE_TOKEN_JSON);
    } else if (fs.existsSync('token.json')) {
      token = JSON.parse(fs.readFileSync('token.json', 'utf8'));
    } else {
      throw new Error('Missing Google token. Set GOOGLE_TOKEN_JSON or include token.json');
    }
  } catch (e) {
    console.error('Invalid GOOGLE_TOKEN_JSON / token.json:', e.message || e);
    throw e;
  }

  oAuth2Client.setCredentials(token);
  return oAuth2Client;
}

// =========================
/** 4) FAQ cache (Google Sheets) */
// =========================
let FAQ_CACHE = [];
let FAQ_CACHE_AT = 0;

function hasFaqConfig() {
  return Boolean(process.env.SHEET_ID && process.env.SHEET_RANGE);
}

async function refreshFaqCache() {
  if (!hasFaqConfig()) {
    FAQ_CACHE = [];
    return;
  }
  try {
    const auth = await getOAuth();
    const sheets = google.sheets({ version: 'v4', auth });
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.SHEET_ID,
      range: process.env.SHEET_RANGE, // e.g. FAQ!A2:C (Type | Question | Answer)
      valueRenderOption: 'UNFORMATTED_VALUE',
    });

    const rows = res.data.values ?? [];
    FAQ_CACHE = rows
      .map((r, i) => {
        const type = String(r?.[0] ?? '').trim();
        const q = String(r?.[1] ?? '').trim();
        const a = String(r?.[2] ?? '').trim();
        if (!q || !a) return null;
        return { id: `faq-${i + 1}`, type, question: q, answer: a };
      })
      .filter(Boolean);
    FAQ_CACHE_AT = Date.now();
    console.log(`✅ FAQ loaded: ${FAQ_CACHE.length} item(s) @ ${new Date().toLocaleString()}`);
  } catch (e) {
    console.warn('⚠️  FAQ refresh failed:', e.message || e);
  }
}

function findFAQ(query) {
  const q = (query || '').toLowerCase();
  let best = null;
  let bestScore = 0;
  for (const item of FAQ_CACHE) {
    const hay = (item.question + ' ' + item.answer + ' ' + (item.type || '')).toLowerCase();
    let score = 0;
    if (hay.includes(q)) score += 10;
    for (const w of q.split(/\s+/).filter(Boolean)) {
      if (hay.includes(w)) score += 1;
    }
    if (score > bestScore) { best = item; bestScore = score; }
  }
  return best;
}

// =========================
/** 5) SOP cache (Google Drive folder of Google Docs) */
// =========================
let SOP_CACHE = [];
let SOP_CACHE_AT = 0;

function getSOPs() { return SOP_CACHE; }

function docText(el) {
  if (!el) return '';
  if (el.paragraph) {
    return (el.paragraph.elements || [])
      .map((e) => e.textRun?.content || '')
      .join('');
  }
  if (el.table) {
    return (el.table.tableRows || []).map((row) =>
      (row.tableCells || []).map((cell) =>
        (cell.content || []).map(docText).join('')
      ).join('\t')
    ).join('\n');
  }
  if (el.sectionBreak) return '\n';
  return '';
}

async function refreshSopsFromDrive() {
  try {
    const folderId = process.env.SOP_DRIVE_FOLDER_ID;
    if (!folderId) {
      console.warn('⚠️  SOP_DRIVE_FOLDER_ID not set. SOP layer disabled.');
      SOP_CACHE = [];
      return;
    }
    const auth = await getOAuth();
    const drive = google.drive({ version: 'v3', auth });
    const docsApi = google.docs({ version: 'v1', auth });

    const list = await drive.files.list({
      q: `'${folderId}' in parents and mimeType='application/vnd.google-apps.document' and trashed=false`,
      fields: 'files(id,name)',
      pageSize: 1000,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });

    const files = list.data.files || [];
    const out = [];
    for (const f of files) {
      try {
        const doc = await docsApi.documents.get({ documentId: f.id });
        const body = doc.data.body?.content || [];
        const text = body.map(docText).join('').replace(/\s+\n/g, '\n').trim();
        out.push({
          id: f.id,
          title: f.name,
          summary: text.slice(0, 200).replace(/\n/g, ' ') + (text.length > 200 ? '…' : ''),
          tags: [],
          url: `https://docs.google.com/document/d/${f.id}/view`,
          content: text,
        });
      } catch (e) {
        console.warn(`⚠️  Could not read doc ${f.name} (${f.id}):`, e.message || e);
      }
    }
    SOP_CACHE = out;
    SOP_CACHE_AT = Date.now();
    console.log(`✅ SOPs loaded: ${SOP_CACHE.length} item(s) @ ${new Date().toLocaleString()}`);
  } catch (e) {
    console.warn('⚠️  SOP refresh failed:', e.message || e);
  }
}

function findSOP(query) {
  const q = (query || '').toLowerCase();
  let best = null;
  let bestScore = 0;
  for (const item of SOP_CACHE) {
    const hay = (item.title + ' ' + item.content).toLowerCase();
    let score = 0;
    if (hay.includes(q)) score += 10;
    for (const w of q.split(/\s+/).filter(Boolean)) {
      if (hay.includes(w)) score += 1;
    }
    // mild boost if query words in title
    for (const w of q.split(/\s+/).filter(Boolean)) {
      if (item.title.toLowerCase().includes(w)) score += 2;
    }
    if (score > bestScore) { best = item; bestScore = score; }
  }
  return best;
}

function shouldPreferSOP(text) {
  const t = (text || '').toLowerCase();
  if (/^sop\s*:/.test(t)) return true; // explicit
  const hints = [
    'listing to close','listing','open house','circle calling','referral',
    'zillow','homelight','onboarding','exp','buyer pending','binsr','inspection',
  ];
  return hints.some(h => t.includes(h));
}

// =========================
/** 6) Formatting helpers */
// =========================
function formatSopAnswer(item) {
  const snippet = item.content.split('\n').slice(0, 40).join('\n'); // first ~40 lines
  return `*${item.title}*\n<${item.url}|Open in Google Docs>\n\n${snippet}`;
}
function formatFaqAnswer(item) {
  const t = item.type ? `Type: ${item.type}\n` : '';
  return `*Q:* ${item.question}\n*A:* ${item.answer}\n${t}`.trim();
}

// =========================
/** 7) Slack message handler */
// =========================
app.message(async ({ message, say }) => {
  // === HYBRID HANDLER (short-circuit) ===
  try {
    const text = (message.text || '').trim();
    if (!text) return;
// --- Chit-chat & trivial message guard ---
const ACK_RE = /^(?:thanks|thank you|thx|ty|👍|👌|🙏|great|got it|sounds good|perfect|awesome|nice|cool|ok|okay|k|yup|yep|roger|copy|understood|done|appreciate it)\b[.!]?\s*$/i;
const tokens = text.split(/\s+/).filter(Boolean);
const looksLikeQuestion =
  /(\?|^\s*(how|what|when|where|why|which|who|can|should|do|does|did|is|are|list|steps|process|policy|sop|guide|checklist)\b)/i.test(text);

// If it's a quick acknowledgement, reply lightly and stop here
if (ACK_RE.test(text)) {
  await say("Anytime! 🙌");
  return;
}

// If it's very short and not question-like, don't run SOP/FAQ search
if (tokens.length < 3 && !looksLikeQuestion && !/^sop:|^faq:/i.test(text)) {
  await say("I’m here when you need me—ask a question or say `sop: <topic>` anytime.");
  return;
}

    // Admin refresh commands
    if (/^refresh\s+sops?$/i.test(text)) {
      if (typeof refreshSOPCache === 'function') {
        await refreshSOPCache();
      } else if (typeof refreshSOPs === 'function') {
        await refreshSOPs();
      } else if (typeof loadSOPsFromDrive === 'function') {
        await loadSOPsFromDrive();
      } else if (typeof refreshSOPDrive === 'function') {
        await refreshSOPDrive();
      } else {
        console.warn('No SOP refresh function found in index.js');
      }
      await say('SOPs refreshed from Google Drive ✅');
      return;
    }

    if (/^refresh\s+faq$/i.test(text)) {
      if (typeof refreshFaqCache === 'function') {
        await refreshFaqCache();
      } else if (typeof refreshFAQ === 'function') {
        await refreshFAQ();
      } else if (typeof loadFAQFromSheet === 'function') {
        await loadFAQFromSheet();
      } else {
        console.warn('No FAQ refresh function found in index.js');
      }
      await say('FAQ refreshed from Google Sheets ✅');
      return;
    }

    // Forced modes: "sop: ..." or "faq: ..."
    let force;
    let q = text;
    const m = text.match(/^\s*(sop|faq)\s*:\s*(.+)$/i);
    if (m) { force = m[1].toLowerCase(); q = m[2]; }

    const answer = await docGroundedAnswer({ text: q, force });
    await say(answer);
    return; // prevent old code below from running
  } catch (err) {
    console.error('hybrid handler error:', err);
    await say("Sorry, I hit an error trying to answer that.");
    return;
  }
  // === END HYBRID HANDLER ===

  try {
    const text = (message.text || '').trim();
    if (!text) return;

    // health command
    if (/^\s*ping\s*$/i.test(text)) {
      return say(`FAQ: ${FAQ_CACHE.length} (updated ${new Date(FAQ_CACHE_AT).toLocaleTimeString() || 'n/a'}) • SOPs: ${SOP_CACHE.length} (updated ${new Date(SOP_CACHE_AT).toLocaleTimeString() || 'n/a'})`);
    }

    // manual refresh
    if (/^\s*refresh sops\s*$/i.test(text)) {
      await refreshSopsFromDrive();
      return say('SOPs refreshed from Google Drive ✅');
    }
    if (/^\s*refresh faq\s*$/i.test(text)) {
      await refreshFaqCache();
      return say('FAQ refreshed from Google Sheets ✅');
    }

    // route
    const forceSop = /^sop\s*:/i.test(text);
    const query = forceSop ? text.replace(/^sop\s*:/i, '').trim() : text;

    const preferSop = forceSop || shouldPreferSOP(text);
    const sop = findSOP(query);
    const faq = findFAQ(query);

    if (preferSop && sop) {
      return say(formatSopAnswer(sop));
    }
    if (sop && !faq) {
      return say(formatSopAnswer(sop));
    }
    if (faq && !sop) {
      return say(formatFaqAnswer(faq));
    }
    if (sop && faq) {
      // When both exist, give SOP first, then quick FAQ follow-up as thread tip
      await say(formatSopAnswer(sop));
      return; // keep simple
    }

    // fallback
    const fallback = await llmAnswer({ text });
    return say(fallback);
  } catch (e) {
    console.error('message handler error:', e);
    return say('Sorry, I hit an error handling that message.');
  }
});

// =========================
/** 8) Bootstrap */
// =========================
(async () => {
  await refreshSopsFromDrive().catch(console.error);
  await refreshFaqCache().catch(console.error);

  // periodic refresh
  setInterval(() => refreshFaqCache().catch(console.error), 5 * 60 * 1000);
  setInterval(() => refreshSopsFromDrive().catch(console.error), 10 * 60 * 1000);

  await app.start();
  console.log(`🚀 MurphyGPT running. FAQ items: ${FAQ_CACHE.length} SOP items: ${SOP_CACHE.length}`);
})();
