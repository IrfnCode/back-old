import { addRekap, getAllDatekRekap, updateRekap, getRekapByTelegramReplyId, deleteRekap } from './database.js';
import { syncRekapToSheets, syncDatekToExternal, syncDatekFromExternal, deleteDatekFromExternal } from './gdocs.js';
import { formatToWIB } from '../utils/time.js';
import { google } from 'googleapis';
import { getConfig } from './database.js';
import { notifyDatekUpdate } from './telegram.js';

/**
 * Parse DATEK message content

 * Format:
 * /datek 
 * Wo Number : WO046951278
 * No Internet : 111655104355
 * Datek Inputan : ODP-RAI-FE/34
 * Datek Real Penarikan : ODP-RAI-FE/77
 * ID Valins ODP Real : 2738293
 */
function parseDatekData(text) {
    const rekap = {
        noInc: null,
        noInet: null,
        idValins: null,
        datekInputan: null,
        datekReal: null,
        category: 'DATEK',
        tipeTiket: 'DATEK'
    };

    // Extract WO Number
    const woMatch = text.match(/(?:WO\s*(?:Number|No)?)\s*[:：]\s*([^\n]+)/i);
    if (woMatch) {
        rekap.noInc = woMatch[1].trim();
    }

    // Extract No Internet
    const inetMatch = text.match(/(?:No\s*Internet)\s*[:：]\s*([^\n]+)/i);
    if (inetMatch) {
        rekap.noInet = inetMatch[1].trim();
    }

    // Extract ID Valins ODP Real
    const valinsMatch = text.match(/(?:ID\s*Valins(?:\s*ODP\s*Real)?)\s*[:：]\s*([^\n]+)/i);
    if (valinsMatch) {
        rekap.idValins = valinsMatch[1].trim();
    }

    // Extract Datek Inputan
    const datekInputMatch = text.match(/(?:Datek\s*Inputan)\s*[:：]\s*([^\n]+)/i);
    if (datekInputMatch) {
        rekap.datekInputan = datekInputMatch[1].trim();
    }

    // Extract Datek Real Penarikan
    const datekRealMatch = text.match(/(?:Datek\s*Real\s*(?:Penarikan)?)\s*[:：]\s*([^\n]+)/i);
    if (datekRealMatch) {
        rekap.datekReal = datekRealMatch[1].trim();
    }

    // If no WO Number found, generate one
    if (!rekap.noInc) {
        rekap.noInc = `DATEK-${Date.now()}`;
    }

    return rekap;
}

/**
 * Register the /datek command handler
 * @param {TelegramBot} bot - The Telegram bot instance
 */
export function registerDatekHandler(bot) {
    bot.onText(/\/datek(?:\s+(.+))?/s, async (msg, match) => {
        const chatId = msg.chat.id;
        const messageId = msg.message_id;
        const userId = msg.from.id;
        const username = msg.from.username || msg.from.first_name || `user_${userId}`;
        const inputText = match[1] || '';

        let textToParse = '';
        let reportedBy = username;

        // Check if this is a reply to another message
        if (msg.reply_to_message) {
            const repliedMessage = msg.reply_to_message;
            textToParse = repliedMessage.text || repliedMessage.caption || '';

            if (repliedMessage.from) {
                reportedBy = repliedMessage.from.username || repliedMessage.from.first_name || `user_${repliedMessage.from.id}`;
            }
        }

        // Combine text from replied message and input command
        if (inputText) {
            textToParse = textToParse + '\n' + inputText;
        }

        if (!textToParse || !textToParse.trim()) {
            await bot.sendMessage(chatId,
                `📋 *Cara penggunaan /datek:*

*Format:*
/datek
Wo Number : WO046951278
No Internet : 111655104355
Datek Inputan : ODP\\-RAI\\-FE/34
Datek Real Penarikan : ODP\\-RAI\\-FE/77
ID Valins ODP Real : 2738293

*Atau reply ke message yang berisi data datek, lalu ketik /datek*`,
                { parse_mode: 'MarkdownV2' }
            );
            return;
        }

        const rekap = parseDatekData(textToParse);
        rekap.inputBy = username;
        rekap.reportedBy = reportedBy;

        // Capture message metadata for reply/edit flow
        rekap.telegramChatId = chatId.toString();
        rekap.telegramMessageId = messageId;

        try {
            // Save to DB
            const saved = addRekap(rekap);

            const escMd = (text) => {
                if (!text) return '\\-';
                return text.toString().replace(/[_*[\]()~`>#+=|{}.!-]/g, '\\$&');
            };

            // This reply serves as the "Confirmation" AND the "Status Tracker"
            // We save this sent message's ID as telegram_reply_id later
            const sentMsg = await bot.sendMessage(chatId,
                `✅ *Rekap DATEK berhasil disimpan\\!*

📋 WO Number: ${escMd(rekap.noInc)}
🔌 No Internet: ${escMd(rekap.noInet)}
📡 Datek Inputan: ${escMd(rekap.datekInputan)}
📡 Datek Real: ${escMd(rekap.datekReal)}
🆔 ID Valins ODP Real: ${escMd(rekap.idValins)}
👷 Reported by: @${escMd(rekap.reportedBy)}
👤 Input by: @${escMd(username)}
⏰ Waktu: ${escMd(formatToWIB())} WIB

_Menunggu update dari Sheet\\.\\.\\._`,
                {
                    parse_mode: 'MarkdownV2',
                    reply_to_message_id: messageId // Reply to the user's command
                }
            );

            // Save the reply ID to allow editing later
            if (sentMsg) {
                updateRekap(saved.id, { telegramReplyId: sentMsg.message_id });
            }

            console.log(`📋 DATEK saved: ${rekap.noInc} by ${username}`);

            // Sync to Google Sheets (both internal and external)
            // We await external sync to ensure it's at least attempted immediately
            syncRekapToSheets().catch(e => console.error('Sync error:', e));
            
            console.log(`📊 [DATEK] Triggering targeted external sync for ${rekap.noInc}...`);
            const syncResult = await syncDatekToExternal(saved.id);
            if (syncResult && syncResult.success) {
                console.log(`📊 [DATEK] Immediate sync successful: ${syncResult.count} rows.`);
            } else {
                console.warn(`⚠️ [DATEK] Immediate sync might have deferred data or failed.`);
            }

        } catch (error) {
            console.error('Failed to save DATEK:', error);
            await bot.sendMessage(chatId, `❌ Gagal menyimpan DATEK\n\nError: ${error.message}`);
        }
    });

    console.log('📋 DATEK /datek handler registered');

    // /cancel handler
    bot.onText(/\/cancel/, async (msg) => {
        const chatId = msg.chat.id;

        // 1. Check if reply
        if (!msg.reply_to_message) {
            await bot.sendMessage(chatId, '❌ Reply pesan balasan bot yang berisi konfirmasi DATEK untuk menghapusnya.');
            return;
        }

        const replyToId = msg.reply_to_message.message_id;

        // 2. Find rekap by the bot's confirmation message ID
        const rekap = getRekapByTelegramReplyId(replyToId);

        if (!rekap) {
            await bot.sendMessage(chatId, '❌ Data tidak ditemukan atau sudah dihapus.');
            return;
        }

        // 3. Delete from DB
        deleteRekap(rekap.id);

        // 4. Delete from External Sheet (if synced)
        await bot.sendMessage(chatId, `⏳ Menghapus data ${rekap.no_inc}...`);

        // We delete from external sheet regardless of flag, just to be safe/sure? 
        // Or check rekap.no_inc
        if (rekap.no_inc) {
            const result = await deleteDatekFromExternal(rekap.no_inc);

            if (result && result.success) {
                await bot.sendMessage(chatId, `✅ Data ${rekap.no_inc} berhasil dihapus dari Database dan Google Sheet External (Shift Up).`);
            } else {
                const errMsg = result ? (result.error || result.message) : 'Unknown error';
                await bot.sendMessage(chatId, `⚠️ Data ${rekap.no_inc} dihapus dari Database, tetapi gagal hapus di Sheet External: ${errMsg}`);
            }
        } else {
            await bot.sendMessage(chatId, `✅ Data berhasil dihapus dari Database.`);
        }
    });

    // /testdatek - diagnostic command
    bot.onText(/\/testdatek/, async (msg) => {
        const chatId = msg.chat.id;
        let report = '🔍 DATEK Diagnostic\n\n';

        try {
            const config = getConfig();
            if (!config.gdocs_credentials) {
                await bot.sendMessage(chatId, '❌ No credentials');
                return;
            }
            report += '1️⃣ Credentials: ✅\n';

            let cred = typeof config.gdocs_credentials === 'string'
                ? JSON.parse(config.gdocs_credentials) : config.gdocs_credentials;
            if (cred.private_key) cred.private_key = cred.private_key.replace(/\\n/g, '\n');

            const auth = new google.auth.GoogleAuth({ credentials: cred, scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
            const sheets = google.sheets({ version: 'v4', auth });

            const SID = '1M5U-22d2ukDuy_bK7WCLgAQmPNHjnNrdidOOs8MdPOQ';
            const SNAME = 'DISINI';

            // List sheets
            try {
                const meta = await sheets.spreadsheets.get({ spreadsheetId: SID });
                const names = meta.data.sheets.map(s => s.properties.title);
                report += `2️⃣ Sheets: ${names.join(', ')}\n`;
                report += `3️⃣ Target "${SNAME}": ${names.includes(SNAME) ? '✅' : '❌'}\n`;
            } catch (e) {
                await bot.sendMessage(chatId, report + `\n❌ Gagal akses spreadsheet: ${e.message}`);
                return;
            }

            // Read existing
            let existing = [];
            try {
                const r = await sheets.spreadsheets.values.get({ spreadsheetId: SID, range: `${SNAME}!A:I` });
                existing = r.data.values || [];
            } catch (e) { /* empty */ }
            report += `4️⃣ Rows di sheet: ${existing.length}\n`;

            // SHOW LAST 5 ROWS
            if (existing.length > 0) {
                report += '\n📋 5 Data Terakhir di Sheet:\n';
                const startIdx = Math.max(1, existing.length - 5);
                for (let i = startIdx; i < existing.length; i++) {
                    const row = existing[i];
                    const wo = row[1] || '(kosong)';
                    const datek = row[5] || '(kosong)'; // Column F = Datek Inputan
                    // Clean up cell content for display
                    const clean = (val) => (val || '').toString().trim().substring(0, 15);
                    report += `   Row ${i + 1}: [B]${clean(wo)} | [F]${clean(datek)}\n`;
                }
                report += '\n';
            }

            // Existing WOs (col B = index 1)
            const woSet = new Set();
            for (let i = 1; i < existing.length; i++) {
                if (existing[i] && existing[i][1]) woSet.add(existing[i][1].toString().trim().toUpperCase());
            }
            report += `5️⃣ WO di sheet: ${woSet.size}\n`;

            // DB data
            const dbData = getAllDatekRekap();
            report += `6️⃣ DB DATEK: ${dbData.length}\n`;

            // Comparison
            let inSheetCount = 0;
            let newCount = 0;
            dbData.forEach(d => {
                if (woSet.has((d.no_inc || '').toUpperCase())) inSheetCount++;
                else newCount++;
            });
            report += `   - Sudah di sheet: ${inSheetCount}\n`;
            report += `   - Belum di sheet: ${newCount}\n`;

            const newOnes = dbData.filter(r => {
                const w = (r.no_inc || '').trim().toUpperCase();
                return w && !woSet.has(w);
            });

            if (newOnes.length > 0) {
                // Find empty row (append at end)
                let emptyRow = existing.length + 1;
                report += `7️⃣ Target empty row: ${emptyRow}\n`;

                // Try manual sync via function
                report += `8️⃣ Mencoba sync manual...\n`;
                try {
                    const result = await syncDatekToExternal();
                    if (result && result.success) {
                        report += `   ✅ Berhasil sync: ${result.count} data\n`;
                    } else {
                        report += `   ⚠️ Sync result null\n`;
                    }
                } catch (e) {
                    report += `   ❌ Sync error: ${e.message}\n`;
                }
            } else {
                report += '7️⃣ Semua data DB sudah ada di sheet (tidak perlu sync)\n';
            }

            await bot.sendMessage(chatId, report);
        } catch (error) {
            report += `\n❌ ${error.message}`;
            await bot.sendMessage(chatId, report);
        }
    });

    console.log('🔍 DATEK /testdatek diagnostic handler registered');
}
