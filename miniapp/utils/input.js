/** 表单输入清洗：只改善前端体验，服务端仍必须独立校验。 */

function digits(value, maxLength = 0) {
  const result = String(value == null ? '' : value).replace(/\D/g, '');
  return maxLength > 0 ? result.slice(0, maxLength) : result;
}

function money(value) {
  let result = String(value == null ? '' : value)
    .replace(/[^\d.]/g, '')
    .replace(/^\./, '0.');
  const dot = result.indexOf('.');
  if (dot >= 0) {
    result = result.slice(0, dot + 1) + result.slice(dot + 1).replace(/\./g, '').slice(0, 2);
  }
  const parts = result.split('.');
  parts[0] = parts[0].replace(/^0+(?=\d)/, '').slice(0, 8);
  return parts.length > 1 ? `${parts[0]}.${parts[1]}` : parts[0];
}

function validMoney(value, { min = 1, max = 10000000 } = {}) {
  const text = String(value == null ? '' : value);
  if (!/^\d{1,8}(?:\.\d{1,2})?$/.test(text)) return false;
  const amount = Number(text);
  return Number.isFinite(amount) && amount >= min && amount <= max;
}

module.exports = { digits, money, validMoney };
