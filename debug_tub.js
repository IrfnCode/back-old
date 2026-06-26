
import { getTodayWorkers } from './src/services/schedule.js';
import { formatToWIB } from './src/utils/time.js';

console.log('Current Time:', formatToWIB());
console.log('--- TUB Workers Today ---');
const workers = getTodayWorkers('TUB');
console.log(JSON.stringify(workers, null, 2));
console.log('--- Shifts ---');
workers.forEach(w => console.log(`${w.member_name}: ${w.shift}`));
