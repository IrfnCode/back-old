import TelegramBot from 'node-telegram-bot-api';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
    addInfraOrder,
    getOpenInfraOrders,
    getClosedInfraOrders,
    getInfraOrderById,
    closeInfraOrder
} from './database.js';
import { exportInfraToSpreadsheet } from './gdocs.js';

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
        console.log('⚠️ INFRA_BOT_TOKEN not found, skipping Infra Bot initialization');
        return;
    }

    const bot = new TelegramBot(token, { polling: true });
    console.log('🚀 [INFRA BOT] Bot Peduli Infra Started');

    bot.onText(/\/start/, (msg) => {
        const chatId = msg.chat.id;
        userStates.delete(chatId); // reset state

        const opts = {
            reply_markup: {
                inline_keyboard: [
                    [{ text: 'INPUT ORDER', callback_data: 'INPUT_ORDER' }],
                    [{ text: 'LIST ORDER OPEN', callback_data: 'LIST_OPEN' }],
                    [{ text: 'LIST ORDER CLOSE', callback_data: 'LIST_CLOSE' }]
                ]
            }
        };
        bot.sendMessage(chatId, 'Selamat datang di Bot *PEDULI INFRA* (INFRACARE).\nSilakan pilih menu di bawah ini:', { parse_mode: 'Markdown', ...opts });
    });

    bot.on('callback_query', async (query) => {
        const chatId = query.message.chat.id;
        const data = query.data;

        if (data === 'INPUT_ORDER') {
            const opts = {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: 'ODP TERBUKA', callback_data: 'CAT_ODP' }],
                        [{ text: 'PINDAH TIANG', callback_data: 'CAT_TIANG' }],
                        [{ text: 'ALPRO (KU JATUH DLL)', callback_data: 'CAT_ALPRO' }]
                    ]
                }
            };
            bot.editMessageText('Pilih Kategori Infracare:', {
                chat_id: chatId,
                message_id: query.message.message_id,
                ...opts
            });
        }
        else if (data.startsWith('CAT_')) {
            let category = '';
            if (data === 'CAT_ODP') category = 'ODP TERBUKA';
            else if (data === 'CAT_TIANG') category = 'PINDAH TIANG';
            else if (data === 'CAT_ALPRO') category = 'ALPRO (KU JATUH DLL)';

            userStates.set(chatId, { step: 'WAIT_KETERANGAN', category });
            
            bot.editMessageText(`Kategori dipilih: *${category}*\n\nSilakan kirimkan *Keterangan* laporan:`, {
                chat_id: chatId,
                message_id: query.message.message_id,
                parse_mode: 'Markdown'
            });
        }
        else if (data === 'LIST_OPEN') {
            const orders = getOpenInfraOrders();
            if (orders.length === 0) {
                bot.sendMessage(chatId, 'Tidak ada Order OPEN saat ini.');
                return;
            }
            const keyboard = orders.map(o => ([{ text: `[OPEN] ${o.order_id} - ${o.kategori}`, callback_data: `VIEW_${o.order_id}` }]));
            bot.sendMessage(chatId, 'Daftar Order *OPEN*:', {
                parse_mode: 'Markdown',
                reply_markup: { inline_keyboard: keyboard }
            });
        }
        else if (data === 'LIST_CLOSE') {
            const orders = getClosedInfraOrders();
            if (orders.length === 0) {
                bot.sendMessage(chatId, 'Tidak ada Order CLOSED saat ini.');
                return;
            }
            const keyboard = orders.map(o => ([{ text: `[CLOSED] ${o.order_id} - ${o.kategori}`, callback_data: `VIEW_${o.order_id}` }]));
            bot.sendMessage(chatId, 'Daftar Order *CLOSED* (50 terakhir):', {
                parse_mode: 'Markdown',
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
            
            const msgText = `*Detail Order ${order.order_id}*\n\n`
                + `*Status*: ${order.status}\n`
                + `*Kategori*: ${order.kategori}\n`
                + `*Keterangan*: ${order.keterangan}\n`
                + `*Lokasi*: ${order.lokasi}\n`
                + `*Dibuat*: ${order.created_at}\n\n`;

            const opts = { parse_mode: 'Markdown' };
            if (order.status === 'OPEN') {
                opts.reply_markup = {
                    inline_keyboard: [
                        [{ text: '✅ CLOSE ORDER INI', callback_data: `CLOSE_${order.order_id}` }]
                    ]
                };
            }

            if (order.foto_path && fs.existsSync(order.foto_path)) {
                bot.sendPhoto(chatId, order.foto_path, { caption: msgText, ...opts });
            } else {
                bot.sendMessage(chatId, msgText, opts);
            }
        }
        else if (data.startsWith('CLOSE_')) {
            const orderId = data.replace('CLOSE_', '');
            const success = closeInfraOrder(orderId);
            if (success) {
                bot.sendMessage(chatId, `✅ Order *${orderId}* berhasil di-close.`, { parse_mode: 'Markdown' });
                syncToSheets(); // Update sheets
            } else {
                bot.sendMessage(chatId, `Gagal close order ${orderId}.`);
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
                bot.sendMessage(chatId, 'Harap kirimkan keterangan dalam bentuk teks.');
                return;
            }
            state.keterangan = msg.text;
            state.step = 'WAIT_FOTO';
            bot.sendMessage(chatId, 'Keterangan disimpan. Selanjutnya, silakan *Kirimkan Foto Evident* (sebagai Photo).', { parse_mode: 'Markdown' });
        }
        else if (state.step === 'WAIT_FOTO') {
            if (!msg.photo || msg.photo.length === 0) {
                bot.sendMessage(chatId, 'Harap kirimkan file berupa Foto (bukan dokumen/file/teks).');
                return;
            }
            // Ambil resolusi terbesar
            const photoInfo = msg.photo[msg.photo.length - 1];
            const fileId = photoInfo.file_id;
            
            try {
                const filePath = await bot.downloadFile(fileId, UPLOADS_DIR);
                state.foto_path = filePath;
                state.step = 'WAIT_LOKASI';
                bot.sendMessage(chatId, 'Foto evident tersimpan. Terakhir, silakan *Kirim Shareloc Langsung* atau ketik *Lat/long* koordinatnya.', { parse_mode: 'Markdown' });
            } catch (err) {
                console.error(err);
                bot.sendMessage(chatId, 'Gagal mengunduh foto. Silakan coba lagi.');
            }
        }
        else if (state.step === 'WAIT_LOKASI') {
            let lokasi = '';
            if (msg.location) {
                lokasi = `${msg.location.latitude}, ${msg.location.longitude}`;
            } else if (msg.text) {
                lokasi = msg.text;
            } else {
                bot.sendMessage(chatId, 'Harap kirimkan lokasi menggunakan fitur Location / Shareloc atau teks koordinat.');
                return;
            }

            state.lokasi = lokasi;
            const orderId = generateOrderId();

            // Save to DB
            const orderData = {
                order_id: orderId,
                kategori: state.category,
                keterangan: state.keterangan,
                lokasi: state.lokasi,
                foto_path: state.foto_path
            };

            addInfraOrder(orderData);
            bot.sendMessage(chatId, `Laporan Tersimpan Dan Dikirim Ke Grup.\n*ID Order*: ${orderId}`, { parse_mode: 'Markdown' });

            // Forward to group
            const targetGroupId = state.category === 'ODP TERBUKA' 
                ? process.env.INFRA_GROUP_ODP 
                : process.env.INFRA_GROUP_OTHER;

            if (targetGroupId) {
                const caption = `*New Order (${state.category})*\n\n*ID*: ${orderId}\n*Keterangan*: ${state.keterangan}\n*Lokasi*: ${state.lokasi}\n*Status*: OPEN`;
                try {
                    await bot.sendPhoto(targetGroupId, state.foto_path, { caption, parse_mode: 'Markdown' });
                    if (msg.location) {
                        // send location mapping to group as well
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
