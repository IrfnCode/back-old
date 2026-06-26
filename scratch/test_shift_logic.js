/**
 * Test script for auto-shift logic
 */

function getWIBDate(now = new Date()) {
    const utcTime = now.getTime() + (now.getTimezoneOffset() * 60000);
    return new Date(utcTime + (7 * 60 * 60 * 1000));
}

function formatToWIB(date) {
    const formatter = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Jakarta',
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', hour12: false
    });
    return formatter.format(date).replace(', ', 'T').slice(0, 16);
}

function testShift(now, filterDateFrom, filterDateTo) {
    const nowWib = getWIBDate(now);
    const configTo = new Date(filterDateTo.replace('T', ' '));
    const configFrom = new Date(filterDateFrom.replace('T', ' '));

    const targetTo = new Date(nowWib);
    targetTo.setHours(23, 59, 0, 0); // NEW logic

    console.log(`Now (WIB): ${formatToWIB(nowWib)}`);
    console.log(`Config: ${filterDateFrom} to ${filterDateTo}`);
    console.log(`TargetTo: ${formatToWIB(targetTo)}`);

    if (targetTo.getTime() > configTo.getTime()) {
        const daysDiff = Math.floor((targetTo.getTime() - configTo.getTime()) / (24 * 60 * 60 * 1000));
        console.log(`DaysDiff: ${daysDiff}`);

        if (daysDiff > 0) {
            const newTo = new Date(configTo);
            newTo.setDate(configTo.getDate() + daysDiff);
            newTo.setHours(23, 59, 0, 0); // NEW logic

            const newFrom = new Date(configFrom);
            newFrom.setDate(configFrom.getDate() + daysDiff);
            newFrom.setHours(0, 0, 0, 0); // NEW logic

            console.log(`Shifted: ${formatToWIB(newFrom)} to ${formatToWIB(newTo)}`);
        } else {
            console.log("No shift (DaysDiff = 0)");
        }
    } else {
        console.log("No shift (Not past TargetTo)");
    }
    console.log('---');
}

// Scenario 1: Yesterday's range (07:00 - 06:00 next day), Now is today 10:00 AM
console.log("Scenario 1: Yesterday range, Now is today 10:00 AM");
const yesterdayRange = { from: '2026-04-22T07:00', to: '2026-04-23T06:00' };
const nowToday = new Date('2026-04-23T10:00:00Z'); // Adjust for UTC to get 10:00 WIB
testShift(nowToday, yesterdayRange.from, yesterdayRange.to);

// Scenario 2: Yesterday's range, Now is today 01:00 AM
console.log("Scenario 2: Yesterday range, Now is today 01:00 AM");
const nowEarly = new Date('2026-04-23T01:00:00+07:00'); 
testShift(nowEarly, yesterdayRange.from, yesterdayRange.to);

// Scenario 3: Already shifted today (00:00 - 23:59), Now is today afternoon
console.log("Scenario 3: Today range (00:00-23:59), Now is today afternoon");
const todayRange = { from: '2026-04-23T00:00', to: '2026-04-23T23:59' };
const nowAfternoon = new Date('2026-04-23T15:00:00+07:00');
testShift(nowAfternoon, todayRange.from, todayRange.to);

// Scenario 4: Multiple days behind
console.log("Scenario 4: 2 days behind");
const oldRange = { from: '2026-04-21T00:00', to: '2026-04-21T23:59' };
testShift(nowToday, oldRange.from, oldRange.to);
