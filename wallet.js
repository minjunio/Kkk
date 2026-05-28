'use strict';

const crypto = require('crypto');
const { ethers } = require('ethers');

/*
  wallet.js
  ---------
  Handles normal crypto wallet logic:
  - EVM wallet generation
  - Encrypted seed/private key storage in user data
  - Receive addresses
  - Demo send transaction records

  Important:
  - Seeds/private keys are encrypted before being stored in wallets.json.
  - Decryption only happens when buildWalletPublicPayload(..., { includeSecrets: true }) is called.
  - This module does NOT broadcast real blockchain transactions.
*/

const WALLET_MASTER_SECRET =
  process.env.WALLET_MASTER_SECRET ||
  'dev-wallet-master-secret-change-this-before-production';

const ENCRYPTION_VERSION = 'v1';

const SUPPORTED_NETWORKS = {
  eth: {
    key: 'eth',
    name: 'Ethereum',
    short: 'ERC20',
    chainId: 1,
    symbol: 'ETH',
    evm: true
  },
  arbitrum: {
    key: 'arbitrum',
    name: 'Arbitrum',
    short: 'ARB',
    chainId: 42161,
    symbol: 'ETH',
    evm: true
  },
  base: {
    key: 'base',
    name: 'Base',
    short: 'BASE',
    chainId: 8453,
    symbol: 'ETH',
    evm: true
  },
  polygon: {
    key: 'polygon',
    name: 'Polygon',
    short: 'POL',
    chainId: 137,
    symbol: 'POL',
    evm: true
  },
  sol: {
    key: 'sol',
    name: 'Solana',
    short: 'SOL',
    chainId: null,
    symbol: 'SOL',
    evm: false
  },
  trx: {
    key: 'trx',
    name: 'TRON',
    short: 'TRC20',
    chainId: null,
    symbol: 'TRX',
    evm: false
  }
};

function nowIso() {
  return new Date().toISOString();
}

function safeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function normalizeNetwork(network) {
  const raw = String(network || '').trim().toLowerCase();

  if (raw.includes('arb')) return 'arbitrum';
  if (raw.includes('base')) return 'base';
  if (raw.includes('poly') || raw.includes('matic')) return 'polygon';
  if (raw.includes('sol')) return 'sol';
  if (raw.includes('tron') || raw.includes('trc') || raw.includes('trx')) return 'trx';
  if (raw.includes('eth') || raw.includes('erc')) return 'eth';

  return 'eth';
}

function sha256Hex(input) {
  return crypto.createHash('sha256').update(String(input)).digest('hex');
}

function hmacHex(secret, input) {
  return crypto.createHmac('sha256', secret).update(String(input)).digest('hex');
}

function makeId(prefix = 'id') {
  return `${prefix}_${Date.now()}_${crypto.randomBytes(8).toString('hex')}`;
}

function getEncryptionKey() {
  return crypto
    .createHash('sha256')
    .update(String(WALLET_MASTER_SECRET))
    .digest();
}

function encryptString(plainText) {
  if (plainText === undefined || plainText === null) {
    throw new Error('Cannot encrypt empty value.');
  }

  const key = getEncryptionKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);

  const encrypted = Buffer.concat([
    cipher.update(String(plainText), 'utf8'),
    cipher.final()
  ]);

  const tag = cipher.getAuthTag();

  return [
    ENCRYPTION_VERSION,
    iv.toString('base64'),
    tag.toString('base64'),
    encrypted.toString('base64')
  ].join(':');
}

function decryptString(encryptedValue) {
  const raw = String(encryptedValue || '');

  if (!raw) {
    throw new Error('Missing encrypted value.');
  }

  const parts = raw.split(':');

  if (parts.length !== 4 || parts[0] !== ENCRYPTION_VERSION) {
    throw new Error('Invalid encrypted value format.');
  }

  const [, ivB64, tagB64, encryptedB64] = parts;

  const key = getEncryptionKey();
  const iv = Buffer.from(ivB64, 'base64');
  const tag = Buffer.from(tagB64, 'base64');
  const encrypted = Buffer.from(encryptedB64, 'base64');

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);

  const decrypted = Buffer.concat([
    decipher.update(encrypted),
    decipher.final()
  ]);

  return decrypted.toString('utf8');
}

function isEncryptedValue(value) {
  return typeof value === 'string' && value.startsWith(`${ENCRYPTION_VERSION}:`);
}

function deriveDeterministicEntropy(email) {
  const normalized = normalizeEmail(email);

  if (!normalized) {
    throw new Error('Email is required to generate wallet.');
  }

  const entropyHex = hmacHex(WALLET_MASTER_SECRET, `evm-wallet:${normalized}`);

  return `0x${entropyHex.slice(0, 32)}`;
}

function generateEvmWalletForEmail(email) {
  const entropy = deriveDeterministicEntropy(email);
  const mnemonic = ethers.Mnemonic.fromEntropy(entropy);
  const hdWallet = ethers.HDNodeWallet.fromMnemonic(mnemonic);

  return {
    address: hdWallet.address,
    privateKey: hdWallet.privateKey,
    seedPhrase: mnemonic.phrase
  };
}

function getNonEvmDemoAddress(email, network) {
  const normalized = normalizeEmail(email);
  const key = normalizeNetwork(network);
  const hash = hmacHex(WALLET_MASTER_SECRET, `receive:${key}:${normalized}`);

  if (key === 'sol') {
    return `SoL${hash.slice(0, 41)}`;
  }

  if (key === 'trx') {
    return `T${hash.slice(0, 33)}`;
  }

  return `0x${hash.slice(0, 40)}`;
}

function getEvmReceiveAddress(userOrEmail) {
  const email = typeof userOrEmail === 'string'
    ? userOrEmail
    : userOrEmail?.email;

  return generateEvmWalletForEmail(email).address;
}

function getReceiveAddresses(email) {
  const evm = generateEvmWalletForEmail(email);

  return {
    eth: evm.address,
    arbitrum: evm.address,
    base: evm.address,
    polygon: evm.address,
    sol: getNonEvmDemoAddress(email, 'sol'),
    trx: getNonEvmDemoAddress(email, 'trx')
  };
}

function getReceiveAddress(email, network = 'eth') {
  const key = normalizeNetwork(network);
  const net = SUPPORTED_NETWORKS[key] || SUPPORTED_NETWORKS.eth;

  if (net.evm) {
    return generateEvmWalletForEmail(email).address;
  }

  return getNonEvmDemoAddress(email, key);
}

function ensureCryptoWalletForUser(user) {
  if (!user || !user.email) {
    throw new Error('User with email is required.');
  }

  const email = normalizeEmail(user.email);
  const generated = generateEvmWalletForEmail(email);
  const receiveAddresses = getReceiveAddresses(email);

  if (!user.cryptoWallet || typeof user.cryptoWallet !== 'object') {
    user.cryptoWallet = {};
  }

  /*
    Migrate old plaintext fields if they exist.
    After this runs, plaintext seeds/private keys are removed.
  */
  const legacyPlainSeed =
    typeof user.normalSeed === 'string' && user.normalSeed.trim()
      ? user.normalSeed.trim()
      : '';

  const legacyPlainPrivateKey =
    typeof user.privateKey === 'string' && user.privateKey.trim()
      ? user.privateKey.trim()
      : '';

  const seedPhrase = legacyPlainSeed || generated.seedPhrase;
  const privateKey = legacyPlainPrivateKey || generated.privateKey;

  if (!user.cryptoWallet.encryptedSeedPhrase) {
    user.cryptoWallet.encryptedSeedPhrase = encryptString(seedPhrase);
  } else if (!isEncryptedValue(user.cryptoWallet.encryptedSeedPhrase)) {
    user.cryptoWallet.encryptedSeedPhrase = encryptString(user.cryptoWallet.encryptedSeedPhrase);
  }

  if (!user.cryptoWallet.encryptedPrivateKey) {
    user.cryptoWallet.encryptedPrivateKey = encryptString(privateKey);
  } else if (!isEncryptedValue(user.cryptoWallet.encryptedPrivateKey)) {
    user.cryptoWallet.encryptedPrivateKey = encryptString(user.cryptoWallet.encryptedPrivateKey);
  }

  user.cryptoWallet.evmAddress = user.cryptoWallet.evmAddress || generated.address;
  user.cryptoWallet.receiveAddresses = {
    ...receiveAddresses,
    ...(user.cryptoWallet.receiveAddresses || {})
  };

  user.cryptoWallet.supportedNetworks = SUPPORTED_NETWORKS;

  if (!user.cryptoWallet.createdAt) {
    user.cryptoWallet.createdAt = Date.now();
    user.cryptoWallet.createdAtIso = nowIso();
  }

  user.cryptoWallet.updatedAt = Date.now();
  user.cryptoWallet.updatedAtIso = nowIso();

  user.evmAddress = user.cryptoWallet.evmAddress;
  user.receiveAddresses = user.cryptoWallet.receiveAddresses;

  /*
    Remove plaintext secrets from the root user object.
    wallet.ejs can still receive decrypted seed only through API response.
  */
  delete user.normalSeed;
  delete user.privateKey;
  delete user.seedPhrase;
  delete user.walletSeed;

  if (!Array.isArray(user.walletTxHistory)) {
    user.walletTxHistory = [];
  }

  return user.cryptoWallet;
}

function decryptCryptoWalletForUser(user) {
  ensureCryptoWalletForUser(user);

  return {
    evmAddress: user.cryptoWallet.evmAddress,
    privateKey: decryptString(user.cryptoWallet.encryptedPrivateKey),
    seedPhrase: decryptString(user.cryptoWallet.encryptedSeedPhrase),
    receiveAddresses: user.cryptoWallet.receiveAddresses || getReceiveAddresses(user.email),
    supportedNetworks: SUPPORTED_NETWORKS
  };
}

function buildWalletPublicPayload(user, options = {}) {
  const includeSecrets = Boolean(options.includeSecrets);

  ensureCryptoWalletForUser(user);

  const payload = {
    evmAddress: user.cryptoWallet.evmAddress,
    receiveAddresses: user.cryptoWallet.receiveAddresses || getReceiveAddresses(user.email),
    supportedNetworks: SUPPORTED_NETWORKS,
    walletTxHistory: Array.isArray(user.walletTxHistory) ? user.walletTxHistory : []
  };

  if (includeSecrets) {
    payload.normalSeed = decryptString(user.cryptoWallet.encryptedSeedPhrase);
    payload.evmPrivateKey = decryptString(user.cryptoWallet.encryptedPrivateKey);
  }

  return payload;
}

function createDemoWalletSendTx({
  user,
  email,
  asset,
  network,
  amount,
  toAddress
}) {
  const userEmail = normalizeEmail(email || user?.email);
  const key = normalizeNetwork(network);
  const normalizedAsset = String(asset || '').trim().toUpperCase();
  const numericAmount = safeNumber(amount, 0);

  if (!userEmail) {
    throw new Error('Missing email.');
  }

  if (!normalizedAsset) {
    throw new Error('Missing asset.');
  }

  if (numericAmount <= 0) {
    throw new Error('Invalid amount.');
  }

  if (!toAddress || String(toAddress).trim().length < 8) {
    throw new Error('Invalid recipient address.');
  }

  const fromAddress = getReceiveAddress(userEmail, key);

  return {
    id: makeId('wallet_send'),
    txHash: `0x${crypto.randomBytes(32).toString('hex')}`,
    status: 'demo-sent',
    asset: normalizedAsset,
    network: key,
    fromAddress,
    toAddress: String(toAddress).trim(),
    amount: numericAmount,
    createdAt: Date.now(),
    createdAtIso: nowIso(),
    note: 'Demo transaction recorded. No real on-chain broadcast was performed.'
  };
}

function applyWalletSendToUser(user, input) {
  if (!user) {
    throw new Error('User is required.');
  }

  ensureCryptoWalletForUser(user);

  const asset = String(input.asset || '').trim().toUpperCase();
  const amount = safeNumber(input.amount, 0);

  if (!asset || amount <= 0) {
    throw new Error('Invalid send details.');
  }

  if (asset === 'USDT') {
    user.usdtBalance = safeNumber(user.usdtBalance, 0);

    if (user.usdtBalance < amount) {
      throw new Error('Insufficient USDT balance.');
    }

    user.usdtBalance -= amount;
  } else if (asset === 'OUSD') {
    user.ousdBalance = safeNumber(user.ousdBalance, 0);

    if (user.ousdBalance < amount) {
      throw new Error('Insufficient OUSD balance.');
    }

    user.ousdBalance -= amount;
  } else {
    const balanceKey = `${asset.toLowerCase()}Balance`;
    user[balanceKey] = safeNumber(user[balanceKey], 0);

    if (user[balanceKey] < amount) {
      throw new Error(`Insufficient ${asset} balance.`);
    }

    user[balanceKey] -= amount;
  }

  const tx = createDemoWalletSendTx({
    user,
    asset,
    network: input.network,
    amount,
    toAddress: input.toAddress
  });

  if (!Array.isArray(user.walletTxHistory)) {
    user.walletTxHistory = [];
  }

  user.walletTxHistory.unshift(tx);
  user.walletTxHistory = user.walletTxHistory.slice(0, 200);
  user.updatedAt = nowIso();

  return tx;
}

function removePlaintextWalletSecrets(user) {
  if (!user) return;

  delete user.normalSeed;
  delete user.privateKey;
  delete user.seedPhrase;
  delete user.walletSeed;

  if (user.cryptoWallet) {
    delete user.cryptoWallet.seedPhrase;
    delete user.cryptoWallet.privateKey;
  }
}

module.exports = {
  SUPPORTED_NETWORKS,
  normalizeNetwork,

  encryptString,
  decryptString,

  generateEvmWalletForEmail,
  ensureCryptoWalletForUser,
  decryptCryptoWalletForUser,
  buildWalletPublicPayload,

  getReceiveAddress,
  getReceiveAddresses,
  getEvmReceiveAddress,

  createDemoWalletSendTx,
  applyWalletSendToUser,
  removePlaintextWalletSecrets
};