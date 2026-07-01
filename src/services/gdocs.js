import { google } from 'googleapis';
import { getConfig, getAllRekap, getRekapByCategory, getAllTeamMembers, updateDatekFromSheet, getAllDatekRekap, getAllPsbRekap, updateRekap, getRekapByNoInc, getDatekByNoInc, getSyncedRekap } from './database.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { notifyDatekUpdate } from './telegram.js';

const __filename = fileURLToPath(import.meta.url);

/**
 * Sync rekap data to Google Sheets
 * Exports to separate sheets per category:
 * - Sheet1 (or configured name): REGULER (assurance/gangguan)
 * - UNSPEC: UNSPEC entries
 * - TANGIBLE: TANGIBLE entries
 * - MTC: Maintenance entries
 */
export async function syncRekapToSheets() {
    try {
        const config = getConfig();

        // Check if Google Sheets is configured
        if (!config.gdocs_credentials || !config.gdocs_spreadsheet_id) {
            console.log('⚠️ Google Sheets not configured, skipping sync');
            return null;
        }

        const spreadsheetId = config.gdocs_spreadsheet_id;
        const mainSheetName = config.gdocs_sheet_name || 'Sheet1';

        // Pre-fetch team members for mapping
        const teamMembers = getAllTeamMembers();
        const memberMap = new Map();

        teamMembers.forEach(tm => {
            // Map by username (strip @ if present)
            if (tm.telegram_username) {
                const u = tm.telegram_username.replace('@', '').toLowerCase();
                memberMap.set(u, tm);
            }
            // Map by full name just in case
            if (tm.full_name) {
                memberMap.set(tm.full_name.toLowerCase(), tm);
            }
            // Map by name (short name)
            if (tm.name) {
                memberMap.set(tm.name.toLowerCase(), tm);
            }
        });

        // Helper to get details
        const getDetails = (username) => {
            if (!username) return { name: '', nik: '', team: '' };
            const u = username.replace('@', '').toLowerCase();
            const member = memberMap.get(u);
            return member ? {
                name: member.full_name || member.name,
                nik: member.nik || '',
                team: member.team_name || ''
            } : { name: '', nik: '', team: '' };
        };

        // Export REGULER to main sheet (Sheet1)
        const regulerData = getRekapByCategory('REGULER');
        await exportCategoryToSheet(spreadsheetId, mainSheetName, regulerData, 'REGULER', getDetails);
        console.log(`📊 Synced ${regulerData.length} REGULER entries to ${mainSheetName}`);

        // Export UNSPEC to UNSPEC sheet
        const unspecData = getRekapByCategory('UNSPEC');
        await exportCategoryToSheet(spreadsheetId, 'UNSPEC', unspecData, 'UNSPEC', getDetails);
        console.log(`📊 Synced ${unspecData.length} UNSPEC entries to UNSPEC sheet`);

        // Export TANGIBLE to TANGIBLE sheet
        const tangibleData = getRekapByCategory('TANGIBLE');
        await exportCategoryToSheet(spreadsheetId, 'TANGIBLE', tangibleData, 'TANGIBLE', getDetails);
        console.log(`📊 Synced ${tangibleData.length} TANGIBLE entries to TANGIBLE sheet`);

        // Export MTC to MTC sheet
        const mtcData = getRekapByCategory('MTC');
        await exportCategoryToSheet(spreadsheetId, 'MTC', mtcData, 'MTC', getDetails);
        console.log(`📊 Synced ${mtcData.length} MTC entries to MTC sheet`);

        // Export DATEK to DATEK sheet
        const datekData = getRekapByCategory('DATEK');
        await exportCategoryToSheet(spreadsheetId, 'DATEK', datekData, 'DATEK', getDetails);
        console.log(`📊 Synced ${datekData.length} DATEK entries to DATEK sheet`);

        // Export PSB to REKAP PSB sheet
        const psbData = getRekapByCategory('PSB');
        await exportCategoryToSheet(spreadsheetId, 'REKAP PSB', psbData, 'PSB', getDetails);
        console.log(`📊 Synced ${psbData.length} PSB entries to REKAP PSB sheet`);

        const totalCount = regulerData.length + unspecData.length + tangibleData.length + mtcData.length + datekData.length + psbData.length;
        return {
            success: true,
            count: totalCount,
            url: `https://docs.google.com/spreadsheets/d/${spreadsheetId}`
        };
    } catch (error) {
        console.error('❌ Failed to sync to Google Sheets:', error.message);
        // Don't throw - sync failure shouldn't break main operations
        return null;
    }
}

/**
 * Sync tickets pulled from Morena API to a specific sheet
 */
export async function syncMorenaTicketsToSheets() {
    try {
        const config = getConfig();
        if (!config.gdocs_credentials || !config.gdocs_spreadsheet_id) {
            return null;
        }

        const spreadsheetId = config.gdocs_spreadsheet_id;
        const sheetName = 'MORENA-TICKET';

        // Fetch team members for details lookup
        const teamMembers = getAllTeamMembers();
        const memberMap = new Map();
        teamMembers.forEach(tm => {
            if (tm.nik) memberMap.set(String(tm.nik), tm);
        });

        const getDetails = (nik) => {
            const member = memberMap.get(String(nik));
            return member ? {
                name: member.full_name || member.name,
                nik: member.nik || '',
                team: member.team_name || ''
            } : { name: '', nik: nik || '', team: '' };
        };

        const syncedData = getSyncedRekap();
        await exportCategoryToSheet(spreadsheetId, sheetName, syncedData, 'MORENA-TICKET', getDetails);
        
        console.log(`📊 [GDOCS] Synced ${syncedData.length} Morena tickets to ${sheetName}`);
        return { success: true, count: syncedData.length };
    } catch (error) {
        console.error('❌ Failed to sync Morena tickets to Google Sheets:', error.message);
        return null;
    }
}

/**
 * Get authenticated Google Sheets client
 */
function getAuthClient() {
    const config = getConfig();
    const credentials = config.gdocs_credentials;

    if (!credentials) {
        throw new Error('Google credentials not configured');
    }

    let credentialsJson;
    try {
        credentialsJson = JSON.parse(credentials);
    } catch (e) {
        throw new Error('Invalid credentials JSON');
    }

    // Fix: Ensure private_key has proper newlines (may be escaped as \\n in database)
    if (credentialsJson.private_key) {
        credentialsJson.private_key = credentialsJson.private_key.replace(/\\n/g, '\n');
    }

    const auth = new google.auth.GoogleAuth({
        credentials: credentialsJson,
        scopes: ['https://www.googleapis.com/auth/spreadsheets']
    });

    // Logging to help identify the service account
    if (credentialsJson.client_email) {
        // console.log(`ℹ️ [GDOCS] Using service account: ${credentialsJson.client_email}`);
    }

    return auth;
}

/**
 * Get the service account email for logging purposes
 */
function getServiceAccountEmail() {
    try {
        const config = getConfig();
        const creds = JSON.parse(config.gdocs_credentials);
        return creds.client_email || 'unknown';
    } catch (e) {
        return 'error-parsing-creds';
    }
}

/**
 * Ensure a sheet exists, create if not
 */
async function ensureSheetExists(sheets, spreadsheetId, sheetName) {
    try {
        // Get all sheets in the spreadsheet
        const response = await sheets.spreadsheets.get({ spreadsheetId });
        const existingSheets = response.data.sheets.map(s => s.properties.title);

        if (!existingSheets.includes(sheetName)) {
            // Create the sheet
            await sheets.spreadsheets.batchUpdate({
                spreadsheetId,
                requestBody: {
                    requests: [{
                        addSheet: {
                            properties: { title: sheetName }
                        }
                    }]
                }
            });
            console.log(`📝 Created new sheet: ${sheetName}`);
        }
    } catch (error) {
        console.error(`Failed to ensure sheet ${sheetName}:`, error.message);
        // Continue anyway, might work
    }
}

/**
 * Export category data to a specific sheet
 */
async function exportCategoryToSheet(spreadsheetId, sheetName, rekapData, category, getDetails) {
    const auth = getAuthClient();
    const sheets = google.sheets({ version: 'v4', auth });

    // Ensure the sheet exists
    await ensureSheetExists(sheets, spreadsheetId, sheetName);

    // Define headers based on category
    let headers;
    let rows;

    if (category === 'REGULER') {
        headers = [
            'NO', 'NO INC', 'NO INET', 'MAT', 'TIPE TIKET', 'ODP', 'RCA',
            'KETERANGAN', 'ALAMAT',
            'REPORTED BY', 'NAMA TEKNISI', 'NIK TEKNISI', 'TEAM',
            'INPUT BY', 'NAMA INPUTTER', 'NIK INPUTTER',
            'WAKTU INPUT'
        ];
        rows = rekapData.map((r, index) => {
            const reported = getDetails(r.reported_by);
            const inputter = getDetails(r.input_by);
            return [
                index + 1,
                r.no_inc || '',
                r.no_inet || '',
                r.mat || '',
                r.tipe_tiket || 'REGULER',
                r.odp || '',
                r.rca || '',
                r.keterangan || '',
                r.alamat || '',
                r.reported_by || '',
                reported.name || '',
                reported.nik || '',
                reported.team || '',
                r.input_by || '',
                inputter.name || '',
                inputter.nik || '',
                r.input_at || ''
            ];
        });
    } else if (category === 'UNSPEC') {
        headers = [
            'NO', 'NO INC', 'ODP', 'NO INET', 'MAT', 'RCA', 'KETERANGAN',
            'REPORTED BY', 'NAMA TEKNISI', 'NIK TEKNISI', 'TEAM',
            'INPUT BY', 'NAMA INPUTTER', 'NIK INPUTTER',
            'WAKTU INPUT'
        ];
        rows = rekapData.map((r, index) => {
            const reported = getDetails(r.reported_by);
            const inputter = getDetails(r.input_by);
            return [
                index + 1,
                r.no_inc || '',
                r.odp || '',
                r.no_inet || '',
                r.mat || '',
                r.rca || '',
                r.keterangan || '',
                r.reported_by || '',
                reported.name || '',
                reported.nik || '',
                reported.team || '',
                r.input_by || '',
                inputter.name || '',
                inputter.nik || '',
                r.input_at || ''
            ];
        });
    } else if (category === 'TANGIBLE') {
        headers = [
            'NO', 'NO INC', 'ODP',
            'REPORTED BY', 'NAMA TEKNISI', 'NIK TEKNISI', 'TEAM',
            'INPUT BY', 'NAMA INPUTTER', 'NIK INPUTTER',
            'WAKTU INPUT'
        ];
        rows = rekapData.map((r, index) => {
            const reported = getDetails(r.reported_by);
            const inputter = getDetails(r.input_by);
            return [
                index + 1,
                r.no_inc || '',
                r.odp || '',
                r.reported_by || '',
                reported.name || '',
                reported.nik || '',
                reported.team || '',
                r.input_by || '',
                inputter.name || '',
                inputter.nik || '',
                r.input_at || ''
            ];
        });
    } else if (category === 'MTC') {
        headers = [
            'NO', 'TIKET', 'PID', 'DESKRIPSI', 'PEKERJAAN',
            'REPORTED BY', 'NAMA TEKNISI', 'NIK TEKNISI', 'TEAM',
            'INPUT BY', 'NAMA INPUTTER', 'NIK INPUTTER',
            'WAKTU INPUT'
        ];
        rows = rekapData.map((r, index) => {
            const reported = getDetails(r.reported_by);
            const inputter = getDetails(r.input_by);
            return [
                index + 1,
                r.no_inc || '',
                r.pid || '',
                r.description || '',
                r.keterangan || '',
                r.reported_by || '',
                reported.name || '',
                reported.nik || '',
                reported.team || '',
                r.input_by || '',
                inputter.name || '',
                inputter.nik || '',
                r.input_at || ''
            ];
        });
    } else if (category === 'DATEK') {
        headers = [
            'NO', 'WO NUMBER', 'NO INET', 'ID VALINS',
            'DATEK INPUTAN', 'DATEK REAL PENARIKAN',
            'KETERANGAN PUSAT', 'TINDAK LANJUT',
            'REPORTED BY', 'NAMA TEKNISI', 'NIK TEKNISI', 'TEAM',
            'INPUT BY', 'NAMA INPUTTER', 'NIK INPUTTER',
            'WAKTU INPUT'
        ];
        rows = rekapData.map((r, index) => {
            const reported = getDetails(r.reported_by);
            const inputter = getDetails(r.input_by);
            return [
                index + 1,
                r.no_inc || '',
                r.no_inet || '',
                r.id_valins || '',
                r.datek_inputan || '',
                r.datek_real || '',
                r.keterangan_pusat || '',
                r.tindak_lanjut || '',
                r.reported_by || '',
                reported.name || '',
                reported.nik || '',
                reported.team || '',
                r.input_by || '',
                inputter.name || '',
                inputter.nik || '',
                r.input_at || ''
            ];
        });
    } else if (category === 'PSB') {
        const materialHeaders = [
            'ALAMAT REAL', 'PENARIKAN REAL', 'PASIF', 'PORT TERPAKAI', 'SISA PORT',
            'BARCODE', 'SN ONT', 'SN STB', 'PASS TV', 'DC', 'SOC', 'PRECON', 'PATCHCORD',
            'S-CLAMP ODP', 'S-CLAMP PELANGGAN', 'S-CLAMP TIANG', 'BREKET', 'OTP', 'PREKSO',
            'JALUR', 'TIANG TELKOM', 'TIANG P L N', 'TRUNKING', 'SURPASS', 'BA', 'HASIL UKUR OPM',
            'TIKOR ODP', 'TIKOR PELANGGAN', 'SISA DC/PC', 'VALINS AWAL', 'VALINS AKHIR',
            'TIANG PLN EXIST', 'TIANG PLN NEW', 'TIANG BARU', 'KOORDINAT TIANG PLN 1',
            'KOORDINAT TIANG PLN 2', 'MITRA', 'NIK'
        ];

        headers = [
            'NO', 'NO WO', 'NO INTERNET', 'VALINS ID', 'ODP', 'SEGMEN',
            ...materialHeaders, 'OTHER MATERIAL',
            'REPORTED BY', 'INPUT BY', 'WAKTU INPUT', 'TEAM', 'USERNAME'
        ];

        rows = rekapData.map((r, index) => {
            const inputter = getDetails(r.input_by);
            
            // Parse r.mat back into map
            const matMap = {};
            if (r.mat) {
                r.mat.split('\n').forEach(line => {
                    const match = line.match(/^(?:🔘|[-*])?\s*(.+?)\s*[:：]\s*(.*)$/i);
                    if (match) {
                        const k = match[1].trim().toUpperCase();
                        matMap[k] = match[2].trim();
                    }
                });
            }

            const materialValues = materialHeaders.map(h => {
                const val = matMap[h];
                delete matMap[h];
                return val || '-';
            });

            // Catch any unexpected keys
            const otherMaterials = Object.entries(matMap)
                .map(([k, v]) => `${k}: ${v}`)
                .join(', ');

            return [
                index + 1,
                r.no_inc || '',
                r.no_inet || '',
                r.id_valins || '',
                r.odp || '',
                r.keterangan || 'PL - TSEL',  // segmen stored in keterangan
                ...materialValues,
                otherMaterials || '-',
                r.reported_by ? `@${r.reported_by.replace('@', '')}` : '',
                r.input_by ? `@${r.input_by.replace('@', '')}` : '',
                r.input_at || '',
                inputter.team || '',
                ''  // Username column filled below
            ];
        });

        // Fill USERNAME column with all team member usernames
        const usernameColIdx = headers.indexOf('USERNAME');
        const inputByColIdx = headers.indexOf('INPUT BY');
        const allMembers = getAllTeamMembers();
        
        rows.forEach((row, index) => {
            const inputUsername = (rekapData[index].input_by || '').replace('@', '').toLowerCase();
            const member = allMembers.find(m => {
                if (!m.telegram_username) return false;
                return m.telegram_username.replace('@', '').toLowerCase() === inputUsername;
            });
            if (member) {
                const teamMembers = allMembers.filter(m => m.team_id === member.team_id);
                row[usernameColIdx] = teamMembers
                    .map(m => m.telegram_username ? `@${m.telegram_username.replace('@', '')}` : m.name)
                    .join(' ');
            } else {
                row[usernameColIdx] = row[inputByColIdx]; // fallback to input_by
            }
        });
    } else if (category === 'MORENA-TICKET') {
        headers = [
            'NO', 'NO TIKET', 'NO INET', 'RCA', 'JENIS', 
            'NIK TEKNISI', 'NAMA TEKNISI',
            'JAM OPEN', 'JAM CLOSE', 'STATUS', 'KETERANGAN',
            'USER ID', 'NO HP', 'UPDATED AT'
        ];
        rows = rekapData.map((r, index) => {
            const tech = getDetails(r.input_by);
            return [
                index + 1,
                r.no_inc || '',
                r.no_inet || '',
                r.rca || '',
                r.category || '',
                r.input_by || '',
                tech.name || r.reported_by || '',
                r.jam_open || '',
                r.jam_close || '',
                r.status || 'CLOSED',
                r.description || '',
                r.user_id || '',
                r.no_hp || '',
                r.updated_at || ''
            ];
        });
    }

    const values = [headers, ...rows];

    // Clear existing data first
    try {
        await sheets.spreadsheets.values.clear({
            spreadsheetId,
            range: `${sheetName}!A:Z`
        });
    } catch (e) {
        // Sheet might not exist or be empty
        console.log(`Note: Could not clear sheet ${sheetName}, might be empty`);
    }

    // Write data
    await sheets.spreadsheets.values.update({
        spreadsheetId,
        range: `${sheetName}!A1`,
        valueInputOption: 'RAW',
        requestBody: { values }
    });

    return { count: rekapData.length };
}

/**
 * Test connection to Google Sheets
 */
export async function testConnection() {
    const config = getConfig();
    const spreadsheetId = config.gdocs_spreadsheet_id;

    if (!spreadsheetId) {
        throw new Error('Spreadsheet ID not configured');
    }

    const auth = getAuthClient();
    const sheets = google.sheets({ version: 'v4', auth });

    const response = await sheets.spreadsheets.get({
        spreadsheetId: spreadsheetId
    });

    return {
        success: true,
        title: response.data.properties?.title,
        url: `https://docs.google.com/spreadsheets/d/${spreadsheetId}`
    };
}

/**
 * Export rekap data to Google Sheets (legacy, kept for compatibility)
 * @param {Array} rekapData - Array of rekap records
 */
export async function exportToSheets(rekapData) {
    // Redirect to new sync function
    return syncRekapToSheets();
}

// =========================
// External Kendala Datek Spreadsheet
// =========================

const DATEK_EXTERNAL_SPREADSHEET_ID = '1M5U-22d2ukDuy_bK7WCLgAQmPNHjnNrdidOOs8MdPOQ';
const DATEK_EXTERNAL_SHEET_NAME = 'DISINI';

/**
 * Sync DATEK data to external Kendala Datek spreadsheet
 * Appends new rows at the first truly empty row
 * Columns: A=kosong, B=WO NUMB, C=Nmr SC, D=Nmr Internet, E=Id Valins, F=Datek Inputan, G=Datek Real, H=Keterangan(yellow), I=TINDAK LANJUT(yellow)
 */
export async function syncDatekToExternal(targetId = null) {
    try {
        const config = getConfig();
        if (!config.gdocs_credentials) {
            console.log('⚠️ Google credentials not configured, skipping external datek sync');
            return null;
        }

        const auth = getAuthClient();
        const sheets = google.sheets({ version: 'v4', auth });

        console.log(`📊 [DATEK SYNC] Starting ${targetId ? 'TARGETED' : 'FULL'} sync to external sheet "${DATEK_EXTERNAL_SHEET_NAME}"...`);

        // Read all existing data to find which WO numbers already exist
        let existingData = [];
        try {
            const response = await sheets.spreadsheets.values.get({
                spreadsheetId: DATEK_EXTERNAL_SPREADSHEET_ID,
                range: `${DATEK_EXTERNAL_SHEET_NAME}!A:I`
            });
            existingData = response.data.values || [];
            console.log(`📊 [DATEK SYNC] Read ${existingData.length} rows from sheet`);
        } catch (e) {
            console.error(`📊 [DATEK SYNC] ❌ Failed to read sheet: ${e.message}`);
            return null;
        }

        // Collect existing WO numbers (column B = index 1, skip header row)
        const existingWOs = new Set();
        for (let i = 1; i < existingData.length; i++) {
            const row = existingData[i];
            if (row && row[1] && row[1].toString().trim()) {
                existingWOs.add(row[1].toString().trim().toUpperCase());
            }
        }
        console.log(`📊 [DATEK SYNC] Found ${existingWOs.size} existing WO numbers in sheet`);

        // Get all DATEK entries from database
        const allDatekEntries = getAllDatekRekap();

        // 1. Identify entries to check
        let syncQueue = [];
        
        if (targetId) {
            // Targeted Sync: Only process requested ID
            syncQueue = allDatekEntries.filter(r => r.id === targetId);
        } else {
            // Full Sync/Recovery: Check unsynced + last 24h
            const now = new Date();
            const yesterday = new Date(now.getTime() - (24 * 60 * 60 * 1000));
            
            syncQueue = allDatekEntries.filter(r => {
                if (!r.is_synced_external) return true;
                if (r.input_at) {
                    const inputDate = new Date(r.input_at);
                    return inputDate >= yesterday;
                }
                return false;
            });
        }

        console.log(`📊 [DATEK SYNC] Processing queue of ${syncQueue.length} entries...`);

        if (syncQueue.length === 0) {
            console.log('📊 [DATEK SYNC] No entries to process.');
            return { success: true, count: 0 };
        }

        const toAppend = [];
        const toMarkSynced = [];

        // 2. Second Pass: Check against existing Sheet data
        for (const entry of syncQueue) {
            const wo = (entry.no_inc || '').trim().toUpperCase();

            if (existingWOs.has(wo)) {
                // If it exists in the sheet but flag is 0, mark as synced
                if (!entry.is_synced_external) {
                    console.log(`📊 [DATEK SYNC] WO "${wo}" already exists in sheet -> Marking synced in DB`);
                    toMarkSynced.push(entry.id);
                }
            } else {
                // If not in sheet, we need to append
                console.log(`📊 [DATEK SYNC] WO "${wo}" is MISSING from sheet -> Adding to append list`);
                toAppend.push(entry);
            }
        }

        console.log(`📊 [DATEK SYNC] Summary: ${toAppend.length} to append, ${toMarkSynced.length} to mark as already synced.`);

        // 3. Mark the records that were already in the sheet as synced
        if (toMarkSynced.length > 0) {
            for (const id of toMarkSynced) {
                updateRekap(id, { isSyncedExternal: 1 });
            }
            console.log(`📊 [DATEK SYNC] Marked ${toMarkSynced.length} (already in sheet) entries as synced in DB`);
        }

        // 4. Append new rows to Sheet (Only Case B)
        if (toAppend.length === 0) {
            console.log('📊 [DATEK SYNC] No new rows to append to sheet.');
            return { success: true, count: 0 };
        }

        // Find the first truly empty row
        let firstEmptyRow = existingData.length + 1;
        console.log(`📊 [DATEK SYNC] Appending ${toAppend.length} rows starting at row ${firstEmptyRow}`);

        // Prepare rows and track IDs for Case B (to be marked after success)
        const newRows = toAppend.map(r => [
            '',                   // A: kosong
            r.no_inc || '',      // B: WO NUMB
            '',                   // C: Nmr SC (kosong)
            r.no_inet || '',     // D: Nmr Internet dan voice
            r.id_valins || '',   // E: Id Valins
            r.datek_inputan || '', // F: Datek Inputan
            r.datek_real || ''   // G: Datek Real Penarikan
        ]);

        const saEmail = getServiceAccountEmail();
        const writeResult = await sheets.spreadsheets.values.update({
            spreadsheetId: DATEK_EXTERNAL_SPREADSHEET_ID,
            range: `${DATEK_EXTERNAL_SHEET_NAME}!A${firstEmptyRow}`,
            valueInputOption: 'RAW',
            requestBody: { values: newRows }
        });

        if (writeResult.status === 200) {
            // ONLY NOW mark Case B records as synced in DB
            let markedNewCount = 0;
            for (const entry of toAppend) {
                updateRekap(entry.id, { isSyncedExternal: 1 });
                markedNewCount++;
            }
            console.log(`📊 [DATEK SYNC] ✅ Appended and marked ${markedNewCount} NEW entries as synced.`);
            return { success: true, count: markedNewCount };
        } else {
            throw new Error(`Google Sheets API returned status ${writeResult.status}`);
        }

    } catch (error) {
        console.error('❌ [DATEK SYNC] Failed:', error.message);
        console.error('❌ [DATEK SYNC] Stack:', error.stack);
        return null;
    }
}

/**
 * Delete a Datek entry from external spreadsheet
 * this will shift cells up
 * @param {string} noInc - WO Number to delete
 */
export async function deleteDatekFromExternal(noInc) {
    try {
        const config = getConfig();
        if (!config.gdocs_credentials) {
            console.log('⚠️ Google credentials not configured, skipping external datek delete');
            return null;
        }

        const auth = getAuthClient();
        const sheets = google.sheets({ version: 'v4', auth });

        console.log(`🗑️ [DATEK DELETE] Attempting to delete ${noInc} from external sheet...`);

        // 1. Find the row index
        let sheetData = [];
        try {
            const response = await sheets.spreadsheets.values.get({
                spreadsheetId: DATEK_EXTERNAL_SPREADSHEET_ID,
                range: `${DATEK_EXTERNAL_SHEET_NAME}!B:B` // Only need column B to search
            });
            sheetData = response.data.values || [];
        } catch (e) {
            console.error('Failed to read external datek sheet for deletion:', e.message);
            return { success: false, error: e.message };
        }

        let rowIndex = -1;
        // Search for the WO number
        for (let i = 0; i < sheetData.length; i++) {
            const rowVal = sheetData[i][0]; // Column B is index 0 in this range
            if (rowVal && rowVal.toString().trim().toUpperCase() === noInc.toString().trim().toUpperCase()) {
                rowIndex = i; // 0-based index
                break;
            }
        }

        if (rowIndex === -1) {
            console.log(`⚠️ [DATEK DELETE] WO ${noInc} not found in external sheet`);
            return { success: false, message: 'Not found in sheet' };
        }

        // 2. Delete the row (rowIndex is 0-based, matching the API expectation for startIndex)
        // Note: sheetId is needed for batchUpdate. We need to get it first.

        // Optimize: verify we have sheetId. We might need to fetch it if not hardcoded, 
        // but for now we'll assume we need to fetch it unless we hardcode it or store it.
        // Let's fetch spreadsheet metadata to get sheetId corresponding to sheetName.

        const meta = await sheets.spreadsheets.get({ spreadsheetId: DATEK_EXTERNAL_SPREADSHEET_ID });
        const sheetObj = meta.data.sheets.find(s => s.properties.title === DATEK_EXTERNAL_SHEET_NAME);

        if (!sheetObj) {
            throw new Error(`Sheet ${DATEK_EXTERNAL_SHEET_NAME} not found`);
        }

        const sheetId = sheetObj.properties.sheetId;

        await sheets.spreadsheets.batchUpdate({
            spreadsheetId: DATEK_EXTERNAL_SPREADSHEET_ID,
            requestBody: {
                requests: [{
                    deleteDimension: {
                        range: {
                            sheetId: sheetId,
                            dimension: "ROWS",
                            startIndex: rowIndex,
                            endIndex: rowIndex + 1
                        }
                    }
                }]
            }
        });

        console.log(`✅ [DATEK DELETE] Successfully deleted row ${rowIndex + 1} for ${noInc}`);
        return { success: true };

    } catch (error) {
        console.error('❌ [DATEK DELETE] Failed:', error.message);
        return { success: false, error: error.message };
    }
}

/**
 * Sync Keterangan and Tindak Lanjut from external Kendala Datek sheet back to database
 * Reads column H (Keterangan) and column I (Tindak Lanjut) and updates matching rekap entries
 */
export async function syncDatekFromExternal() {
    try {
        const config = getConfig();
        if (!config.gdocs_credentials) {
            console.log('⚠️ Google credentials not configured, skipping external datek reverse sync');
            return null;
        }

        const auth = getAuthClient();
        const sheets = google.sheets({ version: 'v4', auth });

        // Read all data from the external sheet (A through I)
        let sheetData = [];
        try {
            const response = await sheets.spreadsheets.values.get({
                spreadsheetId: DATEK_EXTERNAL_SPREADSHEET_ID,
                range: `${DATEK_EXTERNAL_SHEET_NAME}!A:I`
            });
            sheetData = response.data.values || [];
        } catch (e) {
            console.error('Failed to read external datek sheet:', e.message);
            return null;
        }

        if (sheetData.length <= 1) {
            console.log('📊 No data in external datek sheet to sync back');
            return { success: true, updated: 0 };
        }

        let updatedCount = 0;
        let notificationCount = 0;

        // Skip header row (index 0), process data rows
        for (let i = 1; i < sheetData.length; i++) {
            const row = sheetData[i] || [];
            const woNumber = (row[1] || '').trim();          // Column B: WO NUMB
            const keterangan = (row[7] || '').trim();        // Column H: Keterangan
            const tindakLanjut = (row[8] || '').trim();      // Column I: Tindak Lanjut Daman

            // Only update if WO number exists and at least one of H/I has data
            if (woNumber && (keterangan || tindakLanjut)) {

                // 1. Category-Safe Fetching: Use specialized DATEK getter
                const existingRekap = getDatekByNoInc(woNumber);

                if (existingRekap) {
                    // 2. DATE FILTER: Skip records from February (before March 2026)
                    if (existingRekap.input_at < '2026-03-01') {
                        continue;
                    }

                    // 3. DETECT NEW STATUS
                    const ketLower = keterangan.toLowerCase();
                    const tlLower = tindakLanjut.toLowerCase();
                    const combinedText = ` ${ketLower} ${tlLower} `;
                    
                    // broader keywords for DONE (SELESAI, TUTUP, OK, SUCCESS, SOLVED, CLOSE)
                    // Added regex support for exact word matching to be safer
                    const doneRegex = /\b(done|close|selesai|tutup|ok|success|solved)\b/i;
                    const isNewDone = doneRegex.test(combinedText);
                    
                    const newStatus = isNewDone ? 'DONE' : 'ON PROGRESS';

                    const oldStatus = existingRekap.status; // Currently in DB
                    const oldKet = (existingRekap.keterangan_pusat || '').toLowerCase();
                    const oldTl = (existingRekap.tindak_lanjut || '').toLowerCase();

                    // Check if anything actually changed
                    const isTextChanged = oldKet !== ketLower || oldTl !== tlLower;
                    const isStatusChanged = oldStatus !== newStatus;

                    if (isTextChanged || isStatusChanged) {
                        // Update DB including status
                        const updated = updateDatekFromSheet(woNumber, keterangan, tindakLanjut, newStatus);

                        if (updated) {
                            updatedCount++;

                            // 4. PERSISTENT NOTIFICATION GATING & LOCKING
                            // - If oldStatus was already 'DONE', we NEVER notify again (Permanent Lock)
                            // - If oldStatus was NULL (legacy), we initialize silently (User request)
                            // - Otherwise (ON PROGRESS), we notify if it hits DONE or changes text.
                            
                            if (oldStatus !== null && oldStatus !== 'DONE') {
                                // Transition to any status (Nomor Tidak Terdeteksi, On Progress, or DONE)
                                const updatedRekap = getDatekByNoInc(woNumber); // Re-fetch for latest
                                if (updatedRekap && updatedRekap.telegram_chat_id) {
                                    await notifyDatekUpdate(updatedRekap);
                                    notificationCount++;
                                }
                            } else {
                                // Silent update for legacy records or locked 'DONE' records
                                if (oldStatus === 'DONE') {
                                    // console.log(`🔒 [DATEK SYNC] Protected ${woNumber}: Persistent DONE lock active.`);
                                } else {
                                    console.log(`📋 [DATEK SYNC] Silently initialized status for ${woNumber} to ${newStatus}`);
                                }
                            }
                        }
                    }
                }
            }
        }

        console.log(`📊 Synced back ${updatedCount} entries from external datek sheet`);
        if (notificationCount > 0) {
            console.log(`📱 Sent ${notificationCount} update notifications.`);
        }
        return { success: true, updated: updatedCount, notifications: notificationCount };

    } catch (error) {
        console.error('❌ Failed to sync from external datek sheet:', error.message);
        return null;
    }
}

/**
 * Extract GAUL value from ticket summary
 */
export function extractGaulFromSummary(summary) {
    if (!summary) return '-';
    // split by underscore
    const parts = summary.split('_').map(p => p.trim());
    for (let i = 0; i < parts.length; i++) {
        if (parts[i].toLowerCase() === 'gaul' || parts[i].toLowerCase().startsWith('gaul')) {
            if (i + 1 < parts.length) {
                return parts[i + 1];
            }
        }
    }
    // Fallback: regex search
    const match = summary.match(/gaul\s*[:_]\s*([^\s_]+)/i) || summary.match(/gaul\s+([^\s_]+)/i);
    if (match) {
        return match[1];
    }
    return '-';
}

/**
 * Export Reguler, SQM, and UNSPEC tickets to the specified Google Sheet
 */
export async function exportProactiveToSpreadsheet(spreadsheetId, sheetName, regulerTickets, sqmTickets, unspecTickets) {
    try {
        const auth = getAuthClient();
        const sheets = google.sheets({ version: 'v4', auth });

        // Ensure the sheet exists
        await ensureSheetExists(sheets, spreadsheetId, sheetName);

        const values = [];
        const formattingRequests = [];

        const headers = ['NO', 'NO INC', 'SERVICE NO', 'TTR CUSTOMER', 'CUSTOMER TYPE', 'GAUL', 'WORKZONE', 'BOOKING DATE'];
        const colWidth = headers.length; // 8
        const spacing = 1; // 1 empty column separator

        // Column indexes
        const regColStart = 0;                     // Columns A-H (0 to 7)
        const sqmColStart = colWidth + spacing;     // Columns J-Q (9 to 16)
        const unspecColStart = sqmColStart + colWidth + spacing; // Columns S-Z (18 to 25)

        // Helper to fill cell or pad a row array to at least certain length
        const setRowCells = (rowArr, startIdx, dataArr) => {
            while (rowArr.length < startIdx) {
                rowArr.push('');
            }
            for (let i = 0; i < dataArr.length; i++) {
                rowArr[startIdx + i] = dataArr[i];
            }
        };

        // --- ROW 0: TITLE ROW ---
        const row0 = [];
        setRowCells(row0, regColStart, ['=== DATA TIKET REGULER ===', '', '', '', '', '', '', '']);
        setRowCells(row0, sqmColStart, ['=== DATA TIKET SQM ===', '', '', '', '', '', '', '']);
        setRowCells(row0, unspecColStart, ['=== DATA TIKET UNSPEC ===', '', '', '', '', '', '', '']);
        values.push(row0);

        // Add formatting requests for Title row: Merge and Style
        const addTitleFormat = (colStart, bgColor, textColor) => {
            formattingRequests.push({
                mergeCells: {
                    range: {
                        startRowIndex: 0,
                        endRowIndex: 1,
                        startColumnIndex: colStart,
                        endColumnIndex: colStart + colWidth
                    },
                    mergeType: 'MERGE_ALL'
                }
            });
            formattingRequests.push({
                repeatCell: {
                    range: {
                        startRowIndex: 0,
                        endRowIndex: 1,
                        startColumnIndex: colStart,
                        endColumnIndex: colStart + colWidth
                    },
                    cell: {
                        userEnteredFormat: {
                            backgroundColor: bgColor,
                            textFormat: { bold: true, fontSize: 11, foregroundColor: textColor },
                            horizontalAlignment: 'CENTER',
                            verticalAlignment: 'MIDDLE'
                        }
                    },
                    fields: 'userEnteredFormat.backgroundColor,userEnteredFormat.textFormat,userEnteredFormat.horizontalAlignment,userEnteredFormat.verticalAlignment'
                }
            });
        };
        
        // Soft backgrounds + matching text colors
        addTitleFormat(regColStart, { red: 0.92, green: 0.96, blue: 0.98 }, { red: 0.11, green: 0.21, blue: 0.34 });
        addTitleFormat(sqmColStart, { red: 0.91, green: 0.97, blue: 0.96 }, { red: 0.05, green: 0.35, blue: 0.29 });
        addTitleFormat(unspecColStart, { red: 0.99, green: 0.95, blue: 0.91 }, { red: 0.55, green: 0.22, blue: 0.0 });

        // --- ROW 1: HEADERS ROW ---
        const row1 = [];
        setRowCells(row1, regColStart, headers);
        setRowCells(row1, sqmColStart, headers);
        setRowCells(row1, unspecColStart, headers);
        values.push(row1);

        const addHeaderFormat = (colStart, headerColor) => {
            formattingRequests.push({
                repeatCell: {
                    range: {
                        startRowIndex: 1,
                        endRowIndex: 2,
                        startColumnIndex: colStart,
                        endColumnIndex: colStart + colWidth
                    },
                    cell: {
                        userEnteredFormat: {
                            backgroundColor: headerColor,
                            textFormat: { bold: true, foregroundColor: { red: 1.0, green: 1.0, blue: 1.0 }, fontSize: 10 },
                            horizontalAlignment: 'CENTER',
                            verticalAlignment: 'MIDDLE'
                        }
                    },
                    fields: 'userEnteredFormat.backgroundColor,userEnteredFormat.textFormat,userEnteredFormat.horizontalAlignment,userEnteredFormat.verticalAlignment'
                }
            });
        };
        addHeaderFormat(regColStart, { red: 0.17, green: 0.24, blue: 0.31 }); // Professional Slate Gray (#2C3E50)
        addHeaderFormat(sqmColStart, { red: 0.09, green: 0.63, blue: 0.52 }); // Forest Teal (#16A085)
        addHeaderFormat(unspecColStart, { red: 0.83, green: 0.33, blue: 0.0 }); // Warm Bronze/Amber (#D35400)

        // --- DATA ROWS ---
        const formatRows = (tickets) => {
            return tickets.map((wo, index) => {
                const orderId = wo.orderId || wo.order_id || '-';
                const serviceNo = wo.serviceNo || wo.service_no || '-';
                const ttr = wo.ttrCustomer || wo.ttr_customer || '-';
                const custType = wo.customerType || wo.customer_type || 'REGULER';
                const gaul = extractGaulFromSummary(wo.summary || wo.description || '');
                const wz = wo.workzone || '-';
                const bookingDate = wo.bookingDate || wo.booking_date || '-';

                return [
                    index + 1,
                    orderId,
                    serviceNo,
                    ttr,
                    custType,
                    gaul,
                    wz,
                    bookingDate
                ];
            });
        };

        const regData = formatRows(regulerTickets);
        const sqmData = formatRows(sqmTickets);
        const unspecData = formatRows(unspecTickets);

        // Determine data rows range
        const regRowMax = regData.length > 0 ? regData.length : 1;
        const sqmRowMax = sqmData.length > 0 ? sqmData.length : 1;
        const unspecRowMax = unspecData.length > 0 ? unspecData.length : 1;
        const totalDataRows = Math.max(regRowMax, sqmRowMax, unspecRowMax);

        // Helper to format a table cell grid (border + soft zebra)
        const addCellFormat = (rowIdx, colStart, isEven) => {
            formattingRequests.push({
                repeatCell: {
                    range: {
                        startRowIndex: rowIdx,
                        endRowIndex: rowIdx + 1,
                        startColumnIndex: colStart,
                        endColumnIndex: colStart + colWidth
                    },
                    cell: {
                        userEnteredFormat: {
                            backgroundColor: isEven ? { red: 0.98, green: 0.98, blue: 0.98 } : { red: 1.0, green: 1.0, blue: 1.0 },
                            textFormat: { fontSize: 10 },
                            borders: {
                                top: { style: 'SOLID', width: 1, color: { red: 0.88, green: 0.88, blue: 0.88 } },
                                bottom: { style: 'SOLID', width: 1, color: { red: 0.88, green: 0.88, blue: 0.88 } },
                                left: { style: 'SOLID', width: 1, color: { red: 0.88, green: 0.88, blue: 0.88 } },
                                right: { style: 'SOLID', width: 1, color: { red: 0.88, green: 0.88, blue: 0.88 } }
                            }
                        }
                    },
                    fields: 'userEnteredFormat.backgroundColor,userEnteredFormat.textFormat,userEnteredFormat.borders'
                }
            });
        };

        // Helper for styling "Tidak ada data" rows cleanly
        const addNoDataFormat = (rowIdx, colStart) => {
            formattingRequests.push({
                mergeCells: {
                    range: {
                        startRowIndex: rowIdx,
                        endRowIndex: rowIdx + 1,
                        startColumnIndex: colStart,
                        endColumnIndex: colStart + colWidth
                    },
                    mergeType: 'MERGE_ALL'
                }
            });
            formattingRequests.push({
                repeatCell: {
                    range: {
                        startRowIndex: rowIdx,
                        endRowIndex: rowIdx + 1,
                        startColumnIndex: colStart,
                        endColumnIndex: colStart + colWidth
                    },
                    cell: {
                        userEnteredFormat: {
                            backgroundColor: { red: 0.98, green: 0.98, blue: 0.98 },
                            textFormat: { italic: true, fontSize: 10, foregroundColor: { red: 0.5, green: 0.5, blue: 0.5 } },
                            horizontalAlignment: 'CENTER',
                            verticalAlignment: 'MIDDLE',
                            borders: {
                                top: { style: 'SOLID', width: 1, color: { red: 0.88, green: 0.88, blue: 0.88 } },
                                bottom: { style: 'SOLID', width: 1, color: { red: 0.88, green: 0.88, blue: 0.88 } },
                                left: { style: 'SOLID', width: 1, color: { red: 0.88, green: 0.88, blue: 0.88 } },
                                right: { style: 'SOLID', width: 1, color: { red: 0.88, green: 0.88, blue: 0.88 } }
                            }
                        }
                    },
                    fields: 'userEnteredFormat.backgroundColor,userEnteredFormat.textFormat,userEnteredFormat.horizontalAlignment,userEnteredFormat.verticalAlignment,userEnteredFormat.borders'
                }
            });
        };

        for (let r = 0; r < totalDataRows; r++) {
            const dataRow = [];
            const isEven = r % 2 === 0;

            // 1. Reguler Column fill
            if (regData.length === 0 && r === 0) {
                setRowCells(dataRow, regColStart, ['Tidak ada data', '', '', '', '', '', '', '']);
                addNoDataFormat(2, regColStart);
            } else if (r < regData.length) {
                setRowCells(dataRow, regColStart, regData[r]);
                addCellFormat(2 + r, regColStart, isEven);
            }

            // 2. SQM Column fill
            if (sqmData.length === 0 && r === 0) {
                setRowCells(dataRow, sqmColStart, ['Tidak ada data', '', '', '', '', '', '', '']);
                addNoDataFormat(2, sqmColStart);
            } else if (r < sqmData.length) {
                setRowCells(dataRow, sqmColStart, sqmData[r]);
                addCellFormat(2 + r, sqmColStart, isEven);
            }

            // 3. UNSPEC Column fill
            if (unspecData.length === 0 && r === 0) {
                setRowCells(dataRow, unspecColStart, ['Tidak ada data', '', '', '', '', '', '', '']);
                addNoDataFormat(2, unspecColStart);
            } else if (r < unspecData.length) {
                setRowCells(dataRow, unspecColStart, unspecData[r]);
                addCellFormat(2 + r, unspecColStart, isEven);
            }

            values.push(dataRow);
        }

        // --- COLUMNS DIMENSION CONFIGURATION ---
        const colWidths = [
            45,  125, 115, 115, 115, 145, 95, 135, // Reguler (0-7)
            30,                                    // Spacing separator (8)
            45,  125, 115, 115, 115, 145, 95, 135, // SQM (9-16)
            30,                                    // Spacing separator (17)
            45,  125, 115, 115, 115, 145, 95, 135  // UNSPEC (18-25)
        ];

        colWidths.forEach((width, idx) => {
            formattingRequests.push({
                updateDimensionProperties: {
                    range: {
                        dimension: 'COLUMNS',
                        startIndex: idx,
                        endIndex: idx + 1
                    },
                    properties: {
                        pixelSize: width
                    },
                    fields: 'pixelSize'
                }
            });
        });

        // Clear all columns from A to Z first
        try {
            await sheets.spreadsheets.values.clear({
                spreadsheetId,
                range: `${sheetName}!A:Z`
            });
        } catch (e) {
            console.log(`Note: Could not clear sheet ${sheetName}`);
        }

        // Write all values
        await sheets.spreadsheets.values.update({
            spreadsheetId,
            range: `${sheetName}!A1`,
            valueInputOption: 'RAW',
            requestBody: { values }
        });

        // Apply visual formatting using batchUpdate
        const meta = await sheets.spreadsheets.get({ spreadsheetId });
        const sheetObj = meta.data.sheets.find(s => s.properties.title === sheetName);
        if (sheetObj) {
            const sheetId = sheetObj.properties.sheetId;
            formattingRequests.forEach(req => {
                if (req.repeatCell && req.repeatCell.range) {
                    req.repeatCell.range.sheetId = sheetId;
                }
                if (req.mergeCells && req.mergeCells.range) {
                    req.mergeCells.range.sheetId = sheetId;
                }
                if (req.updateDimensionProperties && req.updateDimensionProperties.range) {
                    req.updateDimensionProperties.range.sheetId = sheetId;
                }
            });

            await sheets.spreadsheets.batchUpdate({
                spreadsheetId,
                requestBody: {
                    requests: formattingRequests
                }
            });
        }

        console.log(`✅ [GDOCS] Successfully exported to ${sheetName} sheet horizontally (Reguler: ${regulerTickets.length}, SQM: ${sqmTickets.length}, Unspec: ${unspecTickets.length})`);
        return { success: true };
    } catch (error) {
        console.error('❌ [GDOCS] Failed to export proactive sheets:', error.message);
        throw error;
    }
}

