export function nightsBetween(checkIn, checkOut) {
  const a = new Date(checkIn), b = new Date(checkOut);
  const n = Math.round((b - a) / 86400000);
  return n > 0 ? n : 0;
}
