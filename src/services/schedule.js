/**
 * Schedule & Auto-Send Service
 * Handles Excel upload, schedule parsing, and auto-send with rotation
 */

import * as XLSX from 'xlsx';
import { formatToWIB, getWIBHour, getWIBDay, getWIBMonth, getWIBYear } from '../utils/time.js';
import { sendWorkOrderNotification, getBotInstance } from './telegram.js';
import { getConfig, saveConfig, markWorkOrderAsSent, isWorkOrderSent } from './database.js';
import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const dbPath = join(__dirname, '..', '..', 'data', 'database.sqlite');

let db;
function getDb() {
    if (!db) {
        db = new Database(dbPath);
    }
    return db;
}

// State for auto-send
let isAutoSendActive = false;

export function startAutoSend() {
    isAutoSendActive = true;
    saveConfig('autoSendActive', 'true');
    console.log('🚀 Auto-send started');
    return true;
}

export function stopAutoSend() {
    isAutoSendActive = false;
    saveConfig('autoSendActive', 'false');
    console.log('🛑 Auto-send stopped');
    return true;
}

/**
 * Parse Excel schedule file and save to database
 * Format Excel user:
 * - Baris dengan nama hari (SN, SL, RB, KM, JM, SB, MG) 
 * - Baris dengan tanggal (1, 2, 3, ... 31)
 * - Kolom B: NAMA
 * - Data shift di kolom setelah NAMA (C+)
 * - "JANUARI 2026" ada di cell terakhir baris tanggal
 */
export function parseAndSaveSchedule(fileBuffer) {
    const workbook = XLSX.read(fileBuffer, { type: 'buffer' });
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];

    const data = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });

    if (data.length < 3) {
        throw new Error('Excel file must have at least 3 rows');
    }

    // Parse month/year from anywhere in the sheet
    let month = getWIBMonth();
    let year = getWIBYear();

    const monthNames = {
        'JANUARI': 1, 'FEBRUARI': 2, 'MARET': 3, 'APRIL': 4,
        'MEI': 5, 'JUNI': 6, 'JULI': 7, 'AGUSTUS': 8,
        'SEPTEMBER': 9, 'OKTOBER': 10, 'NOVEMBER': 11, 'DESEMBER': 12
    };

    // Search for month/year in all cells of first 30 rows
    for (let i = 0; i < Math.min(30, data.length); i++) {
        const row = data[i];
        for (let j = 0; j < row.length; j++) {
            const cellText = String(row[j] || '').toUpperCase();
            for (const [monthName, monthNum] of Object.entries(monthNames)) {
                if (cellText.includes(monthName)) {
                    month = monthNum;
                    const yearMatch = cellText.match(/20\d{2}/);
                    if (yearMatch) {
                        year = parseInt(yearMatch[0]);
                    }
                }
            }
        }
    }

    console.log(`📅 Detected schedule for: ${month}/${year}`);

    // Find NAMA column
    let nameColIndex = -1;
    let nameRowIndex = -1;

    for (let i = 0; i < Math.min(10, data.length); i++) {
        const row = data[i];
        for (let j = 0; j < row.length; j++) {
            const cell = String(row[j] || '').toUpperCase().trim();
            if (cell === 'NAMA' || cell === 'NAME') {
                nameColIndex = j;
                nameRowIndex = i;
                break;
            }
        }
        if (nameColIndex >= 0) break;
    }

    if (nameColIndex < 0) {
        throw new Error('Could not find "NAMA" column in Excel');
    }

    // Find row with dates (1, 2, 3...) - look for consecutive numbers
    let dateRowIndex = -1;
    let dayStartColIndex = -1;

    for (let i = 0; i < Math.min(10, data.length); i++) {
        const row = data[i];
        let consecutiveDates = 0;
        let firstDateCol = -1;

        for (let j = nameColIndex + 1; j < Math.min(row.length, 40); j++) {
            const cell = String(row[j] || '').trim();
            const num = parseInt(cell);

            if (!isNaN(num) && num >= 1 && num <= 31) {
                if (firstDateCol < 0) firstDateCol = j;
                consecutiveDates++;
                if (consecutiveDates >= 5) {
                    dateRowIndex = i;
                    dayStartColIndex = firstDateCol;
                    break;
                }
            } else {
                consecutiveDates = 0;
                firstDateCol = -1;
            }
        }
        if (dateRowIndex >= 0) break;
    }

    if (dayStartColIndex < 0) {
        dayStartColIndex = nameColIndex + 1;
        dateRowIndex = nameRowIndex;
    }

    // Data rows start after both NAMA row and date row
    const dataStartRow = Math.max(nameRowIndex, dateRowIndex) + 1;

    console.log(`📊 Name col: ${nameColIndex}, Date row: ${dateRowIndex}, Days col: ${dayStartColIndex}, Data row: ${dataStartRow}`);

    const database = getDb();
    database.prepare('DELETE FROM schedule_entries WHERE month = ? AND year = ?').run(month, year);

    // Get all team members for auto-matching
    const teamMembers = database.prepare('SELECT id, name FROM team_members').all();
    const memberMap = new Map();
    teamMembers.forEach(tm => {
        // Remove [WORKZONE] suffix from member name for matching
        // e.g. "HANDREAN SALEH [TPI]" becomes "HANDREAN SALEH"
        const cleanName = tm.name.replace(/\s*\[[^\]]+\]\s*$/, '').toUpperCase().trim();
        memberMap.set(cleanName, tm.id);
    });

    const insertStmt = database.prepare(`
        INSERT OR REPLACE INTO schedule_entries (name, month, year, day, shift) VALUES (?, ?, ?, ?, ?)
    `);
    const mappingStmt = database.prepare(`INSERT OR IGNORE INTO schedule_mapping (excel_name) VALUES (?)`);
    const autoMatchStmt = database.prepare(`UPDATE schedule_mapping SET team_member_id = ? WHERE excel_name = ? AND team_member_id IS NULL`);

    let entriesCount = 0;
    let namesCount = 0;

    // Build date mapping from the date row
    const dateMapping = {};
    if (dateRowIndex >= 0 && data[dateRowIndex]) {
        const dateRow = data[dateRowIndex];
        for (let j = dayStartColIndex; j < dateRow.length; j++) {
            const num = parseInt(String(dateRow[j] || '').trim());
            if (!isNaN(num) && num >= 1 && num <= 31) {
                dateMapping[j] = num;
            }
        }
    }

    console.log(`📆 Found ${Object.keys(dateMapping).length} date columns`);

    // Process data rows
    for (let i = dataStartRow; i < data.length; i++) {
        const row = data[i];
        const name = String(row[nameColIndex] || '').trim();

        // Skip invalid rows
        const nameUpper = name.toUpperCase();
        const skipPatterns = ['KETERANGAN', 'NAMA', 'CUTI', 'LIBUR', 'PENGGANTI', 'NOTED', 'SETIAP', 'WAJIB', 'YANG', 'SAKIT'];
        if (!name || /^\d+$/.test(name) || /\d{1,2}[:.]\d{2}/.test(name) ||
            nameUpper.startsWith('M :') || nameUpper.startsWith('SHIFT') || nameUpper.startsWith('CT') || nameUpper.startsWith('PL') || nameUpper.startsWith('L :') ||
            skipPatterns.some(p => nameUpper.includes(p))) {
            continue;
        }

        mappingStmt.run(name);

        // Auto-match with team member by name
        const matchedMemberId = memberMap.get(name.toUpperCase().trim());
        if (matchedMemberId) {
            autoMatchStmt.run(matchedMemberId, name);
        }

        namesCount++;

        for (const [colStr, day] of Object.entries(dateMapping)) {
            const colIndex = parseInt(colStr);
            if (colIndex >= row.length) continue;

            const shiftValue = String(row[colIndex] || '').trim().toUpperCase();
            if (['M', 'A', 'SHIFT', 'SH', 'SIST', 'L', 'CT', 'PL'].includes(shiftValue)) {
                insertStmt.run(name, month, year, day, shiftValue);
                entriesCount++;
            }
        }
    }

    console.log(`✅ Saved ${entriesCount} entries for ${namesCount} people`);
    return { month, year, entriesCount, namesCount };
}

/**
 * Clear all schedule entries and mappings
 */
export function clearAllSchedule() {
    const database = getDb();
    const entriesDeleted = database.prepare('DELETE FROM schedule_entries').run().changes;
    const mappingsDeleted = database.prepare('DELETE FROM schedule_mapping').run().changes;
    const rotationReset = database.prepare('DELETE FROM auto_send_config').run().changes;
    console.log(`🗑️ Cleared ${entriesDeleted} entries, ${mappingsDeleted} mappings, ${rotationReset} rotations`);
    return { entriesDeleted, mappingsDeleted, rotationReset };
}

/**
 * Get all schedule mappings with team member info
 */
export function getScheduleMappings() {
    const database = getDb();
    return database.prepare(`
        SELECT sm.id, sm.excel_name, sm.team_member_id, tm.name as member_name,
               tm.telegram_username, t.name as team_name
        FROM schedule_mapping sm
        LEFT JOIN team_members tm ON sm.team_member_id = tm.id
        LEFT JOIN teams t ON tm.team_id = t.id
        ORDER BY sm.excel_name
    `).all();
}

/**
 * Update a schedule mapping
 */
export function updateScheduleMapping(id, teamMemberId) {
    const database = getDb();
    return database.prepare('UPDATE schedule_mapping SET team_member_id = ? WHERE id = ?').run(teamMemberId, id).changes > 0;
}

/**
 * Update a specific schedule entry (shift)
 */
export function updateScheduleEntry(name, day, month, year, newShift) {
    const database = getDb();

    // Check if entry exists
    const existing = database.prepare('SELECT * FROM schedule_entries WHERE name = ? AND day = ? AND month = ? AND year = ?').get(name, day, month, year);

    if (existing) {
        // Update existing
        return database.prepare('UPDATE schedule_entries SET shift = ? WHERE name = ? AND day = ? AND month = ? AND year = ?')
            .run(newShift, name, day, month, year).changes > 0;
    } else {
        // Insert new (if for some reason it doesn't exist but we want to set it)
        return database.prepare('INSERT INTO schedule_entries (name, day, month, year, shift) VALUES (?, ?, ?, ?, ?)')
            .run(name, day, month, year, newShift).changes > 0;
    }
}

/**
 * Get workers for today by workzone
 * Excludes workers with non-ACTIVE status (SAKIT, CUTI, IZIN, etc.)
 */
export function getTodayWorkers(workzone) {
    const database = getDb();
    const day = getWIBDay();
    const month = getWIBMonth();
    const year = getWIBYear();

    return database.prepare(`
        SELECT se.name as excel_name, se.shift, sm.team_member_id,
               tm.nik, tm.name as member_name, tm.telegram_username, t.name as team_name,
               COALESCE(ss.status, 'ACTIVE') as attendance_status,
               ss.note as status_note
        FROM schedule_entries se
        LEFT JOIN schedule_mapping sm ON se.name = sm.excel_name
        LEFT JOIN team_members tm ON sm.team_member_id = tm.id
        LEFT JOIN teams t ON tm.team_id = t.id
        LEFT JOIN schedule_status ss ON se.name = ss.excel_name 
            AND se.day = ss.day AND se.month = ss.month AND se.year = ss.year
        WHERE se.month = ? AND se.year = ? AND se.day = ?
        AND se.shift IN ('M', 'A', 'SHIFT', 'SH', 'SIST')
        AND t.name LIKE ?
        AND (ss.status IS NULL OR ss.status = 'ACTIVE')
        ORDER BY tm.name
    `).all(month, year, day, `%${workzone}%`);
}

/**
 * Get workers to tag based on current time and workzone
 */
export function getWorkersToTag(workzone) {
    const hour = getWIBHour();
    const workers = getTodayWorkers(workzone);

    const shiftOnlyTeams = ['MTC', 'TANGIBLE'];
    const isShiftOnly = shiftOnlyTeams.includes(workzone.toUpperCase());

    let filtered = [];

    if (isShiftOnly) {
        // MTC & TANGIBLE: ONLY tag if shift is SHIFT/SH/SIST, regardless of current hour
        // (Assuming they are available 24h or specifically during those shifts)
        // User said: "mereka masuk hanya kalau mereka dapat jadwal SHIFT"
        filtered = workers.filter(w => ['SHIFT', 'SH', 'SIST'].includes(w.shift));
    } else {
        // Standard logic for other teams
        if (hour >= 8 && hour < 10) {
            filtered = workers.filter(w => ['M', 'A'].includes(w.shift));
        } else if (hour >= 10 && hour < 17) {
            filtered = workers.filter(w => ['M', 'A', 'SHIFT', 'SH', 'SIST'].includes(w.shift));
        } else if (hour >= 17 && hour < 22) {
            filtered = workers.filter(w => ['SHIFT', 'SH', 'SIST'].includes(w.shift));
        }
    }

    return filtered;
}

export function getRotationIndex(workzone) {
    const database = getDb();
    const row = database.prepare('SELECT rotation_index FROM auto_send_config WHERE workzone = ?').get(workzone);
    return row ? row.rotation_index : 0;
}

export function updateRotationIndex(workzone, index) {
    const database = getDb();
    database.prepare(`
        INSERT INTO auto_send_config (workzone, rotation_index, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(workzone) DO UPDATE SET rotation_index = ?, updated_at = ?
    `).run(workzone, index, formatToWIB(), index, formatToWIB());
}

/**
 * Send work order notification with rotation tagging
 */
export async function sendWorkOrderWithRotation(workOrder) {
    const orderId = workOrder.order_id || workOrder.orderId;

    // Check if already sent
    if (isWorkOrderSent(orderId)) {
        console.log(`Debug Auto-Send: WO ${orderId} skipped (already sent)`);
        return false;
    }

    const segment = (workOrder.customer_segment || workOrder.customerSegment || '').toUpperCase();
    console.log(`Debug Auto-Send: WO ${orderId} Segment: "${segment}"`);

    // Check strict segment matching
    // Make sure we match PL_TSEL, PL-TSEL, etc.
    if (!segment.includes('PL_TSEL') && !segment.includes('PL-TSEL')) {
        console.log(`Debug Auto-Send: WO ${orderId} skipped - Segment mismatch. Expected PL_TSEL, got "${segment}"`);
        return false;
    }

    const workzone = workOrder.workzone || '';
    console.log(`Debug Auto-Send: WO ${orderId} Workzone: "${workzone}"`);

    if (!workzone) {
        console.log(`Debug Auto-Send: WO ${orderId} skipped - No workzone`);
        return false;
    }

    const config = getConfig();
    const chatId = config.telegramChatId || process.env.TELEGRAM_CHAT_ID;
    if (!chatId) {
        console.log(`Debug Auto-Send: WO ${orderId} skipped - No Telegram Chat ID config`);
        return false;
    }

    const workers = getWorkersToTag(workzone);
    console.log(`Debug Auto-Send: Found ${workers.length} workers for ${workzone}: ${workers.map(w => w.member_name).join(', ')}`);

    if (workers.length === 0) {
        console.log(`Debug Auto-Send: No eligible workers for ${workzone}, sending without tags`);
    }

    let rotationIndex = 0;
    const selected = [];

    if (workers.length > 0) {
        rotationIndex = getRotationIndex(workzone);
        if (rotationIndex >= workers.length) rotationIndex = 0;

        const tagsCount = 2;
        for (let i = 0; i < tagsCount && i < workers.length; i++) {
            selected.push(workers[(rotationIndex + i) % workers.length]);
        }

        updateRotationIndex(workzone, (rotationIndex + tagsCount) % workers.length);
    }

    const tags = selected
        .filter(w => w.telegram_username)
        .map(w => {
            let u = w.telegram_username;
            if (!u.startsWith('@')) u = '@' + u;
            return u;
        })
        .join(' ');

    const tagNames = selected.map(w => w.member_name || w.excel_name).join(', ');
    console.log(`📤 Auto-send WO ${workOrder.order_id || workOrder.orderId} to ${workzone}: ${tagNames}`);

    try {
        await sendWorkOrderNotification(chatId, workOrder, tags);
        // Mark as sent in database
        markWorkOrderAsSent(orderId);
        return true;
    } catch (error) {
        console.error('❌ Auto-send failed:', error.message);
        return false;
    }
}

// Function definitions removed (duplicates)

export function isAutoSendRunning() {
    return isAutoSendActive;
}

export function getAllTeamMembersForMapping() {
    const database = getDb();
    return database.prepare(`
        SELECT tm.id, tm.name, tm.telegram_username, t.name as team_name
        FROM team_members tm
        LEFT JOIN teams t ON tm.team_id = t.id
        ORDER BY t.name, tm.name
    `).all();
}

export function getTodaySchedulePreview() {
    const database = getDb();
    const day = getWIBDay();
    const month = getWIBMonth();
    const year = getWIBYear();

    const rows = database.prepare(`
        SELECT se.name as excel_name, se.shift, sm.team_member_id,
               tm.name as member_name, tm.telegram_username, t.name as team_name
        FROM schedule_entries se
        LEFT JOIN schedule_mapping sm ON se.name = sm.excel_name
        LEFT JOIN team_members tm ON sm.team_member_id = tm.id
        LEFT JOIN teams t ON tm.team_id = t.id
        WHERE se.month = ? AND se.year = ? AND se.day = ?
        AND se.shift IN ('M', 'A', 'SHIFT', 'SH', 'SIST')
        AND t.name IS NOT NULL
        ORDER BY t.name, se.shift, tm.name
    `).all(month, year, day);

    // Post-process to filter MTC/TANGIBLE specific shifts
    return rows.filter(row => {
        const team = (row.team_name || '').toUpperCase();
        if (team.includes('MTC') || team.includes('TANGIBLE')) {
            // Strict filter for MTC/TANGIBLE: Only allow SHIFT/SH/SIST
            return ['SHIFT', 'SH', 'SIST'].includes(row.shift);
        }
        return true;
    });
}

/**
 * Get all technicians in schedule for a specific date (Full Area: TPI, KMS, KIJ, TUB)
 * Includes both working and OFF/L shifts.
 */
export function getScheduleForReport() {
    const database = getDb();
    const day = getWIBDay();
    const month = getWIBMonth();
    const year = getWIBYear();

    return database.prepare(`
        SELECT se.name as excel_name, se.shift, sm.team_member_id,
               tm.nik, tm.name as member_name, tm.telegram_username, t.name as team_name
        FROM schedule_entries se
        LEFT JOIN schedule_mapping sm ON se.name = sm.excel_name
        LEFT JOIN team_members tm ON sm.team_member_id = tm.id
        LEFT JOIN teams t ON tm.team_id = t.id
        WHERE se.month = ? AND se.year = ? AND se.day = ?
        ORDER BY t.name, tm.name
    `).all(month, year, day);
}
