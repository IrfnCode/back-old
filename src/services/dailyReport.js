// Daily Report Service - Updated for Testing
import { getTodayWorkers, getScheduleForReport } from './schedule.js';
import { getBotInstance, sendFormattedMessage } from './telegram.js';
import { getConfig, getAllTeamMembers, saveConfig } from './database.js';
import { getWIBDate, formatToWIB, getWIBDateString } from '../utils/time.js';
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

export function generateDailyReport() {
    console.log('[DailyReport] Generating daily report for FULL AREA (TPI, KMS, KIJ, TUB)...');
    const database = getDb();

    // 1. Get Today date info (WIB)
    const now = getWIBDate();
    const todayStr = getWIBDateString();
    const dateDisplay = now.toLocaleDateString('id-ID', { day: 'numeric', month: 'long', year: 'numeric' });
    const hourDisplay = now.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' }) + ' WIB';

    // 2. Get All Scheduled Technicians for Today (Source of Truth)
    let masterSchedule = getScheduleForReport();

    // Filter out admins who don't take tickets
    const excludedNames = ['TAFRIZAL', 'IRFAN ADI SUCIPTO'];
    masterSchedule = masterSchedule.filter(s => {
        const name = (s.member_name || s.excel_name || '').toUpperCase();
        return !excludedNames.some(ext => name.includes(ext));
    });

    if (masterSchedule.length === 0) {
        console.warn('[DailyReport] No scheduled technicians found for today.');
        return null;
    }

    // 3. Fetch ALL Today's Tickets for EVERYONE
    const sqlTickets = `
        SELECT input_by as nik, MAX(reported_by) as nama, category, COUNT(*) as count
        FROM rekap
        WHERE DATE(input_at) = DATE(?)
        GROUP BY input_by, category
    `;
    const ticketStats = database.prepare(sqlTickets).all(todayStr);

    // 4. Track processed NIKs to catch completely unscheduled ones
    const processedNiks = new Set();

    // 5. Process categories
    const activeWorkers = [];
    const zeroCloseWorkers = [];
    const liburWorkers = [];

    let totalAllClose = 0;
    const workingTags = [];
    const workingShifts = ['M', 'A', 'SHIFT', 'SH', 'SIST'];

    for (const item of masterSchedule) {
        if (item.nik) processedNiks.add(item.nik);

        const shift = (item.shift || '').toUpperCase();
        const isWorking = workingShifts.includes(shift);

        const stats = ticketStats.filter(s => s.nik === item.nik);
        const categories = {
            SQM: stats.find(s => s.category === 'SQM')?.count || 0,
            REGULER: stats.find(s => s.category === 'REGULER')?.count || 0,
            UNSPEC: stats.find(s => s.category === 'UNSPEC' || s.category === 'UNDERSPEC')?.count || 0,
            INFRACARE: stats.find(s => s.category === 'INFRACARE')?.count || 0
        };
        const total = categories.SQM + categories.REGULER + categories.UNSPEC + categories.INFRACARE;

        const cleanName = (item.member_name || item.excel_name).replace(/\s*\[.*?\]/g, '').trim();

        const data = {
            name: cleanName,
            nik: item.nik,
            tag: item.telegram_username,
            stats: categories,
            total,
            shift
        };

        if (isWorking || total > 0) {
            if (item.telegram_username) {
                let tag = item.telegram_username;
                if (!tag.startsWith('@')) tag = '@' + tag;
                const escapedTag = tag.replace(/_/g, '\\_');
                workingTags.push(escapedTag);
            }

            if (total > 0) {
                if (!isWorking) data.name = `${data.name} (OFF/LM)`;
                activeWorkers.push(data);
                totalAllClose += total;
            } else {
                zeroCloseWorkers.push(data);
            }
        } else {
            liburWorkers.push(data);
        }
    }

    // 6. Sort Active Workers by total close
    activeWorkers.sort((a, b) => b.total - a.total);

    // 7. Format Message
    let message = `*LAPORAN HARIAN CLOSE MORENA - TANJUNGPINANG*\n`;
    message += `📅 Tanggal: ${dateDisplay}\n`;
    message += `⏰ Update: ${hourDisplay}\n\n`;

    // Section 1: Active
    message += `✅ *REKAP CLOSE PER TEKNISI:*\n\n`;
    for (const item of activeWorkers) {
        message += `👤 *${item.name.toUpperCase()}*\n`;
        message += `├─ SQM: ${item.stats.SQM}\n`;
        message += `├─ REGULER: ${item.stats.REGULER}\n`;
        message += `├─ UNSPEC: ${item.stats.UNSPEC}\n`;
        message += `└─ INFRACARE: ${item.stats.INFRACARE}\n`;
        message += `Total: ${item.total} WO\n\n`;
    }

    // Section 2: Zero Close
    message += `⚠️ *TEKNISI HADIR (ZERO CLOSE):*\n`;
    if (zeroCloseWorkers.length > 0) {
        for (const item of zeroCloseWorkers) {
            message += `• ${item.name}\n`;
        }
    } else {
        message += `(Tidak ada)\n`;
    }
    message += `\n`;

    // Section 3: Libur
    message += `😴 *TEKNISI LIBUR / OFF:*\n`;
    if (liburWorkers.length > 0) {
        for (const item of liburWorkers) {
            message += `• ${item.name}\n`;
        }
    } else {
        message += `(Semua masuk)\n`;
    }
    message += `\n`;

    // Section 4: Resume
    message += `📊 *RESUME TOTAL AREA:*\n`;
    message += `✅ Total WO Close: ${totalAllClose} WO\n`;
    message += `👷 Teknisi Masuk: ${activeWorkers.length + zeroCloseWorkers.length} Orang\n`;
    message += `😴 Teknisi Libur: ${liburWorkers.length} Orang\n\n`;

    // Tags
    if (workingTags.length > 0) {
        // Group tags in lines of 3-4
        for (let i = 0; i < workingTags.length; i += 3) {
            message += workingTags.slice(i, i + 3).join(' ') + '\n';
        }
        message += `\n`;
    }

    message += `Laporan ini digenerate otomatis oleh System Workorder Manager.`;

    return message;
}

export async function sendDailyReport() {
    const message = generateDailyReport();
    if (!message) return;

    const config = getConfig();
    const chatId = config.telegramReportChatId || config.telegramChatId;

    if (!chatId) {
        console.error('[DailyReport] No Telegram Chat ID configured for report.');
        return;
    }

    try {
        await sendFormattedMessage(chatId, message);
        console.log('[DailyReport] Report sent to Telegram successfully.');
        saveConfig('lastDailyReportSent', new Date().toISOString());
        return { success: true };
    } catch (error) {
        console.error('[DailyReport] Failed to send report:', error.message);
        return { success: false, error: error.message };
    }
}

let reportIntervalId = null;

export function initDailyReport() {
    const config = getConfig();
    const isEnabled = config.dailyReportEnabled === 'true';
    const intervalMinutes = parseFloat(config.dailyReportInterval || '0');

    console.log(`[DailyReport] Initializing: Enabled=${isEnabled}, Interval=${intervalMinutes}m`);

    if (reportIntervalId) {
        console.log('[DailyReport] Clearing existing interval...');
        clearInterval(reportIntervalId);
        reportIntervalId = null;
    }

    if (isEnabled && intervalMinutes > 0) {
        const ms = intervalMinutes * 60 * 1000;
        console.log(`[DailyReport] Starting new interval: ${ms}ms`);
        reportIntervalId = setInterval(sendDailyReport, ms);
    } else {
        console.log('[DailyReport] Service remains STOPPED (Disabled or Interval=0)');
    }
}

export function restartDailyReport() {
    initDailyReport();
}

export function stopDailyReport() {
    if (reportIntervalId) {
        clearInterval(reportIntervalId);
        reportIntervalId = null;
    }
}
