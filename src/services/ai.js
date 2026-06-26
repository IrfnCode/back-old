import fetch from 'node-fetch';
import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// Pointing to data relative to where this file will be (src/services/ai.js)
const DB_PATH = path.join(__dirname, '../../data/database.sqlite');

// Ensure database directory exists
const DB_DIR = path.dirname(DB_PATH);
if (!fs.existsSync(DB_DIR)) {
    fs.mkdirSync(DB_DIR, { recursive: true });
}

// Ensure database file exists (even if empty) so readonly mode doesn't throw
if (!fs.existsSync(DB_PATH)) {
    fs.writeFileSync(DB_PATH, '');
}

// For regular read-only queries
const db = new Database(DB_PATH, { readonly: true });
// For admin write operations (AI NO FILTER)
const dbAdmin = new Database(DB_PATH);

// Initialize history table for rollback
dbAdmin.exec(`
    CREATE TABLE IF NOT EXISTS history_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        original_sql TEXT,
        rollback_sql TEXT,
        executed_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
`);

async function queryDatabase(sql) {
    if (!sql || typeof sql !== 'string') {
        return { error: 'SQL query is empty or invalid' };
    }
    // SECURITY: Hard enforcement of SELECT only
    const cleanSql = sql.trim().toUpperCase();
    if (!cleanSql.startsWith('SELECT')) {
        throw new Error("I am only allowed to read data (SELECT). Edit/Delete is strictly forbidden.");
    }

    try {
        const stmt = db.prepare(sql);
        return stmt.all();
    } catch (err) {
        return { error: err.message };
    }
}

async function modifyDatabase(sql, rollbackSql) {
    if (!sql || typeof sql !== 'string') {
        return { error: 'SQL modification query is empty' };
    }

    const cleanSql = sql.trim().toUpperCase();
    // Allow UPDATE, DELETE, INSERT in this tool
    if (!cleanSql.startsWith('UPDATE') && !cleanSql.startsWith('DELETE') && !cleanSql.startsWith('INSERT')) {
        return { error: 'modify_database only accepts UPDATE, DELETE, or INSERT' };
    }

    try {
        const transaction = dbAdmin.transaction(() => {
            const stmt = dbAdmin.prepare(sql);
            const info = stmt.run();
            
            // Log to history for rollback
            if (rollbackSql) {
                dbAdmin.prepare('INSERT INTO history_log (original_sql, rollback_sql) VALUES (?, ?)').run(sql, rollbackSql);
            }
            
            return info;
        });

        const result = transaction();
        return { success: true, changes: result.changes, lastInsertRowid: result.lastInsertRowid };
    } catch (err) {
        return { error: err.message };
    }
}

async function performRollback() {
    try {
        const lastLog = dbAdmin.prepare('SELECT * FROM history_log ORDER BY id DESC LIMIT 1').get();
        if (!lastLog || !lastLog.rollback_sql) {
            return { error: 'Tidak ada perubahan yang bisa dibatalkan.' };
        }

        dbAdmin.exec(lastLog.rollback_sql);
        dbAdmin.prepare('DELETE FROM history_log WHERE id = ?').run(lastLog.id);

        return { success: true, original_sql: lastLog.original_sql };
    } catch (err) {
        return { error: err.message };
    }
}

const DB_TOOLS = [
    {
        type: "function",
        function: {
            name: "query_database",
            description: "Jalankan SQL SELECT untuk mencari data dari database. WAJIB gunakan LIKE untuk filter tanggal. Contoh: SELECT COUNT(*) FROM rekap WHERE input_at LIKE '2026-03-10%'",
            parameters: {
                type: "object",
                properties: {
                    sql: {
                        type: "string",
                        description: "SQL SELECT query. Contoh: SELECT COUNT(*) FROM rekap WHERE input_at LIKE '2026-03-10%'"
                    }
                },
                required: ["sql"]
            }
        }
    },
    {
        type: "function",
        function: {
            name: "modify_database",
            description: "ADMIN ONLY: Jalankan SQL UPDATE, DELETE, atau INSERT. WAJIB sertakan rollback_sql agar data bisa dibalikin jika salah. Contoh: sql='UPDATE rekap SET category=\"REGULER\" WHERE no_inc=\"INC123\"', rollback_sql='UPDATE rekap SET category=\"DATEK\" WHERE no_inc=\"INC123\"'",
            parameters: {
                type: "object",
                properties: {
                    sql: { type: "string", description: "SQL command (UPDATE/DELETE/INSERT)" },
                    rollback_sql: { type: "string", description: "SQL kebalikan untuk membatalkan perubahan ini." }
                },
                required: ["sql", "rollback_sql"]
            }
        }
    },
    {
        type: "function",
        function: {
            name: "rollback_last_change",
            description: "ADMIN ONLY: Batalkan perubahan database terakhir jika user memintanya (misal: 'balikin ke semula', 'undo', 'salah edit').",
            parameters: { type: "object", properties: {} }
        }
    },
    {
        type: "function",
        function: {
            name: "answer_general_question",
            description: "Gunakan untuk sapaan atau menjawab pertanyaan umum.",
            parameters: {
                type: "object",
                properties: {
                    reply_text: { type: "string", description: "Jawaban langsung kepada user." }
                },
                required: ["reply_text"]
            }
        }
    }
];

export async function askAI(userPrompt, mode = 'normal') {
    const WORKER_URL = "https://imageai.irfncode.workers.dev/chat";
    const API_KEY = "1ebd13840eced343d689ddf08b03f7a4";
    const todayDate = new Date().toLocaleString("id-ID", {
        timeZone: "Asia/Jakarta",
        year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit"
    });

    const systemPersona = `Anda adalah Pan AI, asisten cerdas WorkOrder Manager PanWO V01.00.
Sekarang tanggal ${todayDate} (WIB). Gunakan ini jika user bilang "hari ini"/"kemarin"/"bulan ini".

ATURAN SQL KRITIS (WAJIB DIPATUHI):
- TANGGAL: Kolom tanggal berformat DATETIME. DILARANG pakai = untuk filter tanggal. WAJIB pakai LIKE. Contoh: WHERE input_at LIKE '2026-03-10%'
- TIKET DIINPUT: Data tiket yang diinput teknisi ada di tabel REKAP (bukan work_orders). Kolom tanggal input = input_at. Kolom penginput = input_by.
- SYNTAX: Gunakan OR dan AND (bahasa SQL), BUKAN ATAU dan DAN.

CONTOH SQL YANG BENAR (IKUTI POLA INI):
- Jumlah tiket diinput tanggal 10 Maret: SELECT COUNT(*) FROM rekap WHERE input_at LIKE '2026-03-10%'
- Siapa saja yang input tiket tanggal 10 Maret: SELECT DISTINCT input_by FROM rekap WHERE input_at LIKE '2026-03-10%'
- Nama + NIK + tiket yg diinput tanggal 10 Maret: SELECT COALESCE(tm.full_name, r.input_by) as nama, COALESCE(tm.nik, '-') as nik, r.no_inc FROM rekap r LEFT JOIN team_members tm ON (tm.name = r.input_by OR tm.telegram_username = r.input_by) WHERE r.input_at LIKE '2026-03-10%'
- Jumlah tiket gangguan masuk tanggal 10 Maret: SELECT COUNT(*) FROM work_orders WHERE reported_date LIKE '2026-03-10%'
- Detail nomor internet: Cari di KEDUA tabel! Pertama: SELECT * FROM work_orders WHERE service_no = '111651112951'. Jika kosong, coba: SELECT * FROM rekap WHERE no_inet = '111651112951'
- Detail nomor tiket/incident: Cari di KEDUA tabel! Pertama: SELECT * FROM work_orders WHERE order_id = 'INC47129437'. Jika kosong, coba: SELECT * FROM rekap WHERE no_inc = 'INC47129437'
- Cari info/NIK teknisi by nama: SELECT * FROM team_members WHERE name LIKE '%didik%' OR full_name LIKE '%didik%'
- PENTING: Jika pencarian pertama hasilnya 0, WAJIB coba tabel kedua sebelum menjawab 'tidak ditemukan'!
- PENTING: Jika user menyebut NAMA ORANG, cari di tabel team_members (kolom name atau full_name), BUKAN di rekap!

ATURAN LAIN:
- JIKA user menyebut NOMOR SPESIFIK (nomor inet, nomor tiket, INC, WO, dll): WAJIB cari di database pakai query_database! JANGAN jawab "tidak punya akses".
- Untuk data spesifik / pertanyaan yang menyebut angka atau kode: PANGGIL tool query_database.
- HANYA untuk sapaan (halo/hai) atau pengetahuan umum tanpa angka: PANGGIL tool answer_general_question.
- UNTUK PERFORMANSI / JUMLAH CLOSE: WAJIB ABAIKAN kategori 'DATEK' (kecuali user secara spesifik bertanya tentang datek). Gunakan 'category != DATEK' di SQL.
- FORMAT LIST: Gunakan bullet point (- ) dan enter ganda di setiap item agar rapi di Telegram.

REFERENSI TABEL DATABASE:
1. work_orders: Tiket utama gangguan pelanggan.
   Kolom: order_id(nomor tiket), title(judul), status(OPEN/CLOSE), assigned_to(teknisi yg menangani), reported_date(tgl laporan), customer_name, service_no, witel, workzone, team, street_address, latitude, longitude
2. rekap: Laporan hasil pekerjaan yg di-input teknisi.
   Kolom: no_inc(nomor insiden), no_inet(nomor internet), input_by(siapa yg input), input_at(kapan diinput), rca, keterangan, alamat, tipe_tiket, category, tindak_lanjut, odp, mat, datek_inputan, datek_real
3. team_members: Data teknisi.
   Kolom: name(nama pendek), full_name(nama lengkap), nik(NIK karyawan), telegram_username, team_id
4. teams: Daftar tim. Kolom: id, name
5. schedule_entries: Jadwal shift teknisi. Kolom: name, month, year, day, shift
6. schedule_status: Status kehadiran. Kolom: excel_name, day, month, year, status(hadir/cuti/izin), note
7. performance_config: Config performa. Kolom: min_close_per_day
8. auto_send_config: Rotasi kirim tiket. Kolom: workzone, rotation_index

Hanya gunakan SELECT. Jangan INSERT/UPDATE/DELETE.`;

    const chatPersona = `Anda adalah Pan AI dalam MODE CHAT.
Anda dilarang keras mengakses data server atau database.
Tugas Anda adalah mengobrol santai, memberikan lelucon, atau menjawab pengetahuan umum secara ramah.
JANGAN gunakan tool database apapun. Jika ditanya soal data server, jawab bahwa Anda sedang dalam mode chat dan tidak punya akses.`;

    const adminPersona = `ANDA ADALAH PAN AI DALAM MODE "AI NO FILTER" (ADMIN).
Anda memiliki akses PENUH untuk MEMBACA, MENGUBAH, dan MENGHAPUS data di database.

ATURAN ADMIN:
1. Anda diperbolehkan menggunakan tool modify_database untuk UPDATE/DELETE/INSERT.
2. Setiap kali mengubah data, WAJIB sertakan rollback_sql yang akurat.
3. Anda bisa membatalkan perubahan terakhir dengan tool rollback_last_change.
4. Jangan ragu-ragu jika user meminta mengedit data, lakukan dengan presisi.
5. Jika data tidak sesuai setelah diedit, tawarkan user untuk menggunakan fitur rollback.

REFERENSI TABEL SAMA DENGAN MODE NORMAL.`;

    let activePersona = systemPersona;
    let activeTools = DB_TOOLS.filter(t => t.function.name !== 'modify_database' && t.function.name !== 'rollback_last_change');

    if (mode === 'chat') {
        activePersona = chatPersona;
        activeTools = DB_TOOLS.filter(t => t.function.name === 'answer_general_question');
    } else if (mode === 'admin') {
        activePersona = adminPersona;
        activeTools = DB_TOOLS;
    }

    try {
        let currentMessages = [
            { role: "system", content: activePersona },
            { role: "user", content: userPrompt }
        ];

        let attempt = 0;
        const MAX_ATTEMPTS = 5;
        let lastSql = "";

        while (attempt < MAX_ATTEMPTS) {
            attempt++;

            const lastMsg = currentMessages[currentMessages.length - 1];
            const shouldSendTools = !(lastMsg.role === "user" && lastMsg.content.includes("TANPA MEMANGGIL TOOL"));

            const requestBody = { messages: currentMessages };
            if (shouldSendTools) {
                requestBody.tools = activeTools;
            }

            const response = await fetch(WORKER_URL, {
                method: "POST",
                headers: {
                    "Authorization": `Bearer ${API_KEY}`,
                    "Content-Type": "application/json"
                },
                body: JSON.stringify(requestBody)
            });

            const data = await response.json();

            // 1. Cek jika AI menggunakan tool resmi
            if (data.tool_calls && data.tool_calls.length > 0) {
                const toolCall = data.tool_calls[0];

                const rawArgs = toolCall.function?.arguments || toolCall.arguments || "{}";
                const args = typeof rawArgs === "string" ? JSON.parse(rawArgs) : rawArgs;
                const toolName = toolCall.function?.name || toolCall.name || "query_database";

                if (toolName === "answer_general_question") {
                    console.log(`💬 AI General Chat: ${args.reply_text}`);
                    return args.reply_text || "Maaf, saya tidak mengerti maksud Anda.";
                }

                if (toolName === "rollback_last_change") {
                    console.log(`🔄 AI requested Rollback`);
                    const rollbackResult = await performRollback();
                    if (rollbackResult.success) {
                        return `✅ *Rollback Berhasil!*\n\nPerubahan terakhir dibatalkan:\n\`${rollbackResult.original_sql}\`\n\nData sekarang sudah kembali ke kondisi semula.`;
                    } else {
                        return `❌ *Rollback Gagal:* ${rollbackResult.error}`;
                    }
                }

                if (toolName === "modify_database") {
                    console.log(`🔴 ADMIN: AI is modifying database: ${args.sql}`);
                    const modResults = await modifyDatabase(args.sql, args.rollback_sql);
                    if (modResults.success) {
                        return `✅ *Database Berhasil Diubah!*\n\nQuery: \`${args.sql}\`\nBaris terpengaruh: ${modResults.changes}\n\nKetik "balikin ke semula" jika ini salah.`;
                    } else {
                        currentMessages.push({ role: "user", content: `Gagal mengubah database: ${modResults.error}. Perbaiki SQL-mu dan coba lagi.` });
                        continue;
                    }
                }

                if (toolName === "rollback_last_change") {
                    console.log(`🔄 AI requested Rollback`);
                    const rollbackResult = await performRollback();
                    if (rollbackResult.success) {
                        return `✅ *Rollback Berhasil!*\n\nPerubahan terakhir dibatalkan:\n\`${rollbackResult.original_sql}\`\n\nData sekarang sudah kembali ke kondisi semula.`;
                    } else {
                        return `❌ *Rollback Gagal:* ${rollbackResult.error}`;
                    }
                }

                if (toolName === "modify_database") {
                    console.log(`🔴 ADMIN: AI is modifying database: ${args.sql}`);
                    const modResults = await modifyDatabase(args.sql, args.rollback_sql);
                    if (modResults.success) {
                        return `✅ *Database Berhasil Diubah!*\n\nQuery: \`${args.sql}\`\nBaris terpengaruh: ${modResults.changes}\n\nKetik "balikin ke semula" jika ini salah.`;
                    } else {
                        currentMessages.push({ role: "user", content: `Gagal mengubah database: ${modResults.error}. Perbaiki SQL-mu dan coba lagi.` });
                        continue;
                    }
                }

                if (toolName === "query_database") {
                    if (args.sql === lastSql) {
                        console.log(`⚠️ AI Bridge Loop Detected! Forcing answer for: ${args.sql}`);
                        currentMessages.push({
                            role: "user",
                            content: "Data sudah diberikan di pesan sebelumnya. BACA data tersebut dan LANGSUNG berikan jawaban finalmu SEKARANG TANPA MEMANGGIL TOOL LAGI!"
                        });
                        continue;
                    }
                    lastSql = args.sql;
                }

                console.log(`🤖 AI Bridge is querying (Attempt ${attempt}): ${args.sql}`);
                if (!args.sql) {
                    console.log(`⚠️ AI called query_database without SQL, forcing text answer`);
                    currentMessages.push({
                        role: "user",
                        content: "Data sudah diberikan di pesan sebelumnya. BACA data tersebut dan LANGSUNG berikan jawaban finalmu SEKARANG TANPA MEMANGGIL TOOL LAGI!"
                    });
                    continue;
                }
                const dbResults = await queryDatabase(args.sql);
                console.log(`📊 DB Results (${Array.isArray(dbResults) ? dbResults.length + ' rows' : 'error'}):`, JSON.stringify(dbResults).substring(0, 300));

                // Jika DB mengembalikan error, beri petunjuk koreksi ke AI
                if (dbResults && dbResults.error) {
                    console.log(`❌ SQL Error: ${dbResults.error}`);
                    currentMessages.push({
                        role: "user",
                        content: `SQL error: ${dbResults.error}. PERBAIKI SQL-MU! Berikut kolom yang BENAR:
- Tabel rekap: no_inc, no_inet, input_by, input_at, rca, keterangan, alamat, tipe_tiket, category, tindak_lanjut, odp, mat
- Tabel team_members: name, full_name, nik, telegram_username, team_id
- Tabel work_orders: order_id, title, status, assigned_to, reported_date, customer_name, service_no, witel, workzone
Jika butuh data dari 2 tabel, gunakan LEFT JOIN! Contoh: SELECT COALESCE(tm.full_name, r.input_by) as nama, COALESCE(tm.nik, '-') as nik, r.no_inc FROM rekap r LEFT JOIN team_members tm ON (tm.name = r.input_by OR tm.telegram_username = r.input_by) WHERE r.input_at LIKE '2026-03-10%'
Gunakan LIKE untuk tanggal. Panggil tool query_database dengan SQL yang sudah diperbaiki.`
                    });
                    continue;
                }
                // Format SEMUA hasil database langsung di Node.js (tidak kirim balik ke AI)
                const labelMap = {
                    'full_name': 'Nama', 'nama': 'Nama', 'name': 'Nama',
                    'nik': 'NIK', 'no_inc': 'No Tiket', 'order_id': 'No Tiket',
                    'input_by': 'Diinput Oleh', 'input_at': 'Waktu Input',
                    'no_inet': 'No Internet', 'status': 'Status',
                    'assigned_to': 'Teknisi', 'customer_name': 'Pelanggan',
                    'workzone': 'Workzone', 'tipe_tiket': 'Tipe', 'category': 'Kategori',
                    'shift': 'Shift', 'rca': 'RCA', 'keterangan': 'Keterangan',
                    'alamat': 'Alamat', 'tindak_lanjut': 'Tindakan',
                    'reported_date': 'Tgl Laporan', 'created_at': 'Dibuat',
                    'title': 'Judul', 'description': 'Deskripsi',
                    'service_no': 'No Layanan', 'contact_phone': 'Telepon',
                    'team': 'Tim', 'witel': 'Witel', 'priority': 'Prioritas',
                    'street_address': 'Alamat', 'summary': 'Ringkasan',
                    'odp': 'ODP', 'mat': 'Material', 'telegram_username': 'Username TG',
                    'customer_type': 'Tipe Pelanggan', 'customer_segment': 'Segmen',
                    'reported_by': 'Dilaporkan Oleh', 'source': 'Sumber',
                    'datek_inputan': 'Datek Input', 'datek_real': 'Datek Real',
                    'updated_at': 'Diupdate'
                };

                if (Array.isArray(dbResults) && dbResults.length === 0) {
                    console.log(`📭 0 rows returned, telling AI to try another table`);
                    currentMessages.push({
                        role: "user",
                        content: `Query "${args.sql}" mengembalikan 0 hasil. Coba cari di tabel LAIN! Ingat: nomor internet bisa di rekap.no_inet ATAU work_orders.service_no. Nomor tiket bisa di rekap.no_inc ATAU work_orders.order_id. Info teknisi di team_members. Panggil query_database dengan tabel yang berbeda.`
                    });
                    continue;
                }

                // Safety cap: jika hasil terlalu banyak (>100), query terlalu lebar, suruh AI perbaiki
                if (Array.isArray(dbResults) && dbResults.length > 100) {
                    console.log(`⚠️ Too many results (${dbResults.length} rows), telling AI to refine query`);
                    currentMessages.push({
                        role: "user",
                        content: `Query mengembalikan ${dbResults.length} baris - TERLALU BANYAK! Query-mu kurang spesifik, pasti kurang WHERE atau filter. Perbaiki query dengan menambah kondisi WHERE yang lebih spesifik sesuai permintaan user. Panggil query_database lagi.`
                    });
                    continue;
                }

                // Jika hasil = 1 baris dan hanya 1 kolom (misal COUNT), jawab singkat
                if (Array.isArray(dbResults) && dbResults.length === 1) {
                    const columns = Object.keys(dbResults[0]);
                    if (columns.length === 1 && columns[0].includes('COUNT')) {
                        return `📊 Jumlah: ${dbResults[0][columns[0]]}`;
                    }
                }

                // Format data sebagai list rapi
                console.log(`📋 Formatting ${dbResults.length} rows directly in code`);
                const columns = Object.keys(dbResults[0]);
                // Hilangkan kolom yang biasanya tidak perlu ditampilkan
                const skipColumns = ['id', 'telegram_sent', 'telegram_chat_id', 'telegram_message_id', 'telegram_reply_id', 'is_synced_external', 'id_valins', 'pid', 'latitude', 'longitude'];
                const displayColumns = columns.filter(c => !skipColumns.includes(c));

                let formattedResult = `📊 Ditemukan ${dbResults.length} data:\n\n`;

                dbResults.forEach((row, i) => {
                    const lines = displayColumns.map(col => {
                        const label = labelMap[col] || col;
                        const val = row[col] !== null && row[col] !== undefined && row[col] !== '' ? row[col] : '-';
                        return `  ${label}: ${val}`;
                    }).join('\n');
                    formattedResult += `${i + 1}.\n${lines}\n\n`;
                });

                return formattedResult;
            }

            // 2. Jika AI membalas teks
            let normalResponse = data.response || data.content || "";
            if (typeof normalResponse !== "string") {
                normalResponse = JSON.stringify(normalResponse);
            }

            // Fallback 1: JSON mentah di teks
            if (typeof normalResponse === "string" && normalResponse.includes('"name":') && normalResponse.includes('query')) {
                try {
                    const startIndex = normalResponse.indexOf('{');
                    const endIndex = normalResponse.lastIndexOf('}');

                    if (startIndex !== -1 && endIndex !== -1 && endIndex > startIndex) {
                        const jsonStr = normalResponse.substring(startIndex, endIndex + 1);
                        const parsed = JSON.parse(jsonStr);

                        const inlineSql = parsed.parameters?.sql || parsed.arguments?.sql;

                        if (inlineSql) {
                            console.log(`🤖 AI Bridge is querying (Fallback JSON Attempt ${attempt}): ${inlineSql}`);
                            const inlineDbResults = await queryDatabase(inlineSql);
                            console.log(`📊 Fallback DB Results:`, JSON.stringify(inlineDbResults).substring(0, 200));

                            const cleanNaration = normalResponse.substring(0, startIndex).trim() || "Berikut adalah data yang saya temukan:";

                            currentMessages.push({ role: "assistant", content: cleanNaration });
                            currentMessages.push({ role: "user", content: `Hasil query database:\n${JSON.stringify(inlineDbResults)}\nRangkum data tersebut dan berikan jawaban yang rapi kepada saya TANPA MEMANGGIL TOOL LAGI. Gunakan bullet point (- ) dan enter ganda untuk list.` });
                            continue;
                        }
                    }
                } catch (e) { console.error("Gagal parse inline fallback JSON", e.message); }
            }
            // Fallback 2: Raw SQL di teks
            else if (typeof normalResponse === "string" && normalResponse.toUpperCase().includes("SELECT ") && normalResponse.toUpperCase().includes(" FROM ")) {
                try {
                    const sqlMatch = normalResponse.match(/SELECT\s+.*?\s+FROM\s+.*?(?:;|(?=\n\n)|$)/is);
                    if (sqlMatch) {
                        const rawSql = sqlMatch[0].trim();
                        const cleanSql = rawSql.replace(/```sql|```/gi, "").trim();

                        console.log(`🤖 AI Bridge is querying (Fallback Raw SQL Attempt ${attempt}): ${cleanSql}`);
                        const rawDbResults = await queryDatabase(cleanSql);
                        console.log(`📊 Raw SQL DB Results:`, JSON.stringify(rawDbResults).substring(0, 200));

                        let cleanNarationRaw = normalResponse.replace(sqlMatch[0], "").replace(/```sql|```/gi, "").trim();
                        if (!cleanNarationRaw) cleanNarationRaw = "Sedang mengambil data dari server:";

                        currentMessages.push({ role: "assistant", content: cleanNarationRaw });
                        currentMessages.push({ role: "user", content: `Hasil query database:\n${JSON.stringify(rawDbResults)}\nRangkum data tersebut dan berikan jawaban yang rapi kepada saya TANPA MEMANGGIL TOOL LAGI. Gunakan bullet point (- ) dan enter ganda untuk list.` });
                        continue;
                    }
                } catch (e) { console.error("Gagal parse raw fallback SQL", e.message); }
            }

            if (!normalResponse || normalResponse.trim() === "") {
                normalResponse = "Maaf, AI merespon dengan pesan kosong dan tidak meminta tool apapun.";
            }

            return normalResponse;
        }

        return "Maaf, AI membutuhkan terlalu banyak percobaan pencarian data (Melebihi Limit).";
    } catch (error) {
        console.error("Worker Bridge AI Error:", error);
        return "Maaf, sistem AI (Bridge) sedang mengalami gangguan.";
    }
}
