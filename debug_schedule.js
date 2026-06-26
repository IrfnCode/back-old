
import { getWorkersToTag, getTodayWorkers } from './src/services/schedule.js';
import { formatToWIB } from './src/utils/time.js';

console.log('Current Time (WIB):', formatToWIB());
console.log('--- Testing TPI ---');
const workersTPI = getWorkersToTag('TPI');
console.log('Workers TPI:', JSON.stringify(workersTPI, null, 2));

console.log('--- Testing KMS ---');
const workersKMS = getWorkersToTag('KMS');
console.log('Workers KMS:', JSON.stringify(workersKMS, null, 2));

console.log('--- Raw TPI Today ---');
const rawTPI = getTodayWorkers('TPI');
console.log('Raw TPI:', rawTPI.map(w => `${w.member_name} (${w.shift})`));
