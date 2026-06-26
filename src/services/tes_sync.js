import { syncDatekToExternal } from './gdocs.js';
import Database from 'better-sqlite3';

// Mock config if needed, but the services should use the real DB
async function runSync() {
    try {
        console.log('--- Starting Manual DATEK Sync ---');
        const result = await syncDatekToExternal();
        console.log('Result:', JSON.stringify(result, null, 2));
    } catch (e) {
        console.error('Error in runSync:', e);
    }
}

runSync();
