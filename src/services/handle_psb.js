import { addRekap, getAllTeamMembers, updateRekap, getAllPsbRekap } from './database.js';
import { syncRekapToSheets } from './gdocs.js';
import { formatToWIB } from '../utils/time.js';

/**
 * Format and standardize raw material text into unified columns
 */
function formatMaterialData(rawMatText) {
    if (!rawMatText) return null;
    
    const lines = rawMatText.split('\n');
    const parsedData = {};
    
    // Regular expression to match bullets/icons like 🔘, 🧵, ⏺️, etc., and then Key : Value
    const regex = /^(?:[\u2000-\u3300]|[\uD83C-\uD83E][\uDC00-\uDFFF]|[\u25A0-\u25FF]|\s)*(.+?)\s*[:：]\s*(.*)$/;
    
    lines.forEach(line => {
        const match = line.trim().match(regex);
        if (match) {
            let key = match[1].trim().toUpperCase();
            let value = match[2].trim();
            
            // Standardize keys
            if (key.includes('ALAMAT REAL')) key = 'ALAMAT REAL';
            else if (key.includes('DATEK REAL ODP') || key.includes('PENARIKAN REAL')) key = 'PENARIKAN REAL';
            else if (key === 'PASIF') key = 'PASIF';
            else if (key === 'PORT' || key.includes('PORT YANG DIGUNAKAN') || key.includes('PORT TERPAKAI')) key = 'PORT TERPAKAI';
            else if (key.includes('SISA PORT')) key = 'SISA PORT';
            else if (key.includes('BARCODE')) key = 'BARCODE';
            else if (key.includes('S/N ONT') || key.includes('SN ONT')) key = 'SN ONT';
            else if (key.includes('S/N STB') || key.includes('SN MAC STB') || key.includes('SN STB')) key = 'SN STB';
            else if (key.includes('PASS TV')) key = 'PASS TV';
            else if (key.includes('S.O.C') || key.includes('SOC')) key = 'SOC';
            else if (key.includes('PRECON')) key = 'PRECON';
            else if (key === 'PC' || key.includes('PATCHCORE')) key = 'PATCHCORD';
            else if (key.includes('S-CLAMP PEL')) key = 'S-CLAMP PELANGGAN';
            else if (key.includes('S-CLAMP ODP')) key = 'S-CLAMP ODP';
            else if (key.includes('S-CLAMP TIANG')) key = 'S-CLAMP TIANG';
            else if (key.includes('CLAM-HOOK') || key.includes('BREKET')) key = 'BREKET';
            else if (key.includes('OTP')) key = 'OTP';
            else if (key.includes('STIKER ONT') || key.includes('STIKER SUPRAS') || key.includes('SURPASS')) key = 'SURPASS';
            else if (key.includes('HASIL UKUR OPM')) key = 'HASIL UKUR OPM';
            else if (key.includes('TIKOR ODP') || key.includes('TAGGING ODP')) key = 'TIKOR ODP';
            else if (key.includes('TIKOR PEL') || key.includes('TAGGING PEL')) key = 'TIKOR PELANGGAN';

            // Only add if not empty or just dashes, or keep empty? Keeping empty might be useful for standard format, 
            // but let's keep it clean
            parsedData[key] = value || '-';
        }
    });

    if (Object.keys(parsedData).length === 0) {
        return rawMatText; // Return raw if parsing failed
    }

    // Define preferred order
    const preferredOrder = [
        'ALAMAT REAL', 'PENARIKAN REAL', 'PASIF', 'PORT TERPAKAI', 'SISA PORT',
        'BARCODE', 'SN ONT', 'SN STB', 'PASS TV', 'DC', 'SOC', 'PRECON', 'PATCHCORD',
        'S-CLAMP ODP', 'S-CLAMP PELANGGAN', 'S-CLAMP TIANG', 'BREKET', 'OTP', 'PREKSO',
        'JALUR', 'TIANG TELKOM', 'TIANG P L N', 'TRUNKING', 'SURPASS', 'BA', 'HASIL UKUR OPM',
        'TIKOR ODP', 'TIKOR PELANGGAN'
    ];

    let formattedText = '';
    
    // First print ordered keys
    for (const key of preferredOrder) {
        if (parsedData[key] !== undefined) {
            formattedText += `🔘 ${key} : ${parsedData[key]}\n`;
            delete parsedData[key];
        }
    }

    // Print remaining unrecognized keys
    for (const [key, value] of Object.entries(parsedData)) {
        formattedText += `🔘 ${key} : ${value}\n`;
    }

    return formattedText.trim();
}

/**
 * Parse PSB ticket message to extract key data
 * 
 * Expected format contains lines like:
 * REAL WO047762003
 * WO047762029  ...  111666105851  ...
 * Valins ID: 33660182
 * Summary ODP: ODP-TUB-FM/125
 * DATEK REAL ODP-TUB-FM/125
 * 
 * Segmen logic:
 * - If text contains "HSI" → HSI
 * - If text contains "PDA" → PDA
 * - Otherwise → PL - TSEL
 */
function parsePsbData(text) {
    const psb = {
        noWo: null,
        noInet: null,
        valinsId: null,
        odp: null,
        segmen: 'PL - TSEL',
        category: 'PSB',
        tipeTiket: 'PSB',
        mat: null
    };

    // Extract WO Number from "REAL WOxxxxxxxx" or "LAMA WOxxxxxxxx"
    // Prefer REAL WO over LAMA WO
    const realWoMatch = text.match(/REAL\s+(WO\d+)/i);
    if (realWoMatch) {
        psb.noWo = realWoMatch[1].trim();
    } else {
        // Fallback: search for any WO number
        const anyWoMatch = text.match(/\b(WO\d{6,})\b/i);
        if (anyWoMatch) {
            psb.noWo = anyWoMatch[1].trim();
        }
    }

    // Extract No Internet (12-digit number starting with 1)
    const inetPatterns = [
        // From the ticket data line (long line with spaces)
        /\b(1\d{11})\b/
    ];
    for (const pattern of inetPatterns) {
        const match = text.match(pattern);
        if (match) {
            psb.noInet = match[1];
            break;
        }
    }

    // Extract Valins ID
    const valinsMatch = text.match(/Valins\s*ID\s*[:：]\s*(\d+)/i);
    if (valinsMatch) {
        psb.valinsId = valinsMatch[1].trim();
    }

    // Extract ODP - from "Summary ODP:" or "DATEK REAL ODP-"
    const odpPatterns = [
        /Summary\s*ODP\s*[:：]\s*([^\n]+)/i,
        /DATEK\s*REAL\s+(ODP[^\n]+)/i,
        /👉🏻\s*DATEK\s*REAL\s+(ODP[^\n]+)/i
    ];
    for (const pattern of odpPatterns) {
        const match = text.match(pattern);
        if (match) {
            psb.odp = match[1].trim();
            break;
        }
    }

    // Determine Segmen
    if (/\bHSI\b/i.test(text)) {
        psb.segmen = 'HSI';
    } else if (/\bPDA\b/i.test(text)) {
        psb.segmen = 'PDA';
    } else {
        psb.segmen = 'PL - TSEL';
    }

    // Extract Material block
    const matMatch = text.match(/DATA MATERIAL([\s\S]*)/i);
    if (matMatch) {
        let matText = matMatch[1];
        if (/╚.*╝/.test(matText)) {
            matText = matText.replace(/[\s\S]*?╚.*╝\s*/, '');
        }
        psb.mat = formatMaterialData(matText.trim());
    } else {
        const matLine = text.match(/(?:^|\n)MAT\s*[:：]\s*([^\n]+)/im);
        if (matLine) psb.mat = matLine[1].trim();
    }

    return psb;
}

/**
 * Find team info for a given telegram username
 * Returns { teamName, memberUsernames } or null
 */
function findTeamByUsername(username) {
    if (!username) return null;

    const allMembers = getAllTeamMembers();
    const cleanUsername = username.replace(/^@/, '').toLowerCase();

    // Find the member matching this username
    const member = allMembers.find(m => {
        if (!m.telegram_username) return false;
        return m.telegram_username.replace(/^@/, '').toLowerCase() === cleanUsername;
    });

    if (!member) return null;

    // Get all members of the same team
    const teamMembers = allMembers.filter(m => m.team_id === member.team_id);
    const memberUsernames = teamMembers
        .map(m => m.telegram_username ? `@${m.telegram_username.replace(/^@/, '')}` : m.name)
        .filter(Boolean);

    return {
        teamName: member.team_name || 'Unknown Team',
        memberUsernames
    };
}

/**
 * Register the /input command handler for PSB on the datek bot
 * @param {TelegramBot} bot - The Telegram bot instance
 */
export function registerPsbInputHandler(bot) {
    bot.onText(/\/input(?:\s+(.+))?/s, async (msg, match) => {
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
                `📋 *Cara penggunaan /input PSB:*

*Reply ke message tiket PSB, lalu ketik /input*

Bot akan otomatis extract:
\\- No WO
\\- No Internet
\\- Valins ID
\\- ODP
\\- Segmen \\(HSI/PDA/PL \\- TSEL\\)
\\- Team & Username`,
                { parse_mode: 'MarkdownV2' }
            );
            return;
        }

        const psb = parsePsbData(textToParse);

        if (!psb.noWo) {
            await bot.sendMessage(chatId, '❌ Tidak dapat menemukan No WO di pesan. Pastikan format tiket PSB benar.');
            return;
        }

        // Look up team info for the inputter
        const teamInfo = findTeamByUsername(username);
        const teamName = teamInfo ? teamInfo.teamName : '-';
        const teamUsernames = teamInfo ? teamInfo.memberUsernames.join(' ') : `@${username}`;

        // Prepare rekap data to save (reuses existing rekap table with category=PSB)
        const rekapData = {
            noInc: psb.noWo,
            noInet: psb.noInet,
            idValins: psb.valinsId,
            odp: psb.odp,
            keterangan: psb.segmen,  // Store segmen in keterangan field
            mat: psb.mat,
            inputBy: username,
            reportedBy: reportedBy,
            category: 'PSB',
            tipeTiket: 'PSB',
            telegramChatId: chatId.toString(),
            telegramMessageId: messageId
        };

        try {
            const saved = addRekap(rekapData);

            const escMd = (text) => {
                if (!text) return '\\-';
                return text.toString().replace(/[_*[\]()~`>#+=|{}.!-]/g, '\\$&');
            };

            const sentMsg = await bot.sendMessage(chatId,
                `✅ *Rekap PSB berhasil disimpan\\!*

📋 No WO: ${escMd(psb.noWo)}
🔌 No Internet: ${escMd(psb.noInet)}
🆔 Valins ID: ${escMd(psb.valinsId)}
📡 ODP: ${escMd(psb.odp)}
📦 Segmen: ${escMd(psb.segmen)}
🔧 Material: ${psb.mat ? '\n' + escMd(psb.mat) : '\\-'}
👷 Reported by: @${escMd(reportedBy)}
👤 Input by: @${escMd(username)}
⏰ Waktu Input: ${escMd(formatToWIB())} WIB
👥 Team: ${escMd(teamName)}
📝 Username: ${escMd(teamUsernames)}`,
                {
                    parse_mode: 'MarkdownV2',
                    reply_to_message_id: messageId
                }
            );

            // Save the reply ID for potential cancel/edit later
            if (sentMsg) {
                updateRekap(saved.id, { telegramReplyId: sentMsg.message_id });
            }

            console.log(`📋 PSB saved: ${psb.noWo} by ${username}`);

            // Sync to internal Google Sheet (async)
            syncRekapToSheets().catch(e => console.error('PSB Sync error:', e));

        } catch (error) {
            console.error('Failed to save PSB:', error);
            await bot.sendMessage(chatId, `❌ Gagal menyimpan rekap PSB\n\nError: ${error.message}`);
        }
    });

    console.log('📋 PSB /input handler registered');
}

/**
 * Register the /rekap command handler for PSB daily pivot
 * Usage: /rekap dd/mm/yyyy or /rekap (defaults to today)
 * @param {TelegramBot} bot - The Telegram bot instance
 */
export function registerPsbRekapHandler(bot) {
    bot.onText(/\/rekap(?:\s+(.+))?/, async (msg, match) => {
        const chatId = msg.chat.id;
        const input = match[1] ? match[1].trim() : '';

        // Parse date
        let targetDate;
        let dateLabel;

        if (!input || input.toLowerCase() === 'today') {
            targetDate = new Date();
        } else {
            const parts = input.match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/);
            if (parts) {
                const day = parseInt(parts[1]);
                const month = parseInt(parts[2]) - 1;
                const year = parseInt(parts[3]);
                targetDate = new Date(year, month, day);
            } else {
                await bot.sendMessage(chatId,
                    'ℹ️ <b>Cara Penggunaan:</b>\n' +
                    'Ketik <code>/rekap [dd/mm/yyyy]</code>\n' +
                    'Contoh: <code>/rekap 03/03/2026</code>\n' +
                    'Atau: <code>/rekap</code> untuk hari ini',
                    { parse_mode: 'HTML' }
                );
                return;
            }
        }

        const dd = String(targetDate.getDate()).padStart(2, '0');
        const mm = String(targetDate.getMonth() + 1).padStart(2, '0');
        const yyyy = targetDate.getFullYear();
        dateLabel = `${dd}/${mm}/${yyyy}`;
        const dateFilter = `${yyyy}-${mm}-${dd}`;

        // Get all PSB data
        const allPsb = getAllPsbRekap();
        const allMembers = getAllTeamMembers();

        // Filter by date
        const dayData = allPsb.filter(r => {
            const inputDate = (r.input_at || '').split(' ')[0] || (r.input_at || '').split('T')[0];
            return inputDate === dateFilter;
        });

        if (dayData.length === 0) {
            await bot.sendMessage(chatId,
                `📊 <b>REKAP PSB ${dateLabel}</b>\n\n❌ Tidak ada data PSB untuk tanggal ini.`,
                { parse_mode: 'HTML' }
            );
            return;
        }

        // Build pivot by team
        const teamPivot = new Map();

        dayData.forEach(r => {
            const inputUsername = (r.input_by || '').replace('@', '').toLowerCase();
            const member = allMembers.find(m => {
                if (!m.telegram_username) return false;
                return m.telegram_username.replace('@', '').toLowerCase() === inputUsername;
            });

            const teamName = member ? (member.team_name || 'Unknown') : 'Tanpa Team';

            if (!teamPivot.has(teamName)) {
                teamPivot.set(teamName, {
                    count: 0,
                    members: new Map(),
                    segmens: new Map()
                });
            }

            const team = teamPivot.get(teamName);
            team.count++;

            // Count per member
            const memberKey = r.input_by || 'unknown';
            team.members.set(memberKey, (team.members.get(memberKey) || 0) + 1);

            // Count per segmen
            const seg = r.keterangan || 'PL - TSEL';
            team.segmens.set(seg, (team.segmens.get(seg) || 0) + 1);
        });

        // Format message
        let message = `📊 <b>REKAP PSB ${dateLabel}</b>\n`;
        message += `━━━━━━━━━━━━━━━━━━\n`;
        message += `📋 Total: <b>${dayData.length}</b> PSB\n\n`;

        // Sort teams by count descending
        const sortedTeams = [...teamPivot.entries()].sort((a, b) => b[1].count - a[1].count);

        sortedTeams.forEach(([teamName, data], idx) => {
            message += `<b>${idx + 1}. ${teamName}</b> — ${data.count} PSB\n`;

            // Members detail
            const sortedMembers = [...data.members.entries()].sort((a, b) => b[1] - a[1]);
            sortedMembers.forEach(([member, count]) => {
                message += `   • @${member.replace('@', '')} = ${count}\n`;
            });

            // Segmen breakdown
            const segStr = [...data.segmens.entries()].map(([s, c]) => `${s}(${c})`).join(' | ');
            message += `   📦 Segmen: ${segStr}\n\n`;
        });

        message += `━━━━━━━━━━━━━━━━━━\n`;
        message += `⏰ Generated: ${formatToWIB()} WIB`;

        await bot.sendMessage(chatId, message, { parse_mode: 'HTML' });
    });

    console.log('📊 PSB /rekap handler registered');
}
