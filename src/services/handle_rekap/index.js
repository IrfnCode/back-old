import { addRekap, syncRekapToWorkOrders, getConfig } from '../database.js';
import { syncRekapToSheets } from '../gdocs.js';
import { formatToWIB } from '../../utils/time.js';

/**
 * Parse message content to extract rekap data
 * @param {string} text - The message text to parse
 * @returns {object} Parsed rekap data
 */
function parseRekapData(text) {
    const rekap = {
        noInc: null,
        noInet: null,
        rca: null,
        keterangan: null,
        alamat: null,
        mat: null,
        odp: null,
        tipeTiket: 'REGULER'
    };

    // Extract NO INC (format: INC...)
    const incMatch = text.match(/INC\d+/i);
    if (incMatch) {
        rekap.noInc = incMatch[0].toUpperCase();
    }

    // Detect TIPE TIKET - if [SQM] is present in text, it's SQM
    if (text.includes('[SQM]') || text.includes('SQM')) {
        rekap.tipeTiket = 'SQM';
    }

    // Extract NO INET - multiple patterns
    const inetPatterns = [
        // Format: "_ 111651100478 _" (underscore separated)
        /_\s*(1\d{11})\s*_/,
        // Format: "NO INET: xxx" or "INET: xxx"
        /(?:NO\s*)?INET[:\s]+(\d{10,15})/i,
        // Format: "nomor IH 111654102267"
        /nomor\s+IH\s+(\d{10,15})/i,
        // Format: service number starting with 1 (12 digits)
        /(?:^|[\s|_])(1\d{11})(?:[\s|_]|$)/,
        // Any 12-digit number starting with 1
        /\b(1\d{11})\b/
    ];

    for (const pattern of inetPatterns) {
        const match = text.match(pattern);
        if (match) {
            rekap.noInet = match[1];
            break;
        }
    }

    // Extract RCA (Root Cause Analysis) - format: "RCA : xxx" or "RCA: xxx" at start of line
    const rcaMatch = text.match(/(?:^|\n)RCA\s*[:：]\s*([^\n]+)/im);
    if (rcaMatch) {
        rekap.rca = rcaMatch[1].trim();
    }

    // Extract MAT (Material) - format: "MAT : xxx" or "MAT: xxx"
    const matMatch = text.match(/(?:^|\n)MAT\s*[:：]\s*([^\n]+)/im);
    if (matMatch) {
        rekap.mat = matMatch[1].trim();
    }

    // Extract ODP - format: "ODP : xxx" or "ODP: xxx"
    const odpMatch = text.match(/(?:^|\n)ODP\s*[:：]\s*([^\n]+)/im);
    if (odpMatch) {
        rekap.odp = odpMatch[1].trim();
    }

    // Extract Keterangan - format: "KET : xxx" or "KETERANGAN: xxx"
    const ketMatch = text.match(/(?:KET|KETERANGAN)\s*[:：]\s*([^\n]+)/i);
    if (ketMatch) {
        rekap.keterangan = ketMatch[1].trim();
    }

    // Extract Alamat - format: "ALAMAT : xxx"
    const alamatMatch = text.match(/ALAMAT\s*[:：]\s*([^\n]+)/i);
    if (alamatMatch) {
        rekap.alamat = alamatMatch[1].trim();
    }

    return rekap;
}

/**
 * Register the /input command handler
 * @param {TelegramBot} bot - The Telegram bot instance
 */
export function registerInputHandler(bot) {
    // Handle /input command - can be reply or direct input
    bot.onText(/\/input(?:\s+(.+))?/s, async (msg, match) => {
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
        let reportedBy = username; // Default to self if direct input

        // Check if this is a reply to another message
        if (msg.reply_to_message) {
            const repliedMessage = msg.reply_to_message;
            textToParse = repliedMessage.text || repliedMessage.caption || '';

            // Get reported by from replied message
            if (repliedMessage.from) {
                reportedBy = repliedMessage.from.username || repliedMessage.from.first_name || `user_${repliedMessage.from.id}`;
            } else if (repliedMessage.forward_from) {
                reportedBy = repliedMessage.forward_from.username || repliedMessage.forward_from.first_name || 'forwarded';
            }

            console.log('📝 Reply to message type:', repliedMessage.photo ? 'photo' : repliedMessage.document ? 'document' : 'text');
            console.log('📝 Caption/Text length:', textToParse.length);
        }

        // Combine text from replied message and input command
        if (inputText) {
            textToParse = textToParse + '\n' + inputText;
        }

        // If no text to parse at all, show help
        if (!textToParse.trim()) {
            await bot.sendMessage(chatId,
                `📋 *Cara penggunaan /input:*

*Opsi 1 \\- Reply:*
Reply ke message WO, lalu ketik \\'/input\\'

*Opsi 2 \\- Langsung:*
\\/input INC12345678
NO INET: 111654102267
RCA: Reset modem
KET: Pelanggan sudah bisa internet
ALAMAT: Jl\\. xxx`,
                { parse_mode: 'MarkdownV2' }
            );
            return;
        }

        // Parse data from textToParse
        const rekap = parseRekapData(textToParse);

        // Add who input this rekap (person who typed /input)
        rekap.inputBy = username;

        // Add who reported/sent the original message
        rekap.reportedBy = reportedBy;

        // If no INC found, set as manual WhatsApp report
        if (!rekap.noInc) {
            rekap.noInc = 'LAPOR WHATSAPP';
            rekap.tipeTiket = 'WHATSAPP';
        }

        try {
            // Save to database
            const saved = addRekap(rekap);

            // Escape special characters for Markdown
            const escMd = (text) => {
                if (!text) return '\\-';
                return text.toString().replace(/[_*[\]()~`>#+=|{}.!-]/g, '\\$&');
            };

            await bot.sendMessage(chatId,
                `✅ *Rekap berhasil disimpan\\!*

📋 NO INC: \`${rekap.noInc}\`
🔌 NO INET: ${escMd(rekap.noInet)}
🎫 TIPE: ${escMd(rekap.tipeTiket)}
🔧 MAT: ${escMd(rekap.mat)}
📡 ODP: ${escMd(rekap.odp)}
🔍 RCA: ${escMd(rekap.rca)}
📝 KET: ${escMd(rekap.keterangan)}
📍 ALAMAT: ${escMd(rekap.alamat)}
👷 Reported by: @${escMd(rekap.reportedBy)}
👤 Input by: @${escMd(username)}
⏰ Waktu: ${escMd(formatToWIB())} WIB`,
                { parse_mode: 'MarkdownV2' }
            );

            console.log(`📋 Rekap saved: ${rekap.noInc} by ${username}`);

            // Sync to Google Sheets (async, don't wait)
            syncRekapToSheets().catch(e => console.error('Sync error:', e));

            // Sync rekap to work orders (update status to CLOSED)
            syncRekapToWorkOrders();

        } catch (error) {
            console.error('Failed to save rekap:', error);
            await bot.sendMessage(chatId,
                `❌ Gagal menyimpan rekap\n\nError: ${error.message}`
            );
        }
    });

    console.log('📋 Rekap /input handler registered');
}
