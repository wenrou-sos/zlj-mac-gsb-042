// 供应商资源池与库存冲突控制核心逻辑
// 所有写操作均在 better-sqlite3 事务内执行；SQLite 单写者 + BEGIN IMMEDIATE
// 保证并发请求串行化提交，配合行级余量校验杜绝超卖。
const db = require('./db');
const { nightsBetween, round2 } = require('./helpers');

const RESOURCE_TYPES = ['航班', '酒店', '地接'];
const ALLOC_STATUSES = ['待确认', '已确认', '已释放'];
const ACTIVE_STATUS = ['待确认', '已确认'];
const BOOKING_TABLE = { 航班: 'flight_bookings', 酒店: 'hotel_bookings', 地接: 'local_services' };

// BEGIN IMMEDIATE：事务开启即取写锁，跨进程的并发请求在 busy_timeout 内排队，
// 串行化提交，避免双读余量后双写导致超卖。
const immediateTxn = (fn) => {
  const t = db.transaction(fn);
  return (...args) => t.immediate(...args);
};

class InventoryError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.status = 409;
    this.details = details;
  }
}

function dateList(start, end) {
  // 酒店占用：入住日 start（含）至离店日 end（不含），逐日一行
  const out = [];
  let d = new Date(start + 'T00:00:00');
  const e = new Date(end + 'T00:00:00');
  while (d < e) {
    out.push(d.toISOString().slice(0, 10));
    d.setDate(d.getDate() + 1);
  }
  return out;
}

function allocationNights(a) {
  return a.end_date ? dateList(a.start_date, a.end_date) : [a.start_date];
}

/* ---------------- 余量计算 ---------------- */

// 计算单个资源在各服务日上的：采购量、有效占用、待确认、已确认、余量、占用来源
function getAvailability(resourceId, tx = db) {
  const r = tx.prepare('SELECT * FROM resources WHERE id=?').get(resourceId);
  if (!r) return null;
  const allocs = tx.prepare(
    `SELECT a.*, t.code AS tour_code, p.name AS tour_name
     FROM resource_allocations a
     JOIN tours t ON t.id = a.tour_id
     JOIN products p ON p.id = t.product_id
     WHERE a.resource_id=? AND a.status IN ('待确认','已确认')
     ORDER BY a.status DESC, a.id`
  ).all(resourceId);

  const sources = [];
  const totals = { 待确认: 0, 已确认: 0 };

  if (r.type === '酒店') {
    const days = dateList(r.service_date, r.end_date).map(date => ({
      date, qty: r.qty, held: 0, pending: 0, confirmed: 0, sources: []
    }));
    const byDate = new Map(days.map(d => [d.date, d]));
    for (const a of allocs) {
      const nights = allocationNights(a);
      let touches = false;
      for (const date of nights) {
        const day = byDate.get(date);
        if (!day) continue;
        touches = true;
        day.held += a.qty;
        day[a.status === '已确认' ? 'confirmed' : 'pending'] += a.qty;
        day.sources.push({
          allocation_id: a.id, tour_id: a.tour_id, tour_code: a.tour_code,
          tour_name: a.tour_name, qty: a.qty, status: a.status, date
        });
      }
      if (touches) {
        totals[a.status] += a.qty;
        sources.push({
          allocation_id: a.id, tour_id: a.tour_id, tour_code: a.tour_code,
          tour_name: a.tour_name, qty: a.qty, status: a.status,
          start_date: a.start_date, end_date: a.end_date
        });
      }
    }
    const minAvailable = days.reduce((m, d) => Math.min(m, r.qty - d.held), Infinity);
    return {
      resource: r,
      daily: days.map(d => ({ ...d, available: r.qty - d.held })),
      available: days.length ? minAvailable : r.qty,
      held: days.reduce((m, d) => Math.max(m, d.held), 0),
      pending: totals['待确认'],
      confirmed: totals['已确认'],
      sources
    };
  }

  // 航班 / 地接：按单一服务日校验
  const held = allocs.reduce((s, a) => s + a.qty, 0);
  return {
    resource: r,
    daily: [{
      date: r.service_date, qty: r.qty, held,
      pending: allocs.filter(a => a.status === '待确认').reduce((s, a) => s + a.qty, 0),
      confirmed: allocs.filter(a => a.status === '已确认').reduce((s, a) => s + a.qty, 0),
      available: r.qty - held,
      sources: allocs.map(a => ({
        allocation_id: a.id, tour_id: a.tour_id, tour_code: a.tour_code,
        tour_name: a.tour_name, qty: a.qty, status: a.status, date: r.service_date
      }))
    }],
    available: r.qty - held,
    held,
    pending: allocs.filter(a => a.status === '待确认').reduce((s, a) => s + a.qty, 0),
    confirmed: allocs.filter(a => a.status === '已确认').reduce((s, a) => s + a.qty, 0),
    sources: allocs.map(a => ({
      allocation_id: a.id, tour_id: a.tour_id, tour_code: a.tour_code,
      tour_name: a.tour_name, qty: a.qty, status: a.status
    }))
  };
}

// 冲突检测：忽略 excludeAllocId，检查给定数量在目标日期上是否可占用
function findConflicts(resource, qty, startDate, endDate, excludeAllocId = null, tx = db) {
  const dates = resource.type === '酒店' ? dateList(startDate, endDate) : [startDate];
  const placeholders = excludeAllocId ? "AND a.id != ?" : '';
  const params = excludeAllocId ? [resource.id, excludeAllocId] : [resource.id];
  const allocs = tx.prepare(
    `SELECT a.* FROM resource_allocations a
     WHERE a.resource_id=? AND a.status IN ('待确认','已确认') ${placeholders}`
  ).all(...params);

  const conflicts = [];
  for (const date of dates) {
    const held = allocs.reduce((s, a) => {
      const aDates = allocationNights(a);
      return aDates.includes(date) ? s + a.qty : s;
    }, 0);
    const available = resource.qty - held;
    if (qty > available) {
      conflicts.push({ date, qty: resource.qty, held, available, short: qty - available });
    }
  }
  return conflicts;
}

/* ---------------- 占用状态流转 ---------------- */

function _loadAlloc(id, tx) {
  return tx.prepare(`
    SELECT a.*, r.type AS resource_type, r.status AS resource_status,
      r.qty AS resource_qty, r.unit_price AS current_price, r.name AS resource_name,
      t.code AS tour_code, p.name AS tour_name
    FROM resource_allocations a
    JOIN resources r ON r.id = a.resource_id
    JOIN tours t ON t.id = a.tour_id
    JOIN products p ON p.id = t.product_id
    WHERE a.id=?`).get(id);
}

// 创建占用（待确认），可联动生成手工计调记录
const createAllocationTxn = immediateTxn((opts) => {
  const { resource_id, tour_id, qty, start_date, end_date, remarks, create_booking = 1 } = opts;
  const resource = db.prepare('SELECT * FROM resources WHERE id=?').get(resource_id);
  if (!resource) throw new InventoryError('资源不存在');
  if (resource.status !== '在售') throw new InventoryError(`资源「${resource.name}」已停售，不能占用`);
  const tour = db.prepare('SELECT id FROM tours WHERE id=?').get(tour_id);
  if (!tour) throw new InventoryError('团队不存在');
  const n = Number(qty);
  if (!(n > 0) || !Number.isInteger(n)) throw new InventoryError('占用数量必须为正整数');

  const sDate = start_date || resource.service_date;
  const eDate = resource.type === '酒店' ? (end_date || resource.end_date) : null;
  if (!sDate) throw new InventoryError('请指定占用日期');
  if (resource.type === '酒店') {
    if (!eDate || eDate <= sDate) throw new InventoryError('酒店占用离店日期需晚于入住日期');
    if (sDate < resource.service_date || eDate > resource.end_date) {
      throw new InventoryError(`占用日期需落在资源控房区间 ${resource.service_date} ~ ${resource.end_date} 内`);
    }
  } else if (sDate !== resource.service_date) {
    throw new InventoryError(`该资源服务日期为 ${resource.service_date}，不能占用其他日期`);
  }

  const conflicts = findConflicts(resource, n, sDate, eDate, null, db);
  if (conflicts.length) {
    throw new InventoryError(buildConflictMessage(resource, conflicts), {
      conflicts,
      available: getAvailability(resource_id, db).available,
      resource_id
    });
  }

  const tourRow = db.prepare(`SELECT t.code, p.name AS product_name
    FROM tours t JOIN products p ON p.id=t.product_id WHERE t.id=?`).get(tour_id);
  const info = db.prepare(`INSERT INTO resource_allocations
    (resource_id, tour_id, qty, start_date, end_date, status, price_snapshot, remarks,
     tour_code, tour_name, booking_table)
    VALUES (?,?,?,?,?,'待确认',?,?,?,?,?)`)
    .run(resource_id, tour_id, n, sDate, eDate, resource.unit_price, remarks || '',
      tourRow.code, tourRow.product_name, create_booking ? BOOKING_TABLE[resource.type] : '');

  const allocId = info.lastInsertRowid;
  let booking = null;
  if (create_booking) booking = syncBooking(allocId, db);
  return { allocation: _loadAlloc(allocId, db), booking };
});

// 修改占用（数量/日期；仅待确认可改；重新做冲突校验）
const updateAllocationTxn = immediateTxn((id, patch) => {
  const alloc = _loadAlloc(id, db);
  if (!alloc) throw new InventoryError('占用记录不存在');
  if (alloc.status === '已释放') throw new InventoryError('占用已释放，不能修改（请重新占用）');
  if (alloc.status === '已确认') {
    // 已确认仅允许改备注；数量/日期变更必须先释放再重新占用
    if (patch.qty !== undefined || patch.start_date !== undefined || patch.end_date !== undefined) {
      throw new InventoryError('占用已确认并锁定成本快照，不能直接改数量/日期，请先释放后重新占用');
    }
  }
  const resource = db.prepare('SELECT * FROM resources WHERE id=?').get(alloc.resource_id);
  const qty = patch.qty !== undefined ? Number(patch.qty) : alloc.qty;
  if (!(qty > 0) || !Number.isInteger(qty)) throw new InventoryError('占用数量必须为正整数');
  const startDate = patch.start_date || alloc.start_date;
  const endDate = resource.type === '酒店' ? (patch.end_date || alloc.end_date) : null;

  const conflicts = findConflicts(resource, qty, startDate, endDate, alloc.id, db);
  if (conflicts.length) {
    throw new InventoryError(buildConflictMessage(resource, conflicts), {
      conflicts,
      available: getAvailability(resource.id, db).available,
      resource_id: resource.id
    });
  }

  db.prepare('UPDATE resource_allocations SET qty=?, start_date=?, end_date=?, remarks=? WHERE id=?')
    .run(qty, startDate, endDate,
      patch.remarks !== undefined ? patch.remarks : alloc.remarks, id);

  let booking = null;
  if (alloc.booking_id) booking = syncBooking(id, db);
  return { allocation: _loadAlloc(id, db), booking };
});

// 确认占用：锁定成本快照（单价取确认时资源价，此后调价不影响本团毛利）
const confirmAllocationTxn = immediateTxn((id) => {
  const alloc = _loadAlloc(id, db);
  if (!alloc) throw new InventoryError('占用记录不存在');
  if (alloc.status === '已确认') return { allocation: alloc, unchanged: true };
  if (alloc.status === '已释放') throw new InventoryError('占用已释放，不能确认');
  const resource = db.prepare('SELECT * FROM resources WHERE id=?').get(alloc.resource_id);

  // 确认前再次校验余量（待确认期间可能有其他团队占用）
  const conflicts = findConflicts(resource, alloc.qty, alloc.start_date, alloc.end_date, alloc.id, db);
  if (conflicts.length) {
    throw new InventoryError(buildConflictMessage(resource, conflicts), {
      conflicts,
      available: getAvailability(resource.id, db).available,
      resource_id: resource.id
    });
  }

  const unit = resource.unit_price;
  const multiplier = resource.type === '酒店' ? nightsBetween(alloc.start_date, alloc.end_date) : 1;
  const cost = round2(alloc.qty * unit * multiplier);
  db.prepare(`UPDATE resource_allocations
    SET status='已确认', price_snapshot=?, cost_snapshot=?, confirmed_at=datetime('now','localtime')
    WHERE id=?`).run(unit, cost, id);

  let booking = null;
  if (alloc.booking_id) {
    booking = syncBooking(id, db);
    db.prepare(`UPDATE ${BOOKING_TABLE[resource.type]} SET confirmed=1 WHERE id=?`).run(alloc.booking_id);
  }
  return { allocation: _loadAlloc(id, db), booking };
});

// 释放占用（退团 / 删除资源 / 取消团队 / 手工释放），联动删除或复位计调记录
const releaseAllocationTxn = immediateTxn((id, reason = '手工释放') => {
  const alloc = _loadAlloc(id, db);
  if (!alloc) throw new InventoryError('占用记录不存在');
  if (alloc.status === '已释放') return { allocation: alloc, unchanged: true };

  if (alloc.booking_id && alloc.booking_table) {
    db.prepare(`DELETE FROM ${alloc.booking_table} WHERE id=?`).run(alloc.booking_id);
  }
  const reasonNote = `${alloc.remarks ? alloc.remarks + '｜' : ''}释放原因：${reason}`;
  db.prepare(`UPDATE resource_allocations
    SET status='已释放', released_at=datetime('now','localtime'), remarks=? WHERE id=?`)
    .run(reasonNote, id);
  return { allocation: _loadAlloc(id, db) };
});

/* ---------------- 计调记录联动 ---------------- */

// 依据占用+资源的当前主数据，upsert 对应计调表行；已确认占用写入快照价
function syncBooking(allocId, tx = db) {
  const a = tx.prepare(`
    SELECT a.*, r.type, r.name, r.sub_name, r.route, r.direction, r.supplier_id,
           r.unit_price AS resource_price,
           s.name AS supplier_name
    FROM resource_allocations a
    JOIN resources r ON r.id = a.resource_id
    JOIN suppliers s ON s.id = r.supplier_id
    WHERE a.id=?`).get(allocId);
  // 已确认：使用锁定的成本快照价；待确认：跟随资源当前采购价
  const price = a.status === '已确认' ? r2(a.price_snapshot) : r2(a.resource_price);
  const released = a.status === '已释放';

  if (a.type === '航班') {
    const row = {
      tour_id: a.tour_id, direction: a.direction || '去程', flight_no: a.name,
      flight_date: a.start_date, route: a.route || a.supplier_name,
      seats: a.qty, unit_price: price,
      confirmed: a.status === '已确认' ? 1 : 0,
      remarks: bookingRemarks(a), allocation_id: a.id
    };
    return upsertBooking(tx, 'flight_bookings', a.booking_id, row, released);
  }
  if (a.type === '酒店') {
    const row = {
      tour_id: a.tour_id, hotel_name: a.name, room_type: a.sub_name || '标间',
      rooms: a.qty, check_in: a.start_date, check_out: a.end_date,
      night_price: price, confirmed: a.status === '已确认' ? 1 : 0,
      remarks: bookingRemarks(a), allocation_id: a.id
    };
    return upsertBooking(tx, 'hotel_bookings', a.booking_id, row, released);
  }
  // 地接
  const row = {
    tour_id: a.tour_id, agency_name: a.supplier_name,
    guide_name: '', guide_phone: '', vehicle: a.route || '', meals_plan: '',
    total_price: round2(a.qty * price), confirmed: a.status === '已确认' ? 1 : 0,
    remarks: bookingRemarks(a), allocation_id: a.id
  };
  return upsertBooking(tx, 'local_services', a.booking_id, row, released);
}

function r2(n) { return Math.round((Number(n) || 0) * 100) / 100; }

function bookingRemarks(a) {
  const tag = `资源池#${a.resource_id} ${a.supplier_name ? '·' + a.supplier_name : ''}`;
  const snap = a.status === '已确认' ? `｜✔成本快照已锁定 ¥${a.price_snapshot}` : '';
  return `${tag}${snap}${a.remarks ? '｜' + a.remarks : ''}`;
}

function upsertBooking(tx, table, bookingId, row, released) {
  const cols = Object.keys(row);
  if (bookingId) {
    const exists = tx.prepare(`SELECT id FROM ${table} WHERE id=?`).get(bookingId);
    if (exists) {
      const setSql = cols.map(c => `${c}=?`).join(',');
      tx.prepare(`UPDATE ${table} SET ${setSql} WHERE id=?`)
        .run(...cols.map(c => row[c]), bookingId);
      const out = tx.prepare(`SELECT * FROM ${table} WHERE id=?`).get(bookingId);
      if (released) tx.prepare(`DELETE FROM ${table} WHERE id=?`).run(bookingId);
      return out;
    }
  }
  const info = tx.prepare(`INSERT INTO ${table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`)
    .run(...cols.map(c => row[c]));
  tx.prepare('UPDATE resource_allocations SET booking_id=?, booking_table=? WHERE id=?')
    .run(info.lastInsertRowid, table, row.allocation_id);
  return tx.prepare(`SELECT * FROM ${table} WHERE id=?`).get(info.lastInsertRowid);
}

/* ---------------- 手工计调记录兼容处理 ---------------- */
// 手工创建/编辑的计调行（无 allocation_id）不做库存校验，保持既有行为；
// 只有当该行显式带上 resource_id 时才纳入资源池占用体系。
function bookingFromPool(tx, table, bookingId) {
  if (!bookingId) return null;
  const row = tx.prepare(`SELECT * FROM ${table} WHERE id=?`).get(bookingId);
  if (!row || !row.allocation_id) return null;
  return tx.prepare('SELECT * FROM resource_allocations WHERE id=?').get(row.allocation_id);
}

function buildConflictMessage(resource, conflicts) {
  const where = conflicts.map(c =>
    `${c.date}（余量 ${c.available}/${resource.qty}，缺 ${c.short}）`
  ).join('、');
  return `「${resource.name}」库存冲突：${where}`;
}

/* ---------------- 查询辅助 ---------------- */

function listResources(filter = {}) {
  const where = [];
  const params = [];
  if (filter.type) { where.push('r.type=?'); params.push(filter.type); }
  if (filter.supplier_id) { where.push('r.supplier_id=?'); params.push(filter.supplier_id); }
  if (filter.status) { where.push('r.status=?'); params.push(filter.status); }
  if (filter.q) {
    where.push('(r.name LIKE ? OR s.name LIKE ?)');
    params.push(`%${filter.q}%`, `%${filter.q}%`);
  }
  const rows = db.prepare(`
    SELECT r.*, s.name AS supplier_name, s.contact AS supplier_contact, s.phone AS supplier_phone
    FROM resources r JOIN suppliers s ON s.id = r.supplier_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY r.type, r.service_date, r.id DESC`).all(...params);
  return rows.map(r => {
    const av = getAvailability(r.id);
    const { resource, ...rest } = av;
    return { ...r, availability: rest };
  });
}

// 删除资源：释放全部有效占用（事务内）
const deleteResourceTxn = immediateTxn((id) => {
  const r = db.prepare('SELECT * FROM resources WHERE id=?').get(id);
  if (!r) throw new InventoryError('资源不存在');
  const active = db.prepare(
    "SELECT id FROM resource_allocations WHERE resource_id=? AND status IN ('待确认','已确认')"
  ).all(id);
  for (const a of active) releaseAllocationTxn(a.id, '资源删除，库存释放');
  db.prepare('DELETE FROM resources WHERE id=?').run(id);
  return { released: active.length };
});

module.exports = {
  RESOURCE_TYPES, ALLOC_STATUSES, ACTIVE_STATUS, BOOKING_TABLE,
  InventoryError, dateList, getAvailability, findConflicts,
  createAllocationTxn, updateAllocationTxn, confirmAllocationTxn, releaseAllocationTxn,
  syncBooking, bookingFromPool, listResources, deleteResourceTxn, buildConflictMessage
};
