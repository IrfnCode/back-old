import { addRekap, getConfig } from './database.js';
import { syncRekapToSheets } from './gdocs.js';
import { formatToWIB } from '../utils/time.js';

/**
 * Parse MTC (Maintenance) message content
 * Format:
 * /mtc 
 * TIKET : INC45604724
 * PID : 26MC14R151-0054
 * QE AKSES PREV-PLAN URGENT PERGANTIAN TIANG KEROPOS LOKASI JL PUTRI BALKIS 3 CATUAN KMS-FAD-D01
 * Pindah Tiang ✅
 * Cat ✅
 * Cor ✅
 */
function parseMtcData(text) {
    const rekap = {
        noInc: null,
        pid: null,
        description: null,
        keterangan: null,
        category: 'MTC',
        tipeTiket: 'MTC'
    };

    // Extract TIKET / NO INC (format: TIKET : INC... or INC...)
    const tiketMatch = text.match(/(?:TIKET\s*[:：]\s*)?(INC\d+)/i);
    if (tiketMatch) {
        rekap.noInc = tiketMatch[1].toUpperCase();
    }

    // Extract PID
    const pidMatch = text.match(/PID\s*[:：]\s*([^\n]+)/i);
    if (pidMatch) {
        rekap.pid = pidMatch[1].trim();
    }

    // Extract work items (lines with ✅)
    const workItems = [];
    const lines = text.split('\n');
    for (const line of lines) {
        if (line.includes('✅')) {
            // Clean the line and add to work items
            const item = line.replace(/✅/g, '').trim();
            if (item) {
                workItems.push(item + ' ✅');
            }
        }
    }
    if (workItems.length > 0) {
        rekap.keterangan = workItems.join(', ');
    }

    // Extract description - lines that don't match other patterns
    const descLines = lines.filter(line => {
        const l = line.trim();
        if (!l) return false;
        if (/^\/mtc/i.test(l)) return false;
        if (/TIKET\s*[:：]/i.test(l)) return false;
        if (/PID\s*[:：]/i.test(l)) return false;
        if (l.includes('✅')) return false;
        if (/^INC\d+$/i.test(l)) return false;
        return true;
    });
    if (descLines.length > 0) {
        rekap.description = descLines.join(' ').trim();
    }

    // If no INC found, generate one
    if (!rekap.noInc) {
        rekap.noInc = `MTC-${rekap.pid || Date.now()}`;
    }

    return rekap;
}

/**
 * Register the /mtc command handler
 * @param {TelegramBot} bot - The Telegram bot instance
 */
export function registerMtcHandler(bot) {
    bot.onText(/\/mtc(?:\s+(.+))?/s, async (msg, match) => {
        const chatId = msg.chat.id;
        const userId = msg.from.id;

        // Check if manual input is enabled
        const config = getConfig();
        if (config.manualInputLogic === 'false') {
            await bot.sendMessage(chatId, 
                `Fitur /input Di Matikan!\nMaaf Silahkan Input Laporan Pekerjaan Di Bot Morena!`,
                { parse_mode: 'Markdown' }
            );
            return;
        }

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
                `📋 *Cara penggunaan /mtc:*

*Opsi 1 - Reply:*
Reply ke message MTC, lalu ketik '/mtc'

*Opsi 2 - Langsung:*
/mtc TIKET : INC45604724
PID : 26MC14R151-0054
Pindah Tiang ✅
Cat ✅`,
                { parse_mode: 'Markdown' }
            );
            return;
        }

        const rekap = parseMtcData(textToParse);
        rekap.inputBy = username;
        rekap.reportedBy = reportedBy;

        try {
            const saved = addRekap(rekap);

            const escMd = (text) => {
                if (!text) return '\\-';
                return text.toString().replace(/[_*[\]()~`>#+=|{}.!-]/g, '\\$&');
            };

            await bot.sendMessage(chatId,
                `✅ *Rekap MTC berhasil disimpan\\!*

📋 TIKET: ${escMd(rekap.noInc)}
🔧 PID: ${escMd(rekap.pid)}
📝 PEKERJAAN: ${escMd(rekap.keterangan)}
📄 DESKRIPSI: ${escMd(rekap.description)}
👷 Reported by: @${escMd(rekap.reportedBy)}
👤 Input by: @${escMd(username)}
⏰ Waktu: ${escMd(formatToWIB())} WIB`,
                { parse_mode: 'MarkdownV2' }
            );

            console.log(`📋 MTC saved: ${rekap.noInc} by ${username}`);

            // Sync to Google Sheets (async)
            syncRekapToSheets().catch(e => console.error('Sync error:', e));

        } catch (error) {
            console.error('Failed to save MTC:', error);
            await bot.sendMessage(chatId, `❌ Gagal menyimpan MTC\n\nError: ${error.message}`);
        }
    });

    console.log('📋 MTC /mtc handler registered');
}
