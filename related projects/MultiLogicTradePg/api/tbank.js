const crypto = require('node:crypto');

/** Хеш токена для accounts.token_hash (локально, не HTTP к бирже). */
function hashToken(token) {
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

module.exports = {
  hashToken,
};
