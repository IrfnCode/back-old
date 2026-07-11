import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import fs from 'fs';
import { formatToWIB } from '../utils/time.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const dbPath = join(__dirname, '..', '..', 'data', 'database.sqlite');
let db;

export function getDb() {
  if (!db) {
    initDatabase();
  }
  return db;
}

export function initDatabase() {
  // Ensure data directory exists
  const dataDir = join(__dirname, '..', '..', 'data');
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  db = new Database(dbPath);

  // Create tables
  db.exec(`
    CREATE TABLE IF NOT EXISTS config (
      key TEXT PRIMARY KEY,
      value TEXT
    );
    
    CREATE TABLE IF NOT EXISTS work_orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id TEXT UNIQUE,
      title TEXT,
      description TEXT,
      status TEXT DEFAULT 'OPEN',
      priority TEXT DEFAULT 'Normal',
      source TEXT DEFAULT 'Scraper',
      assigned_to TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      customer_type TEXT,
      customer_name TEXT,
      contact_phone TEXT,
      service_no TEXT,
      witel TEXT,
      workzone TEXT,
      reported_date DATETIME,
      expired_date DATETIME,
      booking_date DATETIME,
      team TEXT,
      summary TEXT
    );

    CREATE TABLE IF NOT EXISTS teams (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS team_members (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      team_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      telegram_username TEXT,
      nik TEXT,
      full_name TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS performance_config (
      id INTEGER PRIMARY KEY,
      min_close_per_day INTEGER DEFAULT 1,
      min_close_per_month INTEGER DEFAULT 120,
      min_close_per_year INTEGER DEFAULT 1440,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS rekap (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      no_inc TEXT,
      no_inet TEXT,
      rca TEXT,
      keterangan TEXT,
      alamat TEXT,
      reported_by TEXT,
      input_by TEXT,
      input_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS telegram_chats (
      id INTEGER PRIMARY KEY,
      chat_id TEXT UNIQUE NOT NULL,
      title TEXT,
      type TEXT,
      username TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS group_members (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      username TEXT,
      first_name TEXT,
      last_name TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(chat_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS schedule_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      month INTEGER NOT NULL,
      year INTEGER NOT NULL,
      day INTEGER NOT NULL,
      shift TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(name, month, year, day)
    );

    CREATE TABLE IF NOT EXISTS schedule_mapping (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      excel_name TEXT UNIQUE NOT NULL,
      team_member_id INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (team_member_id) REFERENCES team_members(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS auto_send_config (
      workzone TEXT PRIMARY KEY,
      rotation_index INTEGER DEFAULT 0,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS schedule_status (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      excel_name TEXT NOT NULL,
      day INTEGER NOT NULL,
      month INTEGER NOT NULL,
      year INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'ACTIVE',
      note TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(excel_name, day, month, year)
    );

    CREATE TABLE IF NOT EXISTS infra_orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id TEXT UNIQUE NOT NULL,
      kategori TEXT,
      keterangan TEXT,
      lokasi TEXT,
      foto_path TEXT,
      status TEXT DEFAULT 'OPEN',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // Migration: Add new columns if they don't exist (for existing databases)
  const tableInfo = db.pragma('table_info(work_orders)');
  const existingColumns = tableInfo.map(col => col.name);

  const newColumns = [
    { name: 'customer_type', type: 'TEXT' },
    { name: 'customer_name', type: 'TEXT' },
    { name: 'contact_phone', type: 'TEXT' },
    { name: 'service_no', type: 'TEXT' },
    { name: 'witel', type: 'TEXT' },
    { name: 'workzone', type: 'TEXT' },
    { name: 'reported_date', type: 'DATETIME' },
    { name: 'expired_date', type: 'DATETIME' },
    { name: 'booking_date', type: 'DATETIME' },
    { name: 'team', type: 'TEXT' },
    { name: 'summary', type: 'TEXT' },
    { name: 'customer_segment', type: 'TEXT' },
    { name: 'ttr_customer', type: 'TEXT' },
    { name: 'telegram_sent', type: 'INTEGER DEFAULT 0' },
    { name: 'latitude', type: 'REAL' },
    { name: 'longitude', type: 'REAL' },
    { name: 'street_address', type: 'TEXT' }
  ];

  newColumns.forEach(col => {
    if (!existingColumns.includes(col.name)) {
      db.exec(`ALTER TABLE work_orders ADD COLUMN ${col.name} ${col.type}`);
      console.log(`📦 Added column: ${col.name}`);
    }
  });

  // Migration for rekap table
  try {
    const rekapInfo = db.pragma('table_info(rekap)');
    const rekapColumns = rekapInfo.map(col => col.name);

    const rekapNewColumns = [
      { name: 'reported_by', type: 'TEXT' },
      { name: 'mat', type: 'TEXT' },
      { name: 'tipe_tiket', type: 'TEXT' },
      { name: 'odp', type: 'TEXT' },
      { name: 'category', type: "TEXT DEFAULT 'REGULER'" },
      { name: 'pid', type: 'TEXT' },
      { name: 'description', type: 'TEXT' },
      { name: 'datek_inputan', type: 'TEXT' },
      { name: 'datek_real', type: 'TEXT' },
      { name: 'id_valins', type: 'TEXT' },
      { name: 'keterangan_pusat', type: 'TEXT' },
      { name: 'tindak_lanjut', type: 'TEXT' },
      { name: 'telegram_chat_id', type: 'TEXT' },
      { name: 'telegram_message_id', type: 'INTEGER' },
      { name: 'telegram_message_id', type: 'INTEGER' },
      { name: 'telegram_reply_id', type: 'INTEGER' },
      { name: 'is_synced_external', type: 'INTEGER DEFAULT 0' },
      { name: 'status', type: 'TEXT' },
      { name: 'jam_open', type: 'DATETIME' },
      { name: 'jam_close', type: 'DATETIME' },
      { name: 'user_id', type: 'TEXT' },
      { name: 'no_hp', type: 'TEXT' },
      { name: 'updated_at', type: 'DATETIME' }
    ];

    rekapNewColumns.forEach(col => {
      if (!rekapColumns.includes(col.name)) {
        db.exec(`ALTER TABLE rekap ADD COLUMN ${col.name} ${col.type}`);
        console.log(`📦 Added column to rekap: ${col.name}`);
      }
    });
  } catch (e) {
    // Table might not exist yet, that's ok
  }

  // Migration for team_members table (add nik and full_name)
  try {
    const teamMembersInfo = db.pragma('table_info(team_members)');
    const teamMembersColumns = teamMembersInfo.map(col => col.name);

    const teamMembersNewColumns = [
      { name: 'nik', type: 'TEXT' },
      { name: 'full_name', type: 'TEXT' }
    ];

    teamMembersNewColumns.forEach(col => {
      if (!teamMembersColumns.includes(col.name)) {
        db.exec(`ALTER TABLE team_members ADD COLUMN ${col.name} ${col.type}`);
        console.log(`📦 Added column to team_members: ${col.name}`);
      }
    });
  } catch (e) {
    // Table might not exist yet, that's ok
  }

  console.log('📦 Database initialized');
}

export function getConfig() {
  const rows = db.prepare('SELECT key, value FROM config').all();
  const config = {};
  rows.forEach(row => {
    config[row.key] = row.value;
  });
  return config;
}



export function saveConfig(key, value) {
  const stmt = db.prepare(`
    INSERT INTO config (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `);
  stmt.run(key, value);
}

export function getAllWorkOrders() {
  return db.prepare('SELECT * FROM work_orders ORDER BY created_at DESC').all();
}

export function addWorkOrder(workOrder) {
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO work_orders 
    (order_id, title, description, status, priority, source, assigned_to, 
     customer_type, customer_name, contact_phone, service_no, witel, workzone,
     reported_date, expired_date, booking_date, team, summary, customer_segment, ttr_customer,
     created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const now = formatToWIB();

  stmt.run(
    workOrder.orderId,
    workOrder.title,
    workOrder.description || '',
    workOrder.status || 'OPEN',
    workOrder.priority || 'Normal',
    workOrder.source || 'Scraper',
    workOrder.assignedTo || null,
    workOrder.customerType || null,
    workOrder.customerName || null,
    workOrder.contactPhone || null,
    workOrder.serviceNo || null,
    workOrder.witel || null,
    workOrder.workzone || null,
    workOrder.reportedDate || null,
    workOrder.expiredDate || null,
    workOrder.bookingDate || null,
    workOrder.team || null,
    workOrder.summary || null,
    workOrder.customerSegment || null,
    workOrder.ttrCustomer || null,
    now,
    now
  );
}

export function updateWorkOrder(id, updates) {
  const allowedFields = [
    'title', 'description', 'status', 'priority', 'assigned_to',
    'customer_type', 'customer_name', 'contact_phone', 'service_no',
    'witel', 'workzone', 'reported_date', 'expired_date', 'booking_date',
    'team', 'summary', 'latitude', 'longitude', 'street_address'
  ];

  const setClauses = [];
  const values = [];

  Object.keys(updates).forEach(key => {
    if (allowedFields.includes(key)) {
      setClauses.push(`${key} = ?`);
      values.push(updates[key]);
    }
  });

  if (setClauses.length === 0) {
    return false;
  }

  setClauses.push('updated_at = ?');
  values.push(formatToWIB());
  values.push(id);

  const stmt = db.prepare(`
        UPDATE work_orders 
        SET ${setClauses.join(', ')}
        WHERE id = ?
    `);

  const result = stmt.run(...values);
  return result.changes > 0;
}

export function deleteWorkOrder(id) {
  const stmt = db.prepare('DELETE FROM work_orders WHERE id = ?');
  const result = stmt.run(id);
  return result.changes > 0;
}

export function getWorkOrderById(id) {
  return db.prepare('SELECT * FROM work_orders WHERE id = ?').get(id);
}

export function clearOldWorkOrders(daysOld = 30) {
  const stmt = db.prepare(`
    DELETE FROM work_orders 
    WHERE created_at < datetime('now', '-' || ? || ' days')
  `);
  stmt.run(daysOld);
}

export function workOrderExists(orderId) {
  const row = db.prepare('SELECT 1 FROM work_orders WHERE order_id = ?').get(orderId);
  return !!row;
}

export function deleteAllWorkOrders() {
  const stmt = db.prepare('DELETE FROM work_orders');
  const result = stmt.run();
  return result.changes;
}

export function getWorkOrderByOrderId(orderId) {
  return db.prepare('SELECT * FROM work_orders WHERE order_id = ?').get(orderId);
}

export function getWorkOrdersByServiceNo(serviceNo) {
  return db.prepare('SELECT * FROM work_orders WHERE service_no = ? OR service_no LIKE ?').all(serviceNo, `%${serviceNo}%`);
}

export function updateWorkOrderStatus(orderId, status) {
  const stmt = db.prepare(`
    UPDATE work_orders 
    SET status = ?, updated_at = ?
    WHERE order_id = ?
  `);
  const result = stmt.run(status, formatToWIB(), orderId);
  return result.changes > 0;
}

export function markWorkOrderAsSent(orderId) {
  const stmt = db.prepare(`
    UPDATE work_orders 
    SET telegram_sent = 1, updated_at = ?
    WHERE order_id = ?
  `);
  const result = stmt.run(formatToWIB(), orderId);
  return result.changes > 0;
}

export function isWorkOrderSent(orderId) {
  const row = db.prepare('SELECT telegram_sent FROM work_orders WHERE order_id = ?').get(orderId);
  return row ? row.telegram_sent === 1 : false;
}

export function getUnsendWorkOrders() {
  return db.prepare(`
    SELECT * FROM work_orders 
    WHERE (telegram_sent IS NULL OR telegram_sent = 0) 
    AND status != 'CLOSED' AND status != 'CANCELLED' AND status != 'RESOLVED'
    ORDER BY created_at DESC
  `).all();
}


// =========================
// Team Management
// =========================

export function getAllTeams() {
  // Get teams with member count
  const teams = db.prepare(`
    SELECT t.*, COUNT(tm.id) as member_count 
    FROM teams t 
    LEFT JOIN team_members tm ON t.id = tm.team_id 
    GROUP BY t.id 
    ORDER BY t.name
  `).all();
  return teams;
}

export function getTeamById(id) {
  const team = db.prepare('SELECT * FROM teams WHERE id = ?').get(id);
  if (!team) return null;

  const members = db.prepare('SELECT * FROM team_members WHERE team_id = ? ORDER BY name').all(id);
  return { ...team, members };
}

export function createTeam(name) {
  try {
    const stmt = db.prepare('INSERT INTO teams (name) VALUES (?)');
    const info = stmt.run(name);
    return { id: info.lastInsertRowid, name };
  } catch (error) {
    if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      throw new Error('Team name already exists');
    }
    throw error;
  }
}

export function updateTeam(id, name) {
  try {
    const stmt = db.prepare('UPDATE teams SET name = ? WHERE id = ?');
    const result = stmt.run(name, id);
    return result.changes > 0;
  } catch (error) {
    if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      throw new Error('Team name already exists');
    }
    throw error;
  }
}

export function deleteTeam(id) {
  const stmt = db.prepare('DELETE FROM teams WHERE id = ?');
  const result = stmt.run(id);
  return result.changes > 0;
}

// =========================
// Team Member Management
// =========================

export function addTeamMember(teamId, name, telegramUsername, nik = null, fullName = null) {
  const stmt = db.prepare('INSERT INTO team_members (team_id, name, telegram_username, nik, full_name) VALUES (?, ?, ?, ?, ?)');
  const info = stmt.run(teamId, name, telegramUsername, nik, fullName);
  return { id: info.lastInsertRowid, teamId, name, telegramUsername, nik, fullName };
}

export function updateTeamMember(id, name, telegramUsername, nik = null, fullName = null) {
  const stmt = db.prepare('UPDATE team_members SET name = ?, telegram_username = ?, nik = ?, full_name = ? WHERE id = ?');
  const result = stmt.run(name, telegramUsername, nik, fullName, id);
  return result.changes > 0;
}

export function deleteTeamMember(id) {
  const stmt = db.prepare('DELETE FROM team_members WHERE id = ?');
  const result = stmt.run(id);
  return result.changes > 0;
}

export function getTeamMembers(teamId) {
  return db.prepare('SELECT * FROM team_members WHERE team_id = ? ORDER BY name').all(teamId);
}

export function getSyncedRekap() {
    const database = getDb();
    return database.prepare("SELECT * FROM rekap WHERE is_synced_external = 1 AND category != 'DATEK' ORDER BY input_at DESC").all();
}

export function getAllTeamMembers() {
  return db.prepare(`
    SELECT tm.*, t.name as team_name 
    FROM team_members tm 
    LEFT JOIN teams t ON tm.team_id = t.id 
    ORDER BY t.name, tm.name
  `).all();
}

// =========================
// Rekap Management
// =========================

export function getAllRekap(startDate = null, endDate = null, search = null) {
  let query = 'SELECT * FROM rekap';
  const conditions = [];
  const params = [];

  if (startDate) {
    conditions.push('DATE(input_at) >= DATE(?)');
    params.push(startDate);
  }
  if (endDate) {
    conditions.push('DATE(input_at) <= DATE(?)');
    params.push(endDate);
  }
  if (search) {
    conditions.push('(no_inc LIKE ? OR no_inet LIKE ?)');
    params.push(`%${search}%`, `%${search}%`);
  }

  // Filter out DATEK from main list
  conditions.push("COALESCE(category, 'REGULER') != 'DATEK'");

  if (conditions.length > 0) {
    query += ' WHERE ' + conditions.join(' AND ');
  }

  query += ' ORDER BY input_at DESC';

  return db.prepare(query).all(...params);
}

/**
 * Get rekap entries by category
 * @param {string} category - Category to filter (REGULER, UNSPEC, TANGIBLE, MTC)
 */
export function getRekapByCategory(category) {
  return db.prepare(`
    SELECT * FROM rekap 
    WHERE category = ? OR (category IS NULL AND ? = 'REGULER')
    ORDER BY input_at DESC
  `).all(category, category);
}

export function getRekapById(id) {
  return db.prepare('SELECT * FROM rekap WHERE id = ?').get(id);
}

export function getRekapByNoInc(noInc) {
  return db.prepare('SELECT * FROM rekap WHERE UPPER(no_inc) = UPPER(?) ORDER BY input_at DESC LIMIT 1').get(noInc);
}

export function getDatekByNoInc(noInc) {
  return db.prepare("SELECT * FROM rekap WHERE UPPER(no_inc) = UPPER(?) AND UPPER(category) = 'DATEK' ORDER BY input_at DESC LIMIT 1").get(noInc);
}

export function getRekapByTelegramReplyId(replyId) {
  return db.prepare('SELECT * FROM rekap WHERE telegram_reply_id = ?').get(replyId);
}

export function getRekapByTelegramMessageId(messageId) {
  return db.prepare('SELECT * FROM rekap WHERE telegram_message_id = ?').get(messageId);
}

export function addRekap(rekap) {
  const stmt = db.prepare(`
    INSERT INTO rekap (no_inc, no_inet, rca, keterangan, alamat, reported_by, input_by, input_at, mat, tipe_tiket, odp, category, pid, description, datek_inputan, datek_real, id_valins, telegram_chat_id, telegram_message_id, is_synced_external, status, jam_open, jam_close, user_id, no_hp, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const inputAt = rekap.inputAt || formatToWIB();

  const info = stmt.run(
    rekap.noInc || null,
    rekap.noInet || null,
    rekap.rca || null,
    rekap.keterangan || null,
    rekap.alamat || null,
    rekap.reportedBy || null,
    rekap.inputBy || null,
    inputAt,
    rekap.mat || null,
    rekap.tipeTiket || null,
    rekap.odp || null,
    rekap.category || 'REGULER',
    rekap.pid || null,
    rekap.description || null,
    rekap.datekInputan || null,
    rekap.datekReal || null,
    rekap.idValins || null,
    rekap.telegramChatId || null,
    rekap.telegramMessageId || null,
    rekap.isSyncedExternal || 0,
    rekap.status || 'ON PROGRESS',
    rekap.jamOpen || null,
    rekap.jamClose || null,
    rekap.userId || null,
    rekap.noHp || null,
    rekap.updatedAt || null
  );

  return { id: info.lastInsertRowid, ...rekap, inputAt, status: rekap.status || 'ON PROGRESS' };
}

export function updateRekap(id, updates) {
  const allowedFields = [
    'no_inc', 'no_inet', 'rca', 'keterangan', 'alamat', 'reported_by', 'input_by',
    'datek_inputan', 'datek_real', 'id_valins', 'keterangan_pusat', 'tindak_lanjut',
    'category', 'tipe_tiket', 'pid', 'description', 'odp', 'mat',
    'telegram_chat_id', 'telegram_message_id', 'telegram_reply_id',
    'is_synced_external', 'status', 'jam_open', 'jam_close', 'user_id', 'no_hp', 'updated_at'
  ];
  const setClauses = [];
  const values = [];

  Object.keys(updates).forEach(key => {
    // Convert camelCase to snake_case
    const snakeKey = key.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`);
    if (allowedFields.includes(snakeKey)) {
      setClauses.push(`${snakeKey} = ?`);
      values.push(updates[key]);
    }
  });

  if (setClauses.length === 0) return false;

  values.push(id);
  const stmt = db.prepare(`UPDATE rekap SET ${setClauses.join(', ')} WHERE id = ?`);
  const result = stmt.run(...values);
  return result.changes > 0;
}



export function deleteRekap(id) {
  const stmt = db.prepare('DELETE FROM rekap WHERE id = ?');
  const result = stmt.run(id);
  return result.changes > 0;
}



/**
 * Update DATEK rekap entries from external Google Sheet
 * Syncs back Keterangan Pusat and Tindak Lanjut columns
 * @param {string} noInc - WO Number to match
 * @param {string} keteranganPusat - Keterangan from sheet
 * @param {string} tindakLanjut - Tindak Lanjut Daman from sheet
 */
export function updateDatekFromSheet(noInc, keteranganPusat, tindakLanjut, status = null) {
  const fields = ['keterangan_pusat = ?', 'tindak_lanjut = ?'];
  const params = [keteranganPusat || null, tindakLanjut || null];

  if (status) {
    fields.push('status = ?');
    params.push(status);
  }

  params.push(noInc);
  const stmt = db.prepare(`
    UPDATE rekap 
    SET ${fields.join(', ')}
    WHERE UPPER(no_inc) = UPPER(?) AND UPPER(category) = 'DATEK'
  `);
  const result = stmt.run(...params);
  return result.changes > 0;
}

/**
 * Get all DATEK rekap entries
 */
export function getAllDatekRekap() {
  return db.prepare(`
    SELECT * FROM rekap 
    WHERE category = 'DATEK'
    ORDER BY input_at DESC
  `).all();
}

/**
 * Get all PSB rekap entries
 */
export function getAllPsbRekap() {
  return db.prepare(`
    SELECT * FROM rekap 
    WHERE category = 'PSB'
    ORDER BY input_at DESC
  `).all();
}

/**
 * Sync rekap data to work orders
 * Updates work order status to CLOSED if NO INC matches rekap.no_inc
 * @returns Object with sync stats
 */
export function syncRekapToWorkOrders() {
  // Get all rekap NO INC values (excluding LAPOR WHATSAPP)
  const rekaps = db.prepare(`
    SELECT DISTINCT no_inc FROM rekap 
    WHERE no_inc IS NOT NULL AND no_inc != 'LAPOR WHATSAPP'
  `).all();

  const rekapNoIncs = rekaps.map(r => r.no_inc.toUpperCase());

  if (rekapNoIncs.length === 0) {
    return { updated: 0, total: 0 };
  }

  // Update work orders that have matching order_id with rekap no_inc
  let updatedCount = 0;
  const updateStmt = db.prepare(`
    UPDATE work_orders 
    SET status = 'CLOSED', updated_at = ?
    WHERE UPPER(order_id) = ? AND (status != 'CLOSED' OR status IS NULL)
  `);

  const now = formatToWIB();
  for (const noInc of rekapNoIncs) {
    const result = updateStmt.run(now, noInc);
    updatedCount += result.changes;
  }

  console.log(`🔄 Synced rekap to work orders: ${updatedCount} updated`);
  return { updated: updatedCount, total: rekapNoIncs.length };
}

// =========================
// Telegram Chats Management
// =========================

export function upsertTelegramChat(chat) {
  const stmt = db.prepare(`
    INSERT INTO telegram_chats (chat_id, title, type, username, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(chat_id) DO UPDATE SET
      title = excluded.title,
      type = excluded.type,
      username = excluded.username,
      updated_at = excluded.updated_at
  `);

  const now = formatToWIB();
  stmt.run(
    chat.chatId.toString(),
    chat.title || null,
    chat.type || null,
    chat.username || null,
    now
  );
}

export function getAllTelegramChats() {
  return db.prepare('SELECT * FROM telegram_chats ORDER BY updated_at DESC').all();
}

export function deleteTelegramChat(chatId) {
  const stmt = db.prepare('DELETE FROM telegram_chats WHERE chat_id = ?');
  const result = stmt.run(chatId);
  return result.changes > 0;
}

export function getChatByUsername(username) {
  // Remove @ if present
  const cleanUsername = username.replace(/^@/, '');
  return db.prepare('SELECT * FROM telegram_chats WHERE username = ? COLLATE NOCASE').get(cleanUsername);
}

// =========================
// Group Members Management
// =========================

export function upsertGroupMember(member) {
  const stmt = db.prepare(`
    INSERT INTO group_members (chat_id, user_id, username, first_name, last_name, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(chat_id, user_id) DO UPDATE SET
      username = excluded.username,
      first_name = excluded.first_name,
      last_name = excluded.last_name,
      updated_at = excluded.updated_at
  `);

  const now = formatToWIB();
  stmt.run(
    member.chatId.toString(),
    member.userId.toString(),
    member.username || null,
    member.firstName || null,
    member.lastName || null,
    now
  );
}

export function getGroupMembers(chatId) {
  return db.prepare(`
    SELECT * FROM group_members 
    WHERE chat_id = ? 
    ORDER BY username IS NULL, username, first_name
  `).all(chatId.toString());
}

export function getAllGroupMembers() {
  return db.prepare(`
    SELECT gm.*, tc.title as chat_title
    FROM group_members gm
    LEFT JOIN telegram_chats tc ON gm.chat_id = tc.chat_id
    ORDER BY tc.title, gm.username IS NULL, gm.username
  `).all();
}

export function deleteGroupMember(chatId, userId) {
  const stmt = db.prepare('DELETE FROM group_members WHERE chat_id = ? AND user_id = ?');
  const result = stmt.run(chatId.toString(), userId.toString());
  return result.changes > 0;
}

export function clearGroupMembers(chatId) {
  const stmt = db.prepare('DELETE FROM group_members WHERE chat_id = ?');
  const result = stmt.run(chatId.toString());
  return result.changes;
}

// =========================
// Schedule Status Management
// =========================

/**
 * Get all schedule statuses for a specific month/year
 */
export function getScheduleStatuses(month, year) {
  return db.prepare(`
    SELECT * FROM schedule_status 
    WHERE month = ? AND year = ?
    ORDER BY day, excel_name
  `).all(month, year);
}

/**
 * Get schedule status for a specific person on a specific date
 */
export function getScheduleStatus(excelName, day, month, year) {
  return db.prepare(`
    SELECT * FROM schedule_status 
    WHERE excel_name = ? AND day = ? AND month = ? AND year = ?
  `).get(excelName, day, month, year);
}

/**
 * Upsert schedule status (insert or update)
 * status: 'ACTIVE', 'SAKIT', 'CUTI', 'IZIN', 'LIBUR', 'OFF'
 */
export function upsertScheduleStatus(excelName, day, month, year, status, note = null) {
  const stmt = db.prepare(`
    INSERT INTO schedule_status (excel_name, day, month, year, status, note, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(excel_name, day, month, year) DO UPDATE SET
      status = excluded.status,
      note = excluded.note,
      updated_at = excluded.updated_at
  `);

  const now = formatToWIB();
  stmt.run(excelName, day, month, year, status, note, now);
  return getScheduleStatus(excelName, day, month, year);
}

/**
 * Delete schedule status (reset to active)
 */
export function deleteScheduleStatus(excelName, day, month, year) {
  const stmt = db.prepare(`
    DELETE FROM schedule_status 
    WHERE excel_name = ? AND day = ? AND month = ? AND year = ?
  `);
  const result = stmt.run(excelName, day, month, year);
  return result.changes > 0;
}

/**
 * Get schedule entries for a specific date with status info
 */
export function getScheduleEntriesWithStatus(day, month, year) {
  return db.prepare(`
    SELECT 
      se.id, se.name as excel_name, se.shift,
      sm.team_member_id, tm.name as member_name, tm.telegram_username, t.name as team_name,
      COALESCE(ss.status, 'ACTIVE') as attendance_status,
      ss.note as status_note
    FROM schedule_entries se
    LEFT JOIN schedule_mapping sm ON se.name = sm.excel_name
    LEFT JOIN team_members tm ON sm.team_member_id = tm.id
    LEFT JOIN teams t ON tm.team_id = t.id
    LEFT JOIN schedule_status ss ON se.name = ss.excel_name AND se.day = ss.day AND se.month = ss.month AND se.year = ss.year
    WHERE se.month = ? AND se.year = ? AND se.day = ?
    ORDER BY t.name, se.shift, tm.name
  `).all(month, year, day);
}

/**
 * Get all unique names from schedule_entries for a month/year
 */
export function getScheduleNames(month, year) {
  return db.prepare(`
    SELECT DISTINCT se.name as excel_name, sm.team_member_id, tm.name as member_name, t.name as team_name
    FROM schedule_entries se
    LEFT JOIN schedule_mapping sm ON se.name = sm.excel_name
    LEFT JOIN team_members tm ON sm.team_member_id = tm.id
    LEFT JOIN teams t ON tm.team_id = t.id
    WHERE se.month = ? AND se.year = ?
    ORDER BY t.name, se.name
  `).all(month, year);
}

// =========================
// Performance Management
// =========================

/**
 * Get performance config
 */
export function getPerformanceConfig() {
  const row = db.prepare('SELECT * FROM performance_config WHERE id = 1').get();
  return row || { id: 1, min_close_per_day: 1, min_close_per_month: 120, min_close_per_year: 1440 };
}

/**
 * Save performance config
 */
export function savePerformanceConfig(daily, monthly, yearly) {
  const current = getPerformanceConfig();
  const newDaily = daily !== undefined ? daily : current.min_close_per_day;
  const newMonthly = monthly !== undefined ? monthly : current.min_close_per_month;
  const newYearly = yearly !== undefined ? yearly : current.min_close_per_year;

  const stmt = db.prepare(`
    INSERT INTO performance_config (id, min_close_per_day, min_close_per_month, min_close_per_year, updated_at) 
    VALUES (1, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET 
      min_close_per_day = excluded.min_close_per_day,
      min_close_per_month = excluded.min_close_per_month,
      min_close_per_year = excluded.min_close_per_year,
      updated_at = excluded.updated_at
  `);
  const now = formatToWIB();
  stmt.run(newDaily, newMonthly, newYearly, now);
  return getPerformanceConfig();
}

/**
 * Get performance stats grouped by reported_by
 * Matches rekap.reported_by with team_members.full_name (case-insensitive)
 * @param {string} startDate - Start date in YYYY-MM-DD format
 * @param {string} endDate - End date in YYYY-MM-DD format
 * @param {string} period - 'daily' or 'monthly'
 * @param {string[]} tipeTickets - Optional array of tipe_tiket to filter (SQM, REGULER, WHATSAPP, UNSPEC, MTC, TANGIBLE)
 */
export function getPerformanceStats(startDate = null, endDate = null, period = 'daily', tipeTickets = null) {
  const conditions = [];
  const params = [];

  if (startDate && endDate) {
    conditions.push('DATE(r.input_at) BETWEEN DATE(?) AND DATE(?)');
    params.push(startDate, endDate);
  } else if (startDate) {
    conditions.push('DATE(r.input_at) >= DATE(?)');
    params.push(startDate);
  } else if (endDate) {
    conditions.push('DATE(r.input_at) <= DATE(?)');
    params.push(endDate);
  }

  conditions.push("r.reported_by IS NOT NULL AND r.reported_by != ''");
  conditions.push("COALESCE(r.category, 'REGULER') != 'DATEK'");

  // Tipe tiket filter
  if (tipeTickets && tipeTickets.length > 0) {
    const placeholders = tipeTickets.map(() => '?').join(', ');
    conditions.push(`UPPER(COALESCE(r.tipe_tiket, '')) IN (${placeholders})`);
    params.push(...tipeTickets.map(t => t.toUpperCase()));
  }

  const whereClause = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';

  // Get all rekap grouped by reported_by
  const query = `
    SELECT 
      r.reported_by,
      COUNT(*) as total_close,
      ${period === 'daily' ? "DATE(r.input_at) as period_date" : period === 'monthly' ? "strftime('%Y-%m', r.input_at) as period_date" : "strftime('%Y', r.input_at) as period_date"}
    FROM rekap r
    ${whereClause}
    GROUP BY r.reported_by, period_date
    ORDER BY period_date DESC, total_close DESC
  `;

  const stats = db.prepare(query).all(...params);

  // Get all team members for matching
  const teamMembers = db.prepare(`
    SELECT tm.id, tm.name, tm.nik, tm.full_name, tm.telegram_username, t.name as team_name
    FROM team_members tm
    LEFT JOIN teams t ON tm.team_id = t.id
  `).all();

  // Create a map for quick lookup (case-insensitive)
  const memberMap = new Map();
  teamMembers.forEach(tm => {
    if (tm.full_name) {
      memberMap.set(tm.full_name.toUpperCase(), tm);
    }
    // Also try matching with the name field (without workzone suffix)
    const cleanName = tm.name.replace(/\s*\[[^\]]+\]\s*$/, '').toUpperCase();
    if (!memberMap.has(cleanName)) {
      memberMap.set(cleanName, tm);
    }

    // Also index by telegram_username if available
    if (tm.telegram_username) {
      const username = tm.telegram_username.replace('@', '').toUpperCase();
      memberMap.set(username, tm);
      // Also add with @ just in case
      memberMap.set('@' + username, tm);
    }
  });

  // Enrich stats with team member info
  const enrichedStats = stats.map(stat => {
    const reportedByUpper = (stat.reported_by || '').toUpperCase();
    const member = memberMap.get(reportedByUpper);

    // Extract workzone from member name (e.g., "GUNTUR [TPI]" -> "TPI")
    let workzone = null;
    if (member && member.name) {
      const match = member.name.match(/\[([^\]]+)\]/);
      if (match) workzone = match[1];
    }

    return {
      reported_by: stat.reported_by,
      total_close: stat.total_close,
      period_date: stat.period_date,
      nik: member?.nik || null,
      full_name: member?.full_name || member?.name || stat.reported_by,
      workzone: workzone,
      team_name: member?.team_name || null,
      team_member_id: member?.id || null,
      telegram_username: member?.telegram_username || null
    };
  });

  return enrichedStats;
}

/**
 * Get rekap entries by reported_by (for drill-down)
 * @param {string[]} tipeTickets - Optional array of tipe_tiket to filter
 */
export function getRekapByReportedBy(reportedBy, startDate = null, endDate = null, tipeTickets = null) {
  let query = 'SELECT * FROM rekap WHERE UPPER(reported_by) = UPPER(?)';
  const params = [reportedBy];

  if (startDate && endDate) {
    query += ' AND DATE(input_at) BETWEEN DATE(?) AND DATE(?)';
    params.push(startDate, endDate);
  } else if (startDate) {
    query += ' AND DATE(input_at) >= DATE(?)';
    params.push(startDate);
  } else if (endDate) {
    query += ' AND DATE(input_at) <= DATE(?)';
    params.push(endDate);
  }

  query += " AND COALESCE(category, 'REGULER') != 'DATEK'";

  // Tipe tiket filter
  if (tipeTickets && tipeTickets.length > 0) {
    const placeholders = tipeTickets.map(() => '?').join(', ');
    query += ` AND UPPER(COALESCE(tipe_tiket, '')) IN (${placeholders})`;
    params.push(...tipeTickets.map(t => t.toUpperCase()));
  }

  query += ' ORDER BY input_at DESC';

  return db.prepare(query).all(...params);
}

/**
 * Get aggregated performance summary (total per technician across all dates)
 * @param {string[]} tipeTickets - Optional array of tipe_tiket to filter
 */
export function getPerformanceSummary(startDate = null, endDate = null, tipeTickets = null) {
  const conditions = [];
  const params = [];

  if (startDate && endDate) {
    conditions.push('DATE(r.input_at) BETWEEN DATE(?) AND DATE(?)');
    params.push(startDate, endDate);
  } else if (startDate) {
    conditions.push('DATE(r.input_at) >= DATE(?)');
    params.push(startDate);
  } else if (endDate) {
    conditions.push('DATE(r.input_at) <= DATE(?)');
    params.push(endDate);
  }

  conditions.push("r.reported_by IS NOT NULL AND r.reported_by != ''");
  conditions.push("COALESCE(r.category, 'REGULER') != 'DATEK'");

  // Tipe tiket filter
  if (tipeTickets && tipeTickets.length > 0) {
    const placeholders = tipeTickets.map(() => '?').join(', ');
    conditions.push(`UPPER(COALESCE(r.tipe_tiket, '')) IN (${placeholders})`);
    params.push(...tipeTickets.map(t => t.toUpperCase()));
  }

  const whereClause = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';

  const query = `
    SELECT 
      r.reported_by,
      COUNT(*) as total_close
    FROM rekap r
    ${whereClause}
    GROUP BY r.reported_by
    ORDER BY total_close DESC
  `;

  const stats = db.prepare(query).all(...params);

  // Get all team members for matching
  const teamMembers = db.prepare(`
    SELECT tm.id, tm.name, tm.nik, tm.full_name, tm.telegram_username, t.name as team_name
    FROM team_members tm
    LEFT JOIN teams t ON tm.team_id = t.id
  `).all();

  const memberMap = new Map();
  teamMembers.forEach(tm => {
    if (tm.full_name) {
      memberMap.set(tm.full_name.toUpperCase(), tm);
    }
    const cleanName = tm.name.replace(/\s*\[[^\]]+\]\s*$/, '').toUpperCase();
    if (!memberMap.has(cleanName)) {
      memberMap.set(cleanName, tm);
    }

    // Also index by telegram_username if available
    if (tm.telegram_username) {
      const username = (tm.telegram_username || '').replace('@', '').toUpperCase();
      memberMap.set(username, tm);
      memberMap.set('@' + username, tm);
    }
  });

  return stats.map(stat => {
    const reportedByUpper = (stat.reported_by || '').toUpperCase();
    const member = memberMap.get(reportedByUpper);

    // Extract workzone from member name (e.g., "GUNTUR [TPI]" -> "TPI")
    let workzone = null;
    if (member && member.name) {
      const match = member.name.match(/\[([^\]]+)\]/);
      if (match) workzone = match[1];
    }

    return {
      reported_by: stat.reported_by,
      total_close: stat.total_close,
      nik: member?.nik || null,
      full_name: member?.full_name || member?.name || stat.reported_by,
      workzone: workzone,
      team_name: member?.team_name || null,
      team_member_id: member?.id || null
    };
  });
}

/**
 * Get schedule workers for a specific date
 */
export function getWorkersForDate(day, month, year) {
  return db.prepare(`
    SELECT se.name as excel_name, se.shift, sm.team_member_id,
           tm.name as member_name, tm.telegram_username, t.name as team_name,
           COALESCE(ss.status, 'ACTIVE') as attendance_status
    FROM schedule_entries se
    LEFT JOIN schedule_mapping sm ON se.name = sm.excel_name
    LEFT JOIN team_members tm ON sm.team_member_id = tm.id
    LEFT JOIN teams t ON tm.team_id = t.id
    LEFT JOIN schedule_status ss ON se.name = ss.excel_name 
        AND se.day = ss.day AND se.month = ss.month AND se.year = ss.year
    WHERE se.month = ? AND se.year = ? AND se.day = ?
    ORDER BY t.name, se.shift, tm.name
  `).all(month, year, day);
}

export function updateWorkOrderCoordinates(orderId, lat, lng, streetAddress = null) {
  const stmt = db.prepare(`
    UPDATE work_orders 
    SET latitude = ?, longitude = ?, street_address = ?, updated_at = ?
    WHERE order_id = ?
  `);
  return stmt.run(lat, lng, streetAddress, formatToWIB(), orderId);
}


export function getOpenWorkOrdersWithCoords() {
  return db.prepare(`
    SELECT id, order_id, title, summary, status, priority, customer_type,
           workzone, witel, assigned_to, team, reported_date, expired_date,
           latitude, longitude, street_address, customer_segment, service_no,
           contact_phone, booking_date
    FROM work_orders 
    WHERE status NOT IN ('CLOSED', 'RESOLVED', 'CANCELLED')
    ORDER BY 
      CASE WHEN latitude IS NOT NULL AND longitude IS NOT NULL THEN 0 ELSE 1 END,
      reported_date DESC
  `).all();
}

// =========================
// Infra Orders Management
// =========================

export function addInfraOrder(order) {
  const stmt = db.prepare(`
    INSERT INTO infra_orders (order_id, kategori, keterangan, lokasi, foto_path, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const now = formatToWIB();
  const info = stmt.run(
    order.order_id,
    order.kategori || null,
    order.keterangan || null,
    order.lokasi || null,
    order.foto_path || null,
    order.status || 'OPEN',
    now,
    now
  );
  return { id: info.lastInsertRowid, ...order };
}

export function getOpenInfraOrders() {
  return db.prepare("SELECT * FROM infra_orders WHERE status = 'OPEN' ORDER BY created_at ASC").all();
}

export function getClosedInfraOrders() {
  return db.prepare("SELECT * FROM infra_orders WHERE status = 'CLOSED' ORDER BY updated_at DESC LIMIT 50").all();
}

export function getInfraOrderById(orderId) {
  return db.prepare("SELECT * FROM infra_orders WHERE order_id = ?").get(orderId);
}

export function closeInfraOrder(orderId) {
  const stmt = db.prepare("UPDATE infra_orders SET status = 'CLOSED', updated_at = ? WHERE order_id = ?");
  const result = stmt.run(formatToWIB(), orderId);
  return result.changes > 0;
}

export function deleteInfraOrder(orderId) {
  const result = db.prepare("DELETE FROM infra_orders WHERE order_id = ?").run(orderId);
  return result.changes > 0;
}
