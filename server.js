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
const STAFF_EMAIL = process.env.STAFF_EMAIL || 'admin@bluewallet.local';

const DATA_DIR = path.join(__dirname, 'data');
const DB_PATH = path.join(DATA_DIR, 'wallets.json');

const otpStore = new Map();

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(express.urlencoded({ extended: true }));
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
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
  return JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
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

function generateOtp() {
  return String(crypto.randomInt(100000, 999999));
}

function makeWalletRecord(email, role = 'user') {
  return {
    id: `wallet_${sha(email).slice(0, 18)}`,
    email,
    role,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),

    // Encrypted client-side wallet vault.
    // Server never sees plaintext seed phrase.
    encryptedVault: null,

    // Public wallet addresses only.
    publicWallets: [],

    // App-level portfolio state.
    assets: role === 'staff'
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
      vaults: role === 'staff'
        ? [
            {
              currency: 'ETH',
              name: 'Ethereum Vault',
              stakedAmount: 16,
              apy: 5.5,
              earnedAmount: 0,
              livePnlUsd: 0,
              dailyPnlUsd: 0
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
    db.users[normalizedEmail] = makeWalletRecord(normalizedEmail, role);
    writeDb(db);
  }

  if (role === 'staff' && db.users[normalizedEmail].role !== 'staff') {
    db.users[normalizedEmail].role = 'staff';
    db.users[normalizedEmail].assets = makeWalletRecord(normalizedEmail, 'staff').assets;
    db.users[normalizedEmail].staking = makeWalletRecord(normalizedEmail, 'staff').staking;
    db.users[normalizedEmail].updatedAt = new Date().toISOString();
    writeDb(db);
  }

  return db.users[normalizedEmail];
}

function updateUserWallet(email, patch) {
  const normalizedEmail = normalizeEmail(email);
  const db = readDb();

  if (!db.users[normalizedEmail]) {
    db.users[normalizedEmail] = makeWalletRecord(normalizedEmail);
  }

  const current = db.users[normalizedEmail];

  db.users[normalizedEmail] = {
    ...current,
    ...patch,
    updatedAt: new Date().toISOString()
  };

  writeDb(db);
  return db.users[normalizedEmail];
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
    from: `"Blue Wallet" <${process.env.GMAIL_USER}>`,
    to: email,
    subject: 'Your Blue Wallet Login Code',
    text: `Your Blue Wallet login code is ${otp}. It expires in 10 minutes.`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 520px; margin: 0 auto; padding: 24px;">
        <h2>Blue Wallet Login Code</h2>
        <p style="color:#475569;">Use this code to access your wallet.</p>
        <div style="font-size:32px;font-weight:800;letter-spacing:6px;padding:16px;border-radius:12px;background:#eef6ff;color:#0284c7;text-align:center;">
          ${otp}
        </div>
        <p style="color:#64748b;font-size:13px;">This code expires in 10 minutes.</p>
      </div>
    `
  });

  return true;
}

function requireAuth(req, res, next) {
  if (!req.session.user) return res.redirect('/');
  next();
}

app.get('/', (req, res) => {
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

    otpStore.set(email, {
      otpHash: sha(otp),
      expiresAt: Date.now() + 1000 * 60 * 10,
      attempts: 0
    });

    const sent = await sendOtpEmail(email, otp);

    res.render('index', {
      error: null,
      success: sent
        ? 'OTP sent to your email.'
        : 'OTP generated. Gmail is not configured, so check the server console.',
      otpEmail: email
    });
  } catch (error) {
    console.error(error);
    res.render('index', {
      error: 'Unable to send OTP right now.',
      success: null,
      otpEmail: req.body.email || null
    });
  }
});

app.post('/verify-otp', (req, res) => {
  const email = normalizeEmail(req.body.email);
  const otp = String(req.body.otp || '').trim();

  const record = otpStore.get(email);

  if (!record) {
    return res.render('index', {
      error: 'No OTP found. Request a new code.',
      success: null,
      otpEmail: email
    });
  }

  if (Date.now() > record.expiresAt) {
    otpStore.delete(email);
    return res.render('index', {
      error: 'OTP expired. Request a new code.',
      success: null,
      otpEmail: email
    });
  }

  if (record.attempts >= 5) {
    otpStore.delete(email);
    return res.render('index', {
      error: 'Too many attempts. Request a new code.',
      success: null,
      otpEmail: email
    });
  }

  if (sha(otp) !== record.otpHash) {
    record.attempts += 1;
    otpStore.set(email, record);

    return res.render('index', {
      error: 'Invalid OTP code.',
      success: null,
      otpEmail: email
    });
  }

  otpStore.delete(email);

  const user = getOrCreateUser(email, 'user');

  req.session.user = {
    email,
    username: email.split('@')[0],
    role: user.role,
    walletId: user.id
  };

  res.redirect('/wallet');
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

  res.redirect('/wallet');
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

app.get('/api/wallet', requireAuth, (req, res) => {
  const user = getOrCreateUser(req.session.user.email, req.session.user.role);
  res.json(user);
});

app.post('/api/wallet/vault', requireAuth, (req, res) => {
  const { encryptedVault, publicWallets } = req.body;

  if (!encryptedVault || !publicWallets) {
    return res.status(400).json({
      error: 'Missing encryptedVault or publicWallets.'
    });
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

app.get('/api/prices', async (req, res) => {
  try {
    const ids = req.query.ids;

    if (!ids) {
      return res.status(400).json({ error: 'Missing ids query parameter' });
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
      return res.status(response.status).json({
        error: 'Price provider failed'
      });
    }

    const data = await response.json();

    res.setHeader('Cache-Control', 'no-store');
    res.json(data);
  } catch (error) {
    console.error(error);
    res.status(500).json({
      error: 'Unable to fetch prices'
    });
  }
});

app.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/'));
});

app.listen(PORT, () => {
  ensureDb();
  console.log(`Blue Wallet running on port ${PORT}`);
});