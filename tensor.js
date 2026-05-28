'use strict';

const crypto = require('crypto');

/*
  tensor.js
  ---------
  Handles Tensor wallet logic:
  - Tensor seed generation
  - Encrypted Tensor seed storage
  - Main Tensor address
  - Per-token receive addresses for every user
  - Internal Tensor token send records

  Important:
  - Tensor seed is encrypted before storage.
  - Per-token addresses are public receive addresses, so they are not secret.
  - Decryption only happens when buildTensorWalletPayload(..., { includeSecrets: true }) is called.
*/

const TENSOR_MASTER_SECRET =
  process.env.TENSOR_MASTER_SECRET ||
  'dev-tensor-master-secret-change-this-before-production';

const ENCRYPTION_VERSION = 'v1';

const TENSOR_WORDS = [
  'tensor', 'neural', 'orbit', 'matrix', 'vector', 'signal',
  'vault', 'logic', 'future', 'cipher', 'quantum', 'anchor',
  'galaxy', 'kernel', 'prism', 'nova', 'atlas', 'cobalt',
  'rocket', 'crystal', 'bridge', 'pixel', 'summit', 'shadow',
  'alpha', 'delta', 'omega', 'carbon', 'silver', 'ember',
  'solar', 'lunar', 'radar', 'pulse', 'model', 'agent'
];

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

function hmacHex(secret, input) {
  return crypto.createHmac('sha256', secret).update(String(input)).digest('hex');
}

function makeId(prefix = 'id') {
  return `${prefix}_${Date.now()}_${crypto.randomBytes(8).toString('hex')}`;
}

function getEncryptionKey() {
  return crypto
    .createHash('sha256')
    .update(String(TENSOR_MASTER_SECRET))
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

function tensorSeedForEmail(email) {
  const normalized = normalizeEmail(email);

  if (!normalized) {
    throw new Error('Email is required to generate Tensor seed.');
  }

  let cursor = hmacHex(TENSOR_MASTER_SECRET, `tensor-seed:${normalized}`);
  const words = [];

  for (let i = 0; i < 12; i++) {
    cursor = hmacHex(TENSOR_MASTER_SECRET, `${cursor}:${i}:${normalized}`);
    const index = parseInt(cursor.slice(0, 8), 16) % TENSOR_WORDS.length;
    words.push(TENSOR_WORDS[index]);
  }

  return words.join(' ');
}

function tensorAddressForEmail(email) {
  const normalized = normalizeEmail(email);

  if (!normalized) {
    throw new Error('Email is required to generate Tensor address.');
  }

  const hash = hmacHex(TENSOR_MASTER_SECRET, `tensor-main-address:${normalized}`);
  return `T0x${hash.slice(0, 40)}`;
}

function tensorTokenReceiveAddress(email, tokenIdOrSymbol) {
  const normalized = normalizeEmail(email);
  const tokenKey = String(tokenIdOrSymbol || 'TENSOR').trim().toUpperCase();

  if (!normalized) {
    throw new Error('Email is required to generate Tensor token receive address.');
  }

  const hash = hmacHex(
    TENSOR_MASTER_SECRET,
    `tensor-token-address:${normalized}:${tokenKey}`
  );

  return `TT${hash.slice(0, 42)}`;
}

function ensureTensorWalletForUser(user, tensorRegistry = []) {
  if (!user || !user.email) {
    throw new Error('User with email is required.');
  }

  const email = normalizeEmail(user.email);
  const generatedSeed = tensorSeedForEmail(email);
  const generatedMainAddress = tensorAddressForEmail(email);

  if (!user.tensorWallet || typeof user.tensorWallet !== 'object') {
    user.tensorWallet = {};
  }

  /*
    Migrate old plaintext fields if they exist.
    After this runs, plaintext Tensor seed is removed.
  */
  const legacyPlainSeed =
    typeof user.tensorSeed === 'string' && user.tensorSeed.trim()
      ? user.tensorSeed.trim()
      : '';

  const seed = legacyPlainSeed || generatedSeed;

  if (!user.tensorWallet.encryptedSeed) {
    user.tensorWallet.encryptedSeed = encryptString(seed);
  } else if (!isEncryptedValue(user.tensorWallet.encryptedSeed)) {
    user.tensorWallet.encryptedSeed = encryptString(user.tensorWallet.encryptedSeed);
  }

  user.tensorWallet.tensorAddress = user.tensorWallet.tensorAddress || generatedMainAddress;

  if (!user.tensorWallet.tokenAddresses || typeof user.tensorWallet.tokenAddresses !== 'object') {
    user.tensorWallet.tokenAddresses = {};
  }

  tensorRegistry.forEach(token => {
    if (!token) return;

    const tokenId = String(token.id || token.symbol || '').trim();

    if (!tokenId) return;

    if (!user.tensorWallet.tokenAddresses[tokenId]) {
      user.tensorWallet.tokenAddresses[tokenId] = {
        tokenId,
        symbol: token.symbol || tokenId,
        address: tensorTokenReceiveAddress(email, tokenId),
        createdAt: Date.now(),
        createdAtIso: nowIso()
      };
    }
  });

  if (!user.tensorBalances || typeof user.tensorBalances !== 'object') {
    user.tensorBalances = {};
  }

  if (!Array.isArray(user.tensorTxHistory)) {
    user.tensorTxHistory = [];
  }

  user.tensorAddress = user.tensorWallet.tensorAddress;
  user.tensorTokenAddresses = user.tensorWallet.tokenAddresses;

  if (!user.tensorWallet.createdAt) {
    user.tensorWallet.createdAt = Date.now();
    user.tensorWallet.createdAtIso = nowIso();
  }

  user.tensorWallet.updatedAt = Date.now();
  user.tensorWallet.updatedAtIso = nowIso();

  /*
    Remove plaintext secrets from root object.
    wallet.ejs can still receive decrypted seed through API response only.
  */
  delete user.tensorSeed;
  delete user.tensorPrivateKey;
  delete user.tensorWallet.seed;
  delete user.tensorWallet.seedPhrase;

  return user.tensorWallet;
}

function decryptTensorWalletForUser(user, tensorRegistry = []) {
  ensureTensorWalletForUser(user, tensorRegistry);

  return {
    tensorAddress: user.tensorWallet.tensorAddress,
    tensorSeed: decryptString(user.tensorWallet.encryptedSeed),
    tokenAddresses: user.tensorWallet.tokenAddresses || {}
  };
}

function buildTensorWalletPayload(user, tensorRegistry = [], options = {}) {
  const includeSecrets = Boolean(options.includeSecrets);

  ensureTensorWalletForUser(user, tensorRegistry);

  const payload = {
    tensorAddress: user.tensorWallet.tensorAddress,
    tokenAddresses: user.tensorWallet.tokenAddresses || {},
    tensorTxHistory: Array.isArray(user.tensorTxHistory) ? user.tensorTxHistory : []
  };

  if (includeSecrets) {
    payload.tensorSeed = decryptString(user.tensorWallet.encryptedSeed);
  }

  return payload;
}

function getTensorTokenAddressForUser(userOrEmail, tokenIdOrSymbol) {
  const email = typeof userOrEmail === 'string'
    ? userOrEmail
    : userOrEmail?.email;

  return tensorTokenReceiveAddress(email, tokenIdOrSymbol);
}

function findRecipientByTensorAddress(db, tokenId, toAddress) {
  if (!db || !db.users || !toAddress) return null;

  const target = String(toAddress).trim();

  const recipientEmail = Object.keys(db.users).find(email => {
    const user = db.users[email];
    const mainAddress = tensorAddressForEmail(email);
    const tokenAddress = tensorTokenReceiveAddress(email, tokenId);

    const storedTokenAddress =
      user?.tensorWallet?.tokenAddresses?.[tokenId]?.address ||
      user?.tensorTokenAddresses?.[tokenId]?.address ||
      '';

    return target === mainAddress ||
      target === tokenAddress ||
      target === storedTokenAddress;
  });

  if (!recipientEmail) return null;

  return {
    email: recipientEmail,
    user: db.users[recipientEmail]
  };
}

function createTensorSendTx({
  user,
  token,
  amount,
  toAddress
}) {
  if (!user || !user.email) {
    throw new Error('User is required.');
  }

  if (!token || !token.id) {
    throw new Error('Tensor token is required.');
  }

  const numericAmount = safeNumber(amount, 0);

  if (numericAmount <= 0) {
    throw new Error('Invalid amount.');
  }

  if (!toAddress || String(toAddress).trim().length < 8) {
    throw new Error('Invalid recipient address.');
  }

  return {
    id: makeId('tensor_send'),
    txHash: `TTX${crypto.randomBytes(30).toString('hex')}`,
    status: 'tensor-sent',
    tokenId: token.id,
    symbol: token.symbol,
    fromAddress: tensorTokenReceiveAddress(user.email, token.id),
    toAddress: String(toAddress).trim(),
    amount: numericAmount,
    createdAt: Date.now(),
    createdAtIso: nowIso(),
    note: 'Demo Tensor transfer recorded in internal ledger.'
  };
}

function applyTensorSendToUser(db, sender, input) {
  if (!db || !db.users) {
    throw new Error('Database object is required.');
  }

  if (!sender || !sender.email) {
    throw new Error('Sender user is required.');
  }

  const tokenId = String(input.tokenId || '').trim();
  const amount = safeNumber(input.amount, 0);
  const toAddress = String(input.toAddress || '').trim();

  if (!tokenId || amount <= 0 || !toAddress) {
    throw new Error('Invalid Tensor send details.');
  }

  const token = Array.isArray(db.tensorRegistry)
    ? db.tensorRegistry.find(t => String(t.id) === tokenId)
    : null;

  if (!token) {
    throw new Error('Tensor token not found.');
  }

  ensureTensorWalletForUser(sender, db.tensorRegistry || []);

  if (!sender.tensorBalances || typeof sender.tensorBalances !== 'object') {
    sender.tensorBalances = {};
  }

  const senderBalance = safeNumber(sender.tensorBalances[tokenId], 0);

  if (senderBalance < amount) {
    throw new Error('Insufficient Tensor token balance.');
  }

  const tx = createTensorSendTx({
    user: sender,
    token,
    amount,
    toAddress
  });

  sender.tensorBalances[tokenId] = senderBalance - amount;

  if (!Array.isArray(sender.tensorTxHistory)) {
    sender.tensorTxHistory = [];
  }

  sender.tensorTxHistory.unshift(tx);
  sender.tensorTxHistory = sender.tensorTxHistory.slice(0, 200);
  sender.updatedAt = nowIso();

  const recipient = findRecipientByTensorAddress(db, tokenId, toAddress);

  if (recipient && recipient.user) {
    ensureTensorWalletForUser(recipient.user, db.tensorRegistry || []);

    if (!recipient.user.tensorBalances || typeof recipient.user.tensorBalances !== 'object') {
      recipient.user.tensorBalances = {};
    }

    recipient.user.tensorBalances[tokenId] =
      safeNumber(recipient.user.tensorBalances[tokenId], 0) + amount;

    recipient.user.updatedAt = nowIso();

    tx.internalRecipientMatched = true;
    tx.recipientEmailHash = crypto
      .createHash('sha256')
      .update(recipient.email)
      .digest('hex')
      .slice(0, 16);
  } else {
    tx.internalRecipientMatched = false;
  }

  return tx;
}

function removePlaintextTensorSecrets(user) {
  if (!user) return;

  delete user.tensorSeed;
  delete user.tensorPrivateKey;

  if (user.tensorWallet) {
    delete user.tensorWallet.seed;
    delete user.tensorWallet.seedPhrase;
    delete user.tensorWallet.privateKey;
  }
}

module.exports = {
  encryptString,
  decryptString,

  tensorSeedForEmail,
  tensorAddressForEmail,
  tensorTokenReceiveAddress,

  ensureTensorWalletForUser,
  decryptTensorWalletForUser,
  buildTensorWalletPayload,
  getTensorTokenAddressForUser,

  createTensorSendTx,
  applyTensorSendToUser,
  findRecipientByTensorAddress,

  removePlaintextTensorSecrets
};