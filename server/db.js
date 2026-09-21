const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

// 允许通过环境变量指定数据库文件（测试用临时库）
const DATA_DIR = path.join(__dirname, '..', 'data');
const dbFile = process.env.TRAVEL_DB_PATH
  ? path.resolve(process.env.TRAVEL_DB_PATH)
  : path.join(DATA_DIR, 'travel.db');
if (!fs.existsSync(path.dirname(dbFile))) fs.mkdirSync(path.dirname(dbFile), { recursive: true });

const db = new Database(dbFile);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

db.exec(`
CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  days INTEGER NOT NULL,
  departure_city TEXT NOT NULL,
  destination TEXT NOT NULL,
  price_double REAL NOT NULL DEFAULT 0,
  price_triple REAL NOT NULL DEFAULT 0,
  price_child REAL NOT NULL DEFAULT 0,
  description TEXT DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS itinerary_days (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  day_no INTEGER NOT NULL,
  title TEXT DEFAULT '',
  attractions TEXT DEFAULT '',
  meals TEXT DEFAULT '',
  hotel TEXT DEFAULT '',
  UNIQUE(product_id, day_no)
);

CREATE TABLE IF NOT EXISTS tours (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  product_id INTEGER NOT NULL REFERENCES products(id),
  departure_date TEXT NOT NULL,
  return_date TEXT,
  capacity INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT '收客中',
  tour_leader TEXT DEFAULT '',
  remarks TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS tourists (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tour_id INTEGER NOT NULL REFERENCES tours(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  id_card TEXT NOT NULL,
  phone TEXT DEFAULT '',
  room_type TEXT NOT NULL DEFAULT '双人房',
  special_needs TEXT DEFAULT '',
  price REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT '已报名',
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS flight_bookings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tour_id INTEGER NOT NULL REFERENCES tours(id) ON DELETE CASCADE,
  direction TEXT NOT NULL DEFAULT '去程',
  flight_no TEXT NOT NULL,
  flight_date TEXT,
  route TEXT DEFAULT '',
  seats INTEGER NOT NULL DEFAULT 0,
  unit_price REAL NOT NULL DEFAULT 0,
  confirmed INTEGER NOT NULL DEFAULT 0,
  remarks TEXT DEFAULT '',
  resource_id INTEGER,
  released INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS hotel_bookings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tour_id INTEGER NOT NULL REFERENCES tours(id) ON DELETE CASCADE,
  hotel_name TEXT NOT NULL,
  room_type TEXT NOT NULL DEFAULT '标间',
  rooms INTEGER NOT NULL DEFAULT 0,
  check_in TEXT NOT NULL,
  check_out TEXT NOT NULL,
  night_price REAL NOT NULL DEFAULT 0,
  confirmed INTEGER NOT NULL DEFAULT 0,
  remarks TEXT DEFAULT '',
  resource_id INTEGER,
  released INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS local_services (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tour_id INTEGER NOT NULL REFERENCES tours(id) ON DELETE CASCADE,
  agency_name TEXT NOT NULL,
  guide_name TEXT DEFAULT '',
  guide_phone TEXT DEFAULT '',
  vehicle TEXT DEFAULT '',
  meals_plan TEXT DEFAULT '',
  total_price REAL NOT NULL DEFAULT 0,
  confirmed INTEGER NOT NULL DEFAULT 0,
  remarks TEXT DEFAULT '',
  resource_id INTEGER,
  service_date TEXT,
  quantity INTEGER NOT NULL DEFAULT 0,       -- 占用资源池的服务数量（如：接待人数）
  released INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS other_costs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tour_id INTEGER NOT NULL REFERENCES tours(id) ON DELETE CASCADE,
  item TEXT NOT NULL,
  amount REAL NOT NULL DEFAULT 0,
  remarks TEXT DEFAULT ''
);

CREATE TABLE IF NOT EXISTS notices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tour_id INTEGER NOT NULL REFERENCES tours(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  sent INTEGER NOT NULL DEFAULT 0,
  sent_at TEXT,
  recipient_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

/* ============ 供应商资源池 ============ */
CREATE TABLE IF NOT EXISTS suppliers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT '综合',          -- 航空 / 酒店 / 地接 / 综合
  contact TEXT DEFAULT '',
  phone TEXT DEFAULT '',
  remarks TEXT DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

-- 统一资源池：航班座位（type=flight）、酒店每日房量（type=hotel，每晚一行）、地接服务容量（type=local）
CREATE TABLE IF NOT EXISTS resources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  supplier_id INTEGER NOT NULL REFERENCES suppliers(id),
  type TEXT NOT NULL,                        -- flight / hotel / local
  date TEXT,                                 -- 航班日期 / 入住日期（每晚）/ 地接服务日期
  end_date TEXT,                             -- 酒店批量建池时的最后一晚（展示用）
  flight_no TEXT DEFAULT '',
  route TEXT DEFAULT '',
  hotel_name TEXT DEFAULT '',
  room_type TEXT DEFAULT '',
  service_name TEXT DEFAULT '',
  service_unit TEXT DEFAULT '',              -- 地接服务计量单位说明（如：33座大巴/中文导游）
  quantity INTEGER NOT NULL DEFAULT 0,       -- 采购数量（座/间/人·份）
  unit TEXT NOT NULL DEFAULT '间',
  unit_price REAL NOT NULL DEFAULT 0,        -- 采购单价
  status TEXT NOT NULL DEFAULT '开放',       -- 开放 / 停售
  remarks TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

-- 团队对资源池的占用：酒店每一晚一行；航班一班一行；地接一个服务日一行
CREATE TABLE IF NOT EXISTS resource_occupancies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  resource_id INTEGER NOT NULL REFERENCES resources(id),
  tour_id INTEGER REFERENCES tours(id) ON DELETE SET NULL,
  tour_code TEXT DEFAULT '',
  booking_type TEXT NOT NULL,                -- flight / hotel / local
  booking_id INTEGER,                        -- 对应 *_bookings 记录 id（多态关联，手工记录为空）
  service_date TEXT NOT NULL,                -- 酒店=入住夜日期；航班=航班日期；地接=服务日期
  quantity INTEGER NOT NULL,                 -- 占用数量
  status TEXT NOT NULL DEFAULT '待确认',     -- 待确认 / 已确认 / 已释放
  unit_price_snapshot REAL NOT NULL DEFAULT 0, -- 成本快照单价（确认后锁定，供应商调价不影响）
  cost_amount REAL NOT NULL DEFAULT 0,       -- 成本快照金额
  confirmed_at TEXT,
  released_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  UNIQUE(resource_id, booking_type, booking_id, service_date)
);

CREATE INDEX IF NOT EXISTS idx_occ_resource ON resource_occupancies(resource_id, service_date, status);
CREATE INDEX IF NOT EXISTS idx_occ_booking  ON resource_occupancies(booking_type, booking_id);
CREATE INDEX IF NOT EXISTS idx_occ_tour     ON resource_occupancies(tour_id, status);
CREATE INDEX IF NOT EXISTS idx_res_type_date ON resources(type, date);
`);

// 兼容既有数据库：补充计调表上的资源池关联列
function addColumn(table, column, ddl) {
  try { db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`); } catch (e) { /* 列已存在 */ }
}
addColumn('flight_bookings', 'resource_id', 'INTEGER');
addColumn('flight_bookings', 'released', 'INTEGER NOT NULL DEFAULT 0');
addColumn('hotel_bookings', 'resource_id', 'INTEGER');
addColumn('hotel_bookings', 'released', 'INTEGER NOT NULL DEFAULT 0');
addColumn('local_services', 'resource_id', 'INTEGER');
addColumn('local_services', 'service_date', 'TEXT');
addColumn('local_services', 'quantity', 'INTEGER NOT NULL DEFAULT 0');
addColumn('local_services', 'released', 'INTEGER NOT NULL DEFAULT 0');

module.exports = db;
