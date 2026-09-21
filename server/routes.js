const express = require('express');
const db = require('./db');
const pool = require('./pool');
const { ApiError, withImmediate, eachNight } = pool;
const { validIdCard, validPhone, calcFinance, generateTourCode } = require('./helpers');

const router = express.Router();

// 包装处理器：将 ApiError（库存冲突等业务错误）交给路由尾部的错误中间件
const H = fn => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);

/* ---------------- 仪表盘 ---------------- */
router.get('/stats', (req, res) => {
  const one = (sql, ...p) => db.prepare(sql).get(...p);
  res.json({
    products: one('SELECT COUNT(*) c FROM products WHERE active=1').c,
    tours: one('SELECT COUNT(*) c FROM tours').c,
    openTours: one("SELECT COUNT(*) c FROM tours WHERE status='收客中'").c,
    tourists: one("SELECT COUNT(*) c FROM tourists WHERE status!='已退团'").c,
    finance: (() => {
      const all = db.prepare('SELECT id FROM tours').all();
      let revenue = 0, cost = 0;
      for (const t of all) {
        const f = calcFinance(db, t.id);
        revenue += f.revenue;
        cost += f.costs.total;
      }
      return { revenue, cost, grossProfit: Math.round((revenue - cost) * 100) / 100 };
    })()
  });
});

/* ---------------- 旅游产品 ---------------- */
router.get('/products', (req, res) => {
  const q = `%${(req.query.q || '').trim()}%`;
  const rows = db.prepare(`
    SELECT p.*, (SELECT COUNT(*) FROM tours t WHERE t.product_id=p.id) AS tour_count
    FROM products p
    WHERE (?='%%' OR p.name LIKE ? OR p.destination LIKE ? OR p.departure_city LIKE ?)
    ORDER BY p.id DESC
  `).all(q, q, q, q);
  res.json(rows);
});

router.get('/products/:id', (req, res) => {
  const p = db.prepare('SELECT * FROM products WHERE id=?').get(req.params.id);
  if (!p) return res.status(404).json({ error: '产品不存在' });
  p.itinerary = db.prepare('SELECT * FROM itinerary_days WHERE product_id=? ORDER BY day_no').all(p.id);
  res.json(p);
});

function saveItinerary(productId, itinerary) {
  db.prepare('DELETE FROM itinerary_days WHERE product_id=?').run(productId);
  const ins = db.prepare(`INSERT INTO itinerary_days
    (product_id, day_no, title, attractions, meals, hotel) VALUES (?,?,?,?,?,?)`);
  for (const d of itinerary || []) {
    ins.run(productId, Number(d.day_no) || 0, d.title || '', d.attractions || '', d.meals || '', d.hotel || '');
  }
}

function validateProduct(b) {
  if (!b.name || !b.name.trim()) return '请填写线路名称';
  b.days = Number(b.days);
  if (!b.days || b.days < 1) return '行程天数需大于 0';
  if (!b.departure_city) return '请填写出发城市';
  if (!b.destination) return '请填写目的地';
  b.price_double = Number(b.price_double) || 0;
  b.price_triple = Number(b.price_triple) || 0;
  b.price_child = Number(b.price_child) || 0;
  if (b.price_double < 0 || b.price_triple < 0 || b.price_child < 0) return '价格不能为负';
  return null;
}

router.post('/products', (req, res) => {
  const b = req.body;
  const err = validateProduct(b);
  if (err) return res.status(400).json({ error: err });
  const info = db.prepare(`INSERT INTO products
    (name, days, departure_city, destination, price_double, price_triple, price_child, description)
    VALUES (?,?,?,?,?,?,?,?)`).run(
    b.name.trim(), b.days, b.departure_city, b.destination,
    b.price_double, b.price_triple, b.price_child, b.description || ''
  );
  saveItinerary(info.lastInsertRowid, b.itinerary);
  res.json(db.prepare('SELECT * FROM products WHERE id=?').get(info.lastInsertRowid));
});

router.put('/products/:id', (req, res) => {
  const id = req.params.id;
  if (!db.prepare('SELECT id FROM products WHERE id=?').get(id)) return res.status(404).json({ error: '产品不存在' });
  const b = req.body;
  const err = validateProduct(b);
  if (err) return res.status(400).json({ error: err });
  db.prepare(`UPDATE products SET name=?, days=?, departure_city=?, destination=?,
    price_double=?, price_triple=?, price_child=?, description=? WHERE id=?`).run(
    b.name.trim(), b.days, b.departure_city, b.destination,
    b.price_double, b.price_triple, b.price_child, b.description || '', id
  );
  saveItinerary(id, b.itinerary);
  res.json(db.prepare('SELECT * FROM products WHERE id=?').get(id));
});

router.delete('/products/:id', (req, res) => {
  const used = db.prepare('SELECT COUNT(*) c FROM tours WHERE product_id=?').get(req.params.id).c;
  if (used) return res.status(400).json({ error: `该产品已有 ${used} 个团队，无法删除（可保留作历史档案）` });
  db.prepare('DELETE FROM products WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

/* ---------------- 旅游团队 ---------------- */
router.get('/tours', (req, res) => {
  const where = [];
  const params = [];
  if (req.query.status) { where.push('t.status=?'); params.push(req.query.status); }
  if (req.query.q) {
    where.push('(t.code LIKE ? OR p.name LIKE ? OR p.destination LIKE ?)');
    const q = `%${req.query.q}%`;
    params.push(q, q, q);
  }
  const sql = `
    SELECT t.*, p.name AS product_name, p.days, p.departure_city, p.destination,
      p.price_double, p.price_triple, p.price_child,
      (SELECT COUNT(*) FROM tourists tr WHERE tr.tour_id=t.id AND tr.status!='已退团') AS headcount
    FROM tours t JOIN products p ON p.id=t.product_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY t.departure_date DESC, t.id DESC`;
  const rows = db.prepare(sql).all(...params).map(r => ({ ...r, full: r.headcount >= r.capacity }));
  res.json(rows);
});

router.get('/tours/:id', (req, res) => {
  const t = db.prepare(`
    SELECT t.*, p.name AS product_name, p.days, p.departure_city, p.destination,
      p.price_double, p.price_triple, p.price_child, p.description AS product_description
    FROM tours t JOIN products p ON p.id=t.product_id WHERE t.id=?`).get(req.params.id);
  if (!t) return res.status(404).json({ error: '团队不存在' });
  t.full = false;
  t.itinerary = db.prepare('SELECT * FROM itinerary_days WHERE product_id=? ORDER BY day_no').all(t.product_id);
  t.tourists = db.prepare('SELECT * FROM tourists WHERE tour_id=? ORDER BY id').all(t.id);
  t.flights = db.prepare('SELECT * FROM flight_bookings WHERE tour_id=?').all(t.id);
  t.hotels = db.prepare('SELECT * FROM hotel_bookings WHERE tour_id=?').all(t.id);
  t.local_services = db.prepare('SELECT * FROM local_services WHERE tour_id=?').all(t.id);
  t.other_costs = db.prepare('SELECT * FROM other_costs WHERE tour_id=?').all(t.id);
  t.occupancies = db.prepare(`
    SELECT o.*, s.type AS resource_type, s.supplier_id,
           CASE WHEN s.type='flight' THEN s.flight_no
                WHEN s.type='hotel' THEN s.hotel_name || ' ' || s.room_type
                ELSE s.service_name END AS resource_label,
           su.name AS supplier_name
    FROM resource_occupancies o
    JOIN resources s ON s.id=o.resource_id
    JOIN suppliers su ON su.id=s.supplier_id
    WHERE o.tour_id=? ORDER BY o.booking_type, o.service_date, o.id`).all(t.id);
  // 资源池实时余量（仅本团有效占用涉及的资源/日期）
  t.pool_availability = t.occupancies
    .filter(o => o.status !== '已释放')
    .map(o => {
      const a = pool.resourceAvailable(o.resource_id, o.service_date);
      return {
        booking_type: o.booking_type, booking_id: o.booking_id,
        resource_id: o.resource_id, date: o.service_date,
        quantity: a.resource.quantity, held: a.held, available: a.available,
        resource_status: a.resource.status,
        shortage: a.available < 0 || a.resource.status !== '开放'
      };
    });
  // 本团计调中存在的资源池冲突（停售/采购量被调减到占用以下），用于计调页顶部提示
  t.pool_conflicts = t.pool_availability
    .filter(a => a.shortage)
    .map(a => {
      const o = t.occupancies.find(x => x.resource_id === a.resource_id && x.service_date === a.date && x.status !== '已释放');
      return { ...a, label: o?.resource_label || '', occupied: o?.quantity || 0 };
    });
  t.notices = db.prepare('SELECT id, sent, sent_at, recipient_count, created_at FROM notices WHERE tour_id=? ORDER BY id DESC').all(t.id);
  const active = t.tourists.filter(x => x.status !== '已退团');
  t.headcount = active.length;
  t.full = t.headcount >= t.capacity;
  t.finance = calcFinance(db, t.id);
  res.json(t);
});

router.post('/tours', (req, res) => {
  const b = req.body;
  const p = db.prepare('SELECT * FROM products WHERE id=?').get(b.product_id);
  if (!p) return res.status(400).json({ error: '请选择旅游产品' });
  if (!b.departure_date) return res.status(400).json({ error: '请选择出发日期' });
  b.capacity = Number(b.capacity);
  if (!b.capacity || b.capacity < 1) return res.status(400).json({ error: '团容量需大于 0' });
  if (b.return_date && b.return_date < b.departure_date) return res.status(400).json({ error: '回程日期不能早于出发日期' });
  let code = (b.code || '').trim() || generateTourCode(db, b.departure_date);
  try {
    const info = db.prepare(`INSERT INTO tours (code, product_id, departure_date, return_date, capacity, status, tour_leader, remarks)
      VALUES (?,?,?,?,?,'收客中',?,?)`).run(
      code, p.id, b.departure_date, b.return_date || null, b.capacity, b.tour_leader || '', b.remarks || ''
    );
    res.json(db.prepare('SELECT * FROM tours WHERE id=?').get(info.lastInsertRowid));
  } catch (e) {
    res.status(400).json({ error: '团号已存在: ' + code });
  }
});

router.patch('/tours/:id', (req, res) => {
  const t = db.prepare('SELECT * FROM tours WHERE id=?').get(req.params.id);
  if (!t) return res.status(404).json({ error: '团队不存在' });
  const fields = ['code', 'departure_date', 'return_date', 'capacity', 'status', 'tour_leader', 'remarks'];
  for (const f of fields) if (req.body[f] !== undefined) t[f] = req.body[f];
  t.capacity = Number(t.capacity);
  if (t.capacity < 1) return res.status(400).json({ error: '团容量需大于 0' });
  db.prepare(`UPDATE tours SET code=?,departure_date=?,return_date=?,capacity=?,status=?,tour_leader=?,remarks=? WHERE id=?`)
    .run(t.code, t.departure_date, t.return_date, t.capacity, t.status, t.tour_leader, t.remarks, t.id);
  res.json({ ok: true });
});

// 取消/删除团队：事务内先释放本团全部有效资源池占用，再删除团队
router.delete('/tours/:id', H((req, res) => {
  const id = Number(req.params.id);
  if (!db.prepare('SELECT id FROM tours WHERE id=?').get(id)) throw new ApiError(404, '团队不存在');
  withImmediate(() => {
    db.prepare(`UPDATE resource_occupancies SET status='已释放', released_at=datetime('now','localtime')
      WHERE tour_id=? AND status IN ('待确认','已确认')`).run(id);
    db.prepare('DELETE FROM tours WHERE id=?').run(id);
  });
  res.json({ ok: true });
}));

/* ---------------- 收客 / 游客 ---------------- */
router.post('/tours/:id/tourists', (req, res) => {
  const tour = db.prepare('SELECT t.*, p.price_double, p.price_triple, p.price_child FROM tours t JOIN products p ON p.id=t.product_id WHERE t.id=?').get(req.params.id);
  if (!tour) return res.status(404).json({ error: '团队不存在' });
  if (tour.status !== '收客中') return res.status(400).json({ error: `团队当前状态为「${tour.status}」，已停止收客` });

  const count = db.prepare("SELECT COUNT(*) c FROM tourists WHERE tour_id=? AND status!='已退团'").get(tour.id).c;
  if (count >= tour.capacity) return res.status(400).json({ error: '该团已满员，自动停止收客' });

  const b = req.body;
  if (!b.name || !b.name.trim()) return res.status(400).json({ error: '请填写游客姓名' });
  b.id_card = (b.id_card || '').trim().toUpperCase();
  if (!validIdCard(b.id_card)) return res.status(400).json({ error: '身份证号格式或校验位不正确' });
  if (!validPhone(b.phone)) return res.status(400).json({ error: '手机号格式不正确' });
  if (!['双人房', '三人房', '儿童不占床'].includes(b.room_type)) return res.status(400).json({ error: '房型无效' });

  const dup = db.prepare('SELECT id FROM tourists WHERE tour_id=? AND id_card=? AND status!=\'已退团\'').get(tour.id, b.id_card);
  if (dup) return res.status(400).json({ error: '该游客已报名本团（身份证号重复）' });

  const priceMap = { 双人房: tour.price_double, 三人房: tour.price_triple, 儿童不占床: tour.price_child };
  const price = b.price !== undefined && b.price !== '' ? Number(b.price) : priceMap[b.room_type];

  const info = db.prepare(`INSERT INTO tourists (tour_id, name, id_card, phone, room_type, special_needs, price)
    VALUES (?,?,?,?,?,?,?)`).run(tour.id, b.name.trim(), b.id_card, b.phone || '', b.room_type, b.special_needs || '', price || 0);
  res.json(db.prepare('SELECT * FROM tourists WHERE id=?').get(info.lastInsertRowid));
});

router.patch('/tourists/:id', (req, res) => {
  const tr = db.prepare('SELECT * FROM tourists WHERE id=?').get(req.params.id);
  if (!tr) return res.status(404).json({ error: '游客不存在' });
  const b = req.body;
  if (b.phone !== undefined && !validPhone(b.phone)) return res.status(400).json({ error: '手机号格式不正确' });
  if (b.id_card !== undefined) {
    b.id_card = b.id_card.trim().toUpperCase();
    if (!validIdCard(b.id_card)) return res.status(400).json({ error: '身份证号格式或校验位不正确' });
  }
  const fields = ['name', 'id_card', 'phone', 'room_type', 'special_needs', 'price', 'status'];
  for (const f of fields) if (b[f] !== undefined) tr[f] = b[f];
  db.prepare(`UPDATE tourists SET name=?,id_card=?,phone=?,room_type=?,special_needs=?,price=?,status=? WHERE id=?`)
    .run(tr.name, tr.id_card, tr.phone, tr.room_type, tr.special_needs, tr.price, tr.status, tr.id);
  res.json({ ok: true });
});

router.delete('/tourists/:id', (req, res) => {
  db.prepare('DELETE FROM tourists WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

/* ---------------- 计调：航空切位 ---------------- */
router.post('/tours/:id/flights', H((req, res) => {
  const tourId = Number(req.params.id);
  const tour = db.prepare('SELECT * FROM tours WHERE id=?').get(tourId);
  if (!tour) throw new ApiError(404, '团队不存在');
  const b = req.body;
  const seats = Number(b.seats);
  if (!(seats > 0)) throw new ApiError(400, '切位座位数需大于 0');
  const resourceId = b.resource_id ? Number(b.resource_id) : null;

  // 创建占用与切位记录必须在同一个立即事务中完成（并发不超卖）
  const row = withImmediate(() => {
    let r;
    if (resourceId) {
      const resRow = db.prepare('SELECT * FROM resources WHERE id=?').get(resourceId);
      if (!resRow || resRow.type !== 'flight') throw new ApiError(400, '所选航班资源不存在或类型不符');
      const date = b.flight_date || resRow.date;
      r = {
        tour_id: tourId, direction: b.direction || '去程',
        flight_no: (b.flight_no || '').trim() || resRow.flight_no,
        flight_date: date, route: b.route || resRow.route || '',
        seats, unit_price: Number(b.unit_price) || resRow.unit_price,
        confirmed: b.confirmed ? 1 : 0, remarks: b.remarks || '',
        resource_id: resourceId, released: 0
      };
      if (!r.flight_no) throw new ApiError(400, '请填写航班号');
    } else {
      if (!b.flight_no || !b.flight_no.trim()) throw new ApiError(400, '请填写航班号');
      r = {
        tour_id: tourId, direction: b.direction || '去程',
        flight_no: b.flight_no.trim(), flight_date: b.flight_date || null,
        route: b.route || '', seats, unit_price: Number(b.unit_price) || 0,
        confirmed: b.confirmed ? 1 : 0, remarks: b.remarks || '',
        resource_id: null, released: 0
      };
    }
    const info = db.prepare(`INSERT INTO flight_bookings
      (tour_id, direction, flight_no, flight_date, route, seats, unit_price, confirmed, remarks, resource_id, released)
      VALUES (@tour_id,@direction,@flight_no,@flight_date,@route,@seats,@unit_price,@confirmed,@remarks,@resource_id,@released)`).run(r);
    const booking = db.prepare('SELECT * FROM flight_bookings WHERE id=?').get(info.lastInsertRowid);
    if (resourceId) {
      pool.syncFlightOccupancy(booking, {
        resourceId, seats, flightDate: booking.flight_date,
        status: b.confirmed ? '已确认' : '待确认'
      });
    }
    return booking;
  });
  res.json(row);
}));

router.put('/flights/:id', H((req, res) => {
  const id = Number(req.params.id);
  const old = db.prepare('SELECT * FROM flight_bookings WHERE id=?').get(id);
  if (!old) throw new ApiError(404, '记录不存在');
  if (old.released) throw new ApiError(400, '该切位已释放库存，请先「重新占用」后再修改');
  const b = req.body;
  const row = withImmediate(() => {
    const next = { ...old };
    for (const f of ['direction', 'flight_no', 'flight_date', 'route', 'seats', 'unit_price', 'remarks']) {
      if (b[f] !== undefined) next[f] = b[f];
    }
    next.seats = Number(next.seats);
    if (!(next.seats > 0)) throw new ApiError(400, '切位座位数需大于 0');
    if (b.resource_id !== undefined) next.resource_id = b.resource_id ? Number(b.resource_id) : null;
    const confirmed = b.confirmed !== undefined ? (b.confirmed ? 1 : 0) : old.confirmed;
    next.confirmed = confirmed;
    if (next.resource_id) {
      const resRow = db.prepare('SELECT * FROM resources WHERE id=?').get(next.resource_id);
      if (!resRow || resRow.type !== 'flight') throw new ApiError(400, '所选航班资源不存在或类型不符');
      if (!next.flight_no) next.flight_no = resRow.flight_no;
      if (!next.route) next.route = resRow.route || '';
      if (!next.flight_date) next.flight_date = resRow.date;
      if (b.unit_price === undefined) next.unit_price = resRow.unit_price;
    }
    db.prepare(`UPDATE flight_bookings SET direction=?,flight_no=?,flight_date=?,route=?,seats=?,
      unit_price=?,confirmed=?,remarks=?,resource_id=? WHERE id=?`).run(
      next.direction, next.flight_no, next.flight_date, next.route, next.seats,
      next.unit_price, confirmed, next.remarks, next.resource_id, id);
    const booking = db.prepare('SELECT * FROM flight_bookings WHERE id=?').get(id);
    if (next.resource_id) {
      pool.syncFlightOccupancy(booking, {
        resourceId: next.resource_id, seats: next.seats, flightDate: next.flight_date,
        status: confirmed ? '已确认' : '待确认'
      });
    } else {
      pool.releaseBookingOccupancies('flight', id);
    }
    if (b.confirmed !== undefined) pool.setBookingConfirmed('flight', id, !!confirmed);
    return db.prepare('SELECT * FROM flight_bookings WHERE id=?').get(id);
  });
  res.json(row);
}));

// 释放占用（保留切位档案，库存回到资源池）
router.post('/flights/:id/release', H((req, res) => {
  const id = Number(req.params.id);
  if (!db.prepare('SELECT id FROM flight_bookings WHERE id=?').get(id)) throw new ApiError(404, '记录不存在');
  withImmediate(() => {
    pool.releaseBookingOccupancies('flight', id);
    db.prepare('UPDATE flight_bookings SET released=1, confirmed=0 WHERE id=?').run(id);
  });
  res.json({ ok: true });
}));
// 重新占用（按现有数量重新校验库存）
router.post('/flights/:id/reoccupy', H((req, res) => {
  const id = Number(req.params.id);
  withImmediate(() => pool.reoccupyBooking('flight', id));
  db.prepare('UPDATE flight_bookings SET released=0 WHERE id=?').run(id);
  res.json({ ok: true });
}));
router.delete('/flights/:id', H((req, res) => {
  const id = Number(req.params.id);
  if (!db.prepare('SELECT id FROM flight_bookings WHERE id=?').get(id)) throw new ApiError(404, '记录不存在');
  withImmediate(() => {
    pool.releaseBookingOccupancies('flight', id);
    db.prepare('DELETE FROM flight_bookings WHERE id=?').run(id);
  });
  res.json({ ok: true });
}));

/* ---------------- 计调：酒店控房 ---------------- */
router.post('/tours/:id/hotels', H((req, res) => {
  const tourId = Number(req.params.id);
  if (!db.prepare('SELECT id FROM tours WHERE id=?').get(tourId)) throw new ApiError(404, '团队不存在');
  const b = req.body;
  if (!b.hotel_name || !b.hotel_name.trim()) throw new ApiError(400, '请填写酒店名称');
  const rooms = Number(b.rooms);
  if (!(rooms > 0)) throw new ApiError(400, '控房间数需大于 0');
  if (!b.check_in || !b.check_out) throw new ApiError(400, '请选择入住/离店日期');
  if (b.check_out <= b.check_in) throw new ApiError(400, '离店日期需晚于入住日期');
  const linked = !!b.resource_id;

  const row = withImmediate(() => {
    let nightPrice = Number(b.night_price) || 0;
    if (linked) {
      // 以首晚锚定资源行，并逐晚校验库存（冲突会抛出含具体日期与剩余量的 409）
      const anchor = db.prepare('SELECT * FROM resources WHERE id=?').get(Number(b.resource_id));
      if (!anchor || anchor.type !== 'hotel' || anchor.hotel_name !== b.hotel_name.trim()
          || anchor.room_type !== (b.room_type || '标间') || anchor.date !== b.check_in) {
        throw new ApiError(400, '所选酒店资源与酒店/房型/入住日期不一致，请重新从资源池选择');
      }
      const nights = pool.resolveHotelNights({
        hotelName: b.hotel_name.trim(), roomType: b.room_type || '标间', rooms,
        checkIn: b.check_in, checkOut: b.check_out, supplierId: anchor.supplier_id
      });
      if (b.night_price === undefined || b.night_price === '') {
        nightPrice = nights.reduce((s, n) => s + n.resource.unit_price, 0) / nights.length;
      }
    }
    const info = db.prepare(`INSERT INTO hotel_bookings
      (tour_id, hotel_name, room_type, rooms, check_in, check_out, night_price, confirmed, remarks, resource_id, released)
      VALUES (?,?,?,?,?,?,?,?,?,?,0)`).run(
      tourId, b.hotel_name.trim(), b.room_type || '标间', rooms,
      b.check_in, b.check_out, nightPrice, b.confirmed ? 1 : 0, b.remarks || '',
      linked ? Number(b.resource_id) : null);
    const booking = db.prepare('SELECT * FROM hotel_bookings WHERE id=?').get(info.lastInsertRowid);
    if (linked) pool.syncHotelOccupancy(booking, { status: b.confirmed ? '已确认' : '待确认' });
    return booking;
  });
  res.json(row);
}));

router.put('/hotels/:id', H((req, res) => {
  const id = Number(req.params.id);
  const old = db.prepare('SELECT * FROM hotel_bookings WHERE id=?').get(id);
  if (!old) throw new ApiError(404, '记录不存在');
  if (old.released) throw new ApiError(400, '该控房已释放库存，请先「重新占用」后再修改');
  const b = req.body;
  const row = withImmediate(() => {
    const next = { ...old };
    for (const f of ['hotel_name', 'room_type', 'rooms', 'check_in', 'check_out', 'night_price', 'remarks']) {
      if (b[f] !== undefined) next[f] = b[f];
    }
    next.rooms = Number(next.rooms);
    if (!(next.rooms > 0)) throw new ApiError(400, '控房间数需大于 0');
    if (next.check_out <= next.check_in) throw new ApiError(400, '离店日期需晚于入住日期');
    const confirmed = b.confirmed !== undefined ? (b.confirmed ? 1 : 0) : old.confirmed;
    if (b.resource_id !== undefined) next.resource_id = b.resource_id ? Number(b.resource_id) : null;
    const wasLinked = !!old.resource_id || pool.bookingOccs('hotel', id).some(o => o.status !== '已释放');
    const linked = b.resource_id !== undefined ? !!next.resource_id : wasLinked;
    if (linked) {
      const anchorRow = db.prepare('SELECT supplier_id FROM resources WHERE id=?').get(next.resource_id);
      // 按新参数逐晚校验，冲突时整笔回滚（修改在事务内）
      const nights = pool.resolveHotelNights({
        hotelName: next.hotel_name, roomType: next.room_type, rooms: next.rooms,
        checkIn: next.check_in, checkOut: next.check_out, excludeBooking: id,
        supplierId: anchorRow ? anchorRow.supplier_id : null
      });
      if (!next.resource_id) next.resource_id = nights[0].resource.id;
      if (b.night_price === undefined) {
        next.night_price = nights.reduce((s, n) => s + n.resource.unit_price, 0) / nights.length;
      }
    }
    db.prepare(`UPDATE hotel_bookings SET hotel_name=?,room_type=?,rooms=?,check_in=?,check_out=?,
      night_price=?,confirmed=?,remarks=?,resource_id=? WHERE id=?`).run(
      next.hotel_name, next.room_type, next.rooms, next.check_in, next.check_out,
      next.night_price, confirmed, next.remarks, linked ? next.resource_id : null, id);
    const booking = db.prepare('SELECT * FROM hotel_bookings WHERE id=?').get(id);
    if (linked) {
      pool.syncHotelOccupancy(booking, { status: confirmed ? '已确认' : '待确认' });
      if (b.confirmed !== undefined) pool.setBookingConfirmed('hotel', id, !!confirmed);
    } else {
      pool.releaseBookingOccupancies('hotel', id);
    }
    return db.prepare('SELECT * FROM hotel_bookings WHERE id=?').get(id);
  });
  res.json(row);
}));

router.post('/hotels/:id/release', H((req, res) => {
  const id = Number(req.params.id);
  if (!db.prepare('SELECT id FROM hotel_bookings WHERE id=?').get(id)) throw new ApiError(404, '记录不存在');
  withImmediate(() => {
    pool.releaseBookingOccupancies('hotel', id);
    db.prepare('UPDATE hotel_bookings SET released=1, confirmed=0 WHERE id=?').run(id);
  });
  res.json({ ok: true });
}));
router.post('/hotels/:id/reoccupy', H((req, res) => {
  const id = Number(req.params.id);
  withImmediate(() => pool.reoccupyBooking('hotel', id));
  db.prepare('UPDATE hotel_bookings SET released=0 WHERE id=?').run(id);
  res.json({ ok: true });
}));
router.delete('/hotels/:id', H((req, res) => {
  const id = Number(req.params.id);
  if (!db.prepare('SELECT id FROM hotel_bookings WHERE id=?').get(id)) throw new ApiError(404, '记录不存在');
  withImmediate(() => {
    pool.releaseBookingOccupancies('hotel', id);
    db.prepare('DELETE FROM hotel_bookings WHERE id=?').run(id);
  });
  res.json({ ok: true });
}));

/* ---------------- 计调：地接社 ---------------- */
router.post('/tours/:id/local-services', H((req, res) => {
  const tourId = Number(req.params.id);
  if (!db.prepare('SELECT id FROM tours WHERE id=?').get(tourId)) throw new ApiError(404, '团队不存在');
  const b = req.body;
  if (!b.agency_name || !b.agency_name.trim()) throw new ApiError(400, '请填写地接社名称');
  const resourceId = b.resource_id ? Number(b.resource_id) : null;

  const row = withImmediate(() => {
    let r;
    if (resourceId) {
      const resRow = db.prepare('SELECT * FROM resources WHERE id=?').get(resourceId);
      if (!resRow || resRow.type !== 'local') throw new ApiError(400, '所接地接资源不存在或类型不符');
      const date = b.service_date || resRow.date;
      if (!date) throw new ApiError(400, '地接服务需要指定服务日期');
      const quantity = Number(b.quantity) > 0 ? Number(b.quantity) : 1;
      const totalPrice = Number(b.total_price) >= 0 && b.total_price !== ''
        ? Number(b.total_price)
        : Math.round(resRow.unit_price * quantity * 100) / 100;
      r = {
        tour_id: tourId,
        agency_name: (b.agency_name || '').trim() || db.prepare('SELECT name FROM suppliers WHERE id=?').get(resRow.supplier_id)?.name,
        guide_name: b.guide_name || '', guide_phone: b.guide_phone || '',
        vehicle: b.vehicle || '', meals_plan: b.meals_plan || '',
        total_price: totalPrice, confirmed: b.confirmed ? 1 : 0, remarks: b.remarks || '',
        resource_id: resourceId, service_date: date, quantity, released: 0
      };
    } else {
      r = {
        tour_id: tourId, agency_name: b.agency_name.trim(),
        guide_name: b.guide_name || '', guide_phone: b.guide_phone || '',
        vehicle: b.vehicle || '', meals_plan: b.meals_plan || '',
        total_price: Number(b.total_price) || 0, confirmed: b.confirmed ? 1 : 0, remarks: b.remarks || '',
        resource_id: null, service_date: b.service_date || null, quantity: 0, released: 0
      };
    }
    const info = db.prepare(`INSERT INTO local_services
      (tour_id, agency_name, guide_name, guide_phone, vehicle, meals_plan, total_price, confirmed, remarks, resource_id, service_date, quantity, released)
      VALUES (@tour_id,@agency_name,@guide_name,@guide_phone,@vehicle,@meals_plan,@total_price,@confirmed,@remarks,@resource_id,@service_date,@quantity,@released)`).run(r);
    const booking = db.prepare('SELECT * FROM local_services WHERE id=?').get(info.lastInsertRowid);
    if (resourceId) {
      pool.syncLocalOccupancy(booking, {
        resourceId, serviceDate: booking.service_date, quantity: booking.quantity,
        status: b.confirmed ? '已确认' : '待确认'
      });
    }
    return booking;
  });
  res.json(row);
}));

router.put('/local-services/:id', H((req, res) => {
  const id = Number(req.params.id);
  const old = db.prepare('SELECT * FROM local_services WHERE id=?').get(id);
  if (!old) throw new ApiError(404, '记录不存在');
  if (old.released) throw new ApiError(400, '该地接安排已释放库存，请先「重新占用」后再修改');
  const b = req.body;
  const row = withImmediate(() => {
    const next = { ...old };
    for (const f of ['agency_name', 'guide_name', 'guide_phone', 'vehicle', 'meals_plan', 'total_price', 'remarks', 'service_date']) {
      if (b[f] !== undefined) next[f] = b[f];
    }
    if (b.quantity !== undefined) next.quantity = Number(b.quantity) || 0;
    if (b.resource_id !== undefined) next.resource_id = b.resource_id ? Number(b.resource_id) : null;
    const confirmed = b.confirmed !== undefined ? (b.confirmed ? 1 : 0) : old.confirmed;
    if (next.resource_id) {
      const resRow = db.prepare('SELECT * FROM resources WHERE id=?').get(next.resource_id);
      if (!resRow || resRow.type !== 'local') throw new ApiError(400, '所接地接资源不存在或类型不符');
      if (!next.service_date) next.service_date = resRow.date;
      if (!next.quantity || next.quantity < 1) next.quantity = 1;
      if (b.total_price === undefined) {
        next.total_price = Math.round(resRow.unit_price * next.quantity * 100) / 100;
      }
    }
    db.prepare(`UPDATE local_services SET agency_name=?,guide_name=?,guide_phone=?,vehicle=?,meals_plan=?,
      total_price=?,confirmed=?,remarks=?,resource_id=?,service_date=?,quantity=? WHERE id=?`).run(
      next.agency_name, next.guide_name, next.guide_phone, next.vehicle, next.meals_plan,
      next.total_price, confirmed, next.remarks, next.resource_id, next.service_date, next.quantity, id);
    const booking = db.prepare('SELECT * FROM local_services WHERE id=?').get(id);
    if (next.resource_id) {
      pool.syncLocalOccupancy(booking, {
        resourceId: next.resource_id, serviceDate: next.service_date, quantity: next.quantity,
        status: confirmed ? '已确认' : '待确认'
      });
    } else {
      pool.releaseBookingOccupancies('local', id);
    }
    if (b.confirmed !== undefined) pool.setBookingConfirmed('local', id, !!confirmed);
    return db.prepare('SELECT * FROM local_services WHERE id=?').get(id);
  });
  res.json(row);
}));

router.post('/local-services/:id/release', H((req, res) => {
  const id = Number(req.params.id);
  if (!db.prepare('SELECT id FROM local_services WHERE id=?').get(id)) throw new ApiError(404, '记录不存在');
  withImmediate(() => {
    pool.releaseBookingOccupancies('local', id);
    db.prepare('UPDATE local_services SET released=1, confirmed=0 WHERE id=?').run(id);
  });
  res.json({ ok: true });
}));
router.post('/local-services/:id/reoccupy', H((req, res) => {
  const id = Number(req.params.id);
  withImmediate(() => pool.reoccupyBooking('local', id));
  db.prepare('UPDATE local_services SET released=0 WHERE id=?').run(id);
  res.json({ ok: true });
}));
router.delete('/local-services/:id', H((req, res) => {
  const id = Number(req.params.id);
  if (!db.prepare('SELECT id FROM local_services WHERE id=?').get(id)) throw new ApiError(404, '记录不存在');
  withImmediate(() => {
    pool.releaseBookingOccupancies('local', id);
    db.prepare('DELETE FROM local_services WHERE id=?').run(id);
  });
  res.json({ ok: true });
}));

/* ---------------- 其他成本 ---------------- */
router.post('/tours/:id/other-costs', (req, res) => {
  if (!db.prepare('SELECT id FROM tours WHERE id=?').get(req.params.id)) return res.status(404).json({ error: '团队不存在' });
  const b = req.body;
  if (!b.item || !b.item.trim()) return res.status(400).json({ error: '请填写费用项目' });
  const info = db.prepare('INSERT INTO other_costs (tour_id, item, amount, remarks) VALUES (?,?,?,?)')
    .run(req.params.id, b.item.trim(), Number(b.amount) || 0, b.remarks || '');
  res.json(db.prepare('SELECT * FROM other_costs WHERE id=?').get(info.lastInsertRowid));
});
router.delete('/other-costs/:id', (req, res) => simpleDelete('other_costs', req, res));

function simpleDelete(table, req, res) {
  db.prepare(`DELETE FROM ${table} WHERE id=?`).run(req.params.id);
  res.json({ ok: true });
}

/* ===================== 供应商资源池 ===================== */

/* ---------------- 供应商 ---------------- */
router.get('/suppliers', (req, res) => {
  const q = `%${(req.query.q || '').trim()}%`;
  const rows = db.prepare(`
    SELECT su.*,
      (SELECT COUNT(*) FROM resources r WHERE r.supplier_id=su.id) AS resource_count
    FROM suppliers su
    WHERE (?='%%' OR su.name LIKE ? OR su.type LIKE ?)
    ORDER BY su.id DESC`).all(q, q, q);
  res.json(rows);
});

router.post('/suppliers', H((req, res) => {
  const b = req.body;
  if (!b.name || !b.name.trim()) throw new ApiError(400, '请填写供应商名称');
  const info = db.prepare('INSERT INTO suppliers (name, type, contact, phone, remarks) VALUES (?,?,?,?,?)')
    .run(b.name.trim(), b.type || '综合', b.contact || '', b.phone || '', b.remarks || '');
  res.json(db.prepare('SELECT * FROM suppliers WHERE id=?').get(info.lastInsertRowid));
}));

router.put('/suppliers/:id', H((req, res) => {
  const id = Number(req.params.id);
  if (!db.prepare('SELECT id FROM suppliers WHERE id=?').get(id)) throw new ApiError(404, '供应商不存在');
  const b = req.body;
  if (b.name !== undefined && !b.name.trim()) throw new ApiError(400, '供应商名称不能为空');
  const cur = db.prepare('SELECT * FROM suppliers WHERE id=?').get(id);
  db.prepare('UPDATE suppliers SET name=?,type=?,contact=?,phone=?,remarks=?,active=? WHERE id=?')
    .run(
      b.name !== undefined ? b.name.trim() : cur.name,
      b.type !== undefined ? b.type : cur.type,
      b.contact !== undefined ? b.contact : cur.contact,
      b.phone !== undefined ? b.phone : cur.phone,
      b.remarks !== undefined ? b.remarks : cur.remarks,
      b.active !== undefined ? (b.active ? 1 : 0) : cur.active,
      id);
  res.json(db.prepare('SELECT * FROM suppliers WHERE id=?').get(id));
}));

// 停用/启用
router.post('/suppliers/:id/toggle', (req, res) => {
  const id = Number(req.params.id);
  const row = db.prepare('SELECT active FROM suppliers WHERE id=?').get(id);
  if (!row) return res.status(404).json({ error: '供应商不存在' });
  db.prepare('UPDATE suppliers SET active=? WHERE id=?').run(row.active ? 0 : 1, id);
  res.json({ ok: true, active: row.active ? 0 : 1 });
});

// 删除供应商：仍有资源记录时禁止
router.delete('/suppliers/:id', H((req, res) => {
  const id = Number(req.params.id);
  if (!db.prepare('SELECT id FROM suppliers WHERE id=?').get(id)) throw new ApiError(404, '供应商不存在');
  const c = db.prepare('SELECT COUNT(*) c FROM resources WHERE supplier_id=?').get(id).c;
  if (c) throw new ApiError(400, `该供应商名下仍有 ${c} 条资源池记录，无法删除（可改为停用）`);
  db.prepare('DELETE FROM suppliers WHERE id=?').run(id);
  res.json({ ok: true });
}));

/* ---------------- 资源池 ---------------- */
// 列表：支持 type/供应商/关键字/日期过滤；返回当日有效占用与实时余量
router.get('/resources', (req, res) => {
  const where = [];
  const params = [];
  if (req.query.type) { where.push('r.type=?'); params.push(req.query.type); }
  if (req.query.supplier_id) { where.push('r.supplier_id=?'); params.push(Number(req.query.supplier_id)); }
  if (req.query.status) { where.push('r.status=?'); params.push(req.query.status); }
  if (req.query.date) { where.push('r.date=?'); params.push(req.query.date); }
  if (req.query.q) {
    where.push('(r.flight_no LIKE ? OR r.route LIKE ? OR r.hotel_name LIKE ? OR r.service_name LIKE ? OR su.name LIKE ?)');
    const q = `%${req.query.q}%`;
    params.push(q, q, q, q, q);
  }
  const rows = db.prepare(`
    SELECT r.*, su.name AS supplier_name, su.type AS supplier_type
    FROM resources r JOIN suppliers su ON su.id=r.supplier_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY r.type, r.date, r.id`).all(...params);
  const heldMap = new Map();
  for (const r of rows) {
    const held = pool.heldOn(r.id, r.date);
    heldMap.set(r.id, held);
    r.held = held;
    r.available = r.quantity - held;
  }
  res.json(rows);
});

router.get('/resources/:id', H((req, res) => {
  const r = db.prepare(`SELECT r.*, su.name AS supplier_name FROM resources r
    JOIN suppliers su ON su.id=r.supplier_id WHERE r.id=?`).get(req.params.id);
  if (!r) throw new ApiError(404, '资源不存在');
  const a = pool.resourceAvailable(r.id, r.date);
  r.held = a.held; r.available = a.available;
  // 酒店：逐晚余量（批量建池的连续晚数）
  if (r.type === 'hotel' && r.end_date && r.end_date !== r.date) {
    r.nights = eachNight(r.date, pool.addDay(r.end_date, 1)).map(d => {
      const rr = db.prepare("SELECT id, date, quantity, unit_price, status FROM resources WHERE type='hotel' AND hotel_name=? AND room_type=? AND date=?").get(r.hotel_name, r.room_type, d);
      if (!rr) return { date: d, missing: true, quantity: 0, held: 0, available: 0 };
      const held = pool.heldOn(rr.id, d);
      return { resource_id: rr.id, date: d, quantity: rr.quantity, unit_price: rr.unit_price, status: rr.status, held, available: rr.quantity - held };
    });
  }
  r.sources = pool.occupancySourcesForResource(r.id);
  res.json(r);
}));

// 占用来源（实时余量 + 各团队占用明细）
router.get('/resources/:id/sources', H((req, res) => {
  const id = Number(req.params.id);
  const r = db.prepare('SELECT * FROM resources WHERE id=?').get(id);
  if (!r) throw new ApiError(404, '资源不存在');
  const a = pool.resourceAvailable(id, r.date);
  res.json({ resource: { ...r, held: a.held, available: a.available }, sources: pool.occupancySourcesForResource(id) });
}));

// 酒店资源可选组（计调页控房时按 酒店+房型 锚定首晚）
router.get('/resources-hotel/groups', (req, res) => {
  const rows = db.prepare(`
    SELECT r.hotel_name, r.room_type, MIN(r.date) AS first_date, MAX(r.date) AS last_date,
           su.name AS supplier_name,
           COUNT(*) AS night_count
    FROM resources r JOIN suppliers su ON su.id=r.supplier_id
    WHERE r.type='hotel' AND r.status='开放'
    GROUP BY r.hotel_name, r.room_type
    ORDER BY r.hotel_name`).all();
  res.json(rows);
});

function validateResource(b) {
  b.supplier_id = Number(b.supplier_id);
  if (!b.supplier_id) return '请选择供应商';
  if (!['flight', 'hotel', 'local'].includes(b.type)) return '资源类型无效';
  b.quantity = Number(b.quantity);
  if (!(b.quantity > 0)) return '采购数量需大于 0';
  b.unit_price = Number(b.unit_price) || 0;
  if (b.unit_price < 0) return '单价不能为负';
  if (b.type === 'flight') {
    if (!b.date) return '请选择航班日期';
    if (!b.flight_no || !String(b.flight_no).trim()) return '请填写航班号';
  }
  if (b.type === 'hotel') {
    if (!b.date) return '请选择入住日期';
    if (!b.hotel_name || !b.hotel_name.trim()) return '请填写酒店名称';
    if (!b.room_type || !b.room_type.trim()) return '请填写房型';
  }
  if (b.type === 'local') {
    if (!b.date) return '请选择服务日期';
    if (!b.service_name || !b.service_name.trim()) return '请填写地接服务名称';
  }
  return null;
}

// 创建资源（酒店可指定 end_date 批量生成连续入住晚，每晚一行；含首尾两晚）
router.post('/resources', H((req, res) => {
  const b = req.body;
  const err = validateResource(b);
  if (err) throw new ApiError(400, err);
  if (!db.prepare('SELECT id FROM suppliers WHERE id=?').get(b.supplier_id)) {
    throw new ApiError(400, '供应商不存在');
  }
  const ids = withImmediate(() => {
    // 酒店：date 为首晚、end_date 为最后一晚（含）；不传则只建当晚
    const dates = b.type === 'hotel' && b.end_date && b.end_date >= b.date
      ? eachNight(b.date, pool.addDay(b.end_date, 1))
      : [b.date];
    const out = [];
    for (const date of dates) {
      const dup = db.prepare(`SELECT id FROM resources WHERE type=? AND date=?
        AND COALESCE(flight_no,'')=? AND COALESCE(hotel_name,'')=? AND COALESCE(room_type,'')=?
        AND COALESCE(service_name,'')=? AND supplier_id=?`)
        .get(b.type, date, b.flight_no || '', b.hotel_name || '', b.room_type || '', b.service_name || '', b.supplier_id);
      if (dup) throw new ApiError(409, `资源重复：${date} 已存在相同记录（${b.hotel_name || b.flight_no || b.service_name}${b.room_type ? ' ' + b.room_type : ''}）`, {
        conflicts: [{ date, resource_id: dup.id }]
      });
      const info = db.prepare(`INSERT INTO resources
        (supplier_id, type, date, end_date, flight_no, route, hotel_name, room_type, service_name, service_unit, quantity, unit, unit_price, status, remarks)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        b.supplier_id, b.type, date,
        b.type === 'hotel' && dates.length > 1 ? dates[dates.length - 1] : (b.end_date || null),
        b.flight_no || '', b.route || '', b.hotel_name || '', b.room_type || '',
        b.service_name || '', b.service_unit || '',
        b.quantity, b.unit || (b.type === 'flight' ? '座' : b.type === 'hotel' ? '间' : '人'),
        b.unit_price, b.status === '停售' ? '停售' : '开放', b.remarks || '');
      out.push(info.lastInsertRowid);
    }
    return out;
  });
  const list = db.prepare('SELECT * FROM resources WHERE id IN (' + ids.map(() => '?').join(',') + ')').all(...ids);
  res.status(201).json(list.length === 1 ? list[0] : list);
}));

router.put('/resources/:id', H((req, res) => {
  const id = Number(req.params.id);
  const r = db.prepare('SELECT * FROM resources WHERE id=?').get(id);
  if (!r) throw new ApiError(404, '资源不存在');
  const b = req.body;
  withImmediate(() => {
    const next = { ...r };
    for (const f of ['flight_no', 'route', 'hotel_name', 'room_type', 'service_name', 'service_unit', 'unit', 'remarks', 'status', 'date']) {
      if (b[f] !== undefined) next[f] = b[f];
    }
    if (b.quantity !== undefined) {
      next.quantity = Number(b.quantity);
      if (!(next.quantity > 0)) throw new ApiError(400, '采购数量需大于 0');
      // 采购数量不得低于当前有效占用（否则会出现负库存）
      const held = pool.heldOn(id, next.date);
      if (next.quantity < held) throw new ApiError(409, `采购数量不能小于当前有效占用 ${held}，当前输入 ${next.quantity}`, {
        conflicts: [{ resource_id: id, date: next.date, need: next.quantity, available: next.quantity - held, remaining: next.quantity - held, held }]
      });
    }
    if (b.unit_price !== undefined) {
      next.unit_price = Number(b.unit_price);
      if (next.unit_price < 0) throw new ApiError(400, '单价不能为负');
    }
    db.prepare(`UPDATE resources SET flight_no=?,route=?,hotel_name=?,room_type=?,service_name=?,
      service_unit=?,quantity=?,unit=?,unit_price=?,status=?,remarks=?,date=? WHERE id=?`).run(
      next.flight_no, next.route, next.hotel_name, next.room_type, next.service_name,
      next.service_unit, next.quantity, next.unit, next.unit_price,
      b.status === '停售' ? '停售' : (b.status === '开放' ? '开放' : r.status),
      next.remarks, next.date, id);
    // 调价仅影响未确认占用；已确认快照锁定不变
    if (b.unit_price !== undefined) pool.applyPriceChange(id, next.unit_price);
  });
  res.json(db.prepare('SELECT * FROM resources WHERE id=?').get(id));
}));

router.post('/resources/:id/toggle', H((req, res) => {
  const id = Number(req.params.id);
  const r = db.prepare('SELECT status FROM resources WHERE id=?').get(id);
  if (!r) throw new ApiError(404, '资源不存在');
  const status = r.status === '开放' ? '停售' : '开放';
  db.prepare('UPDATE resources SET status=? WHERE id=?').run(status, id);
  res.json({ ok: true, status });
}));

router.delete('/resources/:id', H((req, res) => {
  const id = Number(req.params.id);
  if (!db.prepare('SELECT id FROM resources WHERE id=?').get(id)) throw new ApiError(404, '资源不存在');
  const result = withImmediate(() => pool.removeResource(id));
  res.json({ ok: true, ...result });
}));

/* ---------------- 出团通知书 ---------------- */
router.post('/tours/:id/notices/generate', (req, res) => {
  const t = getFullTour(req.params.id);
  if (!t) return res.status(404).json({ error: '团队不存在' });
  res.json({ content: buildNotice(t) });
});

router.get('/tours/:id/notices', (req, res) => {
  res.json(db.prepare('SELECT * FROM notices WHERE tour_id=? ORDER BY id DESC').all(req.params.id));
});

router.get('/notices/:id', (req, res) => {
  const n = db.prepare('SELECT * FROM notices WHERE id=?').get(req.params.id);
  if (!n) return res.status(404).json({ error: '通知书不存在' });
  res.json(n);
});

router.post('/tours/:id/notices', (req, res) => {
  if (!db.prepare('SELECT id FROM tours WHERE id=?').get(req.params.id)) return res.status(404).json({ error: '团队不存在' });
  const content = (req.body.content || '').trim();
  if (!content) return res.status(400).json({ error: '通知书内容为空' });
  const info = db.prepare('INSERT INTO notices (tour_id, content) VALUES (?,?)').run(req.params.id, content);
  res.json(db.prepare('SELECT * FROM notices WHERE id=?').get(info.lastInsertRowid));
});

// 模拟发送：实际项目中此处对接短信/邮件网关
router.post('/notices/:id/send', (req, res) => {
  const n = db.prepare('SELECT * FROM notices WHERE id=?').get(req.params.id);
  if (!n) return res.status(404).json({ error: '通知书不存在' });
  const recipientCount = db.prepare("SELECT COUNT(*) c FROM tourists WHERE tour_id=? AND status!='已退团'").get(n.tour_id).c;
  db.prepare("UPDATE notices SET sent=1, sent_at=datetime('now','localtime'), recipient_count=? WHERE id=?")
    .run(recipientCount, n.id);
  res.json(db.prepare('SELECT * FROM notices WHERE id=?').get(n.id));
});

function getFullTour(id) {
  const t = db.prepare(`
    SELECT t.*, p.name AS product_name, p.days, p.departure_city, p.destination,
      p.price_double, p.price_triple, p.price_child
    FROM tours t JOIN products p ON p.id=t.product_id WHERE t.id=?`).get(id);
  if (!t) return null;
  t.itinerary = db.prepare('SELECT * FROM itinerary_days WHERE product_id=? ORDER BY day_no').all(t.product_id);
  t.tourists = db.prepare("SELECT * FROM tourists WHERE tour_id=? AND status!='已退团' ORDER BY id").all(id);
  t.flights = db.prepare('SELECT * FROM flight_bookings WHERE tour_id=? AND released=0').all(id);
  t.hotels = db.prepare('SELECT * FROM hotel_bookings WHERE tour_id=? AND released=0').all(id);
  t.local_services = db.prepare('SELECT * FROM local_services WHERE tour_id=? AND released=0').all(id);
  return t;
}

function buildNotice(t) {
  const L = [];
  L.push(`【出团通知书】${t.product_name}（团号：${t.code}）`);
  L.push('');
  L.push(`尊敬的各位团友，您好！您报名参加的“${t.product_name}”即将出发，现将相关事宜通知如下：`);
  L.push('');
  L.push(`一、行程信息`);
  L.push(`出发城市：${t.departure_city}　目的地：${t.destination}`);
  L.push(`行程天数：${t.days} 天`);
  L.push(`出发日期：${t.departure_date}${t.return_date ? '　返程日期：' + t.return_date : ''}`);
  L.push(`集合方式：请于出发当日提前 2 小时到达机场集合，${t.tour_leader ? '领队：' + t.tour_leader : '领队将于出发前一日与您联系'}`);
  L.push('');
  L.push(`二、航班安排`);
  if (t.flights.length) {
    t.flights.forEach(f => L.push(`${f.direction}：${f.flight_no}${f.route ? '（' + f.route + '）' : ''}${f.flight_date ? '　' + f.flight_date : ''}　切位 ${f.seats} 座`));
  } else L.push('航班切位待计调确认，请留意后续通知。');
  L.push('');
  L.push(`三、每日行程`);
  t.itinerary.forEach(d => {
    L.push(`第${d.day_no}天 ${d.title || ''}`);
    if (d.attractions) L.push(`　景点：${d.attractions}`);
    if (d.meals) L.push(`　用餐：${d.meals}`);
    if (d.hotel) L.push(`　住宿：${d.hotel}`);
  });
  L.push('');
  L.push(`四、酒店安排`);
  if (t.hotels.length) {
    t.hotels.forEach(h => L.push(`${h.hotel_name}（${h.room_type}）${h.rooms} 间，${h.check_in} 入住，${h.check_out} 离店`));
  } else L.push('酒店控房待计调确认。');
  L.push('');
  L.push(`五、地接服务`);
  if (t.local_services.length) {
    t.local_services.forEach(s => {
      L.push(`地接社：${s.agency_name}`);
      if (s.guide_name) L.push(`地接导游：${s.guide_name}${s.guide_phone ? '　' + s.guide_phone : ''}`);
      if (s.vehicle) L.push(`用车：${s.vehicle}`);
      if (s.meals_plan) L.push(`用餐：${s.meals_plan}`);
    });
  } else L.push('地接安排待确认。');
  L.push('');
  const special = t.tourists.filter(x => x.special_needs && x.special_needs.trim());
  L.push(`六、温馨提示`);
  L.push(`1. 请携带有效身份证件（儿童携带户口本），提前到达集合地点。`);
  L.push(`2. 本团共 ${t.tourists.length} 位游客出行，请留意人身及财物安全。`);
  if (special.length) L.push(`3. 特殊需求已登记：${special.map(x => x.name + '（' + x.special_needs + '）').join('、')}，我们将提前安排。`);
  L.push(`请保持手机畅通，预祝旅途愉快！`);
  return L.join('\n');
}

/* ---------------- 错误中间件（必须位于全部路由之后） ---------------- */
router.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  if (err instanceof ApiError) return res.status(err.status).json(err.body);
  console.error(err);
  res.status(500).json({ error: err.message || '服务器内部错误' });
});

module.exports = router;
