import TelegramBot from 'node-telegram-bot-api';
import { registerInputHandler } from './handle_rekap/index.js';
import { registerUnspecHandler } from './handle_unspec.js';
import { registerTangibleHandler } from './handle_tangible.js';
import { registerMtcHandler } from './handle_mtc.js';
import { registerDatekHandler } from './handle_datek.js';
import { registerPsbInputHandler, registerPsbRekapHandler } from './handle_psb.js';
import { upsertTelegramChat, upsertGroupMember, getPerformanceStats, getPerformanceConfig, getWorkOrderByOrderId, getWorkersForDate, updateRekap, getConfig } from './database.js';
import { askAI } from './ai.js';
import { formatToWIB, getWIBDay, getWIBMonth, getWIBYear } from '../utils/time.js';

let botGangguan = null;
let botDatek = null;

export function initTelegramBots(tokenGangguan, tokenDatek) {
    // 1. Initialize Gangguan Bot
    if (tokenGangguan) {
        try {
            if (botGangguan) {
                botGangguan.stopPolling().catch(() => { });
            }
            botGangguan = new TelegramBot(tokenGangguan, { polling: false });

            // Add polling error listener
            botGangguan.on('polling_error', (error) => {
                console.error('❌ Gangguan Bot Polling Error:', error.message || error);
            });

            // Register Gangguan Handlers
            registerGangguanHandlers(botGangguan);

            // Delete webhook first to avoid 409 Conflict with polling, then start polling
            botGangguan.deleteWebHook()
                .then(() => {
                    console.log('✅ Webhook deleted for Gangguan Bot, starting polling...');
                    return botGangguan.startPolling();
                })
                .then(() => {
                    console.log('✅ Gangguan Bot initialized and polling started');
                })
                .catch((error) => {
                    console.error('⚠️ Gangguan Bot deleteWebhook failed, starting polling anyway:', error.message);
                    botGangguan.startPolling().catch(err => {
                        console.error('❌ Failed to start polling for Gangguan Bot:', err.message);
                    });
                });
        } catch (error) {
            console.error('❌ Failed to init Gangguan Bot:', error.message);
        }
    }

    // 2. Initialize Datek Bot
    if (tokenDatek) {
        try {
            if (botDatek) {
                botDatek.stopPolling().catch(() => { });
            }
            botDatek = new TelegramBot(tokenDatek, { polling: false });

            // Add polling error listener
            botDatek.on('polling_error', (error) => {
                console.error('❌ Datek Bot Polling Error:', error.message || error);
            });

            // Register Datek Handlers
            registerDatekBotHandlers(botDatek);

            // Delete webhook first to avoid 409 Conflict with polling, then start polling
            botDatek.deleteWebHook()
                .then(() => {
                    console.log('✅ Webhook deleted for Datek Bot, starting polling...');
                    return botDatek.startPolling();
                })
                .then(() => {
                    console.log('✅ Datek Bot initialized and polling started');
                })
                .catch((error) => {
                    console.error('⚠️ Datek Bot deleteWebhook failed, starting polling anyway:', error.message);
                    botDatek.startPolling().catch(err => {
                        console.error('❌ Failed to start polling for Datek Bot:', err.message);
                    });
                });
        } catch (error) {
            console.error('❌ Failed to init Datek Bot:', error.message);
        }
    }
}

// Kept for backward compatibility if needed, but implementation uses new logic
export function initTelegramBot(token) {
    initTelegramBots(token, null);
}

function registerGangguanHandlers(bot) {
    // Handle /start command
    bot.onText(/\/start/, (msg) => {
        const chatId = msg.chat.id;
        bot.sendMessage(chatId,
            `🤖 *Work Order Bot (Gangguan) Aktif!*

Chat ID Anda: \`${chatId}\`

Gunakan Chat ID ini di konfigurasi web untuk menerima notifikasi work order.

Commands:
/status - Cek status bot
/help - Bantuan`,
            { parse_mode: 'Markdown' }
        );
    });

    // Handle /status command
    bot.onText(/\/status/, (msg) => {
        const chatId = msg.chat.id;
        bot.sendMessage(chatId,
            `✅ *Bot Status (Gangguan)*

Status: Online
Time: ${formatToWIB()} (WIB)
Chat ID: \`${chatId}\``,
            { parse_mode: 'Markdown' }
        );
    });

    // Handle /help command  
    bot.onText(/\/help/, (msg) => {
        const chatId = msg.chat.id;
        bot.sendMessage(chatId,
            `📚 *Work Order Bot Command List*

Bot ini akan mengirimkan notifikasi setiap ada work order baru dari hasil scraping INSERA.

Chat ID Anda: \`${chatId}\`

*Commands:*
/start - Mulai bot
/status - Cek status
/input - Input rekap close gangguan
/unspec - Input rekap UNSPEC
/tangible - Input rekap TANGIBLE
/mtc - Input rekap Maintenance
/info - Cek detail tiket
/jadwal - Cek jadwal teknisi
/del - Hapus pesan bot
/help - Tampilkan bantuan`,
        );
    });

    // AI Processing Lock
    const activeAiChats = new Set();
    // User Modes: { chatId: { mode: 'normal' | 'admin' | 'chat', status: 'idle' | 'waiting_pin' } }
    const userState = new Map();

    // Handle /admin command
    bot.onText(/\/admin/, (msg) => {
        const chatId = msg.chat.id;
        const opts = {
            reply_markup: {
                inline_keyboard: [
                    [
                        { text: '🔴 AI NO FILTER', callback_data: 'mode_admin' },
                        { text: '💬 AI CHAT MODE', callback_data: 'mode_chat' }
                    ],
                    [
                        { text: '🟢 NORMAL MODE', callback_data: 'mode_normal' }
                    ]
                ]
            }
        };
        bot.sendMessage(chatId, "🛠 *Admin Panel - PanAI*\n\nSilakan pilih mode operasi AI:", { parse_mode: 'Markdown', ...opts });
    });

    // Handle Callback Queries (Buttons)
    bot.on('callback_query', async (callbackQuery) => {
        const msg = callbackQuery.message;
        const chatId = msg.chat.id;
        const data = callbackQuery.data;

        if (data === 'mode_admin') {
            userState.set(chatId, { mode: 'normal', status: 'waiting_pin' });
            bot.answerCallbackQuery(callbackQuery.id);
            bot.sendMessage(chatId, "🔐 *ADMIN MODE DETECTED*\n\nMasukkan PIN 6 digit untuk melanjutkan:", { parse_mode: 'Markdown' });
        } else if (data === 'mode_chat') {
            userState.set(chatId, { mode: 'chat', status: 'idle' });
            bot.answerCallbackQuery(callbackQuery.id);
            bot.sendMessage(chatId, "💬 *MODE AI CHAT AKTIF*\n\nAI sekarang dalam mode ngobrol biasa tanpa akses data server.", { parse_mode: 'Markdown' });
        } else if (data === 'mode_normal') {
            userState.set(chatId, { mode: 'normal', status: 'idle' });
            bot.answerCallbackQuery(callbackQuery.id);
            bot.sendMessage(chatId, "🟢 *MODE NORMAL AKTIF*\n\nAI kembali ke mode standar (Read-Only Database).", { parse_mode: 'Markdown' });
        }
    });

    // Handle PIN and general messages
    bot.on('message', (msg) => {
        const chatId = msg.chat.id;
        const state = userState.get(chatId);

        if (state && state.status === 'waiting_pin' && msg.text) {
            if (msg.text === '889900') {
                userState.set(chatId, { mode: 'admin', status: 'idle' });
                bot.sendMessage(chatId, "✅ *PIN BENAR*\n\n🔴 *AI NO FILTER AKTIF!*\n\nAnda sekarang dapat mengedit data langsung lewat AI. Hati-hati, setiap perubahan akan terekam.", { parse_mode: 'Markdown' });
                // Delete PIN message for security
                bot.deleteMessage(chatId, msg.message_id).catch(() => { });
            } else if (/^\d+$/.test(msg.text)) {
                bot.sendMessage(chatId, "❌ PIN Salah. Akses ditolak.");
                userState.set(chatId, { mode: 'normal', status: 'idle' });
            }
        }
    });

    // Handle /ai command and greetings
    bot.onText(/\/ai(?:\s+(.*))?/, async (msg, match) => {
        const chatId = msg.chat.id;
        const prompt = match[1] ? match[1].trim() : null;

        if (!prompt) {
            return bot.sendMessage(chatId, "Halo! Saya adalah Pan AI yang dapat menghandle Seluruh Flow WorkOrder Pada WorkOrder Manager PanWO V01.00 With AI. Silakan tulis pertanyaan Anda setelah perintah /ai.\nContoh: `/ai Berapa jumlah work order hari ini?`", { parse_mode: 'Markdown' });
        }

        // Check if AI is currently processing for this chat
        if (activeAiChats.has(chatId)) {
            return bot.sendMessage(chatId, "⏳ *Pan AI masih memproses pertanyaan sebelumnya.*\nHarap tunggu sebentar sebelum bertanya lagi ya!", { parse_mode: 'Markdown' });
        }

        // Lock the chat
        activeAiChats.add(chatId);
        let loadingMsgId = null;

        try {
            // Send typing indicator
            bot.sendChatAction(chatId, 'typing');

            // Send initial loading message
            const state = userState.get(chatId) || { mode: 'normal' };
            let loadingText = "🤔 *Pan AI Sedang Berfikir...*";
            if (state.mode === 'admin') loadingText = "🔴 *ADMIN MODE: Sedang Berfikir...*";
            if (state.mode === 'chat') loadingText = "💬 *CHAT MODE: Sedang Berfikir...*";

            const loadingMsg = await bot.sendMessage(chatId, loadingText, { parse_mode: 'Markdown' });
            loadingMsgId = loadingMsg.message_id;

            // Optional: trigger typing action periodically if thinking takes a while
            const typingInterval = setInterval(() => bot.sendChatAction(chatId, 'typing'), 4000);

            // Fetch AI response
            const response = await askAI(prompt, state.mode);

            clearInterval(typingInterval);

            // Hapus pesan loading "Sedang Berfikir..."
            if (loadingMsgId) {
                bot.deleteMessage(chatId, loadingMsgId).catch(() => { });
            }

            // Kirim pesan jawaban - potong menjadi bagian jika terlalu panjang
            const MAX_MSG_LENGTH = 3500; // Telegram max 4096, sisakan buffer
            // Jika pesan berisi data besar (dari formatter), kirim tanpa Markdown agar underscore aman
            const isDataResponse = response.startsWith('📊');
            const parseMode = isDataResponse ? undefined : 'Markdown';

            if (response.length <= MAX_MSG_LENGTH) {
                // Pesan pendek, kirim langsung
                await bot.sendMessage(chatId, response, { parse_mode: parseMode })
                    .catch(async () => {
                        await bot.sendMessage(chatId, response);
                    });
            } else {
                // Pesan panjang, pecah menjadi beberapa bagian
                const chunks = [];
                let remaining = response;
                while (remaining.length > 0) {
                    if (remaining.length <= MAX_MSG_LENGTH) {
                        chunks.push(remaining);
                        break;
                    }
                    // Cari titik potong terdekat di newline
                    let cutIndex = remaining.lastIndexOf('\n', MAX_MSG_LENGTH);
                    if (cutIndex <= 0) cutIndex = MAX_MSG_LENGTH; // Fallback potong di batas
                    chunks.push(remaining.substring(0, cutIndex));
                    remaining = remaining.substring(cutIndex).trimStart();
                }

                for (let i = 0; i < chunks.length; i++) {
                    const chunk = chunks[i];
                    await bot.sendMessage(chatId, chunk, { parse_mode: parseMode })
                        .catch(async () => {
                            await bot.sendMessage(chatId, chunk);
                        });
                    // Delay kecil antar pesan agar tidak kena rate limit
                    if (i < chunks.length - 1) {
                        await new Promise(r => setTimeout(r, 500));
                    }
                }
                console.log(`📨 AI response sent in ${chunks.length} chunks`);
            }

        } catch (error) {
            console.error('AI Command Error:', error);
            if (loadingMsgId) {
                bot.editMessageText("❌ *Uh oh!* Terjadi kesalahan saat memproses permintaan AI.\nSilakan coba lagi nanti.", {
                    chat_id: chatId,
                    message_id: loadingMsgId,
                    parse_mode: 'Markdown'
                }).catch(() => { });
            } else {
                bot.sendMessage(chatId, "❌ *Uh oh!* Terjadi kesalahan saat memproses permintaan AI.");
            }
        } finally {
            // Unlock the chat
            activeAiChats.delete(chatId);
        }
    });

    // Handle /del command
    bot.onText(/\/del/, async (msg) => {
        handleDelCommand(bot, msg);
    });

    // Handle /info command
    bot.onText(/\/info(.*)/, async (msg, match) => {
        const chatId = msg.chat.id;
        const input = match[1] ? match[1].trim() : '';

        if (!input) {
            return bot.sendMessage(chatId, 'ℹ️ <b>Cara Penggunaan:</b>\nKetik <code>/info &lt;NOMOR_TIKET&gt;</code>\nContoh: <code>/info INC12345</code>', { parse_mode: 'HTML' });
        }

        const orderId = input.split(' ')[0];
        const wo = getWorkOrderByOrderId(orderId);

        if (wo) {
            await sendWorkOrderNotification(chatId, wo, '', true);
        } else {
            bot.sendMessage(chatId, '❌ Ticket not found');
        }
    });

    // Handle /tiketaktif command
    bot.onText(/\/tiketaktif/, async (msg) => {
        const chatId = msg.chat.id;

        const loadingMsg = await bot.sendMessage(chatId, "Mengambil Data Insera....\nMemproses Data Insera...");


        try {
            const { getConfig } = await import('./database.js');
            const { scrapeOnce } = await import('./scraper.js');
            const config = getConfig();

            // Generate dynamic date filters for the last 3 days in WIB timezone
            const getWIBString = (d) => {
                const wibTime = new Date(d.getTime() + (d.getTimezoneOffset() * 60000) + (7 * 3600000));
                const year = wibTime.getFullYear();
                const month = String(wibTime.getMonth() + 1).padStart(2, '0');
                const date = String(wibTime.getDate()).padStart(2, '0');
                return `${year}-${month}-${date}`;
            };
            const now = new Date();
            const dateTo = getWIBString(now) + ' 23:59';
            const pastDate = new Date();
            pastDate.setDate(now.getDate() - 3); // 3 days range
            const dateFrom = getWIBString(pastDate) + ' 00:00';

            // Endpoint khusus untuk /tiketaktif sesuai permintaan
            const activeTicketsUrl = `https://oss-incident.telkom.co.id/jw/web/userview/ticketIncidentService/ticketIncidentService/_/allTicketList?d-5564009-p=1&d-5564009-ps=100&d-5564009-fn_reported_date_filter=${encodeURIComponent(dateFrom)}&d-5564009-fn_reported_date_filter=${encodeURIComponent(dateTo)}&d-5564009-fn_status_date_filter=&d-5564009-fn_status_date_filter=&d-5564009-fn_C_OWNER_GROUP=TIF%20FBB%20DISTRICT%20SUMBAGTENG%2CTIF%20HD%20DISTRICT%20RIKEP%2CTIF%20ROC-1%2CTIF%20FBB%20ROC%20TERRITORY%201%2CTIF%20AOMQ%20DISTRICT%20RIKEP%2CTIF%20AOMQ%20DISTRICT%20SUMBAGTENG%2CTIF%20FBB%20FFM%20DISTRICT%20RIKEP%2CTIF%20FBB%20FFM%20DISTRICT%20SUMBAGTENG%2CTA%20HD%20WITEL%20RIKEP%2CROC-1%2CROC-1%20FULFILLMENT%2CDTVV%20OTT%2CDTVV%20SA%2CACCESS%20MAINTENANCE%20WITEL%20RIAU%20KEPULAUAN%20(BATAM)%2CIPTV-CCM%2CTIF%20ASR%20FBB%20DISTRICT%20BATAM%2CTIF%20ASR%20FBB%20AREA%201%2CTIF%20ED%20REGIONAL%20SUMBAGTENG&d-5564009-fn_C_OWNER=&d-5564009-fn_C_REPORTED_PRIORITY=&d-5564009-fn_C_SOURCE_TICKET=CUSTOMER&d-5564009-fn_C_EXTERNAL_TICKETID=&d-5564009-fn_C_CHANNEL=&d-5564009-fn_C_CUSTOMER_SEGMENT=DCS%2CPL-TSEL&d-5564009-fn_C_CUSTOMER_TYPE=&d-5564009-fn_C_SERVICE_NO=&d-5564009-fn_C_SERVICE_TYPE=&d-5564009-fn_C_SERVICE_ID=&d-5564009-fn_C_SLG=&d-5564009-fn_C_KODE_PRODUK=&d-5564009-fn_DATEMODIFIED=&d-5564009-fn_C_CLOSED_BY=&d-5564009-fn_C_WORK_ZONE=TPI%2CPYT%2CTUB%2CKIJ%2CKMS%2CTER%2CDBS%2CRAI&d-5564009-fn_C_WITEL=&d-5564009-fn_C_REGION=&d-5564009-fn_C_ID_TICKET=&d-5564009-fn_C_ACTUAL_SOLUTION=&d-5564009-fn_C_CLASSIFICATION_PATH=&d-5564009-fn_C_INCIDENT_DOMAIN=&d-5564009-fn_C_TICKET_STATUS=ANALYSIS%2CBACKEND%2CDRAFT%2CFINALCHECK%2CNEW%2CPENDING%2CRESOLVED&d-5564009-fn_C_PERANGKAT=&d-5564009-fn_C_DESCRIPTION_ASSIGMENT=&d-5564009-fn_C_CLASSIFICATION_CATEGORY=TECHNICAL&d-5564009-fn_C_REALM=&d-5564009-fn_C_PIPE_NAME=&d-5564009-fn_C_CUSTOMER_ID=&d-5564009-fn_C_RELATED_TO_GAMAS=&d-5564009-fn_C_TICKET_ID_GAMAS=&d-5564009-fn_C_GUARANTE_STATUS=&d-5564009-fn_C_DESCRIPTION_CUSTOMERID=&d-5564009-fn_C_CONTACT_NAME=`;

            // Panggil scrapeOnce dengan skipConfigOverrides: true agar tidak tertimpa filter status/workzone dari konfigurasi umum
            const result = await scrapeOnce(activeTicketsUrl, null, { skipConfigOverrides: true });
            const activeTickets = (result.data || []).filter(wo => wo.sourceTicket === 'CUSTOMER');

            const day = String(now.getDate()).padStart(2, '0');
            const month = String(now.getMonth() + 1).padStart(2, '0');
            const year = now.getFullYear();
            const dateStr = `${day}/${month}/${year}`;

            const hours = String(now.getHours()).padStart(2, '0');
            const minutes = String(now.getMinutes()).padStart(2, '0');
            const seconds = String(now.getSeconds()).padStart(2, '0');
            const timeStr = `${hours}:${minutes}:${seconds}`;

            let message = `TIKET REGULER AKTIF ${dateStr}\nLAST UPDATE ${dateStr} ${timeStr}\n\n`;

            if (activeTickets.length === 0) {
                message += "Tidak ada tiket reguler aktif saat ini.\n\n";
            } else {
                activeTickets.forEach((wo, index) => {
                    const ttr = wo.ttrCustomer || '-';
                    const wz = wo.workzone || '-';
                    const tier = wo.customerType || 'REGULER';
                    message += `${index + 1}. ${wo.orderId}  ${ttr}  ${wz}  ${tier}\n`;
                    if (wo.bookingDate) {
                        message += `BOOKING DATE : ${wo.bookingDate}\n`;
                    }
                    if (wo.deviceName && wo.deviceName !== '-') {
                        message += `ODP : ${wo.deviceName}\n`;
                    }
                    if (wo.rkInformation && wo.rkInformation !== '-') {
                        message += `ODC : ${wo.rkInformation}\n`;
                    }
                    message += '\n';
                });
            }

            message += "----------------------------------------\n\n";
            message += "silahkan /info INCXXX untuk melihat Summary Ticket nya, Terimakasih";

            await bot.editMessageText(message, {
                chat_id: chatId,
                message_id: loadingMsg.message_id
            });

        } catch (error) {
            await bot.editMessageText(`❌ Gagal mengambil data tiket aktif:\n${error.message}`, {
                chat_id: chatId,
                message_id: loadingMsg.message_id
            });
        }
    });

    // Handle /jadwal command
    bot.onText(/\/jadwal(.*)/, async (msg, match) => {
        const chatId = msg.chat.id;
        const input = match[1] ? match[1].trim() : '';

        let day, month, year;

        if (!input || input.toLowerCase() === 'today') {
            day = getWIBDay();
            month = getWIBMonth();
            year = getWIBYear();
        } else {
            const parts = input.match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/);
            if (parts) {
                day = parseInt(parts[1]);
                month = parseInt(parts[2]);
                year = parseInt(parts[3]);
            } else {
                return bot.sendMessage(chatId, 'ℹ️ <b>Cara Penggunaan:</b>\nKetik <code>/jadwal [dd/mm/yyyy]</code> atau <code>/jadwal today</code>\nContoh: <code>/jadwal 09/02/2026</code>', { parse_mode: 'HTML' });
            }
        }

        const workers = getWorkersForDate(day, month, year);
        const dateStr = `${String(day).padStart(2, '0')}/${String(month).padStart(2, '0')}/${year}`;

        if (workers.length === 0) {
            return bot.sendMessage(chatId, `MAPPING\n${dateStr}\n\n❌ Belum ada jadwal untuk tanggal ini.`);
        }

        const workingShiftCodes = ['M', 'A', 'SHIFT', 'SH', 'SIST'];
        const workingWorkers = workers.filter(w => workingShiftCodes.includes((w.shift || '').toUpperCase()));

        let message = `MAPPING\n${dateStr}\n`;

        if (workingWorkers.length === 0) {
            message += `\n❌ Tidak ada yang masuk hari ini.`;
        } else {
            workingWorkers.forEach(m => {
                const name = m.member_name || m.excel_name;
                const rawShift = (m.shift || '').toUpperCase();
                let shiftDisplay = '';

                if (['SHIFT', 'SH', 'SIST'].includes(rawShift)) {
                    shiftDisplay = ' ( SHIFT )';
                }

                const status = m.attendance_status !== 'ACTIVE' ? ` (${m.attendance_status})` : '';
                message += `\n• ${name.toUpperCase()}${shiftDisplay}${status}`;
            });
        }

        bot.sendMessage(chatId, message, { parse_mode: 'HTML' });
        bot.sendMessage(chatId, message, { parse_mode: 'HTML' });
    });

    // Handle /alamat command (Manual Scrape)
    bot.onText(/\/alamat\s+(INC\d+)/i, async (msg, match) => {
        const chatId = msg.chat.id;
        const orderId = match[1].toUpperCase();

        // 1. Send processing message
        const processingMsg = await bot.sendMessage(chatId, `⏳ *Proses mengambil alamat & tagging untuk ${orderId}...*\n\nMohon tunggu sebentar, ini memakan waktu beberapa detik.`, { parse_mode: 'Markdown' });

        try {
            // 2. Call scraper
            // Import dynamically to avoid circular dependency issues if any, or assume imported at top
            // Better to import at top if possible, but for now let's assume scraper is imported
            // We need to import scrapeSingleTicket from scraper.js

            const { scrapeSingleTicket } = await import('./scraper.js');
            const result = await scrapeSingleTicket(orderId);

            // 3. Edit message with result
            const addr = result.streetAddress || '-';
            const lat = result.latitude || '-';
            const lng = result.longitude || '-';
            const tagging = (lat !== '-' && lng !== '-') ? `${lat},${lng}` : '-';

            await bot.editMessageText(
                `✅ *Validasi Alamat ${orderId}*\n\n` +
                `📍 *Alamat:* \`${addr}\`\n` +
                `🌐 *Tagging:* \`${tagging}\``,
                {
                    chat_id: chatId,
                    message_id: processingMsg.message_id,
                    parse_mode: 'Markdown'
                }
            );

        } catch (error) {
            // 4. Handle error
            const errorText = `❌ *Gagal mengambil detail ${orderId}*\n\nError: ${error.message}`;
            try {
                await bot.editMessageText(errorText, {
                    chat_id: chatId,
                    message_id: processingMsg.message_id,
                    parse_mode: 'Markdown'
                });
            } catch (e) {
                // If edit fails (e.g. message deleted), try sending new one
                bot.sendMessage(chatId, errorText, { parse_mode: 'Markdown' });
            }
        }
    });

    // Register handlers
    registerInputHandler(bot);
    registerUnspecHandler(bot);
    registerTangibleHandler(bot);
    registerMtcHandler(bot);

    // Tracking
    bot.on('message', (msg) => trackMessage(msg));
}

function registerDatekBotHandlers(bot) {
    bot.onText(/\/start/, (msg) => {
        const chatId = msg.chat.id;
        bot.sendMessage(chatId,
            `📊 *Datek Bot Aktif!*

Chat ID: \`${chatId}\`

Bot ini khusus untuk input dan monitoring kendala DATEK & PSB.

Commands:
/datek - Input kendala datek
/input - Input rekap PSB
/rekap - Pivot harian PSB
/testdatek - Test notifikasi`,
            { parse_mode: 'Markdown' }
        );
    });

    bot.onText(/\/help/, (msg) => {
        const chatId = msg.chat.id;
        bot.sendMessage(chatId,
            `📚 *Datek Bot Help*

commands:
/datek - Input data kendala datek
/input - Input rekap PSB (reply ke tiket PSB)
/rekap - Pivot harian PSB (/rekap dd/mm/yyyy)
/cancel - Hapus data (reply ke konfirmasi bot)
/testdatek - Test notifikasi`,
            { parse_mode: 'Markdown' }
        );
    });

    // Handle /del
    bot.onText(/\/del/, async (msg) => {
        handleDelCommand(bot, msg);
    });

    // Register Datek Handler
    registerDatekHandler(bot);

    // Register PSB Input Handler
    registerPsbInputHandler(bot);

    // Register PSB Rekap Handler
    registerPsbRekapHandler(bot);

    // Tracking
    bot.on('message', (msg) => trackMessage(msg));
}

// Shared helper for /del
async function handleDelCommand(bot, msg) {
    const chatId = msg.chat.id;
    if (!msg.reply_to_message) {
        await bot.sendMessage(chatId, '❌ Reply ke pesan bot yang ingin dihapus, lalu ketik /del');
        return;
    }
    const repliedMessage = msg.reply_to_message;
    const botInfo = await bot.getMe();
    if (repliedMessage.from.id !== botInfo.id) {
        await bot.sendMessage(chatId, '❌ Hanya bisa menghapus pesan dari bot ini');
        return;
    }
    try {
        await bot.deleteMessage(chatId, repliedMessage.message_id);
    } catch (error) {
        // ignore
    }
}

// Shared tracking
function trackMessage(msg) {
    try {
        const chat = msg.chat;
        upsertTelegramChat({
            chatId: chat.id,
            title: chat.title || chat.first_name || chat.username || 'Private Chat',
            type: chat.type,
            username: chat.username || null
        });
        if ((chat.type === 'group' || chat.type === 'supergroup') && msg.from) {
            upsertGroupMember({
                chatId: chat.id,
                userId: msg.from.id,
                username: msg.from.username || null,
                firstName: msg.from.first_name || null,
                lastName: msg.from.last_name || null
            });
        }
    } catch (e) { }
}

export async function sendTestMessage(chatId, type = 'gangguan') {
    const bot = type === 'datek' ? botDatek : botGangguan;

    if (!bot) {
        throw new Error(`${type === 'datek' ? 'Datek' : 'Gangguan'} bot not initialized`);
    }

    await bot.sendMessage(chatId,
        `🧪 *Test Message (${type === 'datek' ? 'Datek Bot' : 'Gangguan Bot'})*

Koneksi berhasil!

Time: ${formatToWIB()} (WIB)`,
        { parse_mode: 'Markdown' }
    );
}

export async function sendWorkOrderNotification(chatId, workOrder, extraFooter = '', showSummary = false) {
    if (!botGangguan) {
        console.log('⚠️ Gangguan bot not initialized, skipping notification');
        return;
    }
    const bot = botGangguan;

    // ... rest of notification logic ...
    const bold = (text) => `<b>${text}</b>`;

    // Helper to extract phone and normalize to 628...
    const getPhone = () => {
        let ph = workOrder.contactPhone || workOrder.phone || '';
        ph = String(ph).replace(/\D/g, '');
        if (ph.length >= 10) {
            if (ph.startsWith('62')) return ph;
            if (ph.startsWith('08')) return '62' + ph.substring(1);
        }
        const summary = workOrder.summary || '';
        const match = summary.match(/(62|0)8\d{8,}/);
        if (match) {
            let found = match[0];
            if (found.startsWith('0')) return '62' + found.substring(1);
            return found;
        }
        return ph || '-';
    };

    // Helper to format date
    const formatDate = (dateInput) => {
        if (!dateInput) return '-';
        try {
            const d = new Date(dateInput);
            if (isNaN(d.getTime())) return String(dateInput);

            const day = String(d.getDate()).padStart(2, '0');
            const month = String(d.getMonth() + 1).padStart(2, '0');
            const year = d.getFullYear();
            const hour = String(d.getHours()).padStart(2, '0');
            const minute = String(d.getMinutes()).padStart(2, '0');
            return `${day}-${month}-${year} ${hour}:${minute}`;
        } catch (e) {
            return String(dateInput);
        }
    };

    // Helper to extract No Internet (12 digits, often starts with 1)
    const getNoInet = () => {
        let val = workOrder.serviceNo || workOrder.service_no || workOrder.no_inet || '';
        if (val && val !== '-' && val.length > 5) return val;
        const summary = workOrder.summary || '';
        const match = summary.match(/1\d{11}/);
        return match ? match[0] : (val || '-');
    };

    const statusEmoji = {
        'OPEN': '📬', 'BACKEND': '⚙️', 'IN_PROGRESS': '🔄', 'CLOSED': '✅', 'RESOLVED': '✅', 'CANCELLED': '❌', 'ANALYSIS': '🔍', 'DRAFT': '📝', 'PENDING': '⏳'
    };

    const tierEmoji = {
        'HVC_PLATINUM': '💎', 'HVC_DIAMOND': '💠', 'HVC_GOLD': '🥇', 'REGULER': '📋'
    };

    const orderId = workOrder.orderId || workOrder.order_id || 'Unknown';
    const noInet = getNoInet();
    const status = (workOrder.status || 'OPEN').toUpperCase();
    const tier = workOrder.customerType || 'REGULER';
    const summary = workOrder.summary || workOrder.title || '';
    const type = summary.includes('[SQM]') ? 'SQM' : 'REGULER';
    const workzone = workOrder.workzone || '-';
    const cp = getPhone();
    const reportedDate = formatDate(workOrder.reportedDate || workOrder.reported_date);
    const expiredDate = formatDate(workOrder.expiredDate || workOrder.expired_date);
    const source = workOrder.source || 'Scraper';
    const bookingDate = formatDate(workOrder.bookingDate || workOrder.booking_date);

    // Construct message with HTML
    const message =
        `📋 New Work Order ID: ${code(orderId)}
No Internet : ${code(noInet)}
Status: ${statusEmoji[status] || statusEmoji[workOrder.status] || '⚙️'} ${status}
Tier: ${tierEmoji[tier] || '📋'} ${tier}
Type : ${type}
CP : ${code(cp)}
Workzone : ${workzone}
Reported Date : ${reportedDate}
${type === 'REGULER' ? `<b>Booking Date : ${bookingDate}</b>\n` : ''}Expired Date : ${expiredDate}
Source: ${source}

${showSummary ? `<pre>${(summary || '-').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</pre>` : ''}

${extraFooter || ''}`;

    // Delay 15 seconds (Testing)
    await new Promise(resolve => setTimeout(resolve, 15000));

    try {
        await bot.sendMessage(chatId, message.trim(), { parse_mode: 'HTML' });
        console.log(`📱 Notification sent for ${orderId}`);
    } catch (error) {
        console.error('❌ Failed to send Telegram notification:', error.message);
        try {
            await bot.sendMessage(chatId, message.replace(/<[^>]*>/g, ''), { parse_mode: null });
        } catch (e) {
            console.error('❌ Failed fallback send:', e.message);
        }
    }
}

/**
 * Broadcast technician performance stats
 * @param {string} chatId - Target chat ID
 * @param {string} date - Date YYYY-MM-DD
 * @param {string} period - 'daily' or 'monthly'
 * @param {string[]} tipeTickets - Optional array of tipe_tiket to filter
 */
export async function broadcastPerformance(chatId, date, period = 'daily', tipeTickets = null) {
    if (!botGangguan) throw new Error('Gangguan bot not initialized');

    // Determine filter dates
    let startDate = date;
    let endDate = date;

    if (period === 'monthly') {
        const d = new Date(date);
        startDate = new Date(d.getFullYear(), d.getMonth(), 1).toISOString().split('T')[0];
        endDate = new Date(d.getFullYear(), d.getMonth() + 1, 0).toISOString().split('T')[0];
    }

    const stats = getPerformanceStats(startDate, endDate, period, tipeTickets);
    const config = getPerformanceConfig();
    const target = period === 'daily' ? config.min_close_per_day : config.min_close_per_month;

    // Calculate achievement
    const processedStats = stats.map(s => {
        const isAchieved = s.total_close >= target;
        return {
            ...s,
            isAchieved,
            label: isAchieved ? 'ACHIEVE ✅' : 'NOT ACHIEVE ❌'
        };
    });

    // Format Title
    const dateObj = new Date(date);
    const options = { day: 'numeric', month: 'long', year: 'numeric' };
    const dateStr = dateObj.toLocaleDateString('id-ID', options).toUpperCase();
    const title = period === 'daily'
        ? `PERFORMANSI ${dateStr}`
        : `PERFORMANSI BULAN ${dateObj.toLocaleDateString('id-ID', { month: 'long', year: 'numeric' }).toUpperCase()}`;

    // Format List
    let list = processedStats.map((s, index) => {
        const name = s.full_name ? s.full_name.toUpperCase() : s.reported_by.toUpperCase();
        const icon = s.isAchieved ? '✅' : '❌';

        return `${index + 1}. ${name} - Close = ${s.total_close} ${icon}`;
    }).join('\n');

    if (processedStats.length === 0) {
        list = "Belum ada data performansi untuk periode ini.";
    }

    // Format Footer (Mentions)
    // Escape underscores in usernames for Markdown
    const mentions = processedStats
        .filter(s => s.telegram_username)
        .map(s => {
            const u = s.telegram_username.startsWith('@') ? s.telegram_username : `@${s.telegram_username}`;
            return u.replace(/_/g, '\\_');
        })
        .join(' ');

    const message = `
*${title}*

\`\`\`python
===== PERFORMANCE BY INPUT =====

${list}
==================================
✅ = ACHIEVE
❌ = NOT ACHIEVE
==================================
Workorder Manager © 2026 IrfnCode. All rights reserved.
\`\`\`

${mentions}
`;

    // Send
    await sendFormattedMessage(chatId, message.trim());
    return { count: processedStats.length, message };
}


export async function sendFormattedMessage(chatId, message) {
    if (!botGangguan) {
        throw new Error('Gangguan bot not initialized');
    }

    try {
        await botGangguan.sendMessage(chatId, message, { parse_mode: 'Markdown' });
        console.log('📱 Formatted message sent to Telegram');
    } catch (error) {
        // Try without markdown if it fails
        try {
            await botGangguan.sendMessage(chatId, message);
            console.log('📱 Message sent to Telegram (plain text)');
        } catch (e) {
            console.error('❌ Failed to send Telegram message:', e.message);
            throw e;
        }
    }
}

export function getBotInstance() {
    return botGangguan;
}

export function getGangguanBot() { return botGangguan; }
export function getDatekBot() { return botDatek; }

/**
 * Notify user of DATEK status update via Telegram
 * Edits the existing reply or sends a new reply
 * @param {Object} rekap - The rekap object with updated status
 */
export async function notifyDatekUpdate(rekap) {
    if (!rekap || !rekap.telegram_chat_id) return;

    const bot = botDatek;
    if (!bot) return;

    try {
        const escMd = (text) => {
            if (!text) return '\\-';
            return text.toString().replace(/[_*[\]()~`>#+=|{}.!-]/g, '\\$&');
        };

        // Determine status icon
        const ket = (rekap.keterangan_pusat || '').toLowerCase();
        const tl = (rekap.tindak_lanjut || '').toLowerCase();

        let statusIcon = '⏳';
        let statusText = 'Diproses';

        if (ket.includes('done') || tl.includes('done') || tl.includes('close')) {
            statusIcon = '✅';
            statusText = 'SELESAI';
        } else if (ket || tl) {
            statusIcon = '⚙️';
            statusText = 'ON PROGRESS';
        }

        const reporter = rekap.reported_by || rekap.input_by || '';
        const mention = reporter ? `@${escMd(reporter.replace('@', ''))} ` : '';

        const message = `${statusIcon} *Update Status DATEK*
${mention}

📋 WO Number: ${escMd(rekap.no_inc)}
🔌 No Inet: ${escMd(rekap.no_inet)}
📝 Keterangan Pusat:
_${escMd(rekap.keterangan_pusat || 'Belum ada')}_

🛠 Tindak Lanjut:
_${escMd(rekap.tindak_lanjut || 'Belum ada')}_

${statusIcon} Status: ${statusText}
⏰ Updated: ${escMd(formatToWIB())} WIB`;

        // Delete previous status message if it exists
        if (rekap.telegram_reply_id) {
            try {
                await bot.deleteMessage(rekap.telegram_chat_id, rekap.telegram_reply_id);
                console.log(`🗑️ Deleted previous DATEK status message: ${rekap.telegram_reply_id}`);
            } catch (delError) {
                // If deletion fails (e.g. too old > 48h, or already deleted), just log and continue
                console.log(`⚠️ Could not delete previous message: ${delError.message}`);
            }
        }

        // Send NEW reply (always reply to original message)
        const sentMsg = await bot.sendMessage(rekap.telegram_chat_id, message, {
            reply_to_message_id: rekap.telegram_message_id, // Reply to original command
            parse_mode: 'MarkdownV2'
        });

        // Update DB with new reply ID
        if (sentMsg) {
            updateRekap(rekap.id, { telegramReplyId: sentMsg.message_id });
        }
        console.log(`📱 Sent new DATEK status message for ${rekap.no_inc}`);

    } catch (error) {
        console.error(`❌ Failed to notify DATEK update: ${error.message}`);
    }
}

// Add code() helper as it was used in sendWorkOrderNotification and missed in extraction
function code(text) {
    return `<code>${text}</code>`;
}
