'use strict';

const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const session = require('express-session');
const nodemailer = require('nodemailer');

const app = express();

/* -------------------- Config -------------------- */

const PORT = process.env.PORT || 3000;
const SESSION_SECRET = process.env.SESSION_SECRET || 'tensorwallet-secure-secret-key-change-this';

const STAFF_USERNAME = process.env.STAFF_USERNAME || 'admin';
const STAFF_PASSWORD = process.env.STAFF_PASSWORD || 'monterysasd';

const IS_PROD = process.env.NODE_ENV === 'production' || process.env.RENDER === 'true';
const DATA_DIR = process.env.DATA_DIR || (IS_PROD ? '/data' : path.join(__dirname, 'data'));
const DB_PATH = path.join(DATA_DIR, 'wallets.json');

const COINGECKO_BASE = 'https://api.coingecko.com/api/v3';
const BINANCE_BASE = 'https://api.binance.com';
const BINANCE_FALLBACK = 'https://data-api.binance.vision';

const PRICE_SYNC_MS = 2000;
const MARKET_LOOP_MS = 2500;
const MAX_CANDLES = 2200;

const cache = new Map();
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

/* -------------------- App Setup -------------------- */

app.set('trust proxy', 1);
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(express.urlencoded({ extended: true }));
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.use('/api', (req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  next();
});

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

/* -------------------- Helpers -------------------- */

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
  return `${prefix}_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`;
}

function safeJsonForEjs(obj) {
  return JSON.stringify(obj)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026');
}

function ensureDataFolderOnly() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

/* -------------------- Defaults -------------------- */

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
      low24h: 68000
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
      low24h: 3800
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
      low24h: 170
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
      low24h: 600
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
      low24h: 0.55
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
      low24h: 0.16
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
      low24h: 1.25
    }
  ];
}

function defaultDb() {
  return {
    users: {},
    otps: {},
    tensorRegistry: defaultTensorAssets(),
    treasury: {
      collectedFeesUsdt: 0
    }
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

  if (!db.users) db.users = {};
  if (!db.otps) db.otps = {};
  if (!Array.isArray(db.tensorRegistry)) db.tensorRegistry = [];
  if (!db.treasury) db.treasury = { collectedFeesUsdt: 0 };

  if (db.tensorRegistry.length === 0) {
    db.tensorRegistry = defaultTensorAssets();
  }

  Object.values(db.users).forEach(migrateUser);
  db.tensorRegistry.forEach(migrateToken);

  writeDb(db);
}

function readDb() {
  ensureDataFolderOnly();

  if (!fs.existsSync(DB_PATH)) {
    writeDb(defaultDb());
  }

  const db = readDbRaw();

  if (!db.users) db.users = {};
  if (!db.otps) db.otps = {};
  if (!Array.isArray(db.tensorRegistry)) db.tensorRegistry = [];
  if (!db.treasury) db.treasury = { collectedFeesUsdt: 0 };

  if (db.tensorRegistry.length === 0) {
    db.tensorRegistry = defaultTensorAssets();
  }

  Object.values(db.users).forEach(migrateUser);
  db.tensorRegistry.forEach(migrateToken);

  return db;
}

function migrateUser(user) {
  if (!user) return;

  if (!user.email) user.email = '';
  if (!user.id && user.email) user.id = `wallet_${sha(user.email).slice(0, 20)}`;
  if (!user.role) user.role = 'user';
  if (!user.createdAt) user.createdAt = nowIso();
  if (!user.updatedAt) user.updatedAt = nowIso();

  if (!Array.isArray(user.publicWallets)) user.publicWallets = [];
  if (!Array.isArray(user.assets)) user.assets = [];

  if (!user.tensorAddress && user.email) {
    user.tensorAddress = `T0x${sha(user.email).slice(0, 40)}`;
  }

  if (!user.tensorVault) user.tensorVault = null;
  if (!user.tensorBalances) user.tensorBalances = {};

  if (user.usdtBalance === undefined) {
    user.usdtBalance = user.role === 'staff' ? 1000000 : 15000;
  }

  user.usdtBalance = safeNumber(user.usdtBalance, user.role === 'staff' ? 1000000 : 15000);

  if (!Array.isArray(user.positions)) user.positions = [];
  if (!Array.isArray(user.orderHistory)) user.orderHistory = [];

  user.positions.forEach(pos => {
    if (!pos.id) pos.id = makeId('pos');
    if (!pos.marginMode) pos.marginMode = 'cross';

    pos.margin = safeNumber(pos.margin, 0);
    pos.leverage = safeNumber(pos.leverage, 1);
    pos.size = safeNumber(pos.size, pos.margin * pos.leverage);
    pos.entryPrice = safeNumber(pos.entryPrice, 1);
    pos.side = pos.side === 'short' ? 'short' : 'long';
  });
}

function migrateToken(token) {
  if (!token.id) token.id = `T0x${crypto.randomBytes(20).toString('hex')}`;
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
}

/* -------------------- Users/Auth Helpers -------------------- */

function createWalletRecord(email, role = 'user') {
  const hash = sha(email);

  return {
    id: `wallet_${hash.slice(0, 20)}`,
    email,
    role,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    encryptedVault: null,
    publicWallets: [],
    assets: [],
    tensorAddress: `T0x${hash.slice(0, 40)}`,
    tensorVault: null,
    tensorBalances: {},
    usdtBalance: role === 'staff' ? 1000000 : 15000,
    positions: [],
    orderHistory: []
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

    if (role === 'staff' && db.users[normEmail].role !== 'staff') {
      db.users[normEmail].role = 'staff';
      writeDb(db);
    }
  }

  return db.users[normEmail];
}

function requireAuth(req, res, next) {
  if (!req.session.user) return res.redirect('/');
  next();
}

function requireAuthJson(req, res, next) {
  if (!req.session.user) {
    return res.status(401).json({ error: 'Not authenticated.' });
  }

  next();
}

function requireAdminJson(req, res, next) {
  if (!req.session.user || req.session.user.role !== 'staff') {
    return res.status(403).json({ error: 'Admin access required.' });
  }

  next();
}

function generateOtp() {
  return String(crypto.randomInt(100000, 999999));
}

function saveOtp(email, otp) {
  const normEmail = normalizeEmail(email);
  const db = readDb();

  db.otps[normEmail] = {
    otpHash: sha(otp),
    expiresAt: Date.now() + 10 * 60 * 1000,
    attempts: 0
  };

  writeDb(db);
}

function verifyOtp(email, otp) {
  const normEmail = normalizeEmail(email);
  const db = readDb();
  const record = db.otps[normEmail];

  if (!record) {
    return { ok: false, reason: 'No OTP found. Please request a new code.' };
  }

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

/* -------------------- Network / Price Helpers -------------------- */

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

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

async function cachedJson(key, ttlMs, fetcher) {
  const hit = cache.get(key);

  if (hit && Date.now() - hit.time < ttlMs) {
    return hit.data;
  }

  const data = await fetcher();

  cache.set(key, {
    time: Date.now(),
    data
  });

  return data;
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
      data = await fetchJsonWithTimeout(
        `${BINANCE_BASE}/api/v3/ticker/24hr?symbols=${symbolsParam}`,
        {},
        4500
      );
    } catch {
      data = await fetchJsonWithTimeout(
        `${BINANCE_FALLBACK}/api/v3/ticker/24hr?symbols=${symbolsParam}`,
        {},
        4500
      );
    }

    if (!Array.isArray(data)) {
      return latestRealPrices;
    }

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
    console.error('Real crypto price sync failed:', err.message);
    return latestRealPrices;
  }
}

/* -------------------- Candle / Trading Engine -------------------- */

function initializeCandlesForToken(tokenId, startPrice) {
  if (tensorCandleHistory[tokenId] && tensorCandleHistory[tokenId].length) {
    return;
  }

  const candles = [];
  let price = Math.max(0.000001, safeNumber(startPrice, 1));
  let timeCursor = Date.now() - 1440 * 60 * 1000;

  for (let i = 0; i < 1440; i++) {
    const open = price;
    const close = Math.max(0.000001, open * (1 + (Math.random() - 0.5) * 0.004));
    const high = Math.max(open, close) * (1 + Math.random() * 0.0015);
    const low = Math.max(0.000001, Math.min(open, close) * (1 - Math.random() * 0.0015));

    candles.push({
      time: timeCursor,
      open,
      high,
      low,
      close
    });

    price = close;
    timeCursor += 60 * 1000;
  }

  tensorCandleHistory[tokenId] = candles;
}

function hydrateAllCandles() {
  const db = readDb();

  db.tensorRegistry.forEach(token => {
    initializeCandlesForToken(token.id, token.price);
  });
}

function pushLiveCandle(token, oldPrice) {
  initializeCandlesForToken(token.id, oldPrice);

  const history = tensorCandleHistory[token.id];
  const now = Date.now();
  const last = history[history.length - 1];

  if (last && now - last.time < 60 * 1000) {
    last.close = token.price;
    last.high = Math.max(last.high, token.price);
    last.low = Math.min(last.low, token.price);
  } else {
    history.push({
      time: now,
      open: oldPrice,
      high: Math.max(oldPrice, token.price),
      low: Math.min(oldPrice, token.price),
      close: token.price
    });

    while (history.length > MAX_CANDLES) {
      history.shift();
    }
  }
}

function getLiquidationPrice(pos, availableBalance = 0) {
  const entry = safeNumber(pos.entryPrice, 0);
  const size = safeNumber(pos.size, 0);
  const margin = safeNumber(pos.margin, 0);
  const side = pos.side === 'short' ? 'short' : 'long';
  const mode = pos.marginMode || 'cross';

  if (entry <= 0 || size <= 0 || margin <= 0) return 0;

  const usableMargin = mode === 'cross'
    ? margin + Math.max(0, safeNumber(availableBalance, 0))
    : margin;

  const priceMove = (usableMargin / size) * entry;

  if (side === 'long') {
    return Math.max(0, entry - priceMove);
  }

  return entry + priceMove;
}

function calculatePnl(pos, currentPrice) {
  const entry = safeNumber(pos.entryPrice, 0);
  const size = safeNumber(pos.size, 0);

  if (entry <= 0 || size <= 0) return 0;

  const priceDiff = pos.side === 'long'
    ? currentPrice - entry
    : entry - currentPrice;

  return (priceDiff / entry) * size;
}

async function runMarketLoop() {
  try {
    await syncRealCryptoPrices();

    if (!fs.existsSync(DB_PATH)) return;

    const db = readDb();

    if (!db.tensorRegistry.length) {
      db.tensorRegistry = defaultTensorAssets();
    }

    let totalMarketCap = 0;

    db.tensorRegistry.forEach(token => {
      migrateToken(token);
      token.marketCap = token.price * token.supply;
      totalMarketCap += token.marketCap;
    });

    let alphaDrift = 0;

    db.tensorRegistry.forEach(token => {
      token.dominance = totalMarketCap > 0 ? (token.marketCap / totalMarketCap) * 100 : 0;

      if (token.dominance > 30 && token.bias !== 'pegged' && token.bias !== 'real') {
        alphaDrift += (Math.random() - 0.5) * 0.003 * (token.dominance / 100);
      }
    });

    db.tensorRegistry.forEach(token => {
      const oldPrice = token.price;
      const mappedSymbol = REAL_SYMBOL_MAP[String(token.symbol || '').toUpperCase()];
      const real = mappedSymbol ? latestRealPrices[mappedSymbol] : null;

      if (real && real.price > 0) {
        token.bias = 'real';
        token.price = real.price;
        token.volume = real.volume || token.volume || 0;
        token.changePercent24h = real.changePercent || 0;
        token.high24h = real.high || token.price;
        token.low24h = real.low || token.price;
        token.marketCap = token.price * token.supply;

        pushLiveCandle(token, oldPrice);
        return;
      }

      if (token.bias === 'pegged') {
        token.price = token.startPrice || 1;
      } else {
        const bullChance = Math.max(0, Math.min(100, safeNumber(token.bullChance, 50)));
        const direction = Math.random() * 100 <= bullChance ? 1 : -1;

        const minPct = Math.max(0, safeNumber(token.minPct, 0.0005));
        const maxPct = Math.max(minPct, safeNumber(token.maxPct, 0.004));
        const magnitude = minPct + Math.random() * (maxPct - minPct);

        const dominanceDampener = token.dominance > 35
          ? 0.25
          : Math.max(0.35, 1 - token.dominance / 100);

        const randomMove = direction * magnitude * dominanceDampener;
        const totalMove = randomMove + alphaDrift;

        token.price = Math.max(0.000001, oldPrice * (1 + totalMove));
      }

      token.marketCap = token.price * token.supply;
      token.volume = safeNumber(token.volume, 0) * 0.96 + Math.abs(token.price - oldPrice) * token.supply * 0.04;
      token.high24h = Math.max(safeNumber(token.high24h, token.price), token.price);
      token.low24h = Math.min(safeNumber(token.low24h, token.price), token.price);
      token.changePercent24h = token.startPrice > 0
        ? ((token.price - token.startPrice) / token.startPrice) * 100
        : 0;

      pushLiveCandle(token, oldPrice);
    });

    Object.keys(db.users).forEach(email => {
      const user = db.users[email];
      migrateUser(user);

      if (!Array.isArray(user.positions) || user.positions.length === 0) return;

      const keptPositions = [];

      user.positions.forEach(pos => {
        const token = db.tensorRegistry.find(t => t.id === pos.tokenId);

        if (!token) {
          keptPositions.push(pos);
          return;
        }

        const currentPrice = token.price;
        const liqPrice = getLiquidationPrice(pos, user.usdtBalance);

        const isLiquidated = pos.side === 'long'
          ? currentPrice <= liqPrice
          : currentPrice >= liqPrice;

        if (isLiquidated) {
          user.orderHistory.unshift({
            ...pos,
            closePrice: currentPrice,
            pnl: -Math.abs(safeNumber(pos.margin, 0)),
            closedAt: Date.now(),
            closeReason: 'Liquidation'
          });
        } else {
          keptPositions.push(pos);
        }
      });

      user.positions = keptPositions;
      user.orderHistory = user.orderHistory.slice(0, 100);
      user.updatedAt = nowIso();
    });

    writeDb(db);
  } catch (err) {
    console.error('Market loop error:', err);
  }
}

/* -------------------- Page Routes -------------------- */

app.get('/', (req, res) => {
  if (req.session.user) {
    return res.redirect('/trading');
  }

  res.render('index', {
    error: null,
    success: null,
    otpEmail: null
  });
});

app.get('/index.html', (req, res) => {
  if (req.session.user) {
    return res.redirect('/trading');
  }

  res.render('index', {
    error: null,
    success: null,
    otpEmail: null
  });
});

app.get('/wallet', requireAuth, (req, res) => {
  const user = getOrCreateUser(req.session.user.email, req.session.user.role);

  res.render('wallet', {
    email: req.session.user.email,
    role: req.session.user.role,
    wallet: safeJsonForEjs(user)
  });
});

app.get('/wallet.ejs', requireAuth, (req, res) => {
  res.redirect('/wallet');
});

app.get('/trading', requireAuth, (req, res) => {
  const user = getOrCreateUser(req.session.user.email, req.session.user.role);

  res.render('trading', {
    email: req.session.user.email,
    role: req.session.user.role,
    wallet: safeJsonForEjs(user)
  });
});

app.get('/trading.ejs', requireAuth, (req, res) => {
  res.redirect('/trading');
});

/* -------------------- Auth Routes -------------------- */

app.post('/send-otp', async (req, res) => {
  try {
    const email = normalizeEmail(req.body.email);

    if (!email || !email.includes('@')) {
      return res.render('index', {
        error: 'Enter a valid email.',
        success: null,
        otpEmail: null
      });
    }

    const otp = generateOtp();
    saveOtp(email, otp);

    const sent = await sendOtpEmail(email, otp);

    res.render('index', {
      error: null,
      success: sent
        ? 'OTP sent. Check your inbox.'
        : 'DEV mode: OTP was printed in your server logs.',
      otpEmail: email
    });
  } catch (err) {
    console.error('send-otp error:', err);

    res.render('index', {
      error: 'Could not send OTP. Check server email settings.',
      success: null,
      otpEmail: normalizeEmail(req.body.email)
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

  req.session.save(() => res.redirect('/trading'));
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

  const adminEmail = 'admin@tensorwallet.local';
  const user = getOrCreateUser(adminEmail, 'staff');

  req.session.user = {
    email: adminEmail,
    username: 'admin',
    role: 'staff',
    walletId: user.id
  };

  req.session.save(() => res.redirect('/trading'));
});

app.get('/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('tensorwallet.sid');
    res.redirect('/');
  });
});

app.post('/logout', (req, res) => {
  res.redirect('/logout');
});

/* -------------------- Trading APIs -------------------- */

app.get('/api/trading/state', requireAuthJson, (req, res) => {
  const db = readDb();
  const user = db.users[req.session.user.email] || getOrCreateUser(req.session.user.email, req.session.user.role);

  res.json({
    usdtBalance: safeNumber(user.usdtBalance, 0),
    positions: user.positions || [],
    orderHistory: user.orderHistory || []
  });
});

app.post('/api/trading/execute', requireAuthJson, (req, res) => {
  const tokenId = String(req.body.tokenId || '');
  const side = String(req.body.side || '').toLowerCase();
  const margin = safeNumber(req.body.margin, 0);
  const leverage = safeNumber(req.body.leverage, 1);
  const marginMode = String(req.body.marginMode || 'cross').toLowerCase() === 'isolated'
    ? 'isolated'
    : 'cross';

  if (!tokenId || !['long', 'short'].includes(side)) {
    return res.status(400).json({ error: 'Invalid trade side or asset.' });
  }

  if (margin <= 0 || leverage < 1 || leverage > 150) {
    return res.status(400).json({ error: 'Invalid margin or leverage.' });
  }

  const db = readDb();
  const user = db.users[req.session.user.email];

  if (!user) {
    return res.status(401).json({ error: 'User not found.' });
  }

  const token = db.tensorRegistry.find(t => t.id === tokenId);

  if (!token) {
    return res.status(404).json({ error: 'Asset not found.' });
  }

  if (user.usdtBalance < margin) {
    return res.status(400).json({ error: 'Insufficient USDT balance.' });
  }

  user.usdtBalance = safeNumber(user.usdtBalance, 0) - margin;

  const position = {
    id: makeId('pos'),
    tokenId: token.id,
    symbol: token.symbol,
    side,
    margin,
    leverage,
    marginMode,
    size: margin * leverage,
    entryPrice: token.price,
    openedAt: Date.now()
  };

  user.positions.unshift(position);
  user.updatedAt = nowIso();

  writeDb(db);

  res.json({
    ok: true,
    position,
    usdtBalance: user.usdtBalance
  });
});

app.post('/api/trading/close', requireAuthJson, (req, res) => {
  const positionId = String(req.body.positionId || '');

  if (!positionId) {
    return res.status(400).json({ error: 'Missing position ID.' });
  }

  const db = readDb();
  const user = db.users[req.session.user.email];

  if (!user) {
    return res.status(401).json({ error: 'User not found.' });
  }

  const posIdx = user.positions.findIndex(p => String(p.id) === positionId);

  if (posIdx === -1) {
    return res.status(404).json({ error: 'Position not found.' });
  }

  const pos = user.positions[posIdx];
  const token = db.tensorRegistry.find(t => t.id === pos.tokenId);
  const currentPrice = token ? token.price : pos.entryPrice;
  const pnl = calculatePnl(pos, currentPrice);

  user.usdtBalance = safeNumber(user.usdtBalance, 0) + safeNumber(pos.margin, 0) + pnl;
  user.positions.splice(posIdx, 1);

  const historyRecord = {
    ...pos,
    closePrice: currentPrice,
    pnl,
    closedAt: Date.now(),
    closeReason: 'Market Close'
  };

  user.orderHistory.unshift(historyRecord);
  user.orderHistory = user.orderHistory.slice(0, 100);
  user.updatedAt = nowIso();

  writeDb(db);

  res.json({
    ok: true,
    usdtBalance: user.usdtBalance,
    pnl,
    historyRecord
  });
});

/* -------------------- Wallet APIs -------------------- */

app.get('/api/wallet', requireAuthJson, (req, res) => {
  const user = getOrCreateUser(req.session.user.email, req.session.user.role);
  res.json(user);
});

app.post('/api/wallet/vault', requireAuthJson, (req, res) => {
  const db = readDb();
  const user = db.users[req.session.user.email];

  if (!user) {
    return res.status(401).json({ error: 'User not found.' });
  }

  if (!req.body.encryptedVault) {
    return res.status(400).json({ error: 'No vault data provided.' });
  }

  user.encryptedVault = req.body.encryptedVault;
  user.publicWallets = Array.isArray(req.body.publicWallets) ? req.body.publicWallets : [];
  user.updatedAt = nowIso();

  writeDb(db);

  res.json({ ok: true });
});

app.post('/api/wallet/send', requireAuthJson, (req, res) => {
  const network = String(req.body.network || '').trim();
  const asset = String(req.body.asset || '').trim();
  const amount = safeNumber(req.body.amount, 0);
  const toAddress = String(req.body.toAddress || '').trim();

  if (!network || !asset || amount <= 0 || !toAddress) {
    return res.status(400).json({ error: 'Invalid request.' });
  }

  const txHash = `0x${crypto.randomBytes(32).toString('hex')}`;

  res.json({
    ok: true,
    txHash,
    status: 'demo-sent'
  });
});

/* -------------------- Tensor APIs -------------------- */

app.get('/api/tensor', requireAuthJson, async (req, res) => {
  try {
    await syncRealCryptoPrices();

    const db = readDb();
    const user = db.users[req.session.user.email];

    db.tensorRegistry.forEach(token => {
      const oldPrice = token.price;
      const mappedSymbol = REAL_SYMBOL_MAP[String(token.symbol || '').toUpperCase()];
      const real = mappedSymbol ? latestRealPrices[mappedSymbol] : null;

      if (real && real.price > 0) {
        token.bias = 'real';
        token.price = real.price;
        token.volume = real.volume || token.volume || 0;
        token.changePercent24h = real.changePercent || 0;
        token.high24h = real.high || token.price;
        token.low24h = real.low || token.price;
        token.marketCap = token.price * token.supply;
        pushLiveCandle(token, oldPrice);
      } else {
        initializeCandlesForToken(token.id, token.price);
      }
    });

    writeDb(db);

    res.json({
      registry: db.tensorRegistry,
      address: user.tensorAddress,
      balances: user.tensorBalances || {},
      syncedAt: Date.now(),
      treasury: req.session.user.role === 'staff' ? db.treasury : undefined
    });
  } catch (err) {
    console.error('/api/tensor error:', err);

    res.status(500).json({
      error: 'Could not load tensor registry.'
    });
  }
});

app.get('/api/tensor/chart', requireAuthJson, (req, res) => {
  const tokenId = String(req.query.tokenId || '');

  if (!tokenId) {
    return res.json({ candles: [] });
  }

  const db = readDb();
  const token = db.tensorRegistry.find(t => t.id === tokenId);

  if (!token) {
    return res.json({ candles: [] });
  }

  initializeCandlesForToken(token.id, token.price);

  res.json({
    candles: tensorCandleHistory[token.id] || []
  });
});

app.get('/api/live-prices', requireAuthJson, async (req, res) => {
  try {
    await syncRealCryptoPrices(true);

    res.json({
      ok: true,
      prices: latestRealPrices,
      syncedAt: lastRealPriceSync
    });
  } catch {
    res.status(500).json({
      ok: false,
      error: 'Could not load live prices.'
    });
  }
});

app.post('/api/tensor/vault', requireAuthJson, (req, res) => {
  const db = readDb();
  const user = db.users[req.session.user.email];

  if (!user) {
    return res.status(401).json({ error: 'User not found.' });
  }

  if (!req.body.tensorVault) {
    return res.status(400).json({ error: 'No Tensor vault data provided.' });
  }

  user.tensorVault = req.body.tensorVault;
  user.updatedAt = nowIso();

  writeDb(db);

  res.json({ ok: true });
});

app.post('/api/tensor/deploy', requireAdminJson, (req, res) => {
  const name = String(req.body.name || '').trim();
  const symbol = String(req.body.symbol || '').trim().toUpperCase();
  const price = safeNumber(req.body.price, 0);
  const bias = String(req.body.bias || 'balanced').trim();
  const bullChance = safeNumber(req.body.bullChance, 50);
  const minPct = safeNumber(req.body.minPct, 0.1) / 100;
  const maxPct = safeNumber(req.body.maxPct, 0.5) / 100;
  const icon = String(req.body.icon || symbol.slice(0, 1) || 'T').trim();
  const supply = safeNumber(req.body.supply, 10000000);

  if (!name || !symbol || price <= 0 || supply <= 0) {
    return res.status(400).json({ error: 'Missing or invalid token parameters.' });
  }

  const db = readDb();

  const id = `T0x${crypto.randomBytes(20).toString('hex')}`;

  const token = {
    id,
    name,
    symbol,
    price,
    startPrice: price,
    bias,
    bullChance: Math.max(0, Math.min(100, bullChance)),
    minPct: Math.max(0, minPct),
    maxPct: Math.max(minPct, maxPct),
    icon,
    supply,
    marketCap: price * supply,
    volume: 0,
    dominance: 0,
    changePercent24h: 0,
    high24h: price,
    low24h: price
  };

  db.tensorRegistry.push(token);
  writeDb(db);

  initializeCandlesForToken(id, price);

  res.json({
    ok: true,
    id,
    token
  });
});

app.put('/api/tensor/update/:id', requireAdminJson, (req, res) => {
  const db = readDb();
  const token = db.tensorRegistry.find(t => t.id === req.params.id);

  if (!token) {
    return res.status(404).json({ error: 'Token not found.' });
  }

  if (req.body.name !== undefined) token.name = String(req.body.name || token.name);
  if (req.body.symbol !== undefined) token.symbol = String(req.body.symbol || token.symbol).toUpperCase();
  if (req.body.icon !== undefined) token.icon = String(req.body.icon || token.icon);
  if (req.body.bias !== undefined) token.bias = String(req.body.bias || token.bias);

  if (req.body.price !== undefined) {
    token.price = Math.max(0.000001, safeNumber(req.body.price, token.price));
  }

  if (req.body.startPrice !== undefined) {
    token.startPrice = Math.max(0.000001, safeNumber(req.body.startPrice, token.startPrice));
  }

  if (req.body.bullChance !== undefined) {
    token.bullChance = Math.max(0, Math.min(100, safeNumber(req.body.bullChance, token.bullChance)));
  }

  if (req.body.minPct !== undefined) {
    token.minPct = Math.max(0, safeNumber(req.body.minPct, token.minPct * 100) / 100);
  }

  if (req.body.maxPct !== undefined) {
    token.maxPct = Math.max(token.minPct, safeNumber(req.body.maxPct, token.maxPct * 100) / 100);
  }

  if (req.body.supply !== undefined) {
    token.supply = Math.max(1, safeNumber(req.body.supply, token.supply));
  }

  token.marketCap = token.price * token.supply;

  writeDb(db);
  initializeCandlesForToken(token.id, token.price);

  res.json({
    ok: true,
    token
  });
});

app.delete('/api/tensor/delete/:id', requireAdminJson, (req, res) => {
  const db = readDb();
  const index = db.tensorRegistry.findIndex(t => t.id === req.params.id);

  if (index === -1) {
    return res.status(404).json({ error: 'Token not found.' });
  }

  db.tensorRegistry.splice(index, 1);
  delete tensorCandleHistory[req.params.id];

  Object.values(db.users).forEach(user => {
    if (user.tensorBalances) delete user.tensorBalances[req.params.id];

    if (Array.isArray(user.positions)) {
      user.positions = user.positions.filter(p => p.tokenId !== req.params.id);
    }
  });

  writeDb(db);

  res.json({ ok: true });
});

app.post('/api/tensor/admin-mint', requireAdminJson, (req, res) => {
  const tokenId = String(req.body.tokenId || '');
  const amount = safeNumber(req.body.amount, 0);

  if (!tokenId || amount <= 0) {
    return res.status(400).json({ error: 'Invalid parameters.' });
  }

  const db = readDb();
  const token = db.tensorRegistry.find(t => t.id === tokenId);

  if (!token) {
    return res.status(404).json({ error: 'Token not found.' });
  }

  const user = db.users[req.session.user.email];

  user.tensorBalances[tokenId] = safeNumber(user.tensorBalances[tokenId], 0) + amount;
  user.updatedAt = nowIso();

  writeDb(db);

  res.json({
    ok: true,
    newBalance: user.tensorBalances[tokenId]
  });
});

app.post('/api/tensor/swap', requireAuthJson, (req, res) => {
  const tokenId = String(req.body.tokenId || '');
  const spend = safeNumber(req.body.usdtAmount, 0);

  if (!tokenId || spend <= 0) {
    return res.status(400).json({ error: 'Invalid payload.' });
  }

  const db = readDb();
  const user = db.users[req.session.user.email];
  const token = db.tensorRegistry.find(t => t.id === tokenId);

  if (!token) {
    return res.status(404).json({ error: 'Token missing.' });
  }

  if (safeNumber(user.usdtBalance, 0) < spend) {
    return res.status(400).json({ error: 'Insufficient USDT balance.' });
  }

  const feeRate = 0.000001;
  const feeAmount = spend * feeRate;
  const netSpend = spend - feeAmount;

  db.treasury.collectedFeesUsdt = safeNumber(db.treasury.collectedFeesUsdt, 0) + feeAmount;

  let priceImpact = 0;

  if (token.bias !== 'pegged' && token.bias !== 'real') {
    const marketCap = Math.max(100, safeNumber(token.marketCap, token.price * token.supply));
    const impactMultiplier = netSpend / marketCap;
    priceImpact = Math.min(0.5, impactMultiplier * 0.8);
  }

  const originalPrice = token.price;
  const executionPrice = originalPrice * (1 + priceImpact / 2);
  const received = netSpend / executionPrice;

  user.usdtBalance -= spend;
  user.tensorBalances[tokenId] = safeNumber(user.tensorBalances[tokenId], 0) + received;

  if (token.bias !== 'pegged' && token.bias !== 'real') {
    token.price = Math.max(0.000001, originalPrice * (1 + priceImpact));
    token.marketCap = token.price * token.supply;
  }

  token.volume = safeNumber(token.volume, 0) + spend;

  pushLiveCandle(token, originalPrice);

  user.updatedAt = nowIso();

  writeDb(db);

  res.json({
    ok: true,
    received,
    impactPercent: Number((priceImpact * 100).toFixed(4)),
    feePaid: feeAmount,
    usdtBalance: user.usdtBalance
  });
});

app.post('/api/tensor/send', requireAuthJson, (req, res) => {
  const tokenId = String(req.body.tokenId || '');
  const amount = safeNumber(req.body.amount, 0);
  const toAddress = String(req.body.toAddress || '').trim();

  if (!tokenId || amount <= 0 || !toAddress) {
    return res.status(400).json({ error: 'Invalid parameters.' });
  }

  const db = readDb();
  const sender = db.users[req.session.user.email];

  if (safeNumber(sender.tensorBalances[tokenId], 0) < amount) {
    return res.status(400).json({ error: 'Insufficient balance.' });
  }

  const recipientEmail = Object.keys(db.users).find(email => {
    return db.users[email].tensorAddress === toAddress;
  });

  if (!recipientEmail) {
    return res.status(404).json({ error: 'Recipient not found.' });
  }

  const recipient = db.users[recipientEmail];

  sender.tensorBalances[tokenId] -= amount;
  recipient.tensorBalances[tokenId] = safeNumber(recipient.tensorBalances[tokenId], 0) + amount;

  sender.updatedAt = nowIso();
  recipient.updatedAt = nowIso();

  writeDb(db);

  res.json({ ok: true });
});

/* -------------------- Standard Market APIs -------------------- */

app.get('/api/prices', requireAuthJson, async (req, res) => {
  try {
    const ids = String(req.query.ids || '')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean);

    if (!ids.length) {
      return res.json({});
    }

    const url = `${COINGECKO_BASE}/simple/price?ids=${encodeURIComponent(ids.join(','))}&vs_currencies=usd&include_24hr_change=true&include_market_cap=true`;

    const data = await cachedJson(`cg-prices:${ids.join(',')}`, 5000, () => {
      return fetchJsonWithTimeout(url, {}, 8000);
    });

    res.json(data);
  } catch (err) {
    console.error('/api/prices error:', err.message);
    res.json({});
  }
});

/* -------------------- Health / Fallback -------------------- */

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    uptime: process.uptime(),
    main: '/trading',
    pages: {
      index: '/ or /index.html',
      wallet: '/wallet',
      trading: '/trading'
    },
    dataDir: DATA_DIR,
    dbPath: DB_PATH,
    dbExists: fs.existsSync(DB_PATH),
    lastRealPriceSync,
    realPriceCount: Object.keys(latestRealPrices).length
  });
});

app.use((req, res) => {
  if (req.path.startsWith('/api')) {
    return res.status(404).json({ error: 'API route not found.' });
  }

  if (req.session.user) {
    return res.redirect('/trading');
  }

  return res.redirect('/');
});

/* -------------------- Startup -------------------- */

ensureDb();
hydrateAllCandles();

syncRealCryptoPrices(true)
  .then(() => runMarketLoop())
  .catch(() => runMarketLoop());

setInterval(() => {
  runMarketLoop();
}, MARKET_LOOP_MS);

app.listen(PORT, () => {
  console.log(`Tensor Wallet running on port ${PORT}`);
  console.log(`Index page: /`);
  console.log(`Wallet page: /wallet -> views/wallet.ejs`);
  console.log(`Trading page: /trading -> views/trading.ejs`);
  console.log(`Data directory: ${DATA_DIR}`);
  console.log(`Database path: ${DB_PATH}`);
});