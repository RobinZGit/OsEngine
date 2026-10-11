'use strict';

/**
 * Справочник кодов ошибок для консоли «протокола».
 *
 * Назначение: превращать сухие коды (HTTP 429, ETIMEDOUT, DEPTH_ZERO_SELF_SIGNED_CERT …)
 * в понятные русские расшифровки прямо в окне MultiLogic_Trade_Progress_Start.bat.
 *
 * Печать всего справочника:  node api/lib/error-codes.js
 */

const HTTP_STATUS = {
  400: { title: 'Bad Request', ru: 'Некорректный запрос: сервер не принял параметры или тело.' },
  401: { title: 'Unauthorized', ru: 'Не авторизован: неверный или просроченный токен T-Bank.' },
  402: { title: 'Payment Required', ru: 'Требуется оплата/пополнение (недостаточно средств или тариф).' },
  403: { title: 'Forbidden', ru: 'Доступ запрещён: у токена нет прав на операцию или счёт.' },
  404: { title: 'Not Found', ru: 'Не найдено: проверьте путь, инструмент (FIGI) или счёт.' },
  405: { title: 'Method Not Allowed', ru: 'Метод запрещён для этого адреса (GET/POST перепутаны).' },
  406: { title: 'Not Acceptable', ru: 'Сервер не может отдать ответ в запрошенном формате.' },
  408: { title: 'Request Timeout', ru: 'Сервер не дождался запроса: сеть медленная или зависла. Повторите.' },
  409: { title: 'Conflict', ru: 'Конфликт состояния: операция уже идёт или повторяется.' },
  410: { title: 'Gone', ru: 'Ресурс больше не доступен (удалён/устарел).' },
  412: { title: 'Precondition Failed', ru: 'Не выполнено условие запроса (устаревшая версия/блокировка).' },
  413: { title: 'Payload Too Large', ru: 'Тело запроса слишком большое.' },
  415: { title: 'Unsupported Media Type', ru: 'Неверный тип содержимого (ожидался application/json).' },
  422: { title: 'Unprocessable Entity', ru: 'Запрос понятен, но данные неверны: лот, сумма, лимит или направление.' },
  425: { title: 'Too Early', ru: 'Слишком рано: повторите запрос чуть позже.' },
  429: { title: 'Too Many Requests', ru: 'Слишком много запросов: сработал лимит (rate limit) T-Bank или прокси. Это НЕ ошибка сертификатов; нужна пауза и повтор позже.' },
  451: { title: 'Unavailable For Legal Reasons', ru: 'Недоступно по юридическим причинам (регион/запрет).' },
  500: { title: 'Internal Server Error', ru: 'Внутренняя ошибка сервиса (сторона T-Bank или прокси).' },
  501: { title: 'Not Implemented', ru: 'Операция не поддерживается сервером.' },
  502: { title: 'Bad Gateway', ru: 'Шлюз вернул неверный ответ: прокси или T-Bank недоступны.' },
  503: { title: 'Service Unavailable', ru: 'Сервис недоступен: перегрузка или обслуживание, повторите позже.' },
  504: { title: 'Gateway Timeout', ru: 'Шлюз не дождался ответа от сервиса за отведённое время.' },
};

const NODE_ERROR = {
  ECONNREFUSED: { title: 'Connection refused', ru: 'Соединение отклонено: порт закрыт, сервис не запущен.' },
  ECONNRESET: { title: 'Connection reset', ru: 'Соединение сброшено другой стороной; обычно повтор проходит.' },
  ETIMEDOUT: { title: 'Connection timed out', ru: 'Не удалось установить соединение за отведённое время (сеть зависла).' },
  ESOCKETTIMEDOUT: { title: 'Socket timeout', ru: 'Сокет не дождался ответа за отведённое время.' },
  ERR_SOCKET_CONNECTION_TIMEOUT: { title: 'Socket connect timeout', ru: 'TCP-соединение не установилось за отведённое время.' },
  ECONNABORTED: { title: 'Connection aborted', ru: 'Соединение прервано (отмена/повтор).' },
  EPIPE: { title: 'Broken pipe', ru: 'Поток закрыт на другом конце: соединение оборвано.' },
  EPROTO: { title: 'Protocol error', ru: 'Ошибка протокола TLS/HTTP: сервер ответил не так, как ожидалось.' },
  ENOTFOUND: { title: 'DNS not found', ru: 'DNS не разрешил адрес сервера: проверьте сеть.' },
  EAI_AGAIN: { title: 'DNS temporary failure', ru: 'Временный сбой DNS: повторите позже.' },
  EHOSTUNREACH: { title: 'Host unreachable', ru: 'Хост недоступен: нет маршрута (VPN/сеть/файрвол).' },
  ENETUNREACH: { title: 'Network unreachable', ru: 'Сеть недоступна: проверьте подключение и файрвол.' },
  DEPTH_ZERO_SELF_SIGNED_CERT: { title: 'Self-signed certificate', ru: 'Самоподписанный сертификат: нужен доверенный корневой CA.' },
  SELF_SIGNED_CERT_IN_CHAIN: { title: 'Self-signed in chain', ru: 'В цепочке самоподписанный сертификат: не установлен корневой CA.' },
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: { title: 'Cannot verify leaf', ru: 'Не удалось проверить сертификат сервера: не хватает промежуточного или корневого CA.' },
  UNABLE_TO_GET_ISSUER_CERT_LOCALLY: { title: 'Issuer not found', ru: 'Издатель сертификата не найден локально: отсутствует корневой CA.' },
  CERT_HAS_EXPIRED: { title: 'Certificate expired', ru: 'Срок действия сертификата истёк.' },
  CERT_NOT_YET_VALID: { title: 'Certificate not yet valid', ru: 'Сертификат ещё недействителен: проверьте системные часы.' },
  ERR_TLS_CERT_ALTNAME_INVALID: { title: 'Certificate host mismatch', ru: 'Имя в сертификате не совпадает с адресом сервера.' },
};

const PHRASES = [
  { re: /too many requests|rate limit/i, ru: 'HTTP 429 Too Many Requests: сработал лимит запросов T-Bank или прокси (не сертификаты).', http: 429 },
  { re: /ssl connection timeout/i, ru: 'SSL connection timeout: защищённое соединение не установилось за отведённое время.' },
  { re: /self[ -]?signed/i, ru: 'Самоподписанный сертификат: нужен доверенный корневой CA.' },
  { re: /unable to verify/i, ru: 'Не удалось проверить сертификат сервера: отсутствует доверенный CA.' },
  { re: /certificate.*(expired|has expired)/i, ru: 'Сертификат истёк.' },
  { re: /statement timeout|canceling statement/i, ru: 'SQL statement timeout: запрос к БД выполнялся слишком долго и был отменён.' },
  { re: /deadlock detected/i, ru: 'SQL deadlock: взаимная блокировка транзакций, одна отменена; операция повторяема.' },
];

function httpStatusInfo(code) {
  const n = Number(code);
  return Number.isFinite(n) ? HTTP_STATUS[n] || null : null;
}

function nodeErrorInfo(code) {
  if (code == null) return null;
  return NODE_ERROR[String(code).trim()] || null;
}

function describeHttpStatus(code) {
  const info = httpStatusInfo(code);
  if (!info) return null;
  return `HTTP ${Number(code)} ${info.title}: ${info.ru}`;
}

function describeErrorCode(code) {
  const info = nodeErrorInfo(code);
  if (!info) return null;
  return `${String(code).trim()} ${info.title}: ${info.ru}`;
}

function decorate(input) {
  const text = input == null ? '' : String(input).trim();
  if (!text) return text;

  const extra = [];
  const push = (line) => {
    if (line && !extra.includes(line)) extra.push(line);
  };

  const httpSeen = new Set();
  const httpRe = /\bHTTP[ _-]?(\d{3})\b/gi;
  let m;
  while ((m = httpRe.exec(text))) {
    const code = Number(m[1]);
    if (httpSeen.has(code)) continue;
    httpSeen.add(code);
    const info = httpStatusInfo(code);
    if (info && info.ru && !text.includes(info.ru)) extra.push(describeHttpStatus(code));
  }

  const tokens = text.match(/\b(?:E[A-Z]{2,}|ERR_[A-Z0-9_]+)\b/g) || [];
  const seen = new Set();
  for (const t of tokens) {
    if (seen.has(t)) continue;
    seen.add(t);
    const info = nodeErrorInfo(t);
    if (info && info.ru && !text.includes(info.ru)) {
      extra.push(describeErrorCode(t));
    }
  }

  for (const p of PHRASES) {
    if (p.http && httpSeen.has(p.http)) continue;
    if (p.re.test(text) && !text.includes(p.ru)) extra.push(p.ru);
  }

  if (!extra.length) return text;
  return `${text}\n         -> ${extra.join('\n         -> ')}`;
}

function formatReference() {
  const lines = ['Справочник кодов ошибок MultiLogicTradePg', '='.repeat(60), 'HTTP-статусы:', ''];
  for (const code of Object.keys(HTTP_STATUS).map(Number).sort((a, b) => a - b)) {
    const info = HTTP_STATUS[code];
    lines.push(`  HTTP ${code} ${info.title}: ${info.ru}`);
  }
  lines.push('', 'Сетевые и TLS-коды (Node/сокет):', '');
  for (const code of Object.keys(NODE_ERROR).sort()) {
    const info = NODE_ERROR[code];
    lines.push(`  ${code} ${info.title}: ${info.ru}`);
  }
  return lines.join('\n');
}

module.exports = {
  HTTP_STATUS,
  NODE_ERROR,
  httpStatusInfo,
  nodeErrorInfo,
  describeHttpStatus,
  describeErrorCode,
  decorate,
  formatReference,
};

if (require.main === module) {
  console.log(formatReference());
}
