import Database from 'better-sqlite3';

const dbPath = '/home/backend/data/database.sqlite';
const db = new Database(dbPath);

try {
    // Reset is_synced_external for DATEK records added today (March 18, 2026)
    // to allow them to retry with the new reliable sync logic.
    const result = db.prepare(`
        UPDATE rekap 
        SET is_synced_external = 0 
        WHERE category = 'DATEK' 
        AND DATE(input_at) = '2026-03-18'
    `).run();
    
    console.log(`✅ Reset is_synced_external for ${result.changes} DATEK records from today.`);
} catch (e) {
    console.error(e);
}
db.close();
