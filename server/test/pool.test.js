/* 资源池与库存冲突控制 —— 集成测试
 * 运行：npm test   （node --test，自动使用临时 SQLite 库，不影响开发数据）
 * 覆盖：并发占用防超卖、酒店跨日期逐日控房、释放/重新占用、取消团队释放、
 *       成本快照（确认后供应商调价不影响毛利）、资源删除规则、手工计调兼容。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const TMP_DB = path.join(os.tmpdir(), `travel-pool-test-${process.pid}.db`);
for (const f of [TMP_DB, TMP_DB + '-wal', TMP_DB + '-shm']) { try { fs.rmSync(f); } catch {} }
process.env.TRAVEL_DB_PATH = TMP_DB;

const { app } = require('../index');
const db = require('../db');

let server, base;

test.before(async () => {
  await new Promise(resolve => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}/api`;
});
test.after(() => { server.close(); for (const f of [TMP_DB, TMP_DB + '-wal', TMP_DB + '-shm']) { try { fs.rmSync(f); } catch {} } });

async function call(method, p, body) {
  const res = await fetch(base + p, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, body: json };
}
const get = p => call('GET', p);
const post = (p, b) => call('POST', p, b);
const put = (p, b) => call('PUT', p, b);
const del = p => call('DELETE', p);

/* ---------------- 基础数据 ---------------- */
async function seedFixture() {
  const tag = Math.random().toString(36).slice(2, 8);
  const su = (await post('/suppliers', { name: '测试供应商' + tag, type: '综合' })).body.id;
  const product = (await post('/products', {
    name: '测试线路' + tag, days: 3, departure_city: '上海', destination: '测试地',
    price_double: 1000, price_triple: 900, price_child: 800
  })).body.id;
  const tour = (await post('/tours', { product_id: product, departure_date: '2026-11-01', return_date: '2026-11-04', capacity: 50, code: 'T' + tag })).body.id;
  const tour2 = (await post('/tours', { product_id: product, departure_date: '2026-11-01', return_date: '2026-11-04', capacity: 50, code: 'T' + tag + 'B' })).body.id;
  return { su, product, tour, tour2, tag, hotel: '酒店' + tag };
}
async function flightResource(su, date, qty, price) {
  return (await post('/resources', { supplier_id: su, type: 'flight', date, flight_no: 'CA' + Math.floor(Math.random() * 9000 + 1000), route: 'A → B', quantity: qty, unit_price: price })).body.id;
}
async function hotelResource(su, date, qty, price, name, room = '标间') {
  return (await post('/resources', { supplier_id: su, type: 'hotel', date, hotel_name: name, room_type: room, quantity: qty, unit_price: price })).body.id;
}

/* ---------------- 测试 ---------------- */

test('并发占用同一航班：总量受限，绝不超卖（失败方返回剩余量）', async () => {
  const { su, tour, tour2 } = await seedFixture();
  const rid = await flightResource(su, '2026-11-01', 10, 600);

  const [r1, r2] = await Promise.all([
    post(`/tours/${tour}/flights`, { direction: '去程', seats: 6, resource_id: rid }),
    post(`/tours/${tour2}/flights`, { direction: '去程', seats: 6, resource_id: rid })
  ]);
  const ok = [r1, r2].filter(r => r.status === 200);
  const fail = [r1, r2].filter(r => r.status !== 200);
  assert.equal(ok.length, 1, '恰好一个请求成功');
  assert.equal(fail.length, 1, '恰好一个请求失败');
  assert.equal(fail[0].status, 409);
  assert.equal(fail[0].body.conflicts[0].remaining, 4, '返回剩余可用 4');
  assert.match(fail[0].body.error, /现余 4/);

  const detail = await get('/resources/' + rid);
  assert.equal(detail.body.held, 6);
  assert.equal(detail.body.available, 4, '资源余量正确');
});

test('酒店跨日期控房：逐日校验，冲突时返回具体日期与剩余量', async () => {
  const { su, tour, tour2, hotel } = await seedFixture();
  // 三晚房量分别为 5 / 2 / 5
  await hotelResource(su, '2026-11-01', 5, 300, hotel);
  await hotelResource(su, '2026-11-02', 2, 300, hotel);
  await hotelResource(su, '2026-11-03', 5, 300, hotel);
  const firstNightId = (await get('/resources?type=hotel')).body.find(x => x.date === '2026-11-01' && x.hotel_name === hotel).id;

  // 团队1 控 3 间 × 3 晚：中间晚仅 2 间，应整体失败且指出 11-02 余 2
  const r = await post(`/tours/${tour}/hotels`, {
    hotel_name: hotel, room_type: '标间', rooms: 3,
    check_in: '2026-11-01', check_out: '2026-11-04', resource_id: firstNightId
  });
  assert.equal(r.status, 409);
  assert.equal(r.body.conflicts.length, 1);
  assert.equal(r.body.conflicts[0].date, '2026-11-02');
  assert.equal(r.body.conflicts[0].remaining, 2);
  assert.match(r.body.error, /2026-11-02/);

  // 团队1 控 2 间 × 3 晚：成功（每晚均 ≤ 房量），资源池占用逐晚写入
  const ok = await post(`/tours/${tour}/hotels`, {
    hotel_name: hotel, room_type: '标间', rooms: 2,
    check_in: '2026-11-01', check_out: '2026-11-04', resource_id: firstNightId, night_price: 300
  });
  assert.equal(ok.status, 200);
  assert.ok(ok.body.resource_id, '首晚资源锚点已保存');

  // 修改（不带 resource_id 也保持池关联）
  const putOk = await put('/hotels/' + ok.body.id, {
    hotel_name: hotel, room_type: '标间', rooms: 2,
    check_in: '2026-11-01', check_out: '2026-11-04', night_price: 300
  });
  assert.equal(putOk.status, 200);

  // 团队2 想加占 4 间：首/尾晚余 3、中间晚余 0 → 三晚全部冲突，返回逐日剩余量
  const overlap = await post(`/tours/${tour2}/hotels`, {
    hotel_name: hotel, room_type: '标间', rooms: 4,
    check_in: '2026-11-01', check_out: '2026-11-04', resource_id: firstNightId
  });
  assert.equal(overlap.status, 409);
  const byDate = Object.fromEntries(overlap.body.conflicts.map(c => [c.date, c.remaining]));
  assert.deepEqual(byDate, { '2026-11-01': 3, '2026-11-02': 0, '2026-11-03': 3 }, '返回每个冲突日期的剩余量');
});

test('释放与重新占用：释放后余量恢复，可再被其他团队占用', async () => {
  const { su, tour, tour2 } = await seedFixture();
  const rid = await flightResource(su, '2026-11-01', 8, 600);
  const b = (await post(`/tours/${tour}/flights`, { seats: 8, resource_id: rid })).body;
  assert.equal((await get('/resources/' + rid)).body.available, 0);

  // 满库存时他团占用失败
  const blocked = await post(`/tours/${tour2}/flights`, { seats: 1, resource_id: rid });
  assert.equal(blocked.status, 409);

  const rel = await post(`/flights/${b.id}/release`);
  assert.equal(rel.status, 200);
  assert.equal((await get('/resources/' + rid)).body.available, 8, '释放后余量恢复');

  const again = await post(`/tours/${tour2}/flights`, { seats: 8, resource_id: rid });
  assert.equal(again.status, 200, '释放后他团可占用');

  // 原记录重新占用 → 库存不足失败（不超卖）
  const reBlocked = await post(`/flights/${b.id}/reoccupy`);
  assert.equal(reBlocked.status, 409);

  // 他团释放后，原记录可重新占用
  await post(`/flights/${again.body.id}/release`);
  const reOk = await post(`/flights/${b.id}/reoccupy`);
  assert.equal(reOk.status, 200);
  assert.equal((await get('/resources/' + rid)).body.available, 0);
});

test('酒店缩短日期：多余晚数自动释放；删除记录释放全部库存', async () => {
  const { su, tour, hotel } = await seedFixture();
  await hotelResource(su, '2026-11-01', 5, 300, hotel);
  await hotelResource(su, '2026-11-02', 5, 300, hotel);
  await hotelResource(su, '2026-11-03', 5, 300, hotel);
  const firstNightId = (await get('/resources?type=hotel')).body.find(x => x.date === '2026-11-01' && x.hotel_name === hotel).id;
  const b = (await post(`/tours/${tour}/hotels`, {
    hotel_name: hotel, room_type: '标间', rooms: 5,
    check_in: '2026-11-01', check_out: '2026-11-04', night_price: 300, resource_id: firstNightId
  })).body;

  const held = date => db.prepare(
    "SELECT COALESCE(SUM(o.quantity),0) h FROM resource_occupancies o JOIN resources r ON r.id=o.resource_id WHERE r.type='hotel' AND r.hotel_name=? AND r.date=? AND o.status IN ('待确认','已确认')"
  ).get(hotel, date).h;
  assert.equal(held('2026-11-01'), 5);
  assert.equal(held('2026-11-02'), 5);
  assert.equal(held('2026-11-03'), 5);

  // 缩短为只住第一晚
  const upd = await put('/hotels/' + b.id, {
    hotel_name: hotel, room_type: '标间', rooms: 5,
    check_in: '2026-11-01', check_out: '2026-11-02', night_price: 300
  });
  assert.equal(upd.status, 200);
  assert.equal(held('2026-11-01'), 5);
  assert.equal(held('2026-11-02'), 0, '后两晚已释放');
  assert.equal(held('2026-11-03'), 0);

  // 删除控房记录 → 全部释放
  await del('/hotels/' + b.id);
  assert.equal(held('2026-11-01'), 0);
});

test('成本快照：确认后供应商涨价不影响已确认团队毛利，待确认占用跟随新价', async () => {
  const { su, tour, tour2 } = await seedFixture();
  const rid = await flightResource(su, '2026-11-01', 30, 600);
  const b1 = (await post(`/tours/${tour}/flights`, { seats: 10, resource_id: rid, unit_price: 600 })).body;
  const b2 = (await post(`/tours/${tour2}/flights`, { seats: 10, resource_id: rid, unit_price: 600 })).body;

  // 团队1 确认 → 锁定 600 快照
  const conf = await put('/flights/' + b1.id, { confirmed: true });
  assert.equal(conf.status, 200);
  const f1Before = (await get('/tours/' + tour)).body.finance;
  assert.equal(f1Before.costs.flight, 6000);

  // 供应商涨价 600 → 750
  const priceUpd = await put('/resources/' + rid, { unit_price: 750 });
  assert.equal(priceUpd.status, 200);

  const f1After = (await get('/tours/' + tour)).body.finance;
  assert.equal(f1After.costs.flight, 6000, '已确认团队成本快照不变');
  assert.equal(f1After.costs.total, f1Before.costs.total, '毛利不受供应商调价影响');

  const f2After = (await get('/tours/' + tour2)).body.finance;
  assert.equal(f2After.costs.flight, 7500, '待确认团队成本跟随新价');

  // 团队2 确认 → 按 750 锁定
  await put('/flights/' + b2.id, { confirmed: true });
  await put('/resources/' + rid, { unit_price: 900 });
  const f2Locked = (await get('/tours/' + tour2)).body.finance;
  assert.equal(f2Locked.costs.flight, 7500, '确认时点价格被锁定');

  // 撤销确认 → 回归资源现价
  await put('/flights/' + b2.id, { confirmed: false });
  const f2Revoke = (await get('/tours/' + tour2)).body.finance;
  assert.equal(f2Revoke.costs.flight, 9000, '撤销确认后按现价重估');
});

test('修改占用数量在事务内校验：超量修改整笔回滚，原数据不变', async () => {
  const { su, tour } = await seedFixture();
  const rid = await flightResource(su, '2026-11-01', 10, 600);
  const b = (await post(`/tours/${tour}/flights`, { seats: 4, resource_id: rid })).body;

  const bad = await put('/flights/' + b.id, { seats: 11 });
  assert.equal(bad.status, 409);
  assert.equal(bad.body.conflicts[0].remaining, 6);

  const kept = db.prepare('SELECT seats FROM flight_bookings WHERE id=?').get(b.id);
  assert.equal(kept.seats, 4, '超量修改已回滚，座位数仍为 4');

  const good = await put('/flights/' + b.id, { seats: 10 });
  assert.equal(good.status, 200);
  assert.equal((await get('/resources/' + rid)).body.available, 0);
});

test('采购数量不能低于当前有效占用；停售资源不能再占用', async () => {
  const { su, tour } = await seedFixture();
  const rid = await flightResource(su, '2026-11-01', 10, 600);
  await post(`/tours/${tour}/flights`, { seats: 8, resource_id: rid });

  const shrink = await put('/resources/' + rid, { quantity: 5 });
  assert.equal(shrink.status, 409);
  assert.match(shrink.body.error, /不能小于当前有效占用 8/);

  const stop = await post(`/resources/${rid}/toggle`);
  assert.equal(stop.body.status, '停售');
  // 新建占用被拒；已存在的占用仍记账
  const { tour: t2 } = await seedFixture();
  const blocked = await post(`/tours/${t2}/flights`, { seats: 1, resource_id: rid });
  assert.equal(blocked.status, 409);
  assert.match(blocked.body.error, /停售/);
});

test('删除资源：有已确认占用禁止删除；仅待确认时删除等于自动释放', async () => {
  const { su, tour, tour2 } = await seedFixture();
  const rid1 = await flightResource(su, '2026-11-01', 10, 600);
  const b1 = (await post(`/tours/${tour}/flights`, { seats: 5, resource_id: rid1 })).body;
  await put('/flights/' + b1.id, { confirmed: true });
  const d1 = await del('/resources/' + rid1);
  assert.equal(d1.status, 409);
  assert.match(d1.body.error, /已确认占用/);

  const rid2 = await flightResource(su, '2026-11-02', 10, 600);
  const b2 = (await post(`/tours/${tour2}/flights`, { seats: 3, resource_id: rid2 })).body;
  const d2 = await del('/resources/' + rid2);
  assert.equal(d2.status, 200);
  assert.equal(d2.body.released_pending, 1);
  // 关联的计调记录保留（手工兼容），但不再有有效占用
  const kept = db.prepare('SELECT id FROM flight_bookings WHERE id=?').get(b2.id);
  assert.ok(kept, '删除资源不级联删除团队计调记录');
});

test('取消/删除团队：事务内释放全部有效占用', async () => {
  const { su, tour } = await seedFixture();
  const rid = await flightResource(su, '2026-11-01', 10, 600);
  await post(`/tours/${tour}/flights`, { seats: 10, resource_id: rid });
  assert.equal((await get('/resources/' + rid)).body.available, 0);

  const d = await del('/tours/' + tour);
  assert.equal(d.status, 200);
  assert.equal((await get('/resources/' + rid)).body.available, 10, '团队删除后库存全部释放');
  const left = db.prepare("SELECT COUNT(*) c FROM resource_occupancies WHERE tour_id=? AND status IN ('待确认','已确认')").get(tour).c;
  assert.equal(left, 0);
});

test('手工计调记录（不关联资源池）完全兼容：创建/确认/财务照旧', async () => {
  const { tour } = await seedFixture();
  const f = await post(`/tours/${tour}/flights`, { direction: '去程', flight_no: 'MANUAL', seats: 10, unit_price: 500 });
  assert.equal(f.status, 200);
  assert.equal(f.body.resource_id, null);
  await put('/flights/' + f.body.id, { confirmed: true });
  const fin = (await get('/tours/' + tour)).body.finance;
  assert.equal(fin.costs.flight, 5000, '手工切位按座位数×单价计入成本');

  const h = await post(`/tours/${tour}/hotels`, {
    hotel_name: '手工酒店', room_type: '大床', rooms: 2,
    check_in: '2026-11-01', check_out: '2026-11-03', night_price: 400
  });
  assert.equal(h.status, 200);
  const fin2 = (await get('/tours/' + tour)).body.finance;
  assert.equal(fin2.costs.hotel, 1600, '手工控房按 间数×晚均价×晚数（2×400×2）');
});

test('占用来源：资源详情返回各团队占用与实时余量', async () => {
  const { su, tour, tour2 } = await seedFixture();
  const rid = await flightResource(su, '2026-11-01', 20, 600);
  await post(`/tours/${tour}/flights`, { seats: 7, resource_id: rid });
  await post(`/tours/${tour2}/flights`, { seats: 5, resource_id: rid });

  const src = await get(`/resources/${rid}/sources`);
  assert.equal(src.status, 200);
  assert.equal(src.body.sources.length, 2);
  assert.equal(src.body.resource.held, 12);
  assert.equal(src.body.resource.available, 8);
  const codes = src.body.sources.map(s => s.tour_code).sort();
  const expect = [tour, tour2].map(id => db.prepare('SELECT code FROM tours WHERE id=?').get(id).code).sort();
  assert.deepEqual(codes, expect, '占用来源标注了团队团号');
});

test('酒店资源批量建池：end_date 自动生成每晚记录', async () => {
  const { su } = await seedFixture();
  const r = await post('/resources', {
    supplier_id: su, type: 'hotel', date: '2026-12-01', end_date: '2026-12-03',
    hotel_name: '连住酒店', room_type: '标间', quantity: 6, unit_price: 200
  });
  assert.equal(r.status, 201);
  assert.equal(r.body.length, 3, '生成三晚记录');
  assert.deepEqual(r.body.map(x => x.date), ['2026-12-01', '2026-12-02', '2026-12-03']);
});
