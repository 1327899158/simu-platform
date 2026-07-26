const fenToYuan = (fen) => (fen == null ? '-' : (fen / 100).toFixed(fen % 100 === 0 ? 0 : 2));
const yuanToFen = (yuan) => Math.round(parseFloat(yuan) * 100);
function timeShort(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, '0');
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  return sameDay ? `${p(d.getHours())}:${p(d.getMinutes())}`
    : `${d.getMonth() + 1}-${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
const STATUS_CLASS = {
  QUOTING: 'st-blue', AWAITING_PAYMENT: 'st-orange', IN_PROGRESS: 'st-cyan',
  DELIVERED: 'st-purple', COMPLETED: 'st-green', CLOSED: 'st-gray',
};
module.exports = { fenToYuan, yuanToFen, timeShort, STATUS_CLASS };
