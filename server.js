require('dotenv').config();
const express = require('express'), mongoose = require('mongoose'), bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken'), cron = require('node-cron'), path = require('path');
const { PORT = 3000, MONGODB_URI, JWT_SECRET, GITHUB_TOKEN, PING_CRON = '*/5 * * * *' } = process.env;
if (!MONGODB_URI || !JWT_SECRET) { console.error('Set MONGODB_URI and JWT_SECRET in .env'); process.exit(1); }

const User = mongoose.model('User', new mongoose.Schema({ name: String, email: { type: String, unique: true }, pw: String }));
const Monitor = mongoose.model('Monitor', new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, index: true }, name: String, url: String, sleepy: Boolean,
  checks: [{ _id: false, ok: Boolean, ms: Number, cold: Boolean, t: Number }]
}));

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '10kb' }));
const wrap = f => (q, r, n) => f(q, r, n).catch(n);
const sign = u => jwt.sign({ id: u._id }, JWT_SECRET, { expiresIn: '7d' });
const auth = (q, r, n) => {
  try { q.uid = jwt.verify((q.headers.authorization || '').slice(7), JWT_SECRET).id; n(); }
  catch (e) { r.status(401).json({ error: 'Please log in again.' }); }
};

// basic brute-force guard for auth routes
const hits = new Map(); setInterval(() => hits.clear(), 15 * 60 * 1000).unref();
app.use('/api/auth', (q, r, n) => {
  const c = (hits.get(q.ip) || 0) + 1; hits.set(q.ip, c);
  c > 30 ? r.status(429).json({ error: 'Too many attempts. Try again in 15 minutes.' }) : n();
});

app.get('/api/health', (q, r) => r.json({ ok: true }));

app.post('/api/auth/signup', wrap(async (q, r) => {
  const { name, email, password } = q.body || {};
  if (!name || !/^\S+@\S+\.\S+$/.test(email || '') || String(password || '').length < 6)
    return r.status(400).json({ error: 'Enter your name, a valid email and a password of 6 or more characters.' });
  const e = email.toLowerCase();
  if (await User.findOne({ email: e })) return r.status(409).json({ error: 'An account with this email already exists. Log in instead.' });
  const u = await User.create({ name: String(name).slice(0, 40), email: e, pw: await bcrypt.hash(password, 10) });
  r.json({ token: sign(u), user: { name: u.name, email: u.email } });
}));

app.post('/api/auth/login', wrap(async (q, r) => {
  const { email, password } = q.body || {};
  const u = await User.findOne({ email: String(email || '').toLowerCase() });
  if (!u || !(await bcrypt.compare(String(password || ''), u.pw)))
    return r.status(401).json({ error: 'Wrong email or password. Check them and try again.' });
  r.json({ token: sign(u), user: { name: u.name, email: u.email } });
}));

// only public http(s) URLs, so users cannot aim the pinger at internal addresses
const priv = h => /^(localhost|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|0\.|\[?::1)/i.test(h);
const okUrl = v => { try { const u = new URL(v); return /^https?:$/.test(u.protocol) && !priv(u.hostname); } catch (e) { return false; } };

async function ping(m) {
  const t0 = Date.now(); let ok = false, ms = 0;
  try {
    const res = await fetch(m.url, { signal: AbortSignal.timeout(45000), redirect: 'follow', headers: { 'User-Agent': 'PulseMonitor/1.0' } });
    ok = res.status < 500; ms = Date.now() - t0;
  } catch (e) { /* timeout or network error counts as down */ }
  m.checks.push({ ok, ms: ok ? ms : 0, cold: ok && ms > 5000, t: Date.now() });
  if (m.checks.length > 60) m.checks.splice(0, m.checks.length - 60);
  await m.save();
}

app.get('/api/monitors', auth, wrap(async (q, r) => r.json(await Monitor.find({ user: q.uid }).sort({ _id: -1 }).lean())));
app.post('/api/monitors', auth, wrap(async (q, r) => {
  const { name, url, sleepy } = q.body || {};
  if (!name || !okUrl(url)) return r.status(400).json({ error: 'Enter a name and a public http(s) URL.' });
  if (await Monitor.countDocuments({ user: q.uid }) >= 20) return r.status(400).json({ error: 'You can monitor up to 20 apps.' });
  const m = await Monitor.create({ user: q.uid, name: String(name).slice(0, 40), url, sleepy: !!sleepy, checks: [] });
  await ping(m); r.json(m);
}));
app.post('/api/monitors/:id/ping', auth, wrap(async (q, r) => {
  const m = await Monitor.findOne({ _id: q.params.id, user: q.uid });
  if (!m) return r.sendStatus(404); await ping(m); r.json(m);
}));
app.delete('/api/monitors/:id', auth, wrap(async (q, r) => { await Monitor.deleteOne({ _id: q.params.id, user: q.uid }); r.json({ ok: true }); }));

// GitHub repos: the token stays on the server
app.get('/api/github/:u', auth, wrap(async (q, r) => {
  const u = q.params.u;
  if (!/^[a-z\d](?:[a-z\d-]{0,38})$/i.test(u)) return r.status(400).json({ error: 'Enter a valid GitHub username.' });
  const h = { Accept: 'application/vnd.github+json', 'User-Agent': 'PulseMonitor' };
  if (GITHUB_TOKEN) h.Authorization = 'Bearer ' + GITHUB_TOKEN;
  const out = [];
  for (let p = 1; p <= 5; p++) {
    const g = await fetch(`https://api.github.com/users/${u}/repos?per_page=100&sort=updated&page=${p}`, { headers: h });
    if (g.status === 404) return r.status(404).json({ error: 'GitHub user not found.' });
    if (!g.ok) return r.status(502).json({ error: [401, 403].includes(g.status) ? 'GitHub rejected the request. Check GITHUB_TOKEN or wait for the rate limit to reset.' : 'GitHub request failed.' });
    const a = await g.json(); out.push(...a); if (a.length < 100) break;
  }
  r.json(out.map(x => ({
    name: x.name, description: x.description, language: x.language, stars: x.stargazers_count, forks: x.forks_count,
    updated: x.pushed_at || x.updated_at, url: x.html_url, homepage: /^https?:\/\//.test(x.homepage || '') ? x.homepage : ''
  })));
}));

// public status page (shows the name and health only, never the URL)
app.get('/status/:id', wrap(async (q, r) => {
  const m = await Monitor.findById(q.params.id).lean().catch(() => null);
  if (!m) return r.status(404).send('Status page not found.');
  const c = m.checks, up = c.length ? Math.round(c.filter(x => x.ok).length / c.length * 1000) / 10 : 100, l = c[c.length - 1] || { ok: true };
  const e = s => String(s).replace(/[&<>"]/g, x => '&#' + x.charCodeAt(0) + ';');
  r.send(`<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>${e(m.name)} status</title><body style="margin:0;min-height:100vh;background:#020604;color:#d9ffe8;font:500 15px ui-monospace,Menlo,Consolas,monospace;display:grid;place-items:center"><main style="width:min(560px,92vw);padding:28px;border:1px solid #0f6b35;border-radius:14px;box-shadow:0 0 30px #00ff6622"><h1 style="margin:0;color:#00ff66;text-shadow:0 0 14px #00ff66">${e(m.name)}</h1><p style="color:${l.ok ? '#00ff66' : '#ff4d5e'}">${l.ok ? 'All systems operational' : 'Outage detected'}</p><p>Uptime ${up}% over the last ${c.length} checks</p><div style="display:flex;gap:3px;height:30px">${c.map(x => `<i style="flex:1;border-radius:2px;background:${x.ok ? (x.cold ? '#ffc83d' : '#00ff66') : '#ff4d5e'}"></i>`).join('')}</div><p style="color:#86c9a2;font-size:12px">Powered by Pulse</p></main>`);
}));

app.use(express.static(path.join(__dirname, 'public')));
app.use((err, q, r, n) => { console.error(err); r.status(err.name === 'CastError' ? 400 : 500).json({ error: 'Something went wrong. Try again.' }); });

let busy = false;
cron.schedule(PING_CRON, async () => {
  if (busy) return; busy = true;
  try {
    const all = await Monitor.find();
    for (let i = 0; i < all.length; i += 5) await Promise.all(all.slice(i, i + 5).map(m => ping(m).catch(() => {})));
  } finally { busy = false; }
});

mongoose.connect(MONGODB_URI).then(() => app.listen(PORT, () => console.log(`Pulse running on http://localhost:${PORT}`)))
  .catch(e => { console.error('MongoDB connection failed:', e.message); process.exit(1); });
