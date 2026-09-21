const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DATA_DIR = process.env.TRAVEL_DATA_DIR || path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_FILE = process.env.TRAVEL_DB_FILE
  ? path.resolve(process.env.TRAVEL_DB_FILE)
  : path.join(DATA_DIR, 'travel.db');

const db = new Database(DB_FILE);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
// 并发事务出现写锁竞争时排队等待，而不是立刻 SQLITE_BUSY
db.pragma('busy_timeout = 8000');

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
  allocation_id INTEGER
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
  allocation_id INTEGER
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
  allocation_id INTEGER
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

-- 供应商：航司/包机商、酒店、地接社
CREATE TABLE IF NOT EXISTS suppliers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT '酒店',           -- 航班 / 酒店 / 地接
  contact TEXT DEFAULT '',
  phone TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT '合作中',        -- 合作中 / 已停用
  remarks TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

-- 采购资源（库存）：
--   航班：service_date=航班日期，qty=座位数，unit_price=元/座
--   酒店：service_date=入住起始日，end_date=离店日，qty=每日房量，unit_price=元/间夜
--   地接：service_date=服务日期，qty=接待容量（团数），unit_price=每团打包价
CREATE TABLE IF NOT EXISTS resources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  supplier_id INTEGER NOT NULL REFERENCES suppliers(id),
  type TEXT NOT NULL,                          -- 航班 / 酒店 / 地接
  name TEXT NOT NULL,                          -- 航班号 / 酒店+房型 / 地接产品名
  sub_name TEXT DEFAULT '',                    -- 房型等补充信息
  route TEXT DEFAULT '',
  direction TEXT DEFAULT '去程',
  service_date TEXT NOT NULL,
  end_date TEXT,                               -- 仅酒店使用（离店日）
  qty INTEGER NOT NULL DEFAULT 0,              -- 采购数量
  unit_price REAL NOT NULL DEFAULT 0,          -- 采购单价
  status TEXT NOT NULL DEFAULT '在售',          -- 在售 / 停售
  remarks TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

-- 团队对资源池的占用：待确认(pending) / 已确认(confirmed) / 已释放(released)
CREATE TABLE IF NOT EXISTS resource_allocations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  resource_id INTEGER NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
  tour_id INTEGER NOT NULL REFERENCES tours(id) ON DELETE CASCADE,
  qty INTEGER NOT NULL,
  start_date TEXT NOT NULL,                    -- 航班/地接=服务日；酒店=入住日
  end_date TEXT,                               -- 仅酒店：离店日
  status TEXT NOT NULL DEFAULT '待确认',
  price_snapshot REAL NOT NULL,                -- 确认时锁定的单价（成本快照）
  cost_snapshot REAL,                          -- 确认时锁定的总成本
  cost_currency_note TEXT DEFAULT '',
  booking_table TEXT DEFAULT '',               -- 联动生成的计调表（审计用）
  booking_id INTEGER,                          -- 联动计调记录 id（释放后保留，计调表行已删除）
  tour_code TEXT DEFAULT '',
  tour_name TEXT DEFAULT '',
  confirmed_at TEXT,
  released_at TEXT,
  remarks TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE INDEX IF NOT EXISTS idx_resources_type_date ON resources(type, service_date);
CREATE INDEX IF NOT EXISTS idx_allocations_resource ON resource_allocations(resource_id, status);
`);

/* 兼容旧库：为已存在的计调表补充 allocation_id 列 */
for (const t of ['flight_bookings', 'hotel_bookings', 'local_services']) {
  const cols = db.prepare(`PRAGMA table_info(${t})`).all().map(c => c.name);
  if (!cols.includes('allocation_id')) {
    db.exec(`ALTER TABLE ${t} ADD COLUMN allocation_id INTEGER`);
  }
}

module.exports = db;
