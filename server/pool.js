/* 供应商资源池与库存冲突控制（核心引擎）
 *
 * 约定：
 *  - 所有写操作（创建/修改/确认/释放占用）均在 BEGIN IMMEDIATE 事务内完成，
 *    写事务在 SQLite 层串行化，并发请求不可能超卖。
 *  - 有效占用 = 状态为「待确认」或「已确认」的占用（「已释放」不再扣减可用量）。
 *  - 酒店资源按「入住日期」逐晚建池（resources 每晚一行），占用也逐晚校验/逐晚一行。
 *  - 确认占用时写入成本快照（unit_price_snapshot/cost_amount），
 *    此后供应商调价只影响未确认占用，不影响已确认团队的毛利。
 */
const db = require('./db');

class ApiError extends Error {
  constructor(status, error, extra = {}) {
    super(error);
    this.status = status;
    this.body = { error, ...extra };
  }
}

// 立即型事务：获取写锁后再执行业务校验，杜绝「先读后写」竞态导致的超卖
function withImmediate(fn) {
  return db.transaction(fn).immediate();
}

/* ---------------- 日期工具（UTC，避免时区漂移） ---------------- */
function addDay(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function eachNight(checkIn, checkOut) {
  const out = [];
  const d = new Date(checkIn + 'T00:00:00Z');
  const end = new Date(checkOut + 'T00:00:00Z');
  if (isNaN(d) || isNaN(end) || end <= d) {
    throw new ApiError(400, '离店日期需晚于入住日期');
  }
  while (d < end) {
    out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

const nightsBetween = (checkIn, checkOut) => eachNight(checkIn, checkOut).length;

/* ---------------- 可用量查询 ---------------- */
const heldStmt = db.prepare(`
  SELECT COALESCE(SUM(quantity),0) AS held
  FROM resource_occupancies
  WHERE resource_id=? AND service_date=? AND status IN ('待确认','已确认')`);

const heldExclStmt = db.prepare(`
  SELECT COALESCE(SUM(quantity),0) AS held
  FROM resource_occupancies
  WHERE resource_id=? AND service_date=? AND status IN ('待确认','已确认')
    AND NOT (booking_type=? AND booking_id=?)`);

function heldOn(resourceId, serviceDate) {
  return heldStmt.get(resourceId, serviceDate).held;
}

function resourceAvailable(resourceId, serviceDate) {
  const r = db.prepare('SELECT quantity, status FROM resources WHERE id=?').get(resourceId);
  if (!r) throw new ApiError(404, '资源池记录不存在');
  const held = heldOn(resourceId, serviceDate);
  return { resource: r, held, available: r.quantity - held, open: r.status === '开放' };
}

// 容量校验：need 为本次需要数量；exclude 用于修改时排除占用自身
function assertCapacity(resourceId, serviceDate, need, exclude = null, label = '') {
  const r = db.prepare('SELECT quantity, status FROM resources WHERE id=?').get(resourceId);
  if (!r) throw new ApiError(404, `${label ? label + '：' : ''}资源池记录不存在`);
  if (r.status !== '开放') throw new ApiError(409, `资源「${label || '#' + resourceId}」当前为停售状态，无法占用`);
  const heldAll = heldOn(resourceId, serviceDate);
  const held = exclude
    ? heldExclStmt.get(resourceId, serviceDate, exclude.type, exclude.id).held
    : heldAll;
  const available = r.quantity - held;           // 修改场景：不含本记录占用
  const remaining = Math.max(0, r.quantity - heldAll); // 当前实时余量（含本记录）
  if (need > available) {
    throw new ApiError(409,
      `库存不足：${label ? label + ' ' : ''}${serviceDate} 需要 ${need}，库存 ${r.quantity}（现余 ${remaining}）`,
      { conflicts: [{ resource_id: resourceId, date: serviceDate, need, available, remaining, held: heldAll }] });
  }
  return available;
}

/* ---------------- 酒店：按入住夜定位资源行 ---------------- */
function findHotelResource(hotelName, roomType, date, supplierId = null) {
  return db.prepare(`
    SELECT * FROM resources
    WHERE type='hotel' AND hotel_name=? AND room_type=? AND date=? AND status='开放'
      AND (? IS NULL OR supplier_id=?)
    ORDER BY id LIMIT 1`).get(hotelName, roomType, date, supplierId, supplierId);
}

// 解析酒店控房涉及的每一晚资源；汇总全部冲突日期后一次性抛出（含剩余量与具体日期）
function resolveHotelNights({ hotelName, roomType, rooms, checkIn, checkOut, excludeBooking = null, supplierId = null }) {
  const dates = eachNight(checkIn, checkOut);
  const rows = [];
  const conflicts = [];
  for (const date of dates) {
    const r = findHotelResource(hotelName, roomType, date, supplierId);
    if (!r) {
      conflicts.push({ date, need: rooms, available: 0, remaining: 0, held: 0, reason: '资源池中无该酒店该房型当日房量' });
      continue;
    }
    const heldAll = heldOn(r.id, date);
    const held = excludeBooking
      ? heldExclStmt.get(r.id, date, 'hotel', excludeBooking).held
      : heldAll;
    const available = r.quantity - held; // 修改场景不含本记录
    const remaining = Math.max(0, r.quantity - heldAll); // 实时余量（含本记录）
    if (rooms > available) {
      conflicts.push({ resource_id: r.id, date, need: rooms, available, remaining, held: heldAll });
    }
    rows.push({ date, resource: r });
  }
  if (conflicts.length) {
    throw new ApiError(409,
      `以下 ${conflicts.length} 个入住日期库存不足（需要 ${rooms} 间）：` +
      conflicts.map(c => `${c.date} 余 ${c.remaining} 间`).join('，'),
      { conflicts });
  }
  return rows;
}

/* ---------------- 占用 upsert（单晚） ---------------- */
const getOcc = db.prepare(
  'SELECT * FROM resource_occupancies WHERE resource_id=? AND booking_type=? AND booking_id=? AND service_date=?');
const insOcc = db.prepare(`INSERT INTO resource_occupancies
  (resource_id, tour_id, tour_code, booking_type, booking_id, service_date, quantity, status, unit_price_snapshot, cost_amount, confirmed_at)
  VALUES (?,?,?,?,?,?,?,?,?,?,?)`);

// 已确认占用的价格被快照锁定；待确认占用跟随资源池现价
function upsertOccupancy({ resource, tourId, tourCode, bookingType, bookingId, serviceDate, quantity, initialStatus }) {
  const existing = getOcc.get(resource.id, bookingType, bookingId, serviceDate);
  const price = resource.unit_price;
  if (!existing) {
    const status = initialStatus || '待确认';
    const info = insOcc.run(resource.id, tourId, tourCode || '', bookingType, bookingId, serviceDate,
      quantity, status, price, Math.round(price * quantity * 100) / 100,
      status === '已确认' ? "datetime('now','localtime')" : null);
    return db.prepare('SELECT * FROM resource_occupancies WHERE id=?').get(info.lastInsertRowid);
  }
  // 已释放 → 恢复；曾确认过的保持确认，其余按传入初始态
  let status = existing.status;
  if (status === '已释放') status = existing.confirmed_at ? '已确认' : (initialStatus || '待确认');
  const snapPrice = status === '已确认' ? existing.unit_price_snapshot : price;
  db.prepare(`UPDATE resource_occupancies
    SET quantity=?, status=?, unit_price_snapshot=?, cost_amount=?, released_at=NULL
    WHERE id=?`).run(quantity, status, snapPrice, Math.round(snapPrice * quantity * 100) / 100, existing.id);
  return db.prepare('SELECT * FROM resource_occupancies WHERE id=?').get(existing.id);
}

/* ---------------- 同步各类计调记录的占用 ---------------- */
const releaseByBookingStmt = db.prepare(`
  UPDATE resource_occupancies SET status='已释放', released_at=datetime('now','localtime')
  WHERE booking_type=? AND booking_id=? AND status IN ('待确认','已确认')`);
const bookingOccsStmt = db.prepare(
  `SELECT * FROM resource_occupancies WHERE booking_type=? AND booking_id=? ORDER BY service_date`);
const releaseOtherDates = db.prepare(`
  UPDATE resource_occupancies SET status='已释放', released_at=datetime('now','localtime')
  WHERE booking_type=? AND booking_id=? AND id<>? AND status IN ('待确认','已确认')`);

function releaseByBooking(type, id) { return releaseByBookingStmt.run(type, id); }
function bookingOccs(type, id) { return bookingOccsStmt.all(type, id); }

function tourCodeOf(tourId) {
  const t = db.prepare('SELECT code FROM tours WHERE id=?').get(tourId);
  return t ? t.code : '';
}

// 航空切位：一班一个占用；resource_id 为空表示手工计调（不占池）
function syncFlightOccupancy(booking, { resourceId, seats, status, flightDate } = {}) {
  if (!resourceId) { releaseByBooking('flight', booking.id); return []; }
  const r = db.prepare('SELECT * FROM resources WHERE id=?').get(resourceId);
  if (!r) throw new ApiError(404, '所选航班资源不存在');
  if (r.type !== 'flight') throw new ApiError(400, '所选资源不是航班座位资源');
  const date = flightDate || booking.flight_date || r.date;
  assertCapacity(r.id, date, seats, { type: 'flight', id: booking.id }, `${r.flight_no || ''} ${date || ''}`.trim());
  const occ = upsertOccupancy({
    resource: r, tourId: booking.tour_id, tourCode: tourCodeOf(booking.tour_id),
    bookingType: 'flight', bookingId: booking.id, serviceDate: date,
    quantity: seats, initialStatus: status
  });
  releaseOtherDates.run('flight', booking.id, occ.id);
  return [occ];
}

// 酒店控房：逐晚占用，逐晚校验
function syncHotelOccupancy(booking, { status } = {}) {
  const anchor = booking.resource_id
    ? db.prepare('SELECT supplier_id FROM resources WHERE id=?').get(booking.resource_id) : null;
  const nights = resolveHotelNights({
    hotelName: booking.hotel_name, roomType: booking.room_type, rooms: booking.rooms,
    checkIn: booking.check_in, checkOut: booking.check_out, excludeBooking: booking.id,
    supplierId: anchor ? anchor.supplier_id : null
  });
  const occs = nights.map(n => upsertOccupancy({
    resource: n.resource, tourId: booking.tour_id, tourCode: tourCodeOf(booking.tour_id),
    bookingType: 'hotel', bookingId: booking.id, serviceDate: n.date,
    quantity: booking.rooms, initialStatus: status
  }));
  // 日期范围缩短后，多余的旧晚数标记释放
  const placeholders = occs.map(() => '?').join(',');
  db.prepare(`UPDATE resource_occupancies SET status='已释放', released_at=datetime('now','localtime')
    WHERE booking_type='hotel' AND booking_id=? AND id NOT IN (${placeholders}) AND status IN ('待确认','已确认')`)
    .run(booking.id, ...occs.map(o => o.id));
  return occs;
}

// 地接服务：按服务日一行占用
function syncLocalOccupancy(booking, { resourceId, serviceDate, quantity, status } = {}) {
  if (!resourceId) { releaseByBooking('local', booking.id); return []; }
  const r = db.prepare('SELECT * FROM resources WHERE id=?').get(resourceId);
  if (!r) throw new ApiError(404, '所接地接资源不存在');
  if (r.type !== 'local') throw new ApiError(400, '所选资源不是地接服务资源');
  const date = serviceDate || r.date;
  if (!date) throw new ApiError(400, '地接服务需要指定服务日期');
  assertCapacity(r.id, date, quantity, { type: 'local', id: booking.id }, `${r.service_name || ''} ${date}`.trim());
  const occ = upsertOccupancy({
    resource: r, tourId: booking.tour_id, tourCode: tourCodeOf(booking.tour_id),
    bookingType: 'local', bookingId: booking.id, serviceDate: date,
    quantity, initialStatus: status
  });
  releaseOtherDates.run('local', booking.id, occ.id);
  return [occ];
}

/* ---------------- 确认 / 重新占用 ---------------- */
// 确认：再次做容量校验后锁定成本快照；撤销确认：占用仍有效（待确认），快照回归资源池现价
function setBookingConfirmed(bookingType, bookingId, confirmed) {
  const occs = bookingOccs(bookingType, bookingId).filter(o => o.status !== '已释放');
  if (confirmed) {
    for (const o of occs) {
      assertCapacity(o.resource_id, o.service_date, o.quantity, { type: bookingType, id: bookingId }, '');
    }
    const upd = db.prepare(`UPDATE resource_occupancies
      SET status='已确认', confirmed_at=COALESCE(confirmed_at, datetime('now','localtime')),
          unit_price_snapshot=?, cost_amount=? WHERE id=?`);
    for (const o of occs) {
      const price = o.status === '已确认'
        ? o.unit_price_snapshot
        : db.prepare('SELECT unit_price FROM resources WHERE id=?').get(o.resource_id).unit_price;
      upd.run(price, Math.round(price * o.quantity * 100) / 100, o.id);
    }
  } else {
    const upd = db.prepare(`UPDATE resource_occupancies
      SET status='待确认', confirmed_at=NULL, unit_price_snapshot=?, cost_amount=? WHERE id=?`);
    for (const o of occs) {
      const price = db.prepare('SELECT unit_price FROM resources WHERE id=?').get(o.resource_id).unit_price;
      upd.run(price, Math.round(price * o.quantity * 100) / 100, o.id);
    }
  }
  return bookingOccs(bookingType, bookingId);
}

// 释放后重新占用（库存规则重新校验）
function reoccupyBooking(bookingType, bookingId) {
  if (bookingType === 'flight') {
    const b = db.prepare('SELECT * FROM flight_bookings WHERE id=?').get(bookingId);
    if (!b) throw new ApiError(404, '记录不存在');
    if (!b.resource_id) throw new ApiError(400, '该记录为手工计调，无资源池占用');
    return syncFlightOccupancy(b, { resourceId: b.resource_id, seats: b.seats, status: b.confirmed ? '已确认' : '待确认' });
  }
  if (bookingType === 'hotel') {
    const b = db.prepare('SELECT * FROM hotel_bookings WHERE id=?').get(bookingId);
    if (!b) throw new ApiError(404, '记录不存在');
    return syncHotelOccupancy(b, { status: b.confirmed ? '已确认' : '待确认' });
  }
  const b = db.prepare('SELECT * FROM local_services WHERE id=?').get(bookingId);
  if (!b) throw new ApiError(404, '记录不存在');
  if (!b.resource_id) throw new ApiError(400, '该记录为手工计调，无资源池占用');
  return syncLocalOccupancy(b, {
    resourceId: b.resource_id, serviceDate: b.service_date,
    quantity: b.quantity || 1, status: b.confirmed ? '已确认' : '待确认'
  });
}

/* ---------------- 资源维护对占用的影响 ---------------- */
// 调价：已确认占用快照不变；待确认占用的快照价跟随更新（确认时再锁）
function applyPriceChange(resourceId, newPrice) {
  const rows = db.prepare("SELECT * FROM resource_occupancies WHERE resource_id=? AND status='待确认'").all(resourceId);
  const upd = db.prepare('UPDATE resource_occupancies SET unit_price_snapshot=?, cost_amount=? WHERE id=?');
  for (const o of rows) upd.run(newPrice, Math.round(newPrice * o.quantity * 100) / 100, o.id);
  return rows.length;
}

// 删资源：有已确认占用时禁止；待确认/已释放占用随资源删除（待确认等于自动释放）
function removeResource(resourceId) {
  const confirmed = db.prepare("SELECT COUNT(*) c FROM resource_occupancies WHERE resource_id=? AND status='已确认'").get(resourceId).c;
  if (confirmed) throw new ApiError(409, `该资源存在 ${confirmed} 条已确认占用，不能删除（请先在团队中释放或退订）`);
  const pending = db.prepare("SELECT COUNT(*) c FROM resource_occupancies WHERE resource_id=? AND status='待确认'").get(resourceId).c;
  db.prepare('DELETE FROM resource_occupancies WHERE resource_id=?').run(resourceId);
  db.prepare('DELETE FROM resources WHERE id=?').run(resourceId);
  return { released_pending: pending };
}

/* ---------------- 视图数据组装 ---------------- */
function occupancySourcesForResource(resourceId) {
  return db.prepare(`
    SELECT o.*, t.code AS current_tour_code
    FROM resource_occupancies o LEFT JOIN tours t ON t.id=o.tour_id
    WHERE o.resource_id=? AND o.status IN ('待确认','已确认')
    ORDER BY o.service_date, o.status DESC, o.id`).all(resourceId);
}

module.exports = {
  ApiError, withImmediate,
  addDay, eachNight, nightsBetween,
  heldOn, resourceAvailable, assertCapacity,
  findHotelResource, resolveHotelNights,
  upsertOccupancy,
  syncFlightOccupancy, syncHotelOccupancy, syncLocalOccupancy,
  setBookingConfirmed, releaseBookingOccupancies: releaseByBooking,
  reoccupyBooking, bookingOccs,
  applyPriceChange, removeResource, occupancySourcesForResource
};
