/**
 * Time utility for WIB (Western Indonesia Time / UTC+7)
 */

/**
 * Get current date in WIB
 * @returns {Date}
 */
export function getWIBDate() {
    const now = new Date();
    // Shift the date to UTC, then add 7 hours for WIB
    const utcTime = now.getTime() + (now.getTimezoneOffset() * 60000);
    const wibTime = new Date(utcTime + (7 * 60 * 60 * 1000));
    return wibTime;
}

/**
 * Format a date to WIB MySQL/SQLite string format (YYYY-MM-DD HH:mm:ss)
 * @param {Date|string|number} dateInput 
 * @returns {string}
 */
export function formatToWIB(dateInput = new Date()) {
    const date = new Date(dateInput);
    if (isNaN(date.getTime())) return null;

    // Use Intl to format exactly as we want in WIB
    const formatter = new Intl.DateTimeFormat('en-CA', { // en-CA gives YYYY-MM-DD format
        timeZone: 'Asia/Jakarta',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false
    });

    return formatter.format(date).replace(', ', ' ');
}

/**
 * Get current ISO string in WIB
 * @returns {string}
 */
export function getWIBISOString() {
    return formatToWIB(new Date()).replace(' ', 'T') + '.000Z';
}

/**
 * Get current timestamp for logs/display
 */
export function getWIBTimestamp() {
    return formatToWIB(new Date());
}

/**
 * Get current hour in WIB (0-23)
 * @returns {number}
 */
export function getWIBHour() {
    const wib = getWIBDate();
    return wib.getHours();
}

/**
 * Get current day of month in WIB (1-31)
 * @returns {number}
 */
export function getWIBDay() {
    const wibString = getWIBDateString();
    return parseInt(wibString.split('-')[2]);
}

/**
 * Get current month in WIB (1-12)
 * @returns {number}
 */
export function getWIBMonth() {
    const wibString = getWIBDateString();
    return parseInt(wibString.split('-')[1]);
}

/**
 * Get current date string in YYYY-MM-DD format (WIB)
 * @returns {string}
 */
export function getWIBDateString(dateInput = new Date()) {
    const date = new Date(dateInput);
    const formatter = new Intl.DateTimeFormat('en-CA', { // en-CA gives YYYY-MM-DD format
        timeZone: 'Asia/Jakarta',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
    });
    return formatter.format(date);
}

/**
 * Get current year in WIB
 * @returns {number}
 */
export function getWIBYear() {
    const wibString = getWIBDateString();
    return parseInt(wibString.split('-')[0]);
}
