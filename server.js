const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const session = require('express-session');
const nodemailer = require('nodemailer');

const app = express();

/* =========================
   Config
========================= */

const PORT = process.env.PORT || 3000;

const SESSION_SECRET =
  process.env.SESSION_SECRET || 'change-this-secret-in-render';

const STAFF_USERNAME =
  process.env.STAFF_USERNAME || 'admin';

const STAFF_PASSWORD =
  process.env.STAFF_PASSWORD || 'monterysasd';

const STAFF_EMAIL =
  process.env.STAFF_EMAIL || process.env.GMAIL_USER || 'admin@bluewallet.local';

const DATA_DIR = path.join(__dirname, 'data');
const DB_PATH = path.join(DATA_DIR, 'wallets.json');

const otpStore = new Map();

/* =========================
   Asset Data
========================= */

const SUPPORTED_ASSETS = [
  'BTC', 'ETH', 'SOL', 'BNB', 'XRP', 'DOGE', 'TRX', 'TON', 'ADA', 'AVAX',
  'LINK', 'DOT', 'NEAR', 'ARB', 'OP', 'SUI', 'APT', 'ATOM', 'FIL', 'ETC',
  'LTC', 'BCH', 'ICP', 'HBAR', 'SEI', 'INJ', 'RENDER', 'FET', 'WLD', 'TIA',
  'JUP', 'PYTH', 'GRT', 'ALGO', 'VET', 'EGLD',
  'UNI', 'AAVE', 'MKR', 'LDO', 'RUNE', 'CRV', 'COMP', 'SNX', 'DYDX', 'GMX',
  'PENDLE', 'ENA',
  'PEPE', 'SHIB', 'FLOKI', 'BONK', 'WIF', 'TURBO', 'BRETT', 'PNUT', 'MEW',
  'USDT'
];

const ASSET_NAMES = {
  BTC: 'Bitcoin',
  ETH: 'Ethereum',
  SOL: 'Solana',
  BNB: 'BNB',
  XRP: 'XRP',
  DOGE: 'Dogecoin',
  TRX: 'TRON',
  TON: 'Toncoin',
  ADA: 'Cardano',
  AVAX: 'Avalanche',
  LINK: 'Chainlink',
  DOT: 'Polkadot',
  NEAR: 'NEAR Protocol',
  ARB: 'Arbitrum',
  OP: 'Optimism',
  SUI: 'Sui',
  APT: 'Aptos',
  ATOM: 'Cosmos',
  FIL: 'Filecoin',
  ETC: 'Ethereum Classic',
  LTC: 'Litecoin',
  BCH: 'Bitcoin Cash',
  ICP: 'Internet Computer',
  HBAR: 'Hedera',
  SEI: 'Sei',
  INJ: 'Injective',
  RENDER: 'Render',
  FET: 'Artificial Superintelligence Alliance',
  WLD: 'Worldcoin',
  TIA: 'Celestia',
  JUP: 'Jupiter',
  PYTH: 'Pyth Network',
  GRT: 'The Graph',
  ALGO: 'Algorand',
  VET: 'VeChain',
  EGLD: 'MultiversX',
  UNI: 'Uniswap',
  AAVE: 'Aave',
  MKR: 'Maker',
  LDO: 'Lido DAO',
  RUNE: 'THORChain',
  CRV: 'Curve DAO',
  COMP: 'Compound',
  SNX: 'Synthetix',
  DYDX: 'dYdX',
  GMX: 'GMX',
  PENDLE: 'Pendle',
  ENA: 'Ethena',
  PEPE: 'Pepe',
  SHIB: 'Shiba Inu',
  FLOKI: 'FLOKI',
  BONK: 'Bonk',
  WIF: 'dogwifhat',
  TURBO: 'Turbo',
  BRETT: 'Brett',
  PNUT: 'Peanut the Squirrel',
  MEW: 'cat in a dogs world',
  USDT: 'Tether USD'
};

const GECKO_IDS = {
  BTC: 'bitcoin',
  ETH: 'ethereum',
  SOL: 'solana',
  BNB: 'binancecoin',
  XRP: 'ripple',
  DOGE: 'dogecoin',
  TRX: 'tron',
  TON: 'the-open-network',
  ADA: 'cardano',
  AVAX: 'avalanche-2',
  LINK: 'chainlink',
  DOT: 'polkadot',
  NEAR: 'near',
  ARB: 'arbitrum',
  OP: 'optimism',
  SUI: 'sui',
  APT: 'aptos',
  ATOM: 'cosmos',
  FIL: 'filecoin',
  ETC: 'ethereum-classic',
  LTC: 'litecoin',
  BCH: 'bitcoin-cash',
  ICP: 'internet-computer',
  HBAR: 'hedera-hashgraph',
  SEI: 'sei-network',
  INJ: 'injective-protocol',
  RENDER: 'render-token',
  FET: 'fetch-ai',
  WLD: 'worldcoin-wld',
  TIA: 'celestia',
  JUP: 'jupiter-exchange-solana',
  PYTH: 'pyth-network',
  GRT: 'the-graph',
  ALGO: 'algorand',
  VET: 'vechain',
  EGLD: 'elrond-erd-2',
  UNI: 'uniswap',
  AAVE: 'aave',
  MKR: 'maker',
  LDO: 'lido-dao',
  RUNE: 'thorchain',
  CRV: 'curve-dao-token',
  COMP: 'compound-governance-token',
  SNX: 'havven',
  DYDX: 'dydx-chain',
  GMX: 'gmx',
  PENDLE: 'pendle',
  ENA: 'ethena',
  PEPE: 'pepe',
  SHIB: 'shiba-inu',
  FLOKI: 'floki',
  BONK: 'bonk',
  WIF: 'dogwifcoin',
  TURBO: 'turbo',
  BRETT: 'based-brett',
  PNUT: 'peanut-the-squirrel',
  MEW: 'cat-in-a-dogs-world',
  USDT: 'tether'
};

const STAKING_APYS = {
  INJ: 18.4,
  ATOM: 17.2,
  DOT: 14.1,
  TIA: 13.6,
  NEAR: 11.8,
  AVAX: 9.4,
  SUI: 8.7,
  SOL: 7.2,
  SEI: 6.9,
  ADA: 5.9,
  ETH: 5.5,
  BNB: 4.8,
  APT: 4.1,
  LINK: 3.9,
  TRX: 3.6,
  TON: 3.4,
  BTC: 1.2,
  XRP: 1.1,
  DOGE: 0.8,
  USDT: 3.5
};

/* =========================
   Express Setup
========================= */

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(express.urlencoded({ extended: true }));
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  name: 'bluewallet.sid',
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 1000 * 60 * 60 * 24 * 7
  }
}));

/* =========================
   Database Helpers
========================= */

function ensureDb() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }

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
  return crypto
    .createHash('sha256')
    .update(String(input))
    .digest('hex');
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function nowIso() {
  return new Date().toISOString();
}

/* =========================
   Wallet Records
========================= */

function createWalletRecord(email, role = 'user') {
  const normalizedEmail = normalizeEmail(email);
  const isStaff = role === 'staff';

  return {
    id: `wallet_${sha(normalizedEmail).slice(0, 18)}`,
    email: normalizedEmail,
    role,
    createdAt: nowIso(),
    updatedAt: nowIso(),

    /*
      IMPORTANT:
      The raw seed phrase/private key should NEVER be stored here.
      wallet.ejs encrypts it in the browser and only sends encryptedVault.
    */
    encryptedVault: null,

    /*
      Public wallet addresses are safe to store.
      Example:
      [{ type: 'evm', address: '0x...', networks: ['Ethereum', 'BNB Smart Chain'] }]
    */
    publicWallets: [],

    /*
      App portfolio balances.
      These are app/account balances, not verified on-chain balances.
    */
    assets: isStaff
      ? [
          { currency: 'BTC', name: 'Bitcoin', amount: 2.75, avgBuyPrice: 42000 },
          { currency: 'ETH', name: 'Ethereum', amount: 48.5, avgBuyPrice: 2200 },
          { currency: 'SOL', name: 'Solana', amount: 2400, avgBuyPrice: 72 },
          { currency: 'BNB', name: 'BNB', amount: 180, avgBuyPrice: 310 },
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
            },
            {
              currency: 'SOL',
              name: 'Solana Vault',
              stakedAmount: 500,
              apy: 7.2,
              earnedAmount: 0,
              livePnlUsd: 0,
              dailyPnlUsd: 0,
              failed: false
            },
            {
              currency: 'USDT',
              name: 'USDT Flexible Vault',
              stakedAmount: 50000,
              apy: 3.5,
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

function updateUserWalletNested(email, patch) {
  const normalizedEmail = normalizeEmail(email);
  const db = readDb();

  if (!db.users[normalizedEmail]) {
    db.users[normalizedEmail] = createWalletRecord(normalizedEmail);
  }

  const current = db.users[normalizedEmail];

  db.users[normalizedEmail] = {
    ...current,
    ...patch,
    staking: {
      ...(current.staking || {}),
      ...(patch.staking || {})
    },
    updatedAt: nowIso()
  };

  writeDb(db);
  return db.users[normalizedEmail];
}

/* =========================
   OTP + Gmail
========================= */

function generateOtp() {
  return String(crypto.randomInt(100000, 999999));
}

function createTransporter() {
  const gmailUser = process.env.GMAIL_USER;
  const gmailPass = process.env.GMAIL_APP_PASSWORD;

  if (!gmailUser || !gmailPass) {
    return null;
  }

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
    subject: 'Your Blue Wallet OTP Code',
    text: `Your Blue Wallet login code is ${otp}. It expires in 10 minutes.`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 520px; margin: 0 auto; padding: 24px;">
        <h2 style="margin: 0 0 12px;">Blue Wallet Login Code</h2>
        <p style="color: #475569; margin: 0 0 18px;">Use this code to access your wallet and trading terminal.</p>
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
        <p style="color: #64748b; font-size: 13px; margin-top: 18px;">
          This code expires in 10 minutes. Do not share it with anyone.
        </p>
      </div>
    `
  });

  return true;
}

function saveOtp(email, otp) {
  const normalizedEmail = normalizeEmail(email);

  otpStore.set(normalizedEmail, {
    otpHash: sha(otp),
    expiresAt: Date.now() + 1000 * 60 * 10,
    attempts: 0
  });
}

function verifyOtp(email, otp) {
  const normalizedEmail = normalizeEmail(email);
  const record = otpStore.get(normalizedEmail);

  if (!record) {
    return { ok: false, reason: 'No OTP found. Request a new code.' };
  }

  if (Date.now() > record.expiresAt) {
    otpStore.delete(normalizedEmail);
    return { ok: false, reason: 'OTP expired. Request a new code.' };
  }

  if (record.attempts >= 5) {
    otpStore.delete(normalizedEmail);
    return { ok: false, reason: 'Too many attempts. Request a new code.' };
  }

  if (sha(otp) !== record.otpHash) {
    record.attempts += 1;
    otpStore.set(normalizedEmail, record);
    return { ok: false, reason: 'Invalid OTP code.' };
  }

  otpStore.delete(normalizedEmail);
  return { ok: true };
}

/* =========================
   Auth Middleware
========================= */

function requireAuth(req, res, next) {
  if (!req.session.user) {
    return res.redirect('/');
  }

  next();
}

function requireStaff(req, res, next) {
  if (!req.session.user || req.session.user.role !== 'staff') {
    return res.status(403).json({ error: 'Staff access required.' });
  }

  next();
}

/* =========================
   Page Routes
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
        ? 'OTP code sent to your email.'
        : 'OTP generated. Gmail is not configured, so check the server console.',
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

  return res.redirect('/wallet');
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

  return res.redirect('/wallet');
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
  req.session.destroy(() => {
    res.redirect('/');
  });
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
    return res.status(400).json({
      error: 'Missing or invalid encryptedVault.'
    });
  }

  if (!Array.isArray(publicWallets)) {
    return res.status(400).json({
      error: 'Missing or invalid publicWallets.'
    });
  }

  /*
    Server stores encrypted vault only.
    Never send plaintext seed phrase/private key to this route.
  */
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

  if (Array.isArray(req.body.assets)) {
    patch.assets = req.body.assets.map(asset => ({
      currency: String(asset.currency || '').toUpperCase(),
      name: String(asset.name || asset.currency || ''),
      amount: Number(asset.amount || 0),
      avgBuyPrice: Number(asset.avgBuyPrice || 0)
    }));
  }

  if (req.body.staking && typeof req.body.staking === 'object') {
    patch.staking = {
      autoStake: Boolean(req.body.staking.autoStake),
      riskMode: String(req.body.staking.riskMode || 'balanced'),
      vaults: Array.isArray(req.body.staking.vaults)
        ? req.body.staking.vaults.map(vault => ({
            currency: String(vault.currency || '').toUpperCase(),
            name: String(vault.name || vault.currency || ''),
            stakedAmount: Number(vault.stakedAmount || 0),
            apy: Number(vault.apy || 0),
            earnedAmount: Number(vault.earnedAmount || 0),
            livePnlUsd: Number(vault.livePnlUsd || 0),
            dailyPnlUsd: Number(vault.dailyPnlUsd || 0),
            failed: Boolean(vault.failed)
          }))
        : []
    };
  }

  const user = updateUserWalletNested(req.session.user.email, patch);

  res.json({
    ok: true,
    wallet: user
  });
});

app.post('/api/wallet/public-wallets', requireAuth, (req, res) => {
  const { publicWallets } = req.body;

  if (!Array.isArray(publicWallets)) {
    return res.status(400).json({
      error: 'publicWallets must be an array.'
    });
  }

  const user = updateUserWallet(req.session.user.email, {
    publicWallets
  });

  res.json({
    ok: true,
    wallet: user
  });
});

/* =========================
   Assets + Staking API
========================= */

app.get('/api/assets', (req, res) => {
  const assets = SUPPORTED_ASSETS.map(symbol => ({
    symbol,
    name: ASSET_NAMES[symbol] || symbol,
    geckoId: GECKO_IDS[symbol] || null,
    pair: `${symbol}/USDT`,
    stakingApy: STAKING_APYS[symbol] || null
  }));

  res.json({ assets });
});

app.get('/api/staking-options', (req, res) => {
  const options = SUPPORTED_ASSETS
    .map(symbol => ({
      symbol,
      name: ASSET_NAMES[symbol] || symbol,
      estimatedApy: STAKING_APYS[symbol] || Number((2 + Math.random() * 5).toFixed(2)),
      risk: ['BTC', 'ETH', 'SOL', 'USDT', 'BNB'].includes(symbol)
        ? 'lower'
        : 'variable'
    }))
    .sort((a, b) => b.estimatedApy - a.estimatedApy);

  res.json({ options });
});

/* =========================
   Prices API
========================= */

app.get('/api/prices', async (req, res) => {
  try {
    const ids = String(req.query.ids || '').trim();

    if (!ids) {
      return res.status(400).json({
        error: 'Missing ids query parameter.'
      });
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
        error: 'Price provider failed.'
      });
    }

    const data = await response.json();

    res.setHeader('Cache-Control', 'no-store');
    res.json(data);
  } catch (error) {
    console.error('Price API error:', error);

    res.status(500).json({
      error: 'Unable to fetch prices.'
    });
  }
});

/* =========================
   Staff API
========================= */

app.get('/api/staff/users', requireStaff, (req, res) => {
  const db = readDb();

  const users = Object.values(db.users).map(user => ({
    id: user.id,
    email: user.email,
    role: user.role,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
    assetCount: Array.isArray(user.assets) ? user.assets.length : 0,
    walletCount: Array.isArray(user.publicWallets) ? user.publicWallets.length : 0,
    hasEncryptedVault: Boolean(user.encryptedVault)
  }));

  res.json({ users });
});

/* =========================
   Health
========================= */

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

/* =========================
   Start
========================= */

app.listen(PORT, () => {
  ensureDb();
  console.log(`Blue Wallet running on port ${PORT}`);
});