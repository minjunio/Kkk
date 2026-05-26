const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const session = require('express-session');
const nodemailer = require('nodemailer');

const app = express();

const PORT = process.env.PORT || 3000;
const SESSION_SECRET = process.env.SESSION_SECRET || 'change-this-secret-in-render';
const STAFF_USERNAME = process.env.STAFF_USERNAME || 'admin';
const STAFF_PASSWORD = process.env.STAFF_PASSWORD || 'monterysasd';

const DATA_DIR = path.join(__dirname, 'data');
const DB_PATH = path.join(DATA_DIR, 'wallets.json');

const SUPPORTED_ASSETS = [
  'BTC', 'ETH', 'SOL', 'BNB', 'XRP', 'DOGE', 'TRX', 'TON', 'ADA', 'AVAX',
  'LINK', 'DOT', 'NEAR', 'ARB', 'OP', 'SUI', 'APT', 'ATOM', 'FIL', 'ETC',
  'LTC', 'BCH', 'ICP', 'HBAR', 'SEI', 'INJ', 'RENDER', 'FET', 'WLD', 'TIA',
  'JUP', 'PYTH', 'GRT', 'ALGO', 'VET', 'EGLD',
  'UNI', 'AAVE', 'MKR', 'LDO', 'RUNE', 'CRV', 'COMP', 'SNX', 'DYDX', 'GMX',
  'PENDLE', 'ENA',
  'PEPE', 'SHIB', 'FLOKI', 'BONK', 'WIF', 'TURBO', 'BRETT', 'PNUT', 'MEW'
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
  MEW: 'cat in a dogs world'
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
  MEW: 'cat-in-a-dogs-world'
};

const otpStore = new Map();

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
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

function createDepositAddress(email, asset) {
  const seed = sha(`${email}:${asset}:${process.env.WALLET_ADDRESS_SECRET || 'blue-wallet-secret'}`);
  const prefix = {
    BTC: 'bc1q',
    ETH: '0x',
    BNB: '0x',
    AVAX: '0x',
    MATIC: '0x',
    SOL: 'SoL',
    TRX: 'T',
    XRP: 'r',
    DOGE: 'D',
    LTC: 'L'
  }[asset] || '0x';

  if (prefix === '0x') return `0x${seed.slice(0, 40)}`;
  return `${prefix}${seed.slice(0, 36)}`;
}

function createDepositAddresses(email) {
  const addresses = {};

  for (const asset of SUPPORTED_ASSETS) {
    addresses[asset] = {
      asset,
      address: createDepositAddress(email, asset),
      network: getDefaultNetwork(asset)
    };
  }

  return addresses;
}

function getDefaultNetwork(asset) {
  if (asset === 'BTC') return 'Bitcoin';
  if (asset === 'SOL') return 'Solana';
  if (asset === 'TRX') return 'TRON';
  if (asset === 'XRP') return 'XRP Ledger';
  if (asset === 'DOGE') return 'Dogecoin';
  if (asset === 'LTC') return 'Litecoin';
  return 'Ethereum / EVM';
}

function createNewWallet(email, options = {}) {
  const isStaff = Boolean(options.isStaff);

  const wallet = {
    id: `wallet_${sha(email).slice(0, 18)}`,
    email,
    role: isStaff ? 'staff' : 'user',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
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
              dailyPnlUsd: 0
            },
            {
              currency: 'SOL',
              name: 'Solana Vault',
              stakedAmount: 500,
              apy: 7.2,
              earnedAmount: 0,
              livePnlUsd: 0,
              dailyPnlUsd: 0
            }
          ]
        : []
    },
    depositAddresses: createDepositAddresses(email)
  };

  return wallet;
}

function getOrCreateWallet(email, options = {}) {
  const normalizedEmail = String(email).trim().toLowerCase();
  const db = readDb();

  if (!db.users[normalizedEmail]) {
    db.users[normalizedEmail] = createNewWallet(normalizedEmail, options);
    writeDb(db);
  }

  if (options.isStaff && db.users[normalizedEmail].role !== 'staff') {
    db.users[normalizedEmail].role = 'staff';
    db.users[normalizedEmail].assets = createNewWallet(normalizedEmail, { isStaff: true }).assets;
    db.users[normalizedEmail].staking = createNewWallet(normalizedEmail, { isStaff: true }).staking;
    db.users[normalizedEmail].updatedAt = new Date().toISOString();
    writeDb(db);
  }

  return db.users[normalizedEmail];
}

function updateWallet(email, walletPatch) {
  const normalizedEmail = String(email).trim().toLowerCase();
  const db = readDb();

  if (!db.users[normalizedEmail]) {
    db.users[normalizedEmail] = createNewWallet(normalizedEmail);
  }

  db.users[normalizedEmail] = {
    ...db.users[normalizedEmail],
    ...walletPatch,
    updatedAt: new Date().toISOString()
  };

  writeDb(db);
  return db.users[normalizedEmail];
}

function generateOtp() {
  return String(crypto.randomInt(100000, 999999));
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
    subject: 'Your Blue Wallet OTP Code',
    text: `Your Blue Wallet login code is ${otp}. It expires in 10 minutes.`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 520px; margin: 0 auto; padding: 24px;">
        <h2 style="margin: 0 0 12px;">Blue Wallet Login Code</h2>
        <p style="color: #475569;">Use this code to login to Blue Wallet and Trading.</p>
        <div style="font-size: 32px; font-weight: 800; letter-spacing: 6px; padding: 16px; border-radius: 12px; background: #eef6ff; color: #0284c7; text-align: center;">
          ${otp}
        </div>
        <p style="color: #64748b; font-size: 13px;">This code expires in 10 minutes.</p>
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
    const email = String(req.body.email || '').trim().toLowerCase();

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
        ? 'OTP code sent to your email.'
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
  const email = String(req.body.email || '').trim().toLowerCase();
  const otp = String(req.body.otp || '').trim();

  const record = otpStore.get(email);

  if (!record) {
    return res.render('index', {
      error: 'No OTP found. Please request a new code.',
      success: null,
      otpEmail: email
    });
  }

  if (Date.now() > record.expiresAt) {
    otpStore.delete(email);
    return res.render('index', {
      error: 'OTP expired. Please request a new code.',
      success: null,
      otpEmail: email
    });
  }

  if (record.attempts >= 5) {
    otpStore.delete(email);
    return res.render('index', {
      error: 'Too many attempts. Please request a new code.',
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

  const wallet = getOrCreateWallet(email);

  req.session.user = {
    email,
    username: email.split('@')[0],
    role: wallet.role,
    walletId: wallet.id
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

  const staffEmail = process.env.STAFF_EMAIL || process.env.GMAIL_USER || 'admin@bluewallet.local';
  const wallet = getOrCreateWallet(staffEmail, { isStaff: true });

  req.session.user = {
    email: staffEmail,
    username: 'admin',
    role: 'staff',
    walletId: wallet.id
  };

  res.redirect('/wallet');
});

app.get('/wallet', requireAuth, (req, res) => {
  const wallet = getOrCreateWallet(req.session.user.email, {
    isStaff: req.session.user.role === 'staff'
  });

  res.render('wallet', {
    username: req.session.user.username,
    email: req.session.user.email,
    role: req.session.user.role,
    wallet: JSON.stringify(wallet)
  });
});

app.get('/trading', requireAuth, (req, res) => {
  const wallet = getOrCreateWallet(req.session.user.email, {
    isStaff: req.session.user.role === 'staff'
  });

  res.render('trading', {
    username: req.session.user.username,
    email: req.session.user.email,
    role: req.session.user.role,
    wallet: JSON.stringify(wallet)
  });
});

app.get('/api/wallet', requireAuth, (req, res) => {
  const wallet = getOrCreateWallet(req.session.user.email, {
    isStaff: req.session.user.role === 'staff'
  });

  res.json(wallet);
});

app.post('/api/wallet', requireAuth, (req, res) => {
  const allowedPatch = {};

  if (Array.isArray(req.body.assets)) allowedPatch.assets = req.body.assets;
  if (req.body.staking && typeof req.body.staking === 'object') allowedPatch.staking = req.body.staking;

  const wallet = updateWallet(req.session.user.email, allowedPatch);

  res.json({
    ok: true,
    wallet
  });
});

app.get('/api/assets', (req, res) => {
  res.json({
    assets: SUPPORTED_ASSETS.map(symbol => ({
      symbol,
      name: ASSET_NAMES[symbol] || symbol,
      geckoId: GECKO_IDS[symbol] || null,
      pair: `${symbol}/USDT`,
      network: getDefaultNetwork(symbol)
    }))
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
  req.session.destroy(() => {
    res.redirect('/');
  });
});

app.listen(PORT, () => {
  ensureDb();
  console.log(`Blue Wallet running on port ${PORT}`);
});