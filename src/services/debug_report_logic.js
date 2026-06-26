import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const dbPath = join(__dirname, '..', '..', 'data', 'database.sqlite');
const db = new Database(dbPath);

async function debugReport() {
    console.log('--- DEBUG REPORT LOGIC ---');
    
    // 1. Check Date
    const now = new Date();
    // WIB adjustment (current time is ~03:00 WIB, June 16)
    const utcTime = now.getTime() + (now.getTimezoneOffset() * 60000);
    const wibNow = new Date(utcTime + (7 * 60 * 60 * 1000));
    const todayStr = wibNow.toISOString().split('T')[0];
    console.log(`Today Date String: ${todayStr}`);

    // 2. Check technicians list
    const technicians = db.prepare(`
        SELECT tm.name, tm.nik, t.name as team_name 
        FROM team_members tm
        JOIN teams t ON tm.team_id = t.id
        WHERE t.name LIKE '%TANJUNGPINANG%' OR t.name LIKE '%TPI%'
    `).all();
    console.log(`Total Technicians Found: ${technicians.length}`);
    console.table(technicians.slice(0, 5));

    // 3. Check for specific technicians (Sofian, Riski)
    const targetTechs = technicians.filter(t => t.name.includes('SOFIAN') || t.name.includes('RISKI'));
    console.log('Target Technicians (Sofian/Riski):');
    console.table(targetTechs);

    // 4. Check Tickets in rekap
    const tickets = db.prepare(`
        SELECT input_by as nik, COUNT(*) as count, input_at
        FROM rekap
        WHERE DATE(input_at) = DATE(?)
        GROUP BY input_by
    `).all(todayStr);
    console.log('Tickets found in rekap for today:');
    console.table(tickets);

    // 5. Check specific NIKs in rekap
    const gunturNik = '25060156';
    const gunturTickets = db.prepare('SELECT * FROM rekap WHERE input_by = ?').all(gunturNik);
    console.log(`Tickets for Guntur (${gunturNik}) in rekap (all dates):`);
    console.table(gunturTickets);

    db.close();
}

debugReport();
