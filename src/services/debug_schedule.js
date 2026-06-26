import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const dbPath = join(__dirname, '..', '..', 'data', 'database.sqlite');
const db = new Database(dbPath);

function debugSchedule() {
    const day = 16;
    const month = 4;
    const year = 2026;

    console.log(`Checking schedule for ${day}/${month}/${year}`);

    // Check raw schedule entries
    const entries = db.prepare(`
        SELECT * FROM schedule_entries 
        WHERE day = ? AND month = ? AND year = ?
    `).all(day, month, year);
    
    console.log(`Found ${entries.length} raw entries.`);
    console.table(entries.slice(0, 10));

    // Check specific name from the dashboard (e.g. "GUNTUR [TPI]")
    const gunturEntry = entries.find(e => e.name.includes('GUNTUR'));
    console.log('Guntur Entry:', gunturEntry);

    // Check "SOFIAN" entry
    const sofianEntry = entries.find(e => e.name.toLowerCase().includes('sofian'));
    console.log('Sofian Entry:', sofianEntry);

    // Check "RISKI" entry
    const riskiEntry = entries.find(e => e.name.toLowerCase().includes('riski'));
    console.log('Riski Entry:', riskiEntry);

    db.close();
}

debugSchedule();
