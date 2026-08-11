const fenToYuan = (fen) => (fen == null ? '-' : (fen / 100).toFixed(fen % 100 === 0 ? 0 : 2));
const yuanToFen = (yuan) => {
  const text = String(yuan == null ? '' : yuan).trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(text)) return NaN;
  return Math.round(Number(text) * 100);
};
const parseJson = (str) => {
  try {
    if (str == null) return [];
    if (Array.isArray(str)) return str;
    return typeof str === 'string' ? JSON.parse(str) : [];
  } catch (_) { return []; }
};
function timeShort(iso) {
  if (!iso) return '';
  // MySQL DATETIME 格式 'YYYY-MM-DD HH:MM:SS'，替换空格为 T 使其兼容 ISO
  let normalized = typeof iso === 'string' && iso.includes(' ') ? iso.replace(' ', 'T') : iso;
  // The API returns UTC MySQL DATETIME values without a suffix.  Tell the
  // JS runtime explicitly so devices in UTC+8 do not display an 8-hour skew.
  if (typeof normalized === 'string' && !/[zZ]|[+-]\d{2}:?\d{2}$/.test(normalized)) normalized += 'Z';
  const d = new Date(normalized);
  if (isNaN(d.getTime())) return String(iso);
  const p = (n) => String(n).padStart(2, '0');
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  if (sameDay) return `${p(d.getHours())}:${p(d.getMinutes())}`;
  const sameYear = d.getFullYear() === today.getFullYear();
  if (sameYear) return `${d.getMonth() + 1}月${d.getDate()}日 ${p(d.getHours())}:${p(d.getMinutes())}`;
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 ${p(d.getHours())}:${p(d.getMinutes())}`;
}
const STATUS_CLASS = {
  QUOTING: 'st-blue', AWAITING_PAYMENT: 'st-orange', IN_PROGRESS: 'st-cyan',
  DELIVERED: 'st-purple', COMPLETED: 'st-green', REFUND_PENDING: 'st-orange', CLOSED: 'st-gray', CANCELLED: 'st-gray',
};
module.exports = { fenToYuan, yuanToFen, timeShort, parseJson, STATUS_CLASS };
