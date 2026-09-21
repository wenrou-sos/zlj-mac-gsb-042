// 校验工具
function validIdCard(idCard) {
  if (!/^\d{17}[\dXx]$/.test(idCard || '')) return false;
  const weights = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
  const checks = ['1', '0', 'X', '9', '8', '7', '6', '5', '4', '3', '2'];
  let sum = 0;
  for (let i = 0; i < 17; i++) sum += Number(idCard[i]) * weights[i];
  return checks[sum % 11] === idCard[17].toUpperCase();
}

function validPhone(phone) {
  return !phone || /^1[3-9]\d{9}$/.test(phone);
}

// 计调成本与毛利计算
function calcFinance(db, tourId) {
  const tourists = db.prepare("SELECT * FROM tourists WHERE tour_id=? AND status!='已退团'").all(tourId);
  const flights = db.prepare('SELECT * FROM flight_bookings WHERE tour_id=?').all(tourId);
  const hotels = db.prepare('SELECT * FROM hotel_bookings WHERE tour_id=?').all(tourId);
  const locals = db.prepare('SELECT * FROM local_services WHERE tour_id=?').all(tourId);
  const others = db.prepare('SELECT * FROM other_costs WHERE tour_id=?').all(tourId);

  const revenue = tourists.reduce((s, t) => s + (t.price || 0), 0);

  const flightCost = flights.reduce((s, f) => s + f.seats * f.unit_price, 0);
  const hotelCost = hotels.reduce((s, h) => {
    const nights = nightsBetween(h.check_in, h.check_out);
    return s + h.rooms * h.night_price * nights;
  }, 0);
  const localCost = locals.reduce((s, l) => s + l.total_price, 0);
  const otherCost = others.reduce((s, o) => s + o.amount, 0);
  const totalCost = flightCost + hotelCost + localCost + otherCost;

  return {
    headcount: tourists.length,
    revenue: round2(revenue),
    costs: {
      flight: round2(flightCost),
      hotel: round2(hotelCost),
      local: round2(localCost),
      other: round2(otherCost),
      total: round2(totalCost)
    },
    grossProfit: round2(revenue - totalCost),
    margin: revenue > 0 ? Math.round(((revenue - totalCost) / revenue) * 1000) / 10 : 0
  };
}

function nightsBetween(checkIn, checkOut) {
  const a = new Date(checkIn), b = new Date(checkOut);
  const n = Math.round((b - a) / 86400000);
  return n > 0 ? n : 0;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

// 自动生成团号：TH20260920-001
function generateTourCode(db, dateStr) {
  const ym = (dateStr || '').replace(/-/g, '').slice(0, 8);
  const prefix = `TH${ym}-`;
  const row = db.prepare(
    "SELECT code FROM tours WHERE code LIKE ? ORDER BY code DESC LIMIT 1"
  ).get(`${prefix}%`);
  let seq = 1;
  if (row) seq = parseInt(row.code.split('-')[1] || '0', 10) + 1;
  return `${prefix}${String(seq).padStart(3, '0')}`;
}

module.exports = { validIdCard, validPhone, calcFinance, generateTourCode, nightsBetween, round2 };
