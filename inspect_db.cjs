
const db = require('better-sqlite3')('f:/workorder-scraper/backend/data/database.sqlite');
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
console.log('Tables:', JSON.stringify(tables, null, 2));

// Check if sent_work_orders table exists and what's in it
if (tables.some(t => t.name === 'sent_work_orders')) {
    const sent = db.prepare('SELECT * FROM sent_work_orders ORDER BY created_at DESC LIMIT 5').all();
    console.log('Recent Sent Work Orders:', JSON.stringify(sent, null, 2));
} else {
    console.log('Table sent_work_orders does not exist.');
}
