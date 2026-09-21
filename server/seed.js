/* 初始化演示数据：npm run seed
 * 包含：供应商资源池（航班座位/酒店每日房量/地接容量）、三个团队的占用（含跨团队挤库存）、
 * 以及供应商调价后「已确认成本快照不变、待确认占用跟随新价」的演示场景。
 */
const db = require('./db');
const { eachNight } = require('./pool');

db.exec(`DELETE FROM notices; DELETE FROM other_costs; DELETE FROM local_services;
DELETE FROM hotel_bookings; DELETE FROM flight_bookings; DELETE FROM tourists;
DELETE FROM tours; DELETE FROM itinerary_days; DELETE FROM products;
DELETE FROM resource_occupancies; DELETE FROM resources; DELETE FROM suppliers;
DELETE FROM sqlite_sequence;`);

/* ---------------- 产品 ---------------- */
const insP = db.prepare(`INSERT INTO products (name, days, departure_city, destination, price_double, price_triple, price_child, description)
  VALUES (?,?,?,?,?,?,?,?)`);
const insD = db.prepare('INSERT INTO itinerary_days (product_id, day_no, title, attractions, meals, hotel) VALUES (?,?,?,?,?,?)');

function addProduct(p, days) {
  const pid = insP.run(p.name, p.days, p.from, p.to, p.pd, p.pt, p.pc, '').lastInsertRowid;
  days.forEach(d => insD.run(pid, d[0], d[1], d[2], d[3], d[4]));
  return pid;
}

const p1 = addProduct({
  name: '云南昆明大理丽江双飞6日游', days: 6, from: '上海', to: '云南（昆明/大理/丽江）',
  pd: 5980, pt: 5680, pc: 3980
}, [
  [1, '上海飞昆明，入住酒店', '虹桥机场集合乘机抵达昆明长水机场', '晚餐自理', '昆明锦江大酒店'],
  [2, '昆明 → 石林 → 大理', '石林风景区、七彩云南', '早中晚', '大理风花雪月酒店'],
  [3, '大理古城 + 洱海', '大理古城、洋人街、洱海游船', '早中晚', '大理风花雪月酒店'],
  [4, '大理 → 丽江，丽江古城', '白族民居、丽江古城、四方街', '早中晚', '丽江和府洲际酒店'],
  [5, '玉龙雪山一日游', '玉龙雪山、云杉坪索道、蓝月谷、甘海子', '早中（雪山防寒餐）', '丽江和府洲际酒店'],
  [6, '丽江飞上海', '束河古镇自由活动，下午乘机返沪', '早中', '——']
]);

const p2 = addProduct({
  name: '海南三亚双飞5日纯玩团', days: 5, from: '杭州', to: '海南三亚',
  pd: 2880, pt: 2680, pc: 1680
}, [
  [1, '杭州飞三亚，入住海边酒店', '萧山机场集合飞三亚凤凰机场', '晚餐', '三亚亚特兰蒂斯酒店'],
  [2, '蜈支洲岛一日游', '蜈支洲岛、妈祖庙、情人桥', '早中晚', '三亚亚特兰蒂斯酒店'],
  [3, '南山文化苑 + 天涯海角', '南山寺、108米海上观音、天涯海角', '早中晚', '三亚亚特兰蒂斯酒店'],
  [4, '亚龙湾自由活动', '亚龙湾沙滩、热带天堂森林公园', '早（正餐自理）', '三亚亚特兰蒂斯酒店'],
  [5, '三亚飞杭州', '上午自由活动，下午返程', '早中', '——']
]);

/* ---------------- 供应商 ---------------- */
const insSu = db.prepare('INSERT INTO suppliers (name, type, contact, phone, remarks) VALUES (?,?,?,?,?)');
const suAir = insSu.run('东方航空包机销售部', '航空', '钱经理', '13900010001', '云南/海南航线切位协议价').lastInsertRowid;
const suHotel = insSu.run('云游酒店集采中心', '酒店', '孙主管', '13900010002', '昆明/大理/丽江/三亚酒店每日房量').lastInsertRowid;
const suLocal = insSu.run('云南彩云之南地接社', '地接', '尼玛卓玛', '13888888888', '云南线33座大巴+导游一揽子').lastInsertRowid;
const suLocalHn = insSu.run('三亚海角地接服务公司', '地接', '陈导', '13966666666', '海南线地接用车导游').lastInsertRowid;

/* ---------------- 资源池 ---------------- */
const insRes = db.prepare(`INSERT INTO resources
  (supplier_id, type, date, end_date, flight_no, route, hotel_name, room_type, service_name, service_unit, quantity, unit, unit_price, status, remarks)
  VALUES (@supplier_id,@type,@date,@end_date,@flight_no,@route,@hotel_name,@room_type,@service_name,@service_unit,@quantity,@unit,@unit_price,'开放',@remarks)`);

function resRow(o) {
  return insRes.run({
    end_date: null, flight_no: '', route: '', hotel_name: '', room_type: '',
    service_name: '', service_unit: '', remarks: '', ...o
  }).lastInsertRowid;
}
const flightRes = (su, date, no, route, qty, price) => resRow({
  supplier_id: su, type: 'flight', date, flight_no: no, route, quantity: qty, unit: '座', unit_price: price
});
const hotelRes = (su, name, room, date, qty, price, endDate = null) => resRow({
  supplier_id: su, type: 'hotel', date, end_date: endDate, hotel_name: name, room_type: room,
  quantity: qty, unit: '间', unit_price: price
});
const localRes = (su, date, name, serviceUnit, qty, price) => resRow({
  supplier_id: su, type: 'local', date, service_name: name, service_unit: serviceUnit,
  quantity: qty, unit: '人', unit_price: price
});

function hotelRange(su, name, room, checkIn, checkOut, qty, price) {
  const dates = eachNight(checkIn, checkOut);
  return dates.map(d => hotelRes(su, name, room, d, qty, price, d === dates[0] ? dates[dates.length - 1] : null));
}
const resId = (hotelName, roomType, date) =>
  db.prepare("SELECT id FROM resources WHERE type='hotel' AND hotel_name=? AND room_type=? AND date=?")
    .get(hotelName, roomType, date).id;

// 航班（采购时的协议价）
const rMU5802 = flightRes(suAir, '2026-10-01', 'MU5802', '上海虹桥 → 昆明长水', 34, 680);
const rMU5809 = flightRes(suAir, '2026-10-06', 'MU5809', '丽江三义 → 上海虹桥', 34, 720);
const rCZ3869 = flightRes(suAir, '2026-10-02', 'CZ3869', '杭州萧山 → 三亚凤凰', 24, 520);
flightRes(suAir, '2026-10-06', 'CZ3870', '三亚凤凰 → 杭州萧山', 24, 560);

// 酒店每日房量（每晚一行）
hotelRes(suHotel, '昆明锦江大酒店', '标间', '2026-10-01', 20, 320);
hotelRange(suHotel, '大理风花雪月酒店', '标间', '2026-10-02', '2026-10-04', 20, 380);
hotelRange(suHotel, '丽江和府洲际酒店', '标间', '2026-10-04', '2026-10-06', 18, 520);
hotelRange(suHotel, '三亚亚特兰蒂斯酒店', '海景双床房', '2026-10-02', '2026-10-06', 12, 680);

// 地接容量（按服务日）
const rLocalYN = localRes(suLocal, '2026-10-01', '云南6日地接一揽子（33座大巴/中文导游）', '33座大巴+导游，按人份计价', 33, 400);
const rLocalHN = localRes(suLocalHn, '2026-10-02', '三亚5日地接一揽子（37座大巴/中文导游）', '37座大巴+导游，按人份计价', 24, 350);

/* ---------------- 团队 ---------------- */
const insT = db.prepare(`INSERT INTO tours (code, product_id, departure_date, return_date, capacity, status, tour_leader)
  VALUES (?,?,?,?,?,?,?)`);
const t1 = insT.run('TH20261001-001', p1, '2026-10-01', '2026-10-06', 30, '已成团', '王建国').lastInsertRowid;
const t2 = insT.run('TH20261002-001', p2, '2026-10-02', '2026-10-06', 20, '收客中', '李丽华').lastInsertRowid;
const t3 = insT.run('TH20261001-002', p1, '2026-10-01', '2026-10-06', 25, '收客中', '赵小飞').lastInsertRowid;

/* ---------------- 游客 ---------------- */
const insTr = db.prepare(`INSERT INTO tourists (tour_id, name, id_card, phone, room_type, special_needs, price)
  VALUES (?,?,?,?,?,?,?)`);
const tourists1 = [
  ['张伟', '310101199003074511', '13800000001', '双人房', '', 5980],
  ['王芳', '310101199205123422', '13800000002', '双人房', '素食', 5980],
  ['李强', '110105198812120016', '13900000003', '三人房', '', 5680],
  ['赵敏', '32010620010101452X', '13700000004', '双人房', '轮椅（需要无障碍通道）', 5980],
  ['陈静', '330102199507152341', '13600000005', '儿童不占床', '', 3980]
];
tourists1.forEach(t => insTr.run(t1, ...t));
const tourists1Extra = [
  ['吴秀兰', '11010119910203231X', '13810000010', '双人房', '', 5980],
  ['郑浩', '320506199305071231', '13810000137', '三人房', '', 5680],
  ['冯雪', '440304198711234517', '13810000274', '双人房', '', 5980],
  ['蒋文明', '500103200008087892', '13810000411', '双人房', '', 5980],
  ['韩梅梅', '350203199512120032', '13810000548', '三人房', '全程素食，不食葱蒜', 5680],
  ['杨光', '610104198909095672', '13810000685', '双人房', '', 5980],
  ['许晴', '420106199207073454', '13810000822', '双人房', '', 5980],
  ['邓超', '370102199801018917', '13810000959', '三人房', '', 5680],
  ['曹颖', '530102199603032347', '13810001096', '双人房', '', 5980],
  ['唐嫣', '230103199104045675', '13810001233', '双人房', '', 5980],
  ['罗晋', '340103200205056788', '13810001370', '三人房', '', 5680],
  ['高圆圆', '640104198806068909', '13810001507', '双人房', '', 5980],
  ['黄磊', '220104199707071236', '13810001644', '双人房', '', 5980]
];
tourists1Extra.forEach(t => insTr.run(t1, ...t));
const tourists1Extra2 = [
  ['沈腾', '210102199101011111', '13930000010', '三人房', '', 5680],
  ['马丽', '210202199202022229', '13930000313', '双人房', '', 5980],
  ['贾冰', '130203199303033337', '13930000626', '双人房', '', 5980],
  ['张小斐', '140104199404044441', '13930000939', '双人房', '', 5980],
  ['岳云鹏', '150105199505055551', '13930001252', '三人房', '', 5680],
  ['贾玲', '320306199606066662', '13930001565', '双人房', '', 5980],
  ['宋小宝', '330307199707077772', '13930001878', '双人房', '', 5980],
  ['柳岩', '360208199808088880', '13930002191', '双人房', '', 5980],
  ['包贝尔', '370209199909099990', '13930002504', '三人房', '', 5680],
  ['闫妮', '410110200010101018', '13930002817', '双人房', '', 5980]
];
tourists1Extra2.forEach(t => insTr.run(t1, ...t));
const tourists2 = [
  ['刘洋', '330106199402116710', '13500000006', '双人房', '', 2880],
  ['孙丽', '440103199011058724', '13500000007', '双人房', '', 2880],
  ['周杰', '510104198706063415', '13600000008', '三人房', '海鲜过敏', 2680],
  ['彭于晏', '110223199201013417', '13720000010', '双人房', '', 2880],
  ['董洁', '330206199502024528', '13720000211', '双人房', '', 2880],
  ['袁泉', '441900198803035636', '13720000422', '儿童不占床', '儿童，需安全座椅', 1680],
  ['潘粤明', '510110199904046749', '13720000633', '双人房', '', 2880],
  ['章子怡', '36010219900505785X', '13720000844', '双人房', '', 2880],
  ['蒋勤勤', '130102199606068965', '13720001055', '儿童不占床', '', 1680]
];
tourists2.forEach(t => insTr.run(t2, ...t));
[
  ['林更新', '230106199208181234', '13977770001', '双人房', '', 5980],
  ['赵丽颖', '320105199311122345', '13977770002', '双人房', '', 5980],
  ['魏大勋', '110108199505063456', '13977770003', '三人房', '', 5680]
].forEach(t => insTr.run(t3, ...t));

/* ---------------- 计调记录 + 资源池占用 ---------------- */
const insF = db.prepare(`INSERT INTO flight_bookings
  (tour_id, direction, flight_no, flight_date, route, seats, unit_price, confirmed, resource_id, released)
  VALUES (?,?,?,?,?,?,?,?,?,0)`);
const insH = db.prepare(`INSERT INTO hotel_bookings
  (tour_id, hotel_name, room_type, rooms, check_in, check_out, night_price, confirmed, resource_id, released)
  VALUES (?,?,?,?,?,?,?,?,?,0)`);
const insL = db.prepare(`INSERT INTO local_services
  (tour_id, agency_name, guide_name, guide_phone, vehicle, meals_plan, total_price, confirmed, resource_id, service_date, quantity)
  VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
const insOth = db.prepare('INSERT INTO other_costs (tour_id, item, amount, remarks) VALUES (?,?,?,?)');

const insOcc = db.prepare(`INSERT INTO resource_occupancies
  (resource_id, tour_id, tour_code, booking_type, booking_id, service_date, quantity, status, unit_price_snapshot, cost_amount, confirmed_at)
  VALUES (?,?,?,?,?,?,?,?,?,?,?)`);

const codeOf = tourId => db.prepare('SELECT code FROM tours WHERE id=?').get(tourId).code;

// 占用（status: 已确认 / 待确认；价格为占用发生时的快照价）
function occupy(resourceId, tourId, bookingType, bookingId, serviceDate, qty, status, price) {
  insOcc.run(resourceId, tourId, codeOf(tourId), bookingType, bookingId, serviceDate,
    qty, status, price, Math.round(price * qty * 100) / 100,
    status === '已确认' ? "datetime('now','localtime')" : null);
}
function flightBooking(tourId, dir, no, date, route, seats, price, confirmed, resourceId) {
  return insF.run(tourId, dir, no, date, route, seats, price, confirmed ? 1 : 0, resourceId).lastInsertRowid;
}
function hotelBooking(tourId, name, room, rooms, checkIn, checkOut, nightPrice, confirmed, resourceId) {
  return insH.run(tourId, name, room, rooms, checkIn, checkOut, nightPrice, confirmed ? 1 : 0, resourceId ?? null).lastInsertRowid;
}
// 酒店占用逐晚写入（同一 hotel_bookings 记录每晚一行）
function occupyHotel(tourId, bookingId, name, room, rooms, checkIn, checkOut, prices, status) {
  eachNight(checkIn, checkOut).forEach((d, i) => {
    const price = typeof prices === 'function' ? prices(d, i) : (Array.isArray(prices) ? prices[i] : prices);
    occupy(resId(name, room, d), tourId, 'hotel', bookingId, d, rooms, status, price);
  });
}

/* ===== 团队1：云南线，全部已确认（占用按采购时旧价快照） ===== */
let b;
b = flightBooking(t1, '去程', 'MU5802', '2026-10-01', '上海虹桥 → 昆明长水', 28, 680, true, rMU5802);
occupy(rMU5802, t1, 'flight', b, '2026-10-01', 28, '已确认', 680);
b = flightBooking(t1, '回程', 'MU5809', '2026-10-06', '丽江三义 → 上海虹桥', 28, 720, true, rMU5809);
occupy(rMU5809, t1, 'flight', b, '2026-10-06', 28, '已确认', 720);

b = hotelBooking(t1, '昆明锦江大酒店', '标间', 14, '2026-10-01', '2026-10-02', 320, true, resId('昆明锦江大酒店', '标间', '2026-10-01'));
occupyHotel(t1, b, '昆明锦江大酒店', '标间', 14, '2026-10-01', '2026-10-02', 320, '已确认');
b = hotelBooking(t1, '大理风花雪月酒店', '标间', 14, '2026-10-02', '2026-10-04', 380, true, resId('大理风花雪月酒店', '标间', '2026-10-02'));
occupyHotel(t1, b, '大理风花雪月酒店', '标间', 14, '2026-10-02', '2026-10-04', 380, '已确认');
b = hotelBooking(t1, '丽江和府洲际酒店', '标间', 14, '2026-10-04', '2026-10-06', 520, true, resId('丽江和府洲际酒店', '标间', '2026-10-04'));
occupyHotel(t1, b, '丽江和府洲际酒店', '标间', 14, '2026-10-04', '2026-10-06', 520, '已确认');

b = insL.run(t1, '云南彩云之南地接社', '尼玛卓玛', '13888888888', '33座空调旅游大巴', '5早8正，十人一桌', 11200, 1, rLocalYN, '2026-10-01', 28).lastInsertRowid;
occupy(rLocalYN, t1, 'local', b, '2026-10-01', 28, '已确认', 400);

insOth.run(t1, '玉龙雪山索道及进山费', 28 * 190, '按 28 人预估，含云杉坪索道');

/* ===== 团队3：云南线第二团，待确认占用，与团队1挤同一批资源（演示占用来源/余量） ===== */
b = flightBooking(t3, '去程', 'MU5802', '2026-10-01', '上海虹桥 → 昆明长水', 5, 680, false, rMU5802);
occupy(rMU5802, t3, 'flight', b, '2026-10-01', 5, '待确认', 680);
b = flightBooking(t3, '回程', 'MU5809', '2026-10-06', '丽江三义 → 上海虹桥', 5, 720, false, rMU5809);
occupy(rMU5809, t3, 'flight', b, '2026-10-06', 5, '待确认', 720);
b = hotelBooking(t3, '大理风花雪月酒店', '标间', 3, '2026-10-02', '2026-10-04', 380, false, resId('大理风花雪月酒店', '标间', '2026-10-02'));
occupyHotel(t3, b, '大理风花雪月酒店', '标间', 3, '2026-10-02', '2026-10-04', 380, '待确认');
// 丽江 10-04：18 - 14(团1) = 4 间余量；团3 占 3 间后余 1
b = hotelBooking(t3, '丽江和府洲际酒店', '标间', 3, '2026-10-04', '2026-10-06', 520, false, resId('丽江和府洲际酒店', '标间', '2026-10-04'));
occupyHotel(t3, b, '丽江和府洲际酒店', '标间', 3, '2026-10-04', '2026-10-06', 520, '待确认');
b = insL.run(t3, '云南彩云之南地接社', '尼玛卓玛', '13888888888', '33座空调旅游大巴', '5早8正，十人一桌', 2000, 0, rLocalYN, '2026-10-01', 5).lastInsertRowid;
occupy(rLocalYN, t3, 'local', b, '2026-10-01', 5, '待确认', 400);

/* ===== 供应商调价（演示成本快照）：MU5802 涨到 750、昆明锦江涨到 360、地接涨到 430 =====
 * 已确认占用（团队1）快照价不变，毛利不受影响；
 * 待确认占用（团队3）的快照价同步到新价（确认时再锁定）。 */
const priceUpd = db.prepare('UPDATE resources SET unit_price=? WHERE id=?');
priceUpd.run(750, rMU5802);
priceUpd.run(360, resId('昆明锦江大酒店', '标间', '2026-10-01'));
priceUpd.run(430, rLocalYN);
// 已确认占用（团队1）快照价不变；待确认占用（团队3）的快照价同步到新价（确认时再锁定）
db.prepare(`UPDATE resource_occupancies
  SET unit_price_snapshot=(SELECT unit_price FROM resources WHERE id=resource_id),
      cost_amount=(SELECT unit_price FROM resources WHERE id=resource_id)*quantity
  WHERE status='待确认'`).run();

/* ===== 团队2：海南线，部分待确认占用（手工其他成本保留兼容演示） ===== */
b = flightBooking(t2, '去程', 'CZ3869', '2026-10-02', '杭州萧山 → 三亚凤凰', 10, 520, false, rCZ3869);
occupy(rCZ3869, t2, 'flight', b, '2026-10-02', 10, '待确认', 520);
b = hotelBooking(t2, '三亚亚特兰蒂斯酒店', '海景双床房', 5, '2026-10-02', '2026-10-06', 680, false, resId('三亚亚特兰蒂斯酒店', '海景双床房', '2026-10-02'));
occupyHotel(t2, b, '三亚亚特兰蒂斯酒店', '海景双床房', 5, '2026-10-02', '2026-10-06', 680, '待确认');
b = insL.run(t2, '三亚海角地接服务公司', '陈导', '13966666666', '37座空调大巴', '4早7正', 3150, 0, rLocalHN, '2026-10-02', 9).lastInsertRowid;
occupy(rLocalHN, t2, 'local', b, '2026-10-02', 9, '待确认', 350);
insOth.run(t2, '旅行社责任险', 10 * 30, '按 10 席位预估');

console.log('种子数据已写入：2 个产品、3 个团队、40 名游客、4 家供应商与航班/酒店/地接资源池及跨团占用（含调价后的成本快照演示）');
