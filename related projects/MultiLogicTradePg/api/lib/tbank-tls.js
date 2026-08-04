'use strict';

/**
 * TLS for T-Invest API (Russian Trusted CA / НУЦ Минцифры).
 *
 * Node fetch() often ignores NODE_EXTRA_CA_CERTS set at runtime and does not use
 * the Windows cert store → "fetch failed" / SELF_SIGNED_CERT_IN_CHAIN.
 * Use https.Agent with explicit ca = Mozilla roots + russiantrustedca.pem.
 *
 * Source: https://www.gosuslugi.ru/crt → gu-st.ru russiantrustedca.pem
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const tls = require('tls');

const CERT_DIR = path.join(__dirname, '..', 'certs');
const RU_PEM_PATH = path.join(CERT_DIR, 'russiantrustedca.pem');
const RU_PEM_URL = 'https://gu-st.ru/content/Other/doc/russiantrustedca.pem';

let httpsAgent = null;
let ready = false;

function readRuPem() {
  try {
    if (fs.existsSync(RU_PEM_PATH) && fs.statSync(RU_PEM_PATH).size > 100) {
      return fs.readFileSync(RU_PEM_PATH, 'utf8');
    }
  } catch (_e) {
    /* ignore */
  }
  return null;
}

function buildHttpsAgent(pem) {
  const cas = [...tls.rootCertificates];
  if (pem) cas.push(pem);
  return new https.Agent({
    ca: cas,
    rejectUnauthorized: true,
    keepAlive: true,
  });
}

/**
 * Call once at process start. Builds https.Agent with Russian Trusted CA.
 */
async function ensureTbankTls() {
  if (ready && httpsAgent) {
    return { ok: true, path: RU_PEM_PATH };
  }

  fs.mkdirSync(CERT_DIR, { recursive: true });
  let pem = readRuPem();
  if (!pem) {
    try {
      // Bootstrap download via https.Agent without extra CA (gu-st may work on Mozilla).
      const text = await httpsGetText(RU_PEM_URL, new https.Agent({ rejectUnauthorized: true }));
      if (text.includes('BEGIN CERTIFICATE')) {
        fs.writeFileSync(RU_PEM_PATH, text, 'utf8');
        pem = text;
        console.log(`T-Bank TLS: downloaded Russian Trusted CA → ${RU_PEM_PATH}`);
      }
    } catch (err) {
      console.warn(`T-Bank TLS: could not download Russian CA: ${formatError(err)}`);
    }
  }

  // Helpful for child tools; https.Agent below is what actually matters for T-Bank.
  if (pem) {
    process.env.NODE_EXTRA_CA_CERTS = RU_PEM_PATH;
  }

  httpsAgent = buildHttpsAgent(pem);
  ready = true;

  if (pem) {
    return { ok: true, path: RU_PEM_PATH, bytes: pem.length };
  }
  return { ok: false, path: RU_PEM_PATH, error: 'russiantrustedca.pem missing' };
}

function getTbankHttpsAgent() {
  if (!httpsAgent) {
    httpsAgent = buildHttpsAgent(readRuPem());
  }
  return httpsAgent;
}

function formatError(err) {
  if (!err) return 'unknown error';
  const cause = err.cause || err;
  const parts = [err.message || String(err)];
  if (cause && cause !== err) {
    if (cause.code) parts.push(String(cause.code));
    if (cause.message && cause.message !== err.message) parts.push(cause.message);
  } else if (err.code) {
    parts.push(String(err.code));
  }
  return parts.filter(Boolean).join(' — ');
}

function httpsGetText(urlString, agent) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlString);
    const req = https.request(
      {
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port || 443,
        path: `${u.pathname}${u.search}`,
        method: 'GET',
        agent: agent || getTbankHttpsAgent(),
        headers: { Accept: '*/*' },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode >= 400) {
            reject(new Error(`HTTP ${res.statusCode}: ${text.slice(0, 200)}`));
            return;
          }
          resolve(text);
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

/**
 * POST JSON via https (not fetch) so Russian CA Agent is applied.
 * @returns {Promise<{ status: number, json: any, text: string }>}
 */
function httpsJsonPost(urlString, { headers = {}, body = '', agent } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlString);
    const payload = typeof body === 'string' ? body : JSON.stringify(body ?? {});
    const req = https.request(
      {
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port || 443,
        path: `${u.pathname}${u.search}`,
        method: 'POST',
        agent: agent || getTbankHttpsAgent(),
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          ...headers,
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try {
            json = text ? JSON.parse(text) : null;
          } catch (_e) {
            json = null;
          }
          resolve({ status: res.statusCode || 0, json, text });
        });
      }
    );
    req.on('error', (err) => {
      const wrapped = new Error(`T-Bank HTTPS: ${formatError(err)}`);
      wrapped.cause = err;
      wrapped.code = err.code;
      reject(wrapped);
    });
    req.write(payload);
    req.end();
  });
}

module.exports = {
  RU_PEM_PATH,
  ensureTbankTls,
  getTbankHttpsAgent,
  httpsJsonPost,
  formatError,
  readRuPem,
};
