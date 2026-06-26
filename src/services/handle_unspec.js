import { addRekap, syncRekapToWorkOrders, getConfig } from './database.js';
import { syncRekapToSheets } from './gdocs.js';
import { formatToWIB } from '../utils/time.js';

/**
 * Parse UNSPEC message content
 * Format:
 * /unspec 
 * ODP-KMS-FAN/02 FAN/D01/02.01  KMS  111654100879
 * 
 * Done spec✅✅
 * 
 * Ket:Redting
 * Rca:Perbaikan Ikr/ikg
 * Mat:-
 * ODP: ODP-KMS-FAN/02
 */
function parseUnspecData(text) {
    const rekap = {
        noInc: null,
        noInet: null,
        rca: null,
        keterangan: null,
        mat: null,
        odp: null,
        category: 'UNSPEC',
        tipeTiket: 'UNSPEC'
    };

    // Extract NO INC (format: INC...) if present
    const incMatch = text.match(/INC\d+/i);
    if (incMatch) {
        rekap.noInc = incMatch[0].toUpperCase();
    }

    // Extract NO INET - 12 digits starting with 1
    const inetMatch = text.match(/\b(1\d{11})\b/);
    if (inetMatch) {
        rekap.noInet = inetMatch[1];
    }

    // Extract ODP - format: "ODP : xxx" or "ODP: xxx" or "ODP-xxx"
    const odpPatterns = [
        /(?:^|\n)ODP\s*[:：]\s*([^\n]+)/im,
        /(ODP-[A-Z0-9-\/]+)/i
    ];
    for (const pattern of odpPatterns) {
        const match = text.match(pattern);
        if (match) {
            rekap.odp = match[1].trim();
            break;
        }
    }

    // Extract RCA
    const rcaMatch = text.match(/(?:^|\n)RCA\s*[:：]\s*([^\n]+)/im);
    if (rcaMatch) {
        rekap.rca = rcaMatch[1].trim();
    }

    // Extract Keterangan
    const ketMatch = text.match(/(?:KET|KETERANGAN)\s*[:：]\s*([^\n]+)/i);
    if (ketMatch) {
        rekap.keterangan = ketMatch[1].trim();
    }

    // Extract MAT
    const matMatch = text.match(/(?:^|\n)MAT\s*[:：]\s*([^\n]+)/im);
    if (matMatch) {
        rekap.mat = matMatch[1].trim();
    }

    // If no INC found, generate a unique ID based on ODP and INET
    if (!rekap.noInc) {
        if (rekap.odp || rekap.noInet) {
            rekap.noInc = `UNSPEC-${rekap.odp || rekap.noInet || Date.now()}`;
        } else {
            rekap.noInc = `UNSPEC-${Date.now()}`;
        }
    }

    return rekap;
}

/**
 * Register the /unspec command handler
 * @param {TelegramBot} bot - The Telegram bot instance
 */
export function registerUnspecHandler(bot) {
    bot.onText(/\/unspec(?:\s+(.+))?/s, async (msg, match) => {
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
                `📋 *Cara penggunaan /unspec:*

*Opsi 1 - Reply:*
Reply ke message UNSPEC, lalu ketik '/unspec'

*Opsi 2 - Langsung:*
/unspec ODP-KMS-FAN/02 111654100879
Ket: Redting
Rca: Perbaikan Ikr/ikg
Mat: -`,
                { parse_mode: 'Markdown' }
            );
            return;
        }

        const rekap = parseUnspecData(textToParse);
        rekap.inputBy = username;
        rekap.reportedBy = reportedBy;

        try {
            const saved = addRekap(rekap);

            const escMd = (text) => {
                if (!text) return '\\-';
                return text.toString().replace(/[_*[\]()~`>#+=|{}.!-]/g, '\\$&');
            };

            await bot.sendMessage(chatId,
                `✅ *Rekap UNSPEC berhasil disimpan\\!*

📋 NO INC: ${escMd(rekap.noInc)}
📡 ODP: ${escMd(rekap.odp)}
🔌 NO INET: ${escMd(rekap.noInet)}
🔧 MAT: ${escMd(rekap.mat)}
🔍 RCA: ${escMd(rekap.rca)}
📝 KET: ${escMd(rekap.keterangan)}
👷 Reported by: @${escMd(rekap.reportedBy)}
👤 Input by: @${escMd(username)}
⏰ Waktu: ${escMd(formatToWIB())} WIB`,
                { parse_mode: 'MarkdownV2' }
            );

            console.log(`📋 UNSPEC saved: ${rekap.odp} by ${username}`);

            // Sync to Google Sheets (async)
            syncRekapToSheets().catch(e => console.error('Sync error:', e));

        } catch (error) {
            console.error('Failed to save UNSPEC:', error);
            await bot.sendMessage(chatId, `❌ Gagal menyimpan UNSPEC\n\nError: ${error.message}`);
        }
    });

    console.log('📋 UNSPEC /unspec handler registered');
}
