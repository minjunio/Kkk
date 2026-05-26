const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const session = require('express-session');
const nodemailer = require('nodemailer');

const app = express();

const PORT = process.env.PORT || 3000;
const SESSION_SECRET = process.env.SESSION_SECRET || 'change-this-secret';
const STAFF_USERNAME = process.env.STAFF_USERNAME || 'admin';
const STAFF_PASSWORD = process.env.STAFF_PASSWORD || 'monterysasd';
const STAFF_EMAIL = process.env.STAFF_EMAIL || process.env.GMAIL_USER || 'admin@bluewallet.local';

const DATA_DIR = path.join(__dirname, 'data');
const DB_PATH = path.join(DATA_DIR, 'wallets.json');

const otpStore = new Map();

/*
  VERY IMPORTANT FOR RENDER:
  Without this, secure cookies may not save correctly behind Render proxy.
*/
app.set('trust proxy', 1);

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(express.urlencoded({ extended: true }));
app.use(express.json({ limit: '2mb' }));
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

function ensureDb() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

  if (!fs.existsSync(DB_PATH)) {
    fs.writeFileSync(DB_PATH, JSON.stringify({ users: {} }, null, 2));
  }
}

function readDb() {
  ensureDb();

  try {
    return JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
  } catch (error) {
    console.error('DB read error:', error);
    return { users: {} };
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
  const isStaff = role === 'staff';

  return {
    id: `wallet_${sha(normalizedEmail).slice(0, 18)}`,
    email: normalizedEmail,
    role,
    createdAt: nowIso(),
    updatedAt: nowIso(),

    // Real wallet vault is created/encrypted in wallet.ejs, then saved here.
    encryptedVault: null,
    publicWallets: [],

    // For the real wallet version, normal users start empty.
    assets: isStaff
      ? [
          { currency: 'BTC', name: 'Bitcoin', amount: 2.75, avgBuyPrice: 42000 },
          { currency: 'ETH', name: 'Ethereum', amount: 48.5, avgBuyPrice: 2200 },
          { currency: 'SOL', name: 'Solana', amount: 2400, avgBuyPrice: 72 },
          { currency: 'USDT', name: 'Tether USD', amount: 250000, avgBuyPrice: 1 }
        ]
      : [],

    staking: {
      autoStake: true,
      riskMode: 'balanced',
      vaults: isStaff
        ? [
            {
              currency: 'ETH',
              name: 'Ethereum Vault',
              stakedAmount: 16,
              apy: 5.5,
              earnedAmount: 0,
              livePnlUsd: 0,
              dailyPnlUsd: 0,
              failed: false
            }
          ]
        : []
    }
  };
}

function getOrCreateUser(email, role = 'user') {
  const normalizedEmail = normalizeEmail(email);
  const db = readDb();

  if (!db.users[normalizedEmail]) {
    db.users[normalizedEmail] = createWalletRecord(normalizedEmail, role);
    writeDb(db);
    console.log(`Created new wallet record for ${normalizedEmail}`);
  } else {
    console.log(`Loaded existing wallet record for ${normalizedEmail}`);
  }

  if (role === 'staff' && db.users[normalizedEmail].role !== 'staff') {
    const staffRecord = createWalletRecord(normalizedEmail, 'staff');

    db.users[normalizedEmail] = {
      ...db.users[normalizedEmail],
      role: 'staff',
      assets: staffRecord.assets,
      staking: staffRecord.staking,
      updatedAt: nowIso()
    };

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

function generateOtp() {
  return String(crypto.randomInt(100000, 999999));
}

function saveOtp(email, otp) {
  const normalizedEmail = normalizeEmail(email);

  otpStore.set(normalizedEmail, {
    otpHash: sha(otp),
    expiresAt: Date.now() + 1000 * 60 * 10,
    attempts: 0
  });

  console.log(`OTP saved for ${normalizedEmail}`);
}

function verifyOtp(email, otp) {
  const normalizedEmail = normalizeEmail(email);
  const record = otpStore.get(normalizedEmail);

  if (!record) {
    return { ok: false, reason: 'No OTP found. Please request a new code.' };
  }

  if (Date.now() > record.expiresAt) {
    otpStore.delete(normalizedEmail);
    return { ok: false, reason: 'OTP expired. Please request a new code.' };
  }

  if (record.attempts >= 5) {
    otpStore.delete(normalizedEmail);
    return { ok: false, reason: 'Too many attempts. Please request a new code.' };
  }

  if (sha(otp) !== record.otpHash) {
    record.attempts += 1;
    otpStore.set(normalizedEmail, record);
    return { ok: false, reason: 'Invalid OTP code.' };
  }

  otpStore.delete(normalizedEmail);
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
    console.log('Gmail not configured.');
    console.log(`DEV OTP for ${email}: ${otp}`);
    return false;
  }

  await transporter.sendMail({
    from: `"Blue Wallet" <${process.env.GMAIL_USER}>`,
    replyTo: process.env.GMAIL_USER,
    to: email,
    subject: 'Your Blue Wallet login code',
    text: `Your Blue Wallet login code is ${otp}. It expires in 10 minutes.`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 520px; margin: 0 auto; padding: 24px;">
        <h2 style="margin: 0 0 12px;">Blue Wallet Login Code</h2>
        <p style="color: #475569;">Use this code to access your wallet.</p>
        <div style="
          font-size: 34px;
          font-weight: 800;
          letter-spacing: 7px;
          padding: 18px;
          border-radius: 14px;
          background: #eef6ff;
          color: #0284c7;
          text-align: center;
        ">
          ${otp}
        </div>
        <p style="color: #64748b; font-size: 13px;">
          This code expires in 10 minutes. If you did not request it, ignore this email.
        </p>
      </div>
    `
  });

  return true;
}

function requireAuth(req, res, next) {
  if (!req.session.user) {
    console.log('Blocked /wallet because no session user exists.');
    return res.redirect('/');
  }

  next();
}

/* =========================
   Pages
========================= */

app.get('/', (req, res) => {
  if (req.session.user) {
    return res.redirect('/wallet');
  }

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

    return res.render('index', {
      error: null,
      success: sent
        ? 'OTP sent successfully.'
        : 'OTP generated. Gmail is not configured, so check the Render logs.',
      otpEmail: email
    });
  } catch (error) {
    console.error('Send OTP error:', error);

    return res.render('index', {
      error: 'Unable to send OTP right now.',
      success: null,
      otpEmail: req.body.email || null
    });
  }
});

app.post('/verify-otp', (req, res) => {
  const email = normalizeEmail(req.body.email);
  const otp = String(req.body.otp || '').trim();

  console.log(`Verifying OTP for ${email}`);

  const result = verifyOtp(email, otp);

  if (!result.ok) {
    console.log(`OTP failed for ${email}: ${result.reason}`);

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

  console.log('Session user set:', req.session.user);

  req.session.save((error) => {
    if (error) {
      console.error('Session save error:', error);

      return res.render('index', {
        error: 'Login session could not be saved. Please try again.',
        success: null,
        otpEmail: email
      });
    }

    console.log(`Redirecting ${email} to /wallet`);
    return res.redirect('/wallet');
  });
});

app.post('/staff-login', (req, res) => {
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');

  if (username !== STAFF_USERNAME || password !== STAFF_PASSWORD) {
    return res.render('index', {
      error: 'Invalid staff username or password.',
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

  req.session.save((error) => {
    if (error) {
      console.error('Staff session save error:', error);

      return res.render('index', {
        error: 'Login session could not be saved. Please try again.',
        success: null,
        otpEmail: null
      });
    }

    return res.redirect('/wallet');
  });
});

app.get('/wallet', requireAuth, (req, res) => {
  const user = getOrCreateUser(req.session.user.email, req.session.user.role);

  console.log(`Rendering wallet.ejs for ${user.email}`);

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

/* =========================
   Wallet API
========================= */

app.get('/api/wallet', requireAuth, (req, res) => {
  const user = getOrCreateUser(req.session.user.email, req.session.user.role);
  res.json(user);
});

app.post('/api/wallet/vault', requireAuth, (req, res) => {
  const { encryptedVault, publicWallets } = req.body;

  if (!encryptedVault || typeof encryptedVault !== 'object') {
    return res.status(400).json({ error: 'Missing or invalid encryptedVault.' });
  }

  if (!Array.isArray(publicWallets)) {
    return res.status(400).json({ error: 'Missing or invalid publicWallets.' });
  }

  const user = updateUserWallet(req.session.user.email, {
    encryptedVault,
    publicWallets
  });

  res.json({
    ok: true,
    wallet: user
  });
});

app.post('/api/wallet/state', requireAuth, (req, res) => {
  const patch = {};

  if (Array.isArray(req.body.assets)) patch.assets = req.body.assets;
  if (req.body.staking && typeof req.body.staking === 'object') patch.staking = req.body.staking;

  const user = updateUserWallet(req.session.user.email, patch);

  res.json({
    ok: true,
    wallet: user
  });
});

/* =========================
   Price API
========================= */

app.get('/api/prices', async (req, res) => {
  try {
    const ids = String(req.query.ids || '').trim();

    if (!ids) {
      return res.status(400).json({ error: 'Missing ids query parameter.' });
    }

    const url =
      `https://api.coingecko.com/api/v3/simple/price` +
      `?ids=${encodeURIComponent(ids)}` +
      `&vs_currencies=usd` +
      `&include_24hr_change=true`;

    const response = await fetch(url, {
      headers: {
        accept: 'application/json',
        'user-agent': 'BlueCrypto-Wallet/1.0'
      }
    });

    if (!response.ok) {
      return res.status(response.status).json({ error: 'Price provider failed.' });
    }

    const data = await response.json();

    res.setHeader('Cache-Control', 'no-store');
    res.json(data);
  } catch (error) {
    console.error('Price API error:', error);
    res.status(500).json({ error: 'Unable to fetch prices.' });
  }
});

/* =========================
   Debug
========================= */

app.get('/debug-session', (req, res) => {
  res.json({
    session: req.session,
    user: req.session.user || null
  });
});

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    app: 'Blue Wallet',
    time: nowIso()
  });
});

/* =========================
   404
========================= */

app.use((req, res) => {
  res.status(404).send('Page not found');
});

app.listen(PORT, () => {
  ensureDb();
  console.log(`Blue Wallet running on port ${PORT}`);
});