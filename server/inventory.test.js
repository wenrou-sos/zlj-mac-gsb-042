// 供应商资源池与库存冲突控制测试
// 运行：npm test（使用独立临时数据库，不影响 data/travel.db）
process.env.TRAVEL_DB_FILE = require('path').join(__dirname, '..', 'tmp-test', 'test.db');

const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');
const Database = require('better-sqlite3');

const testDir = path.join(__dirname, '..', 'tmp-test');
if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
fs.mkdirSync(testDir, { recursive: true });

const db = require('./db');
const inv = require('./inventory');
const { calcFinance } = require('./helpers');

/* ---------- 固定基础数据 ---------- */
function setup() {
  db.exec(`DELETE FROM resource_allocations; DELETE FROM resources; DELETE FROM suppliers;
    DELETE FROM notices; DELETE FROM other_costs; DELETE FROM local_services;
    DELETE FROM hotel_bookings; DELETE FROM flight_bookings; DELETE FROM tourists;
    DELETE FROM tours; DELETE FROM itinerary_days; DELETE FROM products;
    DELETE FROM sqlite_sequence;`);
  db.prepare(`INSERT INTO products (name, days, departure_city, destination, price_double)
    VALUES ('测试线路', 3, '上海', '三亚', 3000)`).run();
  const pid = db.prepare('SELECT id FROM products').get().id;
  const insTour = db.prepare(`INSERT INTO tours (code, product_id, departure_date, return_date, capacity, status)
    VALUES (?,?,?,?,?, '收客中')`);
  const t1 = insTour.run('TEST-001', pid, '2026-10-01', '2026-10-03', 20).lastInsertRowid;
  const t2 = insTour.run('TEST-002', pid, '2026-10-01', '2026-10-03', 20).lastInsertRowid;
  const t3 = insTour.run('TEST-003', pid, '2026-10-01', '2026-10-03', 20).lastInsertRowid;

  const sup = db.prepare("INSERT INTO suppliers (name, type) VALUES ('测试供应商', '酒店')").run().lastInsertRowid;
  const supF = db.prepare("INSERT INTO suppliers (name, type) VALUES ('航司', '航班')").run().lastInsertRowid;
  const supL = db.prepare("INSERT INTO suppliers (name, type) VALUES ('地接社', '地接')").run().lastInsertRowid;

  // 酒店：10/1~10/5，每日 10 间
  const hotel = db.prepare(`INSERT INTO resources (supplier_id, type, name, service_date, end_date, qty, unit_price)
    VALUES (?, '酒店', '测试酒店', '2026-10-01', '2026-10-05', 10, 500)`).run(sup).lastInsertRowid;
  // 航班：100 座
  const flight = db.prepare(`INSERT INTO resources (supplier_id, type, name, service_date, qty, unit_price)
    VALUES (?, '航班', 'CA1234', '2026-10-01', 100, 800)`).run(supF).lastInsertRowid;
  // 地接：同期 2 个团容量
  const local = db.prepare(`INSERT INTO resources (supplier_id, type, name, service_date, qty, unit_price)
    VALUES (?, '地接', '地接打包', '2026-10-01', 2, 5000)`).run(supL).lastInsertRowid;

  return { t1, t2, t3, hotel, flight, local };
}

function conflictErr(f) {
  try { f(); return null; } catch (e) { return e; }
}

/* ================= 1. 基础余量与跨日期逐日控房 ================= */
test('酒店占用按入住日期逐日扣减，跨日期区间每天都校验', () => {
  const { t1, hotel } = setup();
  // t1 占 6 间，10/1~10/3（2 晚）
  inv.createAllocationTxn({ resource_id: hotel, tour_id: t1, qty: 6, start_date: '2026-10-01', end_date: '2026-10-03', create_booking: 0 });
  const av = inv.getAvailability(hotel);
  assert.deepStrictEqual(av.daily.map(d => [d.date, d.held, d.available]), [
    ['2026-10-01', 6, 4],
    ['2026-10-02', 6, 4],
    ['2026-10-03', 0, 10], // 离店日不占房
    ['2026-10-04', 0, 10]
  ]);
  assert.strictEqual(av.available, 4);
});

test('部分重叠日期冲突时返回具体日期与剩余量', () => {
  const { t1, t2, hotel } = setup();
  inv.createAllocationTxn({ resource_id: hotel, tour_id: t1, qty: 6, start_date: '2026-10-01', end_date: '2026-10-04', create_booking: 0 });
  // t2 要 6 间，10/3~10/5：10/1、10/2 不重叠（余10），10/3 仅余 4 → 冲突且必须指出 10/3
  const err = conflictErr(() =>
    inv.createAllocationTxn({ resource_id: hotel, tour_id: t2, qty: 6, start_date: '2026-10-03', end_date: '2026-10-05', create_booking: 0 }));
  assert.ok(err instanceof inv.InventoryError);
  assert.strictEqual(err.status, 409);
  assert.deepStrictEqual(err.details.conflicts.map(c => c.date), ['2026-10-03']);
  assert.strictEqual(err.details.conflicts[0].available, 4);
  assert.strictEqual(err.details.conflicts[0].short, 2);
  assert.match(err.message, /2026-10-03/);
});

test('航班/地接按单服务日校验，超量被拒', () => {
  const { t1, t2, t3, flight, local } = setup();
  const e1 = conflictErr(() => inv.createAllocationTxn({ resource_id: flight, tour_id: t1, qty: 101, create_booking: 0 }));
  assert.ok(e1); assert.strictEqual(e1.details.conflicts[0].available, 100);
  inv.createAllocationTxn({ resource_id: local, tour_id: t1, qty: 1, create_booking: 0 });
  inv.createAllocationTxn({ resource_id: local, tour_id: t2, qty: 1, create_booking: 0 });
  // 容量 2 团，第 3 团被拒
  const e2 = conflictErr(() => inv.createAllocationTxn({ resource_id: local, tour_id: t3, qty: 1, create_booking: 0 }));
  assert.ok(e2);
  assert.strictEqual(e2.details.conflicts[0].available, 0);
});

test('停售资源不能占用；占用日期超出控房区间被拒', () => {
  const { t1, hotel } = setup();
  db.prepare("UPDATE resources SET status='停售' WHERE id=?").run(hotel);
  assert.ok(conflictErr(() => inv.createAllocationTxn({ resource_id: hotel, tour_id: t1, qty: 1, start_date: '2026-10-01', end_date: '2026-10-02', create_booking: 0 })));
  db.prepare("UPDATE resources SET status='在售' WHERE id=?").run(hotel);
  assert.ok(conflictErr(() => inv.createAllocationTxn({ resource_id: hotel, tour_id: t1, qty: 1, start_date: '2026-09-30', end_date: '2026-10-02', create_booking: 0 })));
});

/* ================= 2. 并发占用不超卖（多 worker 进程） ================= */
test('并发：100 座航班，20 个请求各抢 8 座，只能成交 12 笔，绝不超卖', async () => {
  const { flight } = setup();

  const workerPath = path.join(testDir, 'worker.cjs');
  // 先建 10 个团（每个 worker 用独立团）
  const tourIds = [];
  for (let i = 0; i < 20; i++) {
    const id = db.prepare(`INSERT INTO tours (code, product_id, departure_date, capacity, status)
      SELECT 'C-' || ?, id, '2026-10-01', 20, '收客' FROM products LIMIT 1`).run(String(i).padStart(3, '0')).lastInsertRowid;
    tourIds.push(id);
  }

  fs.writeFileSync(workerPath, `
    const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
    process.env.TRAVEL_DB_FILE = ${JSON.stringify(process.env.TRAVEL_DB_FILE)};
    if (!isMainThread) {
      const inv = require(${JSON.stringify(path.join(__dirname, 'inventory.js'))});
      try {
        const a = inv.createAllocationTxn({ resource_id: workerData.resource, tour_id: workerData.tour, qty: 8, create_booking: 0 });
        parentPort.postMessage({ ok: true, id: a.allocation.id });
      } catch (e) {
        parentPort.postMessage({ ok: false, status: e.status, conflicts: e.details && e.details.conflicts });
      }
    }
    module.exports = { Worker };
  `);

  const { Worker } = require(workerPath);
  const results = await Promise.all(tourIds.map((tour, i) => new Promise(resolve => {
    const w = new Worker(workerPath, { workerData: { resource: flight, tour } });
    w.once('message', resolve);
    w.on('error', () => resolve({ ok: false, fatal: true }));
  })));

  const ok = results.filter(r => r.ok);
  const fail = results.filter(r => !r.ok);
  assert.strictEqual(ok.length, 12, '恰好成交 12 笔（96 座）');
  assert.strictEqual(fail.length, 8, '8 笔因库存不足失败');
  assert.deepStrictEqual(fail[0].conflicts[0].available, 4, '冲突返回剩余量 4');

  const held = db.prepare("SELECT COALESCE(SUM(qty),0) s FROM resource_allocations WHERE resource_id=? AND status!='已释放'").get(flight).s;
  assert.strictEqual(held, 96, '有效占用合计 96，不超卖');
  assert.ok(held <= 100);
});

test('并发：酒店 10 间，30 个跨日期请求，每日占用均不超过房量', async () => {
  const { hotel } = setup();
  const tourIds = [];
  for (let i = 0; i < 30; i++) {
    tourIds.push(db.prepare(`INSERT INTO tours (code, product_id, departure_date, capacity, status)
      SELECT 'H-' || ?, id, '2026-10-01', 20, '收客' FROM products LIMIT 1`).run(String(i).padStart(3, '0')).lastInsertRowid);
  }
  const workerPath = path.join(testDir, 'worker-hotel.cjs');
  fs.writeFileSync(workerPath, `
    const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
    process.env.TRAVEL_DB_FILE = ${JSON.stringify(process.env.TRAVEL_DB_FILE)};
    if (!isMainThread) {
      const inv = require(${JSON.stringify(path.join(__dirname, 'inventory.js'))});
      const spans = [
        ['2026-10-01', '2026-10-03'], ['2026-10-02', '2026-10-04'], ['2026-10-03', '2026-10-05']
      ];
      const [s, e] = spans[workerData.i % 3];
      try {
        inv.createAllocationTxn({ resource_id: workerData.resource, tour_id: workerData.tour, qty: 4, start_date: s, end_date: e, create_booking: 0 });
        parentPort.postMessage({ ok: true });
      } catch (err) { parentPort.postMessage({ ok: false }); }
    }
  `);
  const { Worker } = require('worker_threads');
  const results = await Promise.all(tourIds.map((tour, i) => new Promise(resolve => {
    const w = new Worker(workerPath, { workerData: { resource: hotel, tour, i } });
    w.once('message', resolve);
    w.on('error', () => resolve({ ok: false }));
  })));

  const av = inv.getAvailability(hotel);
  for (const d of av.daily) {
    assert.ok(d.held <= 10, `${d.date} 占用 ${d.held} 超过房量 10（超卖）`);
    assert.ok(d.available >= 0);
  }
  assert.ok(results.filter(r => r.ok).length < 30, '必有请求被拒');
});

/* ================= 3. 释放规则 ================= */
test('释放占用后余量恢复且可被其他团重新占用；重复释放幂等', () => {
  const { t1, t2, flight } = setup();
  const a = inv.createAllocationTxn({ resource_id: flight, tour_id: t1, qty: 100, create_booking: 0 }).allocation;
  assert.ok(conflictErr(() => inv.createAllocationTxn({ resource_id: flight, tour_id: t2, qty: 1, create_booking: 0 })));
  inv.releaseAllocationTxn(a.id, '测试释放');
  assert.strictEqual(inv.getAvailability(flight).available, 100);
  inv.createAllocationTxn({ resource_id: flight, tour_id: t2, qty: 100, create_booking: 0 });
  const again = inv.releaseAllocationTxn(a.id); // 幂等
  assert.strictEqual(again.allocation.status, '已释放');
});

test('删除资源时自动释放全部有效占用并联动清理', () => {
  const { t1, t2, flight } = setup();
  inv.createAllocationTxn({ resource_id: flight, tour_id: t1, qty: 30, create_booking: 1 });
  inv.createAllocationTxn({ resource_id: flight, tour_id: t2, qty: 40, create_booking: 1 });
  const r = inv.deleteResourceTxn(flight);
  assert.strictEqual(r.released, 2);
  // 联动计调行已随释放删除
  const bookings = db.prepare("SELECT COUNT(*) c FROM flight_bookings WHERE tour_id IN (?,?) AND flight_no='CA1234'")
    .get(t1, t2).c;
  assert.strictEqual(bookings, 0);
  // 资源与其占用级联清除
  assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM resources WHERE id=?').get(flight).c, 0);
  assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM resource_allocations WHERE resource_id=?').get(flight).c, 0);
});

test('删除团队（取消）时释放全部占用', () => {
  const { t1, flight, hotel } = setup();
  inv.createAllocationTxn({ resource_id: flight, tour_id: t1, qty: 10, create_booking: 0 });
  inv.createAllocationTxn({ resource_id: hotel, tour_id: t1, qty: 5, start_date: '2026-10-01', end_date: '2026-10-02', create_booking: 0 });
  db.prepare('DELETE FROM tours WHERE id=?').run(t1); // ON DELETE CASCADE
  assert.strictEqual(inv.getAvailability(flight).available, 100);
  assert.strictEqual(inv.getAvailability(hotel).available, 10);
});

test('整团退团自动释放待确认占用，已确认占用保留', () => {
  const { t1, flight } = setup();
  const pending = inv.createAllocationTxn({ resource_id: flight, tour_id: t1, qty: 30, create_booking: 0 }).allocation;
  const confirmed = inv.createAllocationTxn({ resource_id: flight, tour_id: t1, qty: 20, create_booking: 0 }).allocation;
  inv.confirmAllocationTxn(confirmed.id);
  db.prepare("INSERT INTO tourists (tour_id, name, id_card, price, status) VALUES (?, '张三', '310101199003074511', 3000, '已报名')").run(t1);
  // 退团
  db.prepare("UPDATE tourists SET status='已退团' WHERE tour_id=?").run(t1);
  const leftPending = db.prepare("SELECT COUNT(*) c FROM tourists WHERE tour_id=? AND status!='已退团'").get(t1).c === 0;
  if (leftPending) inv.releaseAllocationTxn(pending.id, '游客全部退团，待确认占用自动释放');
  assert.strictEqual(db.prepare('SELECT status FROM resource_allocations WHERE id=?').get(pending.id).status, '已释放');
  assert.strictEqual(db.prepare('SELECT status FROM resource_allocations WHERE id=?').get(confirmed.id).status, '已确认');
  assert.strictEqual(inv.getAvailability(flight).available, 80); // 100-20
});

/* ================= 4. 成本快照与毛利保护 ================= */
test('确认时锁定单价快照，供应商后续调价不影响既有团队成本', () => {
  const { t1, hotel, flight } = setup();
  const a = inv.createAllocationTxn({ resource_id: hotel, tour_id: t1, qty: 8, start_date: '2026-10-01', end_date: '2026-10-04', create_booking: 1 }).allocation;
  inv.confirmAllocationTxn(a.id); // 3 晚 × 8 间 × 500 = 12000
  const snap = db.prepare('SELECT price_snapshot, cost_snapshot FROM resource_allocations WHERE id=?').get(a.id);
  assert.strictEqual(snap.price_snapshot, 500);
  assert.strictEqual(snap.cost_snapshot, 12000);

  // 联动的酒店计调行价格随快照
  const booking = db.prepare('SELECT * FROM hotel_bookings WHERE allocation_id=?').get(a.id);
  assert.strictEqual(booking.night_price, 500);

  // 供应商涨价
  db.prepare('UPDATE resources SET unit_price=900, qty=20 WHERE id=?').run(hotel);
  inv.syncBooking(a.id);
  const bookingAfter = db.prepare('SELECT night_price FROM hotel_bookings WHERE allocation_id=?').get(a.id);
  assert.strictEqual(bookingAfter.night_price, 500, '计调行保持快照价');
  const f = calcFinance(db, t1);
  assert.strictEqual(f.costs.hotel, 12000, '既有团队酒店成本不受调价影响');

  // 新团占用按新价，确认后快照 900
  const { t2 } = { t2: db.prepare("SELECT id FROM tours WHERE code='TEST-002'").get().id };
  const b = inv.createAllocationTxn({ resource_id: hotel, tour_id: t2, qty: 2, start_date: '2026-10-01', end_date: '2026-10-02', create_booking: 1 }).allocation;
  const pendingBooking = db.prepare('SELECT night_price FROM hotel_bookings WHERE allocation_id=?').get(b.id);
  assert.strictEqual(pendingBooking.night_price, 900, '待确认占用跟随当前采购价');
  inv.confirmAllocationTxn(b.id);
  assert.strictEqual(db.prepare('SELECT price_snapshot FROM resource_allocations WHERE id=?').get(b.id).price_snapshot, 900);
});

test('待确认占用改价后联动计调行跟随；释放删除联动计调行', () => {
  const { t1, flight } = setup();
  const a = inv.createAllocationTxn({ resource_id: flight, tour_id: t1, qty: 10, create_booking: 1 }).allocation;
  let row = db.prepare('SELECT unit_price FROM flight_bookings WHERE allocation_id=?').get(a.id);
  assert.strictEqual(row.unit_price, 800);
  db.prepare('UPDATE resources SET unit_price=850 WHERE id=?').run(flight);
  inv.syncBooking(a.id);
  row = db.prepare('SELECT unit_price FROM flight_bookings WHERE allocation_id=?').get(a.id);
  assert.strictEqual(row.unit_price, 850);
  inv.releaseAllocationTxn(a.id);
  assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM flight_bookings WHERE allocation_id=?').get(a.id).c, 0);
});

test('已确认占用不能修改数量/日期；待确认修改重新校验冲突', () => {
  const { t1, t2, flight } = setup();
  const a = inv.createAllocationTxn({ resource_id: flight, tour_id: t1, qty: 50, create_booking: 0 }).allocation;
  inv.confirmAllocationTxn(a.id);
  assert.ok(conflictErr(() => inv.updateAllocationTxn(a.id, { qty: 60 })));

  const b = inv.createAllocationTxn({ resource_id: flight, tour_id: t2, qty: 40, create_booking: 0 }).allocation;
  // 40 + 50 = 90 ≤ 100 可改；改成 51 → 101 超卖
  assert.ok(!conflictErr(() => inv.updateAllocationTxn(b.id, { qty: 50 })));
  assert.ok(conflictErr(() => inv.updateAllocationTxn(b.id, { qty: 51 })));
});

test('手工计调记录（无 allocation_id）保持兼容，不受资源池约束', () => {
  const { t1 } = setup();
  db.prepare(`INSERT INTO flight_bookings (tour_id, direction, flight_no, flight_date, seats, unit_price, confirmed)
    VALUES (?, '去程', 'MANUAL', '2026-11-11', 999, 100, 0)`).run(t1);
  const row = db.prepare("SELECT * FROM flight_bookings WHERE flight_no='MANUAL'").get();
  assert.strictEqual(row.allocation_id, null);
  const f = calcFinance(db, t1);
  assert.strictEqual(f.costs.flight, 99900);
});

/* ================= 5. 资源收缩保护 ================= */
test('资源调减数量导致已超量时，PUT 校验返回冲突与余量', () => {
  const { t1, flight } = setup();
  inv.createAllocationTxn({ resource_id: flight, tour_id: t1, qty: 80, create_booking: 0 });
  const testRow = { ...db.prepare('SELECT * FROM resources WHERE id=?').get(flight), qty: 50 };
  const alloc = db.prepare("SELECT * FROM resource_allocations WHERE resource_id=? AND status!='已释放'").all(flight)[0];
  const conflicts = inv.findConflicts(testRow, alloc.qty, alloc.start_date, null, alloc.id);
  assert.strictEqual(conflicts[0].available, 50);
  assert.strictEqual(conflicts[0].short, 30);
});
