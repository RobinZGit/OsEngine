'use strict';

/**
 * TLS helpers for T-Invest API (Russian Trusted CA / НУЦ Минцифры).
 * Node does not use the Windows cert store by default — append PEM via
 * NODE_EXTRA_CA_CERTS and undici Agent.
 *
 * Source: https://www.gosuslugi.ru/crt → russiantrustedca.pem (gu-st.ru)
 */

const fs = require('fs');
const path = require('path');
const tls = require('tls');

const CERT_DIR = path.join(__dirname, '..', 'certs');
const RU_PEM_PATH = path.join(CERT_DIR, 'russiantrustedca.pem');
const RU_PEM_URL = 'https://gu-st.ru/content/Other/doc/russiantrustedca.pem';

let dispatcher = null;
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

/**
 * Call once at process start (before T-Bank HTTPS).
 * Sets NODE_EXTRA_CA_CERTS and builds undici dispatcher with extra CA.
 */
async function ensureTbankTls() {
  if (ready && dispatcher) return { ok: true, path: RU_PEM_PATH };

  fs.mkdirSync(CERT_DIR, { recursive: true });
  let pem = readRuPem();
  if (!pem) {
    try {
      const res = await fetch(RU_PEM_URL);
      const text = await res.text();
      if (res.ok && text.includes('BEGIN CERTIFICATE')) {
        fs.writeFileSync(RU_PEM_PATH, text, 'utf8');
        pem = text;
        console.log(`T-Bank TLS: downloaded Russian Trusted CA → ${RU_PEM_PATH}`);
      }
    } catch (err) {
      console.warn(`T-Bank TLS: could not download Russian CA: ${err.message}`);
    }
  }

  if (pem) {
    process.env.NODE_EXTRA_CA_CERTS = RU_PEM_PATH;
    try {
      const { Agent } = require('undici');
      const cas = [...tls.rootCertificates, pem];
      dispatcher = new Agent({
        connect: { ca: cas, rejectUnauthorized: true },
      });
    } catch (err) {
      console.warn(`T-Bank TLS: undici Agent not set (${err.message}); using NODE_EXTRA_CA_CERTS only`);
      dispatcher = null;
    }
    ready = true;
    return { ok: true, path: RU_PEM_PATH, bytes: pem.length };
  }

  ready = true;
  return { ok: false, path: RU_PEM_PATH, error: 'russiantrustedca.pem missing' };
}

function getTbankFetchDispatcher() {
  return dispatcher;
}

/** Options to pass into fetch() for T-Bank HTTPS. */
function tbankFetchOptions(extra = {}) {
  const opts = { ...extra };
  if (dispatcher) {
    opts.dispatcher = dispatcher;
  }
  return opts;
}

module.exports = {
  RU_PEM_PATH,
  ensureTbankTls,
  getTbankFetchDispatcher,
  tbankFetchOptions,
  readRuPem,
};
