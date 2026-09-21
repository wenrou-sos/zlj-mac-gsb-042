const express = require('express');
const db = require('./db');
const { validIdCard, validPhone, calcFinance, generateTourCode, nightsBetween } = require('./helpers');
const inv = require('./inventory');

const router = express.Router();

// 统一处理库存事务错误：409 + 剩余量与具体冲突日期
function handleTxn(res, fn) {
  try { return fn(); }
  catch (e) {
    if (e instanceof inv.InventoryError) {
      return res.status(e.status).json({ error: e.message, ...e.details });
    }
    throw e;
  }
}

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
  const allocRows = db.prepare(`
    SELECT a.*, r.type AS resource_type, r.name AS resource_name, r.sub_name AS resource_sub,
           r.route AS resource_route, r.qty AS resource_qty, r.unit_price AS resource_price,
           r.status AS resource_status, s.name AS supplier_name
    FROM resource_allocations a
    JOIN resources r ON r.id = a.resource_id
    JOIN suppliers s ON s.id = r.supplier_id
    WHERE a.tour_id=? ORDER BY
      CASE a.status WHEN '待确认' THEN 0 WHEN '已确认' THEN 1 ELSE 2 END, r.type, a.id`).all(t.id);
  // 每个资源只计算一次余量，附到该团各占用的日期窗口上
  const avCache = new Map();
  t.allocations = allocRows.map(a => {
    if (a.status === '已释放') return { ...a, availability: null };
    if (!avCache.has(a.resource_id)) avCache.set(a.resource_id, inv.getAvailability(a.resource_id));
    const av = avCache.get(a.resource_id);
    const dates = a.resource_type === '酒店' ? inv.dateList(a.start_date, a.end_date) : [a.start_date];
    return { ...a, availability: av.daily.filter(d => dates.includes(d.date)) };
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

router.delete('/tours/:id', (req, res) => {
  const id = req.params.id;
  if (!db.prepare('SELECT id FROM tours WHERE id=?').get(id)) return res.status(404).json({ error: '团队不存在' });
  // 取消/删除团队：先释放全部有效占用（联动删除计调表行），再删团
  const releaseAndDelete = db.transaction(() => {
    const rows = db.prepare(
      "SELECT id FROM resource_allocations WHERE tour_id=? AND status IN ('待确认','已确认')"
    ).all(id);
    rows.forEach(a => inv.releaseAllocationTxn(a.id, '团队取消/删除，库存释放'));
    db.prepare('DELETE FROM tours WHERE id=?').run(id);
  });
  releaseAndDelete();
  res.json({ ok: true, released: db.prepare('SELECT changes() c').get().c });
});

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

  // 退团规则：整团在团人数归零时，自动释放该团「待确认」占用（可继续卖给其他团）；
  // 已确认占用涉及与供应商的成约/成本快照，保留由计调手工释放，避免擅自违约。
  let released = [];
  if (b.status === '已退团') {
    const left = db.prepare("SELECT COUNT(*) c FROM tourists WHERE tour_id=? AND status!='已退团'").get(tr.tour_id).c;
    if (left === 0) {
      const pending = db.prepare("SELECT id FROM resource_allocations WHERE tour_id=? AND status='待确认'").all(tr.tour_id);
      pending.forEach(a => { inv.releaseAllocationTxn(a.id, '游客全部退团，待确认占用自动释放'); released.push(a.id); });
    }
  }
  res.json({ ok: true, released });
});

router.delete('/tourists/:id', (req, res) => {
  const tr = db.prepare('SELECT * FROM tourists WHERE id=?').get(req.params.id);
  if (!tr) return res.status(404).json({ error: '游客不存在' });
  db.prepare('DELETE FROM tourists WHERE id=?').run(tr.id);
  let released = [];
  const left = db.prepare("SELECT COUNT(*) c FROM tourists WHERE tour_id=? AND status!='已退团'").get(tr.tour_id).c;
  if (left === 0) {
    const pending = db.prepare("SELECT id FROM resource_allocations WHERE tour_id=? AND status='待确认'").all(tr.tour_id);
    pending.forEach(a => { inv.releaseAllocationTxn(a.id, '游客全部退团，待确认占用自动释放'); released.push(a.id); });
  }
  res.json({ ok: true, released });
});

/* ---------------- 计调：航空切位 ---------------- */
router.post('/tours/:id/flights', (req, res) => {
  if (!db.prepare('SELECT id FROM tours WHERE id=?').get(req.params.id)) return res.status(404).json({ error: '团队不存在' });
  const b = req.body;
  if (!b.flight_no || !b.flight_no.trim()) return res.status(400).json({ error: '请填写航班号' });
  if (!(Number(b.seats) > 0)) return res.status(400).json({ error: '切位座位数需大于 0' });
  const info = db.prepare(`INSERT INTO flight_bookings (tour_id, direction, flight_no, flight_date, route, seats, unit_price, confirmed, remarks)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(
    req.params.id, b.direction || '去程', b.flight_no.trim(), b.flight_date || null, b.route || '',
    Number(b.seats), Number(b.unit_price) || 0, b.confirmed ? 1 : 0, b.remarks || ''
  );
  res.json(db.prepare('SELECT * FROM flight_bookings WHERE id=?').get(info.lastInsertRowid));
});

router.put('/flights/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM flight_bookings WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: '记录不存在' });
  if (row.allocation_id) return res.status(409).json({ error: '该切位来自供应商资源池，请通过占用记录修改/释放' });
  simpleUpdate('flight_bookings', req, res,
    ['direction', 'flight_no', 'flight_date', 'route', 'seats', 'unit_price', 'confirmed', 'remarks']);
});
router.delete('/flights/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM flight_bookings WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: '记录不存在' });
  if (row.allocation_id) return res.status(409).json({ error: '该切位来自供应商资源池，请释放对应占用记录' });
  simpleDelete('flight_bookings', req, res);
});

/* ---------------- 计调：酒店控房 ---------------- */
router.post('/tours/:id/hotels', (req, res) => {
  if (!db.prepare('SELECT id FROM tours WHERE id=?').get(req.params.id)) return res.status(404).json({ error: '团队不存在' });
  const b = req.body;
  if (!b.hotel_name || !b.hotel_name.trim()) return res.status(400).json({ error: '请填写酒店名称' });
  if (!(Number(b.rooms) > 0)) return res.status(400).json({ error: '控房间数需大于 0' });
  if (!b.check_in || !b.check_out) return res.status(400).json({ error: '请选择入住/离店日期' });
  if (b.check_out <= b.check_in) return res.status(400).json({ error: '离店日期需晚于入住日期' });
  const info = db.prepare(`INSERT INTO hotel_bookings (tour_id, hotel_name, room_type, rooms, check_in, check_out, night_price, confirmed, remarks)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(
    req.params.id, b.hotel_name.trim(), b.room_type || '标间', Number(b.rooms),
    b.check_in, b.check_out, Number(b.night_price) || 0, b.confirmed ? 1 : 0, b.remarks || ''
  );
  res.json(db.prepare('SELECT * FROM hotel_bookings WHERE id=?').get(info.lastInsertRowid));
});

router.put('/hotels/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM hotel_bookings WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: '记录不存在' });
  if (row.allocation_id) return res.status(409).json({ error: '该控房来自供应商资源池，请通过占用记录修改/释放' });
  simpleUpdate('hotel_bookings', req, res,
    ['hotel_name', 'room_type', 'rooms', 'check_in', 'check_out', 'night_price', 'confirmed', 'remarks']);
});
router.delete('/hotels/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM hotel_bookings WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: '记录不存在' });
  if (row.allocation_id) return res.status(409).json({ error: '该控房来自供应商资源池，请释放对应占用记录' });
  simpleDelete('hotel_bookings', req, res);
});

/* ---------------- 计调：地接社 ---------------- */
router.post('/tours/:id/local-services', (req, res) => {
  if (!db.prepare('SELECT id FROM tours WHERE id=?').get(req.params.id)) return res.status(404).json({ error: '团队不存在' });
  const b = req.body;
  if (!b.agency_name || !b.agency_name.trim()) return res.status(400).json({ error: '请填写地接社名称' });
  const info = db.prepare(`INSERT INTO local_services (tour_id, agency_name, guide_name, guide_phone, vehicle, meals_plan, total_price, confirmed, remarks)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(
    req.params.id, b.agency_name.trim(), b.guide_name || '', b.guide_phone || '',
    b.vehicle || '', b.meals_plan || '', Number(b.total_price) || 0, b.confirmed ? 1 : 0, b.remarks || ''
  );
  res.json(db.prepare('SELECT * FROM local_services WHERE id=?').get(info.lastInsertRowid));
});

router.put('/local-services/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM local_services WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: '记录不存在' });
  if (row.allocation_id) return res.status(409).json({ error: '该地接安排来自供应商资源池，请通过占用记录修改/释放' });
  simpleUpdate('local_services', req, res,
    ['agency_name', 'guide_name', 'guide_phone', 'vehicle', 'meals_plan', 'total_price', 'confirmed', 'remarks']);
});
router.delete('/local-services/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM local_services WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: '记录不存在' });
  if (row.allocation_id) return res.status(409).json({ error: '该地接安排来自供应商资源池，请释放对应占用记录' });
  simpleDelete('local_services', req, res);
});

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

/* ================= 供应商资源池 ================= */

/* ---------- 供应商 ---------- */
router.get('/suppliers', (req, res) => {
  const rows = db.prepare(`
    SELECT s.*, (SELECT COUNT(*) FROM resources r WHERE r.supplier_id=s.id) AS resource_count
    FROM suppliers s ORDER BY s.type, s.id DESC`).all();
  res.json(rows);
});

router.post('/suppliers', (req, res) => {
  const b = req.body;
  if (!b.name || !b.name.trim()) return res.status(400).json({ error: '请填写供应商名称' });
  if (!inv.RESOURCE_TYPES.includes(b.type)) return res.status(400).json({ error: '供应商类型无效' });
  const info = db.prepare(`INSERT INTO suppliers (name, type, contact, phone, status, remarks)
    VALUES (?,?,?,?,?,?)`).run(
    b.name.trim(), b.type, b.contact || '', b.phone || '', b.status || '合作中', b.remarks || '');
  res.json(db.prepare('SELECT * FROM suppliers WHERE id=?').get(info.lastInsertRowid));
});

router.put('/suppliers/:id', (req, res) => {
  const s = db.prepare('SELECT * FROM suppliers WHERE id=?').get(req.params.id);
  if (!s) return res.status(404).json({ error: '供应商不存在' });
  const b = req.body;
  ['name', 'type', 'contact', 'phone', 'status', 'remarks'].forEach(f => { if (b[f] !== undefined) s[f] = b[f]; });
  db.prepare('UPDATE suppliers SET name=?,type=?,contact=?,phone=?,status=?,remarks=? WHERE id=?')
    .run(s.name, s.type, s.contact, s.phone, s.status, s.remarks, s.id);
  res.json(db.prepare('SELECT * FROM suppliers WHERE id=?').get(s.id));
});

router.delete('/suppliers/:id', (req, res) => {
  const id = req.params.id;
  const used = db.prepare('SELECT COUNT(*) c FROM resources WHERE supplier_id=?').get(id).c;
  if (used) return res.status(400).json({ error: `该供应商名下有 ${used} 条采购资源，请先删除资源或将供应商停用` });
  db.prepare('DELETE FROM suppliers WHERE id=?').run(id);
  res.json({ ok: true });
});

/* ---------- 采购资源（库存） ---------- */
router.get('/resources', (req, res) => {
  res.json(inv.listResources(req.query));
});

router.get('/resources/:id', (req, res) => {
  const av = inv.getAvailability(req.params.id);
  if (!av) return res.status(404).json({ error: '资源不存在' });
  const { resource, ...rest } = av;
  const supplier = db.prepare('SELECT * FROM suppliers WHERE id=?').get(resource.supplier_id);
  res.json({ ...resource, supplier, availability: rest });
});

function validateResource(b) {
  if (!inv.RESOURCE_TYPES.includes(b.type)) return '资源类型无效（航班/酒店/地接）';
  if (!b.name || !b.name.trim()) return '请填写资源名称（航班号/酒店名称/地接产品）';
  b.qty = Number(b.qty);
  if (!(b.qty > 0) || !Number.isInteger(b.qty)) return '采购数量需为正整数';
  b.unit_price = Number(b.unit_price) || 0;
  if (b.unit_price < 0) return '采购单价不能为负';
  if (!b.service_date) return '请选择服务日期（航班日期/入住起始日/地接日期）';
  if (b.type === '酒店') {
    if (!b.end_date || b.end_date <= b.service_date) return '酒店资源需填写晚于入住日的离店日期';
  }
  if (!b.supplier_id) return '请选择供应商';
  if (!db.prepare('SELECT id FROM suppliers WHERE id=?').get(b.supplier_id)) return '供应商不存在';
  return null;
}

router.post('/resources', (req, res) => {
  const b = req.body;
  const err = validateResource(b);
  if (err) return res.status(400).json({ error: err });
  const info = db.prepare(`INSERT INTO resources
    (supplier_id, type, name, sub_name, route, direction, service_date, end_date, qty, unit_price, status, remarks)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    b.supplier_id, b.type, b.name.trim(), b.sub_name || '', b.route || '',
    b.direction || '去程', b.service_date, b.type === '酒店' ? b.end_date : null,
    b.qty, b.unit_price, b.status || '在售', b.remarks || '');
  res.json(db.prepare('SELECT * FROM resources WHERE id=?').get(info.lastInsertRowid));
});

router.put('/resources/:id', (req, res) => {
  const r = db.prepare('SELECT * FROM resources WHERE id=?').get(req.params.id);
  if (!r) return res.status(404).json({ error: '资源不存在' });
  const b = req.body;
  // 名称/价格/状态可随时调整；数量与日期收窄前校验已有有效占用，防止把库存改穿
  const next = { ...r, ...b };
  next.qty = Number(next.qty); next.unit_price = Number(next.unit_price) || 0;
  if (!(next.qty > 0) || !Number.isInteger(next.qty)) return res.status(400).json({ error: '采购数量需为正整数' });
  if (next.type === '酒店' && (!next.end_date || next.end_date <= next.service_date)) {
    return res.status(400).json({ error: '酒店资源离店日期需晚于入住日期' });
  }

  const testRow = { ...r, qty: next.qty, service_date: next.service_date, end_date: next.type === '酒店' ? next.end_date : null };
  const allocations = db.prepare(
    "SELECT * FROM resource_allocations WHERE resource_id=? AND status IN ('待确认','已确认')"
  ).all(r.id);
  for (const a of allocations) {
    if (next.type === '酒店') {
      if (a.start_date < next.service_date || (a.end_date || a.start_date) > next.end_date) {
        return res.status(409).json({ error: `占用 #${a.id}（${a.tour_code || a.tour_id}，${a.start_date}~${a.end_date}）超出新的控房区间，请先释放或调整` });
      }
    }
    const conflicts = inv.findConflicts(testRow, a.qty, a.start_date,
      next.type === '酒店' ? a.end_date : null, a.id);
    if (conflicts.length) {
      return res.status(409).json({
        error: inv.buildConflictMessage(testRow, conflicts),
        conflicts, available: Math.min(...conflicts.map(c => c.available))
      });
    }
  }

  db.prepare(`UPDATE resources SET supplier_id=?,name=?,sub_name=?,route=?,direction=?,
    service_date=?,end_date=?,qty=?,unit_price=?,status=?,remarks=? WHERE id=?`).run(
    next.supplier_id, next.name, next.sub_name || '', next.route || '', next.direction || '去程',
    next.service_date, next.type === '酒店' ? next.end_date : null,
    next.qty, next.unit_price, next.status || '在售', next.remarks || '', r.id);

  // 待确认占用联动的计调行单价跟随新采购价；已确认占用保留快照价，调价不影响既有团队毛利
  allocations.filter(a => a.status === '待确认').forEach(a => inv.syncBooking(a.id));

  res.json(db.prepare('SELECT * FROM resources WHERE id=?').get(r.id));
});

router.delete('/resources/:id', (req, res) => {
  const result = handleTxn(res, () => inv.deleteResourceTxn(req.params.id));
  if (result) res.json({ ok: true, ...result });
});

/* ---------- 资源余量 / 占用来源 ---------- */
router.get('/resources/:id/availability', (req, res) => {
  const av = inv.getAvailability(req.params.id);
  if (!av) return res.status(404).json({ error: '资源不存在' });
  res.json(av);
});

/* ---------- 占用（团队计调从资源池占位） ---------- */
router.get('/allocations', (req, res) => {
  const where = [];
  const params = [];
  if (req.query.tour_id) { where.push('a.tour_id=?'); params.push(req.query.tour_id); }
  if (req.query.resource_id) { where.push('a.resource_id=?'); params.push(req.query.resource_id); }
  if (req.query.status) { where.push('a.status=?'); params.push(req.query.status); }
  const rows = db.prepare(`
    SELECT a.*, r.type AS resource_type, r.name AS resource_name, r.sub_name AS resource_sub,
      r.qty AS resource_qty, r.unit_price AS resource_price, r.status AS resource_status,
      s.name AS supplier_name, p.name AS product_name
    FROM resource_allocations a
    JOIN resources r ON r.id=a.resource_id
    JOIN suppliers s ON s.id=r.supplier_id
    JOIN tours t ON t.id=a.tour_id
    JOIN products p ON p.id=t.product_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY a.id DESC`).all(...params);
  res.json(rows);
});

router.post('/allocations', (req, res) => {
  const result = handleTxn(res, () => inv.createAllocationTxn(req.body));
  if (result) res.status(201).json(result.allocation);
});

router.get('/allocations/:id', (req, res) => {
  const a = db.prepare(`
    SELECT a.*, r.type AS resource_type, r.name AS resource_name, r.qty AS resource_qty,
      r.unit_price AS resource_price, s.name AS supplier_name
    FROM resource_allocations a
    JOIN resources r ON r.id=a.resource_id
    JOIN suppliers s ON s.id=r.supplier_id WHERE a.id=?`).get(req.params.id);
  if (!a) return res.status(404).json({ error: '占用记录不存在' });
  res.json(a);
});

router.put('/allocations/:id', (req, res) => {
  const result = handleTxn(res, () => inv.updateAllocationTxn(req.params.id, req.body));
  if (result) res.json(result.allocation);
});

// 确认占用（锁定成本快照）
router.post('/allocations/:id/confirm', (req, res) => {
  const result = handleTxn(res, () => inv.confirmAllocationTxn(req.params.id));
  if (result) res.json(result.allocation);
});

// 释放占用（联动删除计调表行、恢复余量）
router.post('/allocations/:id/release', (req, res) => {
  const result = handleTxn(res, () => inv.releaseAllocationTxn(req.params.id, req.body?.reason || '手工释放'));
  if (result) res.json(result.allocation);
});

function simpleUpdate(table, req, res, fields) {
  const row = db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(req.params.id);
  if (!row) return res.status(404).json({ error: '记录不存在' });
  const b = req.body;
  for (const f of fields) if (b[f] !== undefined) row[f] = b[f];
  if ('confirmed' in row) row.confirmed = b.confirmed ? 1 : 0;
  const setSql = fields.map(f => `${f}=?`).join(',');
  db.prepare(`UPDATE ${table} SET ${setSql} WHERE id=?`).run(...fields.map(f => row[f]), req.params.id);
  res.json(db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(req.params.id));
}
function simpleDelete(table, req, res) {
  db.prepare(`DELETE FROM ${table} WHERE id=?`).run(req.params.id);
  res.json({ ok: true });
}

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
  t.flights = db.prepare('SELECT * FROM flight_bookings WHERE tour_id=?').all(id);
  t.hotels = db.prepare('SELECT * FROM hotel_bookings WHERE tour_id=?').all(id);
  t.local_services = db.prepare('SELECT * FROM local_services WHERE tour_id=?').all(id);
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

module.exports = router;
