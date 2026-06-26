import { addRekap, syncRekapToWorkOrders, getConfig } from './database.js';
import { syncRekapToSheets } from './gdocs.js';
import { formatToWIB } from '../utils/time.js';

/**
 * Parse TANGIBLE message content
 * Format:
 * /tangible 
 * INCXXXXXXX
 * ODP-KMS-FAS/38
 */
function parseTangibleData(text) {
    const rekap = {
        noInc: null,
        noInet: null,
        odp: null,
        category: 'TANGIBLE',
        tipeTiket: 'TANGIBLE'
    };

    // Extract NO INC (format: INC...)
    const incMatch = text.match(/INC\d+/i);
    if (incMatch) {
        rekap.noInc = incMatch[0].toUpperCase();
    }

    // Extract ODP - format: ODP-xxx
    const odpMatch = text.match(/(ODP-[A-Z0-9-\/]+)/i);
    if (odpMatch) {
        rekap.odp = odpMatch[1].trim();
    }

    // If no INC found, generate one
    if (!rekap.noInc) {
        rekap.noInc = `TANGIBLE-${rekap.odp || Date.now()}`;
    }

    return rekap;
}

/**
 * Register the /tangible command handler
 * @param {TelegramBot} bot - The Telegram bot instance
 */
export function registerTangibleHandler(bot) {
    bot.onText(/\/tangible(?:\s+(.+))?/s, async (msg, match) => {
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
                `📋 *Cara penggunaan /tangible:*

*Opsi 1 - Reply:*
Reply ke message TANGIBLE, lalu ketik '/tangible'

*Opsi 2 - Langsung:*
/tangible INC12345678
ODP-KMS-FAS/38`,
                { parse_mode: 'Markdown' }
            );
            return;
        }

        const rekap = parseTangibleData(textToParse);
        rekap.inputBy = username;
        rekap.reportedBy = reportedBy;

        try {
            const saved = addRekap(rekap);

            const escMd = (text) => {
                if (!text) return '\\-';
                return text.toString().replace(/[_*[\]()~`>#+=|{}.!-]/g, '\\$&');
            };

            await bot.sendMessage(chatId,
                `✅ *Rekap TANGIBLE berhasil disimpan\\!*

📋 NO INC: ${escMd(rekap.noInc)}
📡 ODP: ${escMd(rekap.odp)}
👷 Reported by: @${escMd(rekap.reportedBy)}
👤 Input by: @${escMd(username)}
⏰ Waktu: ${escMd(formatToWIB())} WIB`,
                { parse_mode: 'MarkdownV2' }
            );

            console.log(`📋 TANGIBLE saved: ${rekap.noInc} by ${username}`);

            // Sync to Google Sheets (async)
            syncRekapToSheets().catch(e => console.error('Sync error:', e));

            // Sync to work orders (mark as closed)
            syncRekapToWorkOrders();

        } catch (error) {
            console.error('Failed to save TANGIBLE:', error);
            await bot.sendMessage(chatId, `❌ Gagal menyimpan TANGIBLE\n\nError: ${error.message}`);
        }
    });

    console.log('📋 TANGIBLE /tangible handler registered');
}
