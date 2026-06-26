import { initDatabase } from './src/services/database.js';
import { syncRekapToSheets } from './src/services/gdocs.js';

async function run() {
    console.log('🚀 Starting manual Google Sheets sync...');

    // Initialize DB connection
    initDatabase();

    // Run sync
    try {
        const result = await syncRekapToSheets();
        if (result && result.success) {
            console.log('✅ Sync completed successfully!');
            console.log(`📊 Total rows synced: ${result.count}`);
            console.log(`🔗 URL: ${result.url}`);
        } else {
            console.log('⚠️ Sync finished but returned no success/result (check logs for specific errors)');
        }
    } catch (error) {
        console.error('❌ Sync failed:', error);
    }
}

run();
