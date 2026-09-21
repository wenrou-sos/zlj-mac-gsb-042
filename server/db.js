const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DATA_DIR = path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'travel.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

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
  remarks TEXT DEFAULT ''
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
  remarks TEXT DEFAULT ''
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
  remarks TEXT DEFAULT ''
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
`);

module.exports = db;
