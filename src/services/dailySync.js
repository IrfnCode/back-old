import fetch from 'node-fetch';
import { addRekap, getRekapByNoInc, updateRekap, getConfig } from './database.js';
import { syncMorenaTicketsToSheets } from './gdocs.js';
import { formatToWIB } from '../utils/time.js';

let syncInterval = null;
let isSyncing = false;

export async function syncClosedTickets(isManual = false) {
    if (isSyncing) return { success: false, error: 'Synchronization already in progress' };
    isSyncing = true;

    try {
        const config = getConfig();
        const apiUrl = config.syncApiUrl || 'https://insera.irfncode.my.id/api/reports/closed-tickets';
        const isEnabled = config.dailySyncEnabled === 'true';

        if (!isEnabled && !isManual) {
            console.log('[DailySync] Sync is disabled in config.');
            return { success: false, error: 'Sync is disabled' };
        }

        console.log(`[DailySync] Fetching tickets from: ${apiUrl}`);
        const response = await fetch(apiUrl);
        const result = await response.json();

        if (!result.success) {
            throw new Error(result.error || 'Unknown API error');
        }

        const tickets = result.data || [];
        let newCount = 0;
        let updateCount = 0;

        for (const ticket of tickets) {
            const existing = getRekapByNoInc(ticket.no_tiket);
            
            // Fix UNDERSPEC naming and format times strictly to WIB to avoid SQLite UTC date grouping issues
            const jenisMap = ticket.jenis === 'UNDERSPEC' ? 'UNSPEC' : (ticket.jenis || 'REGULER');
            const jamCloseWIB = ticket.jam_close ? formatToWIB(ticket.jam_close) : formatToWIB();

            const rekapData = {
                noInc: ticket.no_tiket,
                noInet: ticket.no_inet,
                rca: ticket.rca,
                category: jenisMap,
                inputBy: ticket.nik_teknisi,
                reportedBy: ticket.nama,
                jamOpen: ticket.jam_open ? formatToWIB(ticket.jam_open) : formatToWIB(),
                jamClose: jamCloseWIB,
                status: 'CLOSED',
                description: ticket.catatan || '',
                odp: ticket.odp || '',
                userId: ticket.user_id,
                noHp: ticket.no_hp,
                updatedAt: ticket.updated_at ? formatToWIB(ticket.updated_at) : formatToWIB()
            };

            if (existing) {
                // Update if status is not already CLOSED or if it's from sync
                if (existing.status !== 'CLOSED' || existing.is_synced_external) {
                    updateRekap(existing.id, {
                        ...rekapData,
                        inputAt: jamCloseWIB, // Ensure time is WIB
                        isSyncedExternal: 1
                    });
                    updateCount++;
                }
            } else {
                addRekap({
                    ...rekapData,
                    isSyncedExternal: 1,
                    inputAt: jamCloseWIB // Use WIB formatted jam_close as input time
                });
                newCount++;
            }
        }

        console.log(`[DailySync] Sync finished: ${newCount} new, ${updateCount} updated.`);
        
        // Trigger Google Sheets Sync
        try {
            await syncMorenaTicketsToSheets();
        } catch (sheetsError) {
            console.error('[DailySync] Google Sheets sync failed:', sheetsError.message);
        }

        return { success: true, newCount, updateCount };

    } catch (error) {
        let msg = error.message;
        if (msg.includes('ECONNREFUSED')) {
            msg = `Koneksi ditolak ke: ${apiUrl}. Pastikan backend baru menyala dan URL sudah benar.`;
        }
        console.error('[DailySync] Sync error:', msg);
        return { success: false, error: msg };
    } finally {
        isSyncing = false;
    }
}

export function initDailySync() {
    const config = getConfig();
    const intervalMinutes = parseFloat(config.dailySyncInterval || '30');
    
    // Clear existing interval if any
    if (syncInterval) clearInterval(syncInterval);

    if (intervalMinutes > 0) {
        console.log(`[DailySync] Initialized polling every ${intervalMinutes} minutes.`);
        syncInterval = setInterval(syncClosedTickets, intervalMinutes * 60 * 1000);
        
        // Run once immediately
        setTimeout(syncClosedTickets, 5000);
    }
}

export function setSyncInterval(minutes) {
    if (syncInterval) clearInterval(syncInterval);
    syncInterval = setInterval(syncClosedTickets, parseFloat(minutes) * 60 * 1000);
}
