'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SITE_URL = process.env.INFISICAL_SITE_URL;
const CLIENT_ID = process.env.INFISICAL_CLIENT_ID;
const CLIENT_SEC = process.env.INFISICAL_CLIENT_SECRET;
const PROJECT_ID = process.env.INFISICAL_PROJECT_ID;
const ENV = process.env.INFISICAL_ENV || 'development';
const SVC_PATH = process.env.INFISICAL_SECRET_PATH; // e.g. '/auth-microservice'
const POLL_MS = (parseInt(process.env.INFISICAL_POLL_SEC, 10) || 900) * 1000;
const CACHE_DIR = process.env.INFISICAL_CACHE_DIR || path.join(__dirname, '.infisical-cache');

// Cache file name derived from service path so each service has its own file
const CACHE_NAME = (SVC_PATH || 'default').replace(/\//g, '_').replace(/^_/, '');

function _cacheKey() {
  return crypto
    .createHash('sha256')
    .update(CLIENT_SEC || '')
    .digest();
}

function _writeCache(secrets) {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', _cacheKey(), iv);
    const enc = Buffer.concat([c.update(JSON.stringify(secrets), 'utf8'), c.final()]);
    fs.writeFileSync(
      path.join(CACHE_DIR, `${CACHE_NAME}.cache`),
      Buffer.concat([iv, c.getAuthTag(), enc]),
      { mode: 0o600 }
    );
  } catch (e) {
    console.warn(`[infisical] cache write failed: ${e.message}`);
  }
}

function _readCache() {
  try {
    const buf = fs.readFileSync(path.join(CACHE_DIR, `${CACHE_NAME}.cache`));
    const d = crypto.createDecipheriv('aes-256-gcm', _cacheKey(), buf.subarray(0, 12));
    d.setAuthTag(buf.subarray(12, 28));
    return JSON.parse(Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString('utf8'));
  } catch {
    return null;
  }
}

function _applyToEnv(secrets) {
  for (const [k, v] of Object.entries(secrets)) process.env[k] = v;
}

async function _fetchAll() {
  const { InfisicalSDK } = require('@infisical/sdk');
  const client = new InfisicalSDK({ siteUrl: SITE_URL });
  await client.auth().universalAuth.login({ clientId: CLIENT_ID, clientSecret: CLIENT_SEC });

  const [sharedResult, ownResult] = await Promise.all([
    client.secrets().listSecrets({
      projectId: PROJECT_ID,
      environment: ENV,
      secretPath: '/shared',
      expandSecretReferences: true,
    }),
    client.secrets().listSecrets({
      projectId: PROJECT_ID,
      environment: ENV,
      secretPath: SVC_PATH,
      expandSecretReferences: true,
    }),
  ]);

  const shared = Object.fromEntries(sharedResult.secrets.map((s) => [s.secretKey, s.secretValue]));
  const own = Object.fromEntries(ownResult.secrets.map((s) => [s.secretKey, s.secretValue]));
  return { ...shared, ...own }; // service-specific values win over shared
}

async function bootstrap() {
  if (!SITE_URL || !CLIENT_ID || !CLIENT_SEC || !PROJECT_ID || !SVC_PATH) {
    throw new Error(
      '[infisical] missing required env: INFISICAL_SITE_URL, INFISICAL_CLIENT_ID, ' +
        'INFISICAL_CLIENT_SECRET, INFISICAL_PROJECT_ID, INFISICAL_SECRET_PATH'
    );
  }

  let secrets;
  try {
    secrets = await _fetchAll();
    _writeCache(secrets);
    console.log(`[infisical] loaded ${Object.keys(secrets).length} secrets (${ENV}${SVC_PATH})`);
  } catch (err) {
    console.warn(`[infisical] fetch failed — ${err.message}`);
    secrets = _readCache();
    if (!secrets) {
      throw new Error(
        `[infisical] Infisical unreachable AND no disk cache — refusing to start. ` +
          `Original error: ${err.message}`
      );
    }
    console.warn(
      `[infisical] loaded ${Object.keys(secrets).length} secrets from disk cache (degraded mode)`
    );
  }
  _applyToEnv(secrets);

  // Background poll
  setInterval(async () => {
    try {
      const fresh = await _fetchAll();
      _applyToEnv(fresh);
      _writeCache(fresh);
      console.log(`[infisical] refreshed ${Object.keys(fresh).length} secrets`);
    } catch (err) {
      console.warn(`[infisical] refresh failed — ${err.message}`);
    }
  }, POLL_MS).unref();

  // Manual refresh via SIGHUP
  process.on('SIGHUP', async () => {
    try {
      const fresh = await _fetchAll();
      _applyToEnv(fresh);
      _writeCache(fresh);
      console.log('[infisical] SIGHUP refresh complete');
    } catch (err) {
      console.warn(`[infisical] SIGHUP refresh failed — ${err.message}`);
    }
  });
}

module.exports = { bootstrap };
