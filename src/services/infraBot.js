import TelegramBot from 'node-telegram-bot-api';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
    addInfraOrder,
    getOpenInfraOrders,
    getClosedInfraOrders,
    getInfraOrderById,
    closeInfraOrder,
    deleteInfraOrder
} from './database.js';
import { exportInfraToSpreadsheet } from './gdocs.js';

// Fungsi upload ke Catbox
async function uploadToCatbox(filePath) {
    try {
        const fileBuffer = fs.readFileSync(filePath);
        const form = new FormData();
        form.append('reqtype', 'fileupload');
        const blob = new Blob([fileBuffer], { type: 'image/jpeg' });
        form.append('fileToUpload', blob, path.basename(filePath));
        
        const res = await fetch('https://catbox.moe/user/api.php', { method: 'POST', body: form });
        const url = await res.text();
        return url.startsWith('http') ? url : null;
    } catch (e) {
        console.error('Catbox upload error:', e.message);
        return null;
    }
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const UPLOADS_DIR = path.join(__dirname, '../../data/infra_uploads');

// Ensure uploads dir exists
if (!fs.existsSync(UPLOADS_DIR)) {
    fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

// In-memory state for conversational bot
const userStates = new Map();

// Helper to generate random order ID
function generateOrderId() {
    return 'INFRA-' + Math.random().toString(36).substr(2, 6).toUpperCase();
}

async function syncToSheets() {
    try {
        const sheetId = '1583_RvfcTZ8-BZrMVQxpGZ25fZ_QyN8ziRsofN6zZtY'; // Configured sheet ID
        const openOrders = getOpenInfraOrders();
        const closedOrders = getClosedInfraOrders();
        const allOrders = [...openOrders, ...closedOrders];
        await exportInfraToSpreadsheet(sheetId, allOrders);
    } catch (err) {
        console.error('Failed to sync infra orders to sheets:', err.message);
    }
}

export function initInfraBot() {
    const token = process.env.INFRA_BOT_TOKEN;
    if (!token) {
        console.log('⚠️ INFRA_BOT_TOKEN not found, skipping PELANTAR Bot initialization');
        return;
    }

    const bot = new TelegramBot(token, { polling: true });
    console.log('🚀 [PELANTAR] Bot PELANTAR Started');

    // Helper: cek apakah chatId termasuk admin yang boleh hapus order
    const adminIds = (process.env.INFRA_ADMIN_IDS || '')
        .split(',')
        .map(id => id.trim())
        .filter(Boolean);
    const isAdmin = (chatId) => adminIds.length === 0 || adminIds.includes(String(chatId));

    bot.onText(/\/start/, (msg) => {
        const chatId = msg.chat.id;
        userStates.delete(chatId); // reset state

        const opts = {
            reply_markup: {
                inline_keyboard: [
                    [{ text: '➕ INPUT ORDER', callback_data: 'INPUT_ORDER' }],
                    [{ text: '📂 LIST ORDER OPEN', callback_data: 'LIST_OPEN' }],
                    [{ text: '✅ LIST ORDER CLOSE', callback_data: 'LIST_CLOSE' }]
                ]
            }
        };
        const welcomeText = `👋 Selamat datang di Bot <b>PELANTAR</b>\n<i>(Peduli Layanan &amp; Infrastruktur Network Tanjung Pinang &amp; Sekitar)</i>\n\n`
            + `Silakan pilih menu di bawah ini untuk mengelola laporan Infrastruktur:`;
        bot.sendMessage(chatId, welcomeText, { parse_mode: 'HTML', ...opts });
    });

    // Handle /listorder for groups
    bot.onText(/\/listorder/, (msg) => {
        const chatId = msg.chat.id;
        const orders = getOpenInfraOrders();
        if (orders.length === 0) {
            bot.sendMessage(chatId, '📭 <i>Tidak ada Order OPEN saat ini.</i>', { parse_mode: 'HTML' });
            return;
        }
        
        let text = `📂 <b>DAFTAR ORDER PELANTAR (OPEN)</b>\n━━━━━━━━━━━━━━━━━━━━\n\n`;
        orders.forEach((o, idx) => {
            text += `<b>${idx+1}. ID:</b> <code>${o.order_id}</code>\n`;
            text += `🚨 <b>Kategori:</b> ${o.kategori}\n`;
            text += `📝 <b>Ket:</b> ${o.keterangan}\n`;
            text += `📍 <b>Lokasi:</b> <a href="https://maps.google.com/?q=${encodeURIComponent(o.lokasi)}">Buka Map</a>\n`;
            text += `🕒 <b>Waktu:</b> ${o.created_at}\n`;
            text += `━━━━━━━━━━━━━━━━━━━━\n`;
        });
        
        bot.sendMessage(chatId, text, { parse_mode: 'HTML', disable_web_page_preview: true });
    });

    bot.on('callback_query', async (query) => {
        const chatId = query.message.chat.id;
        const data = query.data;

        if (data === 'INPUT_ORDER') {
            const opts = {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '📦 ODP TERBUKA', callback_data: 'CAT_ODP' }],
                        [{ text: '🏗️ PINDAH TIANG', callback_data: 'CAT_TIANG' }],
                        [{ text: '⚠️ ALPRO (KU JATUH DLL)', callback_data: 'CAT_ALPRO' }]
                    ]
                }
            };
            bot.editMessageText('🚨 <b>Pilih Kategori Order PELANTAR:</b>', {
                chat_id: chatId,
                message_id: query.message.message_id,
                parse_mode: 'HTML',
                ...opts
            });
        }
        else if (data.startsWith('CAT_')) {
            let category = '';
            if (data === 'CAT_ODP') category = 'ODP TERBUKA';
            else if (data === 'CAT_TIANG') category = 'PINDAH TIANG';
            else if (data === 'CAT_ALPRO') category = 'ALPRO (KU JATUH DLL)';

            userStates.set(chatId, { 
                step: 'WAIT_KETERANGAN', 
                category, 
                foto_paths: [], 
                foto_urls: [] 
            });
            
            bot.editMessageText(`✅ Kategori dipilih: <b>${category}</b>\n\n📝 <b>Silakan ketik dan kirimkan Keterangan laporan:</b>`, {
                chat_id: chatId,
                message_id: query.message.message_id,
                parse_mode: 'HTML'
            });
        }
        else if (data === 'LIST_OPEN') {
            const orders = getOpenInfraOrders();
            if (orders.length === 0) {
                bot.sendMessage(chatId, '📭 <i>Tidak ada Order OPEN saat ini.</i>', { parse_mode: 'HTML' });
                return;
            }
            const keyboard = orders.map(o => ([{ text: `📂 [OPEN] ${o.order_id} - ${o.kategori}`, callback_data: `VIEW_${o.order_id}` }]));
            bot.sendMessage(chatId, '<b>Daftar Order OPEN:</b>\nKlik salah satu untuk melihat detail.', {
                parse_mode: 'HTML',
                reply_markup: { inline_keyboard: keyboard }
            });
        }
        else if (data === 'LIST_CLOSE') {
            const orders = getClosedInfraOrders();
            if (orders.length === 0) {
                bot.sendMessage(chatId, '📭 <i>Tidak ada Order CLOSED saat ini.</i>', { parse_mode: 'HTML' });
                return;
            }
            const keyboard = orders.map(o => ([{ text: `✅ [CLOSED] ${o.order_id} - ${o.kategori}`, callback_data: `VIEW_${o.order_id}` }]));
            bot.sendMessage(chatId, '<b>Daftar Order CLOSED (50 terakhir):</b>', {
                parse_mode: 'HTML',
                reply_markup: { inline_keyboard: keyboard }
            });
        }
        else if (data.startsWith('VIEW_')) {
            const orderId = data.replace('VIEW_', '');
            const order = getInfraOrderById(orderId);
            if (!order) {
                bot.sendMessage(chatId, 'Order tidak ditemukan.');
                return;
            }
            
            const msgText = `<b>DETAIL ORDER</b>\n━━━━━━━━━━━━━━━━━━━━\n`
                + `🆔 <b>ID Order:</b> <code>${order.order_id}</code>\n`
                + `📌 <b>Status:</b> ${order.status === 'OPEN' ? '📂 OPEN' : '✅ CLOSED'}\n`
                + `🚨 <b>Kategori:</b> ${order.kategori}\n`
                + `📝 <b>Keterangan:</b> ${order.keterangan}\n`
                + `📍 <b>Lokasi:</b> <a href="https://maps.google.com/?q=${encodeURIComponent(order.lokasi)}">${order.lokasi}</a>\n`
                + `🕒 <b>Dibuat:</b> ${order.created_at}\n`
                + `━━━━━━━━━━━━━━━━━━━━`;

            const opts = { parse_mode: 'HTML', disable_web_page_preview: true };
            const inlineButtons = [];
            if (order.status === 'OPEN') {
                inlineButtons.push([{ text: '✅ TANDAI SEBAGAI SELESAI (CLOSE)', callback_data: `CLOSE_${order.order_id}` }]);
            }
            inlineButtons.push([{ text: '🗑️ HAPUS ORDER INI', callback_data: `DEL_${order.order_id}` }]);
            opts.reply_markup = { inline_keyboard: inlineButtons };

            // Parse multiple URLs
            const urls = order.foto_path ? order.foto_path.split(',').filter(u => u.trim() !== '') : [];
            
            if (urls.length > 0) {
                if (urls.length === 1) {
                    bot.sendPhoto(chatId, urls[0], { caption: msgText, ...opts });
                } else {
                    // Send media group then the action message
                    const mediaGroup = urls.map((u, i) => ({ type: 'photo', media: u, caption: i === 0 ? '📸 Evident Lampiran' : '' }));
                    await bot.sendMediaGroup(chatId, mediaGroup);
                    bot.sendMessage(chatId, msgText, opts);
                }
            } else {
                bot.sendMessage(chatId, msgText, opts);
            }
        }
        else if (data.startsWith('CLOSE_')) {
            const orderId = data.replace('CLOSE_', '');
            const success = closeInfraOrder(orderId);
            if (success) {
                bot.sendMessage(chatId, `🎉 Order <code>${orderId}</code> berhasil ditutup (CLOSED).`, { parse_mode: 'HTML' });
                syncToSheets(); // Update sheets
            } else {
                bot.sendMessage(chatId, `❌ Gagal menutup order <code>${orderId}</code>.`, { parse_mode: 'HTML' });
            }
        }
        else if (data.startsWith('DEL_')) {
            if (!isAdmin(chatId)) {
                bot.answerCallbackQuery(query.id, { text: '🚫 Anda tidak memiliki akses untuk menghapus order.', show_alert: true });
                return;
            }
            const orderId = data.replace('DEL_', '');
            const order = getInfraOrderById(orderId);
            if (!order) {
                bot.answerCallbackQuery(query.id, { text: 'Order tidak ditemukan.', show_alert: true });
                return;
            }
            // Kirim konfirmasi sebelum hapus
            bot.sendMessage(chatId,
                `⚠️ <b>Konfirmasi Hapus</b>\n━━━━━━━━━━━━━━━━━━━━\n🆔 <code>${orderId}</code>\n🚨 ${order.kategori}\n\nYakin ingin <b>menghapus permanen</b> order ini? Tindakan ini tidak bisa dibatalkan!`,
                {
                    parse_mode: 'HTML',
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: '❌ YA, HAPUS PERMANEN', callback_data: `CONFIRM_DEL_${orderId}` }],
                            [{ text: '⬅️ BATAL', callback_data: `VIEW_${orderId}` }]
                        ]
                    }
                }
            );
            bot.answerCallbackQuery(query.id);
            return;
        }
        else if (data.startsWith('CONFIRM_DEL_')) {
            if (!isAdmin(chatId)) {
                bot.answerCallbackQuery(query.id, { text: '🚫 Anda tidak memiliki akses untuk menghapus order.', show_alert: true });
                return;
            }
            const orderId = data.replace('CONFIRM_DEL_', '');
            const success = deleteInfraOrder(orderId);
            if (success) {
                bot.answerCallbackQuery(query.id, { text: `🗑️ Order ${orderId} berhasil dihapus.` });
                bot.sendMessage(chatId, `🗑️ Order <code>${orderId}</code> telah <b>dihapus permanen</b>.`, { parse_mode: 'HTML' });
                syncToSheets();
            } else {
                bot.answerCallbackQuery(query.id, { text: '❌ Gagal menghapus order.', show_alert: true });
            }
            return;
        }
        else if (data === 'DONE_FOTO') {
            const state = userStates.get(chatId);
            if (state && state.step === 'WAIT_FOTO') {
                if (state.foto_paths.length === 0) {
                    bot.answerCallbackQuery(query.id, { text: '⚠️ Anda belum mengirimkan satupun foto!', show_alert: true });
                    return;
                }
                // Langsung jawab callback agar tombol tidak nge-lag
                bot.answerCallbackQuery(query.id, { text: `✅ ${state.foto_paths.length} foto diterima. Lanjut ke lokasi...` });
                state.step = 'WAIT_LOKASI';
                bot.sendMessage(chatId, `✅ <b>${state.foto_paths.length} Foto evident tersimpan.</b>\n\n📍 Terakhir, silakan <b>Kirim Shareloc Langsung</b> melalui fitur Location Telegram, atau ketik koordinatnya (Lat, Long).`, { parse_mode: 'HTML' });
                return; // sudah jawab, skip answerCallbackQuery di bawah
            }
        }
        
        bot.answerCallbackQuery(query.id);
    });

    bot.on('message', async (msg) => {
        const chatId = msg.chat.id;
        // Ignore commands
        if (msg.text && msg.text.startsWith('/')) return;

        const state = userStates.get(chatId);
        if (!state) return;

        if (state.step === 'WAIT_KETERANGAN') {
            if (!msg.text) {
                bot.sendMessage(chatId, '⚠️ <i>Harap kirimkan keterangan dalam bentuk teks.</i>', { parse_mode: 'HTML' });
                return;
            }
            state.keterangan = msg.text;
            state.step = 'WAIT_FOTO';
            bot.sendMessage(chatId, `✅ <b>Keterangan disimpan.</b>\n\n📸 Selanjutnya, silakan <b>Kirimkan Foto Evident</b>.\n<i>(Anda bisa mengirim lebih dari 1 foto / album sekaligus).</i>\n\nJika sudah selesai upload semua foto, klik tombol di bawah ini:`, { 
                parse_mode: 'HTML',
                reply_markup: {
                    inline_keyboard: [[{ text: '✅ SELESAI UPLOAD FOTO', callback_data: 'DONE_FOTO' }]]
                }
            });
        }
        else if (state.step === 'WAIT_FOTO') {
            if (!msg.photo || msg.photo.length === 0) {
                bot.sendMessage(chatId, '⚠️ <i>Harap kirimkan file berupa Foto, bukan dokumen/teks.</i>', { parse_mode: 'HTML' });
                return;
            }
            // Ambil resolusi terbesar
            const photoInfo = msg.photo[msg.photo.length - 1];
            const fileId = photoInfo.file_id;
            
            try {
                // Download lokal
                const filePath = await bot.downloadFile(fileId, UPLOADS_DIR);
                state.foto_paths.push(filePath);

                // Upload ke catbox untuk link publik (berjalan background)
                uploadToCatbox(filePath).then(url => {
                    if (url) state.foto_urls.push(url);
                });

                // Konfirmasi ke user bahwa foto diterima
                const count = state.foto_paths.length;
                bot.sendMessage(chatId, 
                    `📸 <b>Foto ke-${count} diterima!</b>\n<i>Kirim foto lain jika ada, atau tekan tombol <b>SELESAI UPLOAD FOTO</b> untuk lanjut.</i>`,
                    { parse_mode: 'HTML' }
                );
            } catch (err) {
                console.error(err);
                bot.sendMessage(chatId, '❌ Gagal memproses foto. Silakan coba lagi.');
            }
        }
        else if (state.step === 'WAIT_LOKASI') {
            let lokasi = '';
            if (msg.location) {
                lokasi = `${msg.location.latitude}, ${msg.location.longitude}`;
            } else if (msg.text) {
                lokasi = msg.text;
            } else {
                bot.sendMessage(chatId, '⚠️ <i>Harap kirimkan lokasi menggunakan fitur Location / Shareloc atau teks koordinat.</i>', { parse_mode: 'HTML' });
                return;
            }

            state.lokasi = lokasi;
            const orderId = generateOrderId();

            // Beri jeda sejenak untuk memastikan semua upload Catbox selesai
            // (Dalam skenario nyata, foto terakhir yang diupload Catbox mungkin butuh 1-2 detik)
            await new Promise(resolve => setTimeout(resolve, 1500));

            // Jika gagal catbox, gunakan fallback lokal
            const finalUrls = state.foto_urls.length > 0 ? state.foto_urls : state.foto_paths;
            const joinedPaths = finalUrls.join(',');

            // Save to DB
            const orderData = {
                order_id: orderId,
                kategori: state.category,
                keterangan: state.keterangan,
                lokasi: state.lokasi,
                foto_path: joinedPaths
            };

            addInfraOrder(orderData);
            
            const successMsg = `🎉 <b>LAPORAN TERSIMPAN & DIKIRIM KE GRUP!</b>\n━━━━━━━━━━━━━━━━━━━━\n🆔 <b>ID Order:</b> <code>${orderId}</code>`;
            bot.sendMessage(chatId, successMsg, { parse_mode: 'HTML' });

            // Forward to group
            const targetGroupId = state.category === 'ODP TERBUKA' 
                ? process.env.INFRA_GROUP_ODP 
                : process.env.INFRA_GROUP_OTHER;

            if (targetGroupId) {
                const caption = `🚨 <b>NEW ORDER (${state.category})</b>\n━━━━━━━━━━━━━━━━━━━━\n`
                    + `🆔 <b>ID:</b> <code>${orderId}</code>\n`
                    + `📝 <b>Keterangan:</b> ${state.keterangan}\n`
                    + `📍 <b>Lokasi:</b> <a href="https://maps.google.com/?q=${encodeURIComponent(state.lokasi)}">${state.lokasi}</a>\n`
                    + `📌 <b>Status:</b> 📂 OPEN\n`
                    + `━━━━━━━━━━━━━━━━━━━━`;

                try {
                    if (state.foto_paths.length === 1) {
                        await bot.sendPhoto(targetGroupId, state.foto_paths[0], { caption, parse_mode: 'HTML' });
                    } else if (state.foto_paths.length > 1) {
                        const mediaGroup = state.foto_paths.map((p, i) => ({
                            type: 'photo',
                            media: p,
                            caption: i === 0 ? caption : '',
                            parse_mode: 'HTML'
                        }));
                        await bot.sendMediaGroup(targetGroupId, mediaGroup);
                    }
                    
                    if (msg.location) {
                        await bot.sendLocation(targetGroupId, msg.location.latitude, msg.location.longitude);
                    }
                } catch (err) {
                    console.error('Failed to forward infra order to group:', err.message);
                }
            } else {
                console.log('⚠️ INFRA_GROUP_ODP or INFRA_GROUP_OTHER not set in env.');
            }

            // Sync to sheets
            syncToSheets();

            // Clear state
            userStates.delete(chatId);
        }
    });
}
