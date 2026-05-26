const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const session = require('express-session');
const nodemailer = require('nodemailer');

const app = express();

const PORT = process.env.PORT || 3000;
const SESSION_SECRET = process.env.SESSION_SECRET || 'change-this-secret-now';
const STAFF_USERNAME = process.env.STAFF_USERNAME || 'admin';
const STAFF_PASSWORD = process.env.STAFF_PASSWORD || 'monterysasd';
const STAFF_EMAIL = process.env.STAFF_EMAIL || process.env.GMAIL_USER || 'admin@bluewallet.local';

const DATA_DIR = path.join(__dirname, 'data');
const DB_PATH = path.join(DATA_DIR, 'wallets.json');

const ZEROX_API_KEY = process.env.ZEROX_API_KEY || '';
const COINGECKO_BASE = 'https://api.coingecko.com/api/v3';

app.set('trust proxy', 1);
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(express.urlencoded({ extended: true }));
app.use(express.json({ limit: '3mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.use(session({
  name: 'bluewallet.sid',
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  proxy: true,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 1000 * 60 * 60 * 24 * 7
  }
}));

const priceCache = new Map();

function ensureDb() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

  if (!fs.existsSync(DB_PATH)) {
    fs.writeFileSync(DB_PATH, JSON.stringify({ users: {}, otps: {} }, null, 2));
  }
}

function readDb() {
  ensureDb();

  try {
    const db = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
    if (!db.users) db.users = {};
    if (!db.otps) db.otps = {};
    return db;
  } catch {
    return { users: {}, otps: {} };
  }
}

function writeDb(db) {
  ensureDb();
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}

function sha(input) {
  return crypto.createHash('sha256').update(String(input)).digest('hex');
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function nowIso() {
  return new Date().toISOString();
}

function createWalletRecord(email, role = 'user') {
  const normalizedEmail = normalizeEmail(email);

  return {
    id: `wallet_${sha(normalizedEmail).slice(0, 20)}`,
    email: normalizedEmail,
    role,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    encryptedVault: null,
    publicWallets: [],
    assets: [],
    staking: {
      autoStake: false,
      riskMode: 'balanced',
      vaults: []
    }
  };
}

function getOrCreateUser(email, role = 'user') {
  const normalizedEmail = normalizeEmail(email);
  const db = readDb();

  if (!db.users[normalizedEmail]) {
    db.users[normalizedEmail] = createWalletRecord(normalizedEmail, role);
    writeDb(db);
  }

  if (role === 'staff' && db.users[normalizedEmail].role !== 'staff') {
    db.users[normalizedEmail].role = 'staff';
    db.users[normalizedEmail].updatedAt = nowIso();
    writeDb(db);
  }

  return db.users[normalizedEmail];
}

function updateUserWallet(email, patch) {
  const normalizedEmail = normalizeEmail(email);
  const db = readDb();

  if (!db.users[normalizedEmail]) {
    db.users[normalizedEmail] = createWalletRecord(normalizedEmail);
  }

  db.users[normalizedEmail] = {
    ...db.users[normalizedEmail],
    ...patch,
    updatedAt: nowIso()
  };

  writeDb(db);
  return db.users[normalizedEmail];
}

function deleteUserWalletVault(email) {
  const normalizedEmail = normalizeEmail(email);
  const db = readDb();

  if (!db.users[normalizedEmail]) return null;

  db.users[normalizedEmail].encryptedVault = null;
  db.users[normalizedEmail].publicWallets = [];
  db.users[normalizedEmail].assets = [];
  db.users[normalizedEmail].staking = {
    autoStake: false,
    riskMode: 'balanced',
    vaults: []
  };
  db.users[normalizedEmail].updatedAt = nowIso();

  writeDb(db);
  return db.users[normalizedEmail];
}

function requireAuth(req, res, next) {
  if (!req.session.user) return res.redirect('/');
  next();
}

function generateOtp() {
  return String(crypto.randomInt(100000, 999999));
}

function saveOtp(email, otp) {
  const normalizedEmail = normalizeEmail(email);
  const db = readDb();

  db.otps[normalizedEmail] = {
    otpHash: sha(otp),
    expiresAt: Date.now() + 1000 * 60 * 10,
    attempts: 0,
    createdAt: nowIso()
  };

  writeDb(db);
}

function verifyOtp(email, otp) {
  const normalizedEmail = normalizeEmail(email);
  const db = readDb();
  const record = db.otps[normalizedEmail];

  if (!record) return { ok: false, reason: 'No OTP found. Request a new code.' };

  if (Date.now() > record.expiresAt) {
    delete db.otps[normalizedEmail];
    writeDb(db);
    return { ok: false, reason: 'OTP expired. Request a new code.' };
  }

  if (record.attempts >= 5) {
    delete db.otps[normalizedEmail];
    writeDb(db);
    return { ok: false, reason: 'Too many attempts. Request a new code.' };
  }

  if (sha(otp) !== record.otpHash) {
    record.attempts += 1;
    db.otps[normalizedEmail] = record;
    writeDb(db);
    return { ok: false, reason: 'Invalid OTP code.' };
  }

  delete db.otps[normalizedEmail];
  writeDb(db);
  return { ok: true };
}

function createTransporter() {
  const gmailUser = process.env.GMAIL_USER;
  const gmailPass = process.env.GMAIL_APP_PASSWORD;

  if (!gmailUser || !gmailPass) return null;

  return nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: gmailUser,
      pass: gmailPass
    }
  });
}

async function sendOtpEmail(email, otp) {
  const transporter = createTransporter();

  if (!transporter) {
    console.log(`DEV OTP for ${email}: ${otp}`);
    return false;
  }

  await transporter.sendMail({
    from: `"Bluebook Wallet" <${process.env.GMAIL_USER}>`,
    replyTo: process.env.GMAIL_USER,
    to: email,
    subject: 'Your Bluebook Wallet login code',
    text: `Your Bluebook Wallet login code is ${otp}. It expires in 10 minutes.`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;padding:24px;">
        <h2 style="margin:0 0 12px;">Bluebook Wallet Login Code</h2>
        <p style="color:#475569;">Use this code to access your wallet.</p>
        <div style="font-size:34px;font-weight:800;letter-spacing:7px;padding:18px;border-radius:14px;background:#eef6ff;color:#0284c7;text-align:center;">
          ${otp}
        </div>
        <p style="color:#64748b;font-size:13px;">This code expires in 10 minutes. Check Spam/Junk if you do not see it.</p>
      </div>
    `
  });

  return true;
}

async function cachedJson(key, ttlMs, fetcher) {
  const hit = priceCache.get(key);

  if (hit && Date.now() - hit.time < ttlMs) {
    return hit.data;
  }

  const data = await fetcher();
  priceCache.set(key, { time: Date.now(), data });
  return data;
}

/* Pages */

app.get('/', (req, res) => {
  if (req.session.user) return res.redirect('/wallet');

  res.render('index', {
    error: null,
    success: null,
    otpEmail: null
  });
});

app.post('/send-otp', async (req, res) => {
  try {
    const email = normalizeEmail(req.body.email);

    if (!email || !email.includes('@')) {
      return res.render('index', {
        error: 'Enter a valid email address.',
        success: null,
        otpEmail: null
      });
    }

    const otp = generateOtp();
    saveOtp(email, otp);

    const sent = await sendOtpEmail(email, otp);

    res.render('index', {
      error: null,
      success: sent ? 'OTP sent successfully. Check your inbox or spam folder.' : 'OTP generated. Gmail is not configured, check Render logs.',
      otpEmail: email
    });
  } catch (error) {
    console.error('Send OTP error:', error);

    res.render('index', {
      error: 'Unable to send OTP. Check Gmail app password and Render logs.',
      success: null,
      otpEmail: req.body.email || null
    });
  }
});

app.post('/verify-otp', (req, res) => {
  const email = normalizeEmail(req.body.email);
  const otp = String(req.body.otp || '').trim();

  const result = verifyOtp(email, otp);

  if (!result.ok) {
    return res.render('index', {
      error: result.reason,
      success: null,
      otpEmail: email
    });
  }

  const user = getOrCreateUser(email, 'user');

  req.session.user = {
    email,
    username: email.split('@')[0],
    role: user.role,
    walletId: user.id
  };

  req.session.save(error => {
    if (error) {
      console.error('Session save error:', error);

      return res.render('index', {
        error: 'Session could not be saved. Try again.',
        success: null,
        otpEmail: email
      });
    }

    res.redirect('/wallet');
  });
});

app.post('/staff-login', (req, res) => {
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');

  if (username !== STAFF_USERNAME || password !== STAFF_PASSWORD) {
    return res.render('index', {
      error: 'Invalid staff login.',
      success: null,
      otpEmail: null
    });
  }

  const user = getOrCreateUser(STAFF_EMAIL, 'staff');

  req.session.user = {
    email: STAFF_EMAIL,
    username: 'admin',
    role: 'staff',
    walletId: user.id
  };

  req.session.save(() => res.redirect('/wallet'));
});

app.get('/wallet', requireAuth, (req, res) => {
  const user = getOrCreateUser(req.session.user.email, req.session.user.role);

  res.render('wallet', {
    username: req.session.user.username,
    email: req.session.user.email,
    role: req.session.user.role,
    wallet: JSON.stringify(user)
  });
});

app.get('/trading', requireAuth, (req, res) => {
  const user = getOrCreateUser(req.session.user.email, req.session.user.role);

  res.render('trading', {
    username: req.session.user.username,
    email: req.session.user.email,
    role: req.session.user.role,
    wallet: JSON.stringify(user)
  });
});

app.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/'));
});

/* Wallet API */

app.get('/api/wallet', requireAuth, (req, res) => {
  const user = getOrCreateUser(req.session.user.email, req.session.user.role);
  res.json(user);
});

app.post('/api/wallet/vault', requireAuth, (req, res) => {
  const { encryptedVault, publicWallets } = req.body;

  if (!encryptedVault || typeof encryptedVault !== 'object') {
    return res.status(400).json({ error: 'Missing encryptedVault.' });
  }

  if (!Array.isArray(publicWallets)) {
    return res.status(400).json({ error: 'Missing publicWallets.' });
  }

  const user = updateUserWallet(req.session.user.email, {
    encryptedVault,
    publicWallets
  });

  res.json({ ok: true, wallet: user });
});

app.delete('/api/wallet/vault', requireAuth, (req, res) => {
  const user = deleteUserWalletVault(req.session.user.email);
  res.json({ ok: true, wallet: user });
});

/* Prices */

app.get('/api/prices', requireAuth, async (req, res) => {
  try {
    const ids = String(req.query.ids || '')
      .split(',')
      .map(x => x.trim())
      .filter(Boolean)
      .slice(0, 120);

    if (!ids.length) return res.json({});

    const key = `prices:${ids.sort().join(',')}`;

    const data = await cachedJson(key, 20_000, async () => {
      const url = `${COINGECKO_BASE}/simple/price?ids=${encodeURIComponent(ids.join(','))}&vs_currencies=usd&include_24hr_change=true`;
      const response = await fetch(url, {
        headers: {
          accept: 'application/json'
        }
      });

      if (!response.ok) throw new Error(`CoinGecko failed: ${response.status}`);
      return response.json();
    });

    res.json(data);
  } catch (error) {
    console.error('Price error:', error);
    res.status(500).json({ error: 'Unable to load prices.' });
  }
});

app.get('/api/chart', requireAuth, async (req, res) => {
  try {
    const id = String(req.query.id || '').trim();
    const tf = String(req.query.tf || '5m').trim();

    if (!id) return res.status(400).json({ error: 'Missing id.' });

    const days = tf === '1h' ? '1' : '1';
    const key = `chart:${id}:${tf}`;

    const data = await cachedJson(key, 20_000, async () => {
      const url = `${COINGECKO_BASE}/coins/${encodeURIComponent(id)}/market_chart?vs_currency=usd&days=${days}`;
      const response = await fetch(url, {
        headers: {
          accept: 'application/json'
        }
      });

      if (!response.ok) throw new Error(`Chart failed: ${response.status}`);
      return response.json();
    });

    res.json(data);
  } catch (error) {
    console.error('Chart error:', error);
    res.status(500).json({ error: 'Unable to load chart.' });
  }
});

/* Swap API */

app.post('/api/swap/quote', requireAuth, async (req, res) => {
  try {
    if (!ZEROX_API_KEY) {
      return res.status(501).json({
        error: 'Swap API key missing. Add ZEROX_API_KEY in Render environment variables.'
      });
    }

    const { chainId, sellToken, buyToken, sellAmount, taker } = req.body;

    if (!chainId || !sellToken || !buyToken || !sellAmount || !taker) {
      return res.status(400).json({ error: 'Missing swap quote fields.' });
    }

    const params = new URLSearchParams({
      chainId: String(chainId),
      sellToken: String(sellToken),
      buyToken: String(buyToken),
      sellAmount: String(sellAmount),
      taker: String(taker)
    });

    const url = `https://api.0x.org/swap/allowance-holder/quote?${params.toString()}`;

    const response = await fetch(url, {
      headers: {
        '0x-api-key': ZEROX_API_KEY,
        '0x-version': 'v2',
        accept: 'application/json'
      }
    });

    const body = await response.json().catch(() => ({}));

    if (!response.ok) {
      return res.status(response.status).json({
        error: body?.message || body?.reason || 'Swap quote failed.',
        details: body
      });
    }

    res.json(body);
  } catch (error) {
    console.error('Swap quote error:', error);
    res.status(500).json({ error: 'Unable to get swap quote.' });
  }
});

/* Debug */

app.get('/debug-session', (req, res) => {
  res.json({
    user: req.session.user || null,
    session: req.session
  });
});

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    time: nowIso()
  });
});

app.use((req, res) => {
  res.status(404).send('Page not found');
});

app.listen(PORT, () => {
  ensureDb();
  console.log(`Bluebook Wallet running on port ${PORT}`);
});