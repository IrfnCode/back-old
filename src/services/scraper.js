import fs from 'fs';
import * as cheerio from 'cheerio';
import puppeteer from 'puppeteer';
import { getBrowserInstance, getPageInstance, getUserDataDir } from './browser.js';
import { isLoginPage, performAutoLogin, handleTOTPPage, isLoggedIn } from './auth.js';
import { getConfig, saveConfig, getWorkOrderById, updateWorkOrderCoordinates } from './database.js';
import { formatToWIB, getWIBDate } from '../utils/time.js';

let scrapeInterval = null;
let isScrapingActive = false;
let isScrapingNow = false;
let ownBrowser = null;
let ownPage = null;
let scrapSheetInterval = null;
let scrapSheetIntervalMs = 0;
let scrapSheetStartedAt = null;

/**
 * Get sheet scraping schedule state
 */
export function getScrapSheetStatus() {
    return {
        running: scrapSheetInterval !== null,
        intervalMs: scrapSheetIntervalMs,
        startedAt: scrapSheetStartedAt
    };
}

/**
 * Stop the automatic sheet scraping schedule
 */
export function stopScrapSheet() {
    if (scrapSheetInterval) {
        clearInterval(scrapSheetInterval);
        scrapSheetInterval = null;
        scrapSheetIntervalMs = 0;
        scrapSheetStartedAt = null;
        return true;
    }
    return false;
}

/**
 * Start the automatic sheet scraping schedule
 * @param {Function} runFn - async function that does the actual scrape+export
 * @param {number} intervalMs - interval in milliseconds
 */
export function startScrapSheet(runFn, intervalMs) {
    // Stop any existing schedule first
    stopScrapSheet();

    scrapSheetIntervalMs = intervalMs;
    scrapSheetStartedAt = new Date();

    // Run immediately on start, then on interval
    runFn().catch(err => console.error('❌ [ScrapSheet] Initial run error:', err.message));

    scrapSheetInterval = setInterval(() => {
        runFn().catch(err => console.error('❌ [ScrapSheet] Interval run error:', err.message));
    }, intervalMs);

    console.log(`⏰ [ScrapSheet] Auto-schedule started every ${intervalMs / 60000} minutes`);
    return true;
}

// HVC Tier expiry hours configuration
// HVC Tier expiry hours configuration
const HVC_EXPIRY_HOURS = {
    'HVC_PLATINUM': 6,
    'HVCPLATINUM': 6,
    'PLATINUM': 6,
    'HVC_DIAMOND': 3,
    'HVCDIAMOND': 3,
    'DIAMOND': 3,
    'HVC_GOLD': 10,
    'HVCGOLD': 10,
    'GOLD': 10,
    'REGULER': 36,
    'DEFAULT': 36
};

/**
 * Calculate expired date based on HVC tier
 */
export function calculateExpiredDate(reportedDate, customerType) {
    if (!reportedDate) return null;

    const date = new Date(reportedDate);
    if (isNaN(date.getTime())) return null;

    // Normalize customer type
    // Remove all non-alphanumeric chars for matching (e.g. HVC_GOLD -> HVCGOLD, HVC Gold -> HVCGOLD)
    const rawType = (customerType || '').toUpperCase();
    const normalized = rawType.replace(/[^A-Z]/g, '');

    // Check if it contains specific keywords if direct match fails
    let hours = HVC_EXPIRY_HOURS['DEFAULT'];

    if (normalized.includes('PLATINUM')) hours = 6;
    else if (normalized.includes('DIAMOND')) hours = 3;
    else if (normalized.includes('GOLD')) hours = 10;
    else if (HVC_EXPIRY_HOURS[normalized]) hours = HVC_EXPIRY_HOURS[normalized]; // Direct match check (e.g. REGULER)
    else if (HVC_EXPIRY_HOURS[rawType.replace(/[-\s]/g, '_')]) hours = HVC_EXPIRY_HOURS[rawType.replace(/[-\s]/g, '_')]; // Fallback to old normalization

    console.log(`Debug Expired: Type="${customerType}" Raw="${rawType}" Norm="${normalized}" Hours=${hours}`);

    date.setTime(date.getTime() + (hours * 60 * 60 * 1000));

    return formatToWIB(date);
}

/**
 * Parse raw ticket data from table rows
 * Expected format: tab-separated values from the ticketing system
 */
function parseTicketRow(rowText) {
    // Split by tab or multiple spaces
    const parts = rowText.split(/\t|\s{2,}/).map(p => p.trim()).filter(p => p);

    if (parts.length < 10) return null;

    // Map known field positions (adjust based on actual data structure)
    // Based on the sample data provided:
    // INCIDENT | TTR_CUSTOMER | SUMMARY | REPORTED_DATE | OWNER_GROUP | OWNER | 
    // CUSTOMER_SEGMENT | SERVICE_TYPE | WITEL | WORKZONE | STATUS | ...

    const incident = parts.find(p => p.match(/^INC\d+/)) || parts[0];
    if (!incident.match(/^INC\d+/)) return null;

    // Find specific fields by pattern
    // Find specific fields by pattern
    const reportedDateMatch = parts.find(p => p.match(/^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}$/));
    // Improve regex to catch all variations: prefixed, spaced, or standalone
    const customerType = parts.find(p => p.match(/(?:HVC[\s_]?)?(PLATINUM|DIAMOND|GOLD)|REGULER/i)) || 'REGULER';
    const contactPhone = parts.find(p => p.match(/^62\d{9,}$/)) || '';
    const serviceNo = parts.find(p => p.match(/^\d{12,15}$/)) || '';

    // Get summary - usually the longest text field
    const summary = parts.find(p => p.length > 50) || parts[2] || '';

    return {
        orderId: incident,
        title: summary.substring(0, 100),
        summary: summary,
        description: summary.substring(0, 200),
        customerType: customerType.toUpperCase().replace(/[-\s]/g, '_'),
        contactPhone: contactPhone,
        serviceNo: serviceNo,
        reportedDate: reportedDateMatch || null,
        status: 'OPEN',
        priority: 'Normal',
        source: 'Scraper'
    };
}

// Parse work orders from HTML
function parseWorkOrders(html) {
    const $ = cheerio.load(html);
    const workOrders = [];
    const seenIds = new Set();

    console.log('🔍 [ParseWorkOrders] Starting to parse HTML...');

    // First, try to find and parse header row to get column indices
    let columnMap = {};
    $('table thead tr, table tbody tr').first().each((index, element) => {
        const $el = $(element);
        const headerText = $el.text().toLowerCase();

        // Check if this looks like a header row
        if (headerText.includes('incident') || headerText.includes('summary')) {
            $el.find('th, td').each((i, cell) => {
                const text = $(cell).text().trim().toLowerCase();
                if (text.includes('service') && text.includes('no')) columnMap.serviceNo = i;
                if (text.includes('service') && text.includes('number')) columnMap.serviceNo = i;
                if (text.includes('no') && text.includes('layanan')) columnMap.serviceNo = i;
                if (text.includes('no') && text.includes('internet')) columnMap.serviceNo = i;
                if (text.includes('booking')) columnMap.bookingDate = i;
                if (text.includes('customer') && text.includes('segment')) columnMap.customerSegment = i;
                if (text.includes('workzone')) columnMap.workzone = i;
                if (text.includes('witel')) columnMap.witel = i;
                if (text.includes('status')) columnMap.status = i;
                if (text.includes('reported') && text.includes('by')) columnMap.reportedBy = i;
                if (text.includes('reported') && !text.includes('by')) columnMap.reportedDate = i;
                if (text.includes('source') && text.includes('ticket')) columnMap.sourceTicket = i;
                if (text.includes('device') && text.includes('name')) columnMap.deviceName = i;
                if (text.includes('rk') && text.includes('information')) columnMap.rkInformation = i;
            });
            console.log('📋 Column mapping:', columnMap);
        }
    });

    // Try to find table rows with incident data
    $('table tbody tr').each((index, element) => {
        const $el = $(element);
        const rowText = $el.text().trim();

        // Skip header rows
        if (rowText.includes('INCIDENT') && rowText.includes('SUMMARY')) return;

        // Check if this row contains an incident number
        if (!rowText.match(/INC\d+/)) return;

        // Extract UUID from onclick attribute
        // Format: window.location='?_mode=edit&id=ac1b2c3d-...'
        // Extract UUID
        let uuid = null;

        // 1. Try onclick (legacy)
        const onclick = $el.attr('onclick');
        if (onclick) {
            const match = onclick.match(/[?&]id=([^&']+)&?/);
            if (match) uuid = match[1];
        }

        // 2. Try child anchors
        if (!uuid) {
            const hrefs = $el.find('a').map((i, el) => $(el).attr('href')).get();
            for (const href of hrefs) {
                const match = href && href.match(/[?&]id=([^&']+)&?/);
                if (match) {
                    uuid = match[1];
                    break;
                }
            }
        }

        if (uuid) {
            // console.log(`[Scraper] Found UUID: ${uuid}`);
        }

        // Get all cell values
        const cells = [];
        $el.find('td').each((i, cell) => {
            cells.push($(cell).text().trim());
        });

        if (cells.length < 5) {
            console.log(`⏭️ Skipping row ${index}: only ${cells.length} cells (need 5+)`);
            return;
        }

        // ACTUAL Column positions from OSS Incident website:
        // 0: Checkbox (empty)
        // 1: UUID
        // 2: INCIDENT (INC44813829)
        // 3: TTR CUSTOMER (00:16:44)
        // 4: SUMMARY
        // 5+: Other columns (REPORTED DATE, OWNER GROUP, etc)

        // Find INC number - it's usually in column 2
        let orderId = null;
        let incColumnIndex = -1;
        for (let i = 0; i < cells.length; i++) {
            if (cells[i] && cells[i].match(/^INC\d+$/)) {
                orderId = cells[i];
                incColumnIndex = i;
                break;
            }
        }

        if (!orderId || seenIds.has(orderId)) {
            console.log(`⏭️ Row ${index}: No INC found or duplicate`);
            return;
        }
        seenIds.add(orderId);

        console.log(`✅ Found ticket: ${orderId} at column ${incColumnIndex}`);

        // Extract data based on actual structure
        // Columns after INC: TTR, SUMMARY, REPORTED_DATE, ...
        const ttrCustomer = cells[incColumnIndex + 1] || null;
        const summary = cells[incColumnIndex + 2] || '';
        const reportedDate = cells[incColumnIndex + 3] || null;

        // Try to find other fields by pattern matching
        let customerType = 'REGULER';
        let workzone = null;
        let witel = null;
        let customerSegment = null;
        let status = 'OPEN';
        let bookingDate = null;
        let sourceTicket = 'UNKNOWN';
        let deviceName = null;
        let rkInformation = null;
        let serviceNo = null;
        let reportedBy = null;
 
        // Use column mapping if available (from header row)
        if (columnMap.bookingDate !== undefined && cells[columnMap.bookingDate]) {
            bookingDate = cells[columnMap.bookingDate];
            console.log(`📅 Found booking date from column ${columnMap.bookingDate}: ${bookingDate}`);
        }
        if (columnMap.customerSegment !== undefined && cells[columnMap.customerSegment]) {
            customerSegment = cells[columnMap.customerSegment];
        }
        if (columnMap.workzone !== undefined && cells[columnMap.workzone]) {
            workzone = cells[columnMap.workzone];
        }
        if (columnMap.witel !== undefined && cells[columnMap.witel]) {
            witel = cells[columnMap.witel];
        }
        if (columnMap.status !== undefined && cells[columnMap.status]) {
            const statusVal = cells[columnMap.status].toUpperCase();
            if (['OPEN', 'IN_PROGRESS', 'BACKEND', 'CLOSED', 'RESOLVED', 'CANCELLED'].includes(statusVal)) {
                status = statusVal;
            }
        }
        if (columnMap.sourceTicket !== undefined && cells[columnMap.sourceTicket]) {
            sourceTicket = cells[columnMap.sourceTicket].trim().toUpperCase();
        }
        if (columnMap.deviceName !== undefined && cells[columnMap.deviceName]) {
            deviceName = cells[columnMap.deviceName].trim();
        }
        if (columnMap.rkInformation !== undefined && cells[columnMap.rkInformation]) {
            rkInformation = cells[columnMap.rkInformation].trim();
        }
        if (columnMap.serviceNo !== undefined && cells[columnMap.serviceNo]) {
            serviceNo = cells[columnMap.serviceNo].trim();
        }
        if (columnMap.reportedBy !== undefined && cells[columnMap.reportedBy]) {
            reportedBy = cells[columnMap.reportedBy].trim();
        }
 
        for (let i = 0; i < cells.length; i++) {
            const cell = cells[i];
            if (!cell) continue;
 
            // Customer type pattern
            if (cell.match(/^(HVC_?(PLATINUM|DIAMOND|GOLD)|REGULER)$/i)) {
                customerType = cell.toUpperCase().replace(/[-\s]/g, '_');
            }
            // Status pattern
            if (cell.match(/^(OPEN|IN_PROGRESS|BACKEND|CLOSED|RESOLVED|CANCELLED)$/i)) {
                status = cell.toUpperCase();
            }
            // Customer segment pattern (like PL-TSEL, DGS, ENTERPRISE, PERSONAL, PEMERINTAH, etc.)
            if (cell.match(/^(PL-TSEL|DGS|DBS|DES|DSS|DPS|ENTERPRISE|PERSONAL|PEMERINTAH|WHOLESALE|BUSINESS|CONSUMER|GOVERNMENT|SOE|MEDIUM|SMALL)$/i)) {
                customerSegment = cell.toUpperCase();
            }
            // Fallback for source ticket if not found by column map
            if (sourceTicket === 'UNKNOWN' && cell.match(/^(CUSTOMER|PROACTIVE|GAMAS|SQM)$/i)) {
                sourceTicket = cell.toUpperCase();
            }
            // Service number pattern (e.g. 12-digit number starting with 1, 2, or 3)
            if (!serviceNo && cell.match(/^(111|12|13|14|15|16|17|18|19)\d{9}$/)) {
                serviceNo = cell;
            }
        }

        // Extract workzone from deviceName (ODP) or rkInformation (ODC) to prevent false matches from customer names
        const searchWz = (str) => {
            if (!str) return null;
            const parts = str.toUpperCase().split(/[^A-Z]/);
            for (const part of parts) {
                if (part.length === 3 && part !== 'ODP' && part !== 'ODC') {
                    return part;
                }
            }
            return null;
        };
        const extractedWz = searchWz(deviceName) || searchWz(rkInformation);
        if (extractedWz) {
            workzone = extractedWz;
        }
 
        const ticket = {
            uuid: uuid, // Added UUID
            orderId: orderId,
            ttrCustomer: ttrCustomer,
            summary: summary,
            title: summary.substring(0, 100),
            description: summary.substring(0, 200),
            reportedDate: reportedDate,
            bookingDate: bookingDate,
            customerSegment: customerSegment,
            workzone: workzone,
            customerType: customerType,
            status: status,
            witel: witel,
            priority: 'Normal',
            sourceTicket: sourceTicket,
            deviceName: deviceName,
            rkInformation: rkInformation,
            serviceNo: serviceNo,
            reportedBy: reportedBy || sourceTicket,
            source: 'Scraper'
        };

        // Calculate expired date - skip for SQM tickets
        if (summary.includes('[SQM]')) {
            ticket.expiredDate = null;
        } else {
            ticket.expiredDate = calculateExpiredDate(ticket.reportedDate, ticket.customerType);
        }

        // Skip closed tickets - only process active ones
        if (status === 'CLOSED' || status === 'RESOLVED' || status === 'CANCELLED') {
            console.log(`⏭️ Skipping closed ticket: ${orderId}`);
            return;
        }

        workOrders.push(ticket);
    });

    // Also try to parse from pre/code blocks with raw text
    $('pre, code, .raw-data').each((index, element) => {
        const text = $(element).text();
        const lines = text.split('\n');

        lines.forEach(line => {
            if (line.match(/^INC\d+/)) {
                const parsed = parseTicketRow(line);
                if (parsed && !seenIds.has(parsed.orderId)) {
                    seenIds.add(parsed.orderId);
                    parsed.expiredDate = calculateExpiredDate(parsed.reportedDate, parsed.customerType);
                    workOrders.push(parsed);
                }
            }
        });
    });

    return workOrders;
}

/**
 * Scrape detail page for coordinates
 */
async function scrapeTicketDetails(page, uuid, orderId) {
    if (!uuid) return null;

    try {
        console.log(`📍 Navigating to detail page for ${orderId}...`);

        // Construct detail URL (assuming relative to current base)
        // Standard Joget pattern: controller/web/userview/.../form?_mode=edit&id=UUID
        // We can just append the query params to the base URL if we are in the right app
        // Or safer: click the row if we were on the list, but we are navigating directly.
        // Let's try to infer base URL from current page or use a standard pattern.
        const currentUrl = page.url();
        const baseUrl = currentUrl.split('?')[0];
        const detailUrl = `${baseUrl}?_mode=edit&id=${uuid}`;

        await page.goto(detailUrl, { waitUntil: 'networkidle2', timeout: 60000 });

        // Wait for tabs to load
        // Selector for "Customer Information" tab.
        // Using ::-p-xpath for Puppeteer v22+ compliance
        const tabSelector = "::-p-xpath(//a[contains(text(), 'Customer Information')])";
        try {
            await page.waitForSelector(tabSelector, { timeout: 5000 });
        } catch (e) { /* ignore */ }

        const tabs = await page.$$(tabSelector);
        if (tabs.length > 0) {
            console.log('📑 Clicking "Customer Information" tab...');
            await tabs[0].click();
            await new Promise(r => setTimeout(r, 1000)); // Wait for tab switch
        } else {
            console.log('⚠️ "Customer Information" tab not found, trying to scrape visible fields anyway...');
        }

        // Now scrape fields: Street Address, Latitude, Longitude
        // Now scrape fields: Street Address, Latitude, Longitude
        const html = await page.content();

        // DEBUG: Save HTML to file for analysis
        try {
            fs.writeFileSync('detail_debug.html', html);
            console.log('📄 Saved detail page HTML to detail_debug.html');

            // Log all links to see what tabs are available
            /* javascript-obfuscator:disable */
            const links = await page.$$eval('a', as => as.map(a => a.innerText));
            /* javascript-obfuscator:enable */

            console.log('🔗 Visible Links/Tabs:', links.filter(t => t && t.length < 50).join(', '));
        } catch (e) { console.log('Debug save failed', e); }

        const $ = cheerio.load(html);

        let lat = null;
        let lng = null;
        let streetAddress = null;

        // --- NEW STRATEGIES ---

        // Strategy 1: Hidden Inputs (Direct ID/Name match)
        // IDs found: child_id_1_ticketUserInformationAfterRunCrud_latitude, ..._service_address
        const latInput = $('input[name*="latitude"]').val();
        const lngInput = $('input[name*="longitude"]').val();
        const addrInput = $('input[name*="service_address"]').val();

        if (latInput) lat = parseFloat(latInput);
        if (lngInput) lng = parseFloat(lngInput);
        if (addrInput) streetAddress = addrInput;

        // console.log(`🔍 Strategy 1 (Hidden Inputs) - Lat: ${latInput}, Lng: ${lngInput}, Addr: ${addrInput}`);

        // Strategy 2: Global JS Variables (Regex on HTML)
        // Variables: CI_LATITUDE, CI_LONGITUDE
        if (!lat || !lng) {
            const latMatch = html.match(/let\s+CI_LATITUDE\s*=\s*"([^"]+)"/) || html.match(/CI_LATITUDE\s*=\s*"([^"]+)"/);
            const lngMatch = html.match(/let\s+CI_LONGITUDE\s*=\s*"([^"]+)"/) || html.match(/CI_LONGITUDE\s*=\s*"([^"]+)"/);

            if (latMatch && latMatch[1]) lat = parseFloat(latMatch[1]);
            if (lngMatch && lngMatch[1]) lng = parseFloat(lngMatch[1]);

            if (latMatch || lngMatch) console.log(`🔍 Strategy 2 (JS Vars) - Lat: ${lat}, Lng: ${lng}`);
        }

        // Strategy 3: Technical Data Table
        // Iterate table rows for keys 'LATITUDE', 'LONGITUDE', 'ADDRESS'
        if (!lat || !lng || !streetAddress) {
            $('tr.grid-row').each((i, el) => {
                const key = $(el).find('[column_key="port_name"]').text().trim().toUpperCase();
                const val = $(el).find('[column_key="device_name"]').text().trim();

                if (key === 'LATITUDE') lat = parseFloat(val);
                if (key === 'LONGITUDE') lng = parseFloat(val);
                if (key === 'ADDRESS' && !streetAddress) streetAddress = val;
            });
            console.log(`🔍 Strategy 3 (Tech Table) - Lat: ${lat}, Lng: ${lng}, Addr: ${streetAddress}`);
        }

        // Helper to find input value by label
        const getFieldValue = (label) => {
            // Find label, then find corresponding input/textarea
            // Typically label is in a td, input in next td or same structure
            // Or label has 'for' attribute
            // Let's try to match text in td/th and get next value
            let val = null;
            $('td, th, label').each((i, el) => {
                if ($(el).text().trim().includes(label)) {
                    // Try next element or closest input
                    const $next = $(el).next();
                    val = $next.find('input, textarea, span').text() || $next.find('input').val() || $next.text();
                    return false; // break
                }
            });
            return val ? val.trim() : null;
        };

        // 1. Try "Street Address" field pattern: ... | lat | lng
        // Look for element with "Street Address" label
        // We can also look for specific IDs if we knew them, but text match is safer for generic
        // User screenshot showed "Street Address" in a textarea or large field

        // Find visible text that looks like coords
        // We can regex search the whole body for coordinates as a fallback
        const bodyText = $('body').text();

        // Strategy 1: specific fields
        const latField = getFieldValue('Latitude');
        const lngField = getFieldValue('Longitude');
        const addressField = getFieldValue('Street Address');

        if (latField) lat = parseFloat(latField);
        if (lngField) lng = parseFloat(lngField);
        streetAddress = addressField;

        // Strategy 2: Parse address field
        if ((!lat || !lng) && addressField) {
            // Format: ... | 0.0081527 | 104.0275189
            const parts = addressField.split('|').map(p => p.trim());
            if (parts.length >= 3) {
                // Check last two parts for coords
                const p1 = parseFloat(parts[parts.length - 2]);
                const p2 = parseFloat(parts[parts.length - 1]);
                if (!isNaN(p1) && !isNaN(p2)) {
                    lat = p1;
                    lng = p2;
                }
            }
        }

        // Strategy 3: Regex match in body (fallback)
        if (!lat || !lng) {
            // Match "Latitude : 1.234" pattern
            const latMatch = bodyText.match(/Latitude\s*[:]\s*([-\d.]+)/i);
            const lngMatch = bodyText.match(/Longitude\s*[:]\s*([-\d.]+)/i);
            if (latMatch) lat = parseFloat(latMatch[1]);
            if (lngMatch) lng = parseFloat(lngMatch[1]);
        }

        if (lat && lng) {
            console.log(`✅ Found Coords: ${lat}, ${lng} (${streetAddress})`);
            return { lat, lng, streetAddress };
        } else {
            console.log('⚠️ No coordinates found on detail page');
            return null;
        }

    } catch (err) {
        console.error(`❌ Error scraping details for ${orderId}:`, err.message);
        return null;
    }
}

/**
 * Format work order for display/Telegram
 */
export function formatWorkOrderMessage(wo) {
    // Escape function for Markdown (Legacy)
    // Only escape characters that strictly break Markdown syntax: *, _, `, [
    // Standard text usually doesn't need aggressive escaping in Legacy Markdown
    const esc = (text) => {
        if (!text) return '';
        return text.toString().replace(/[_*`[]/g, '\\$&');
    };

    const orderId = wo.order_id || wo.orderId || 'Unknown';
    const status = wo.status || 'OPEN';
    const tier = wo.customer_type || wo.customerType || 'REGULER';
    const source = wo.source || 'Scraper';
    const summary = wo.summary || wo.title || '';
    const reportedDate = wo.reported_date || wo.reportedDate || 'N/A';
    const expiredDate = wo.expired_date || wo.expiredDate || 'N/A';
    const bookingDate = wo.booking_date || wo.bookingDate;
    const workzone = wo.workzone || '';
    const witel = wo.witel || '';
    const customerSegment = wo.customer_segment || wo.customerSegment || '';

    let locationInfo = '';
    if (workzone || witel || customerSegment) {
        const parts = [workzone, witel, customerSegment].filter(p => p);
        locationInfo = parts.join(' | ');
    }

    const statusEmoji = {
        'OPEN': '📬',
        'BACKEND': '⚙️',
        'IN_PROGRESS': '🔄',
        'CLOSED': '✅',
        'RESOLVED': '✅',
        'CANCELLED': '❌'
    };

    const tierEmoji = {
        'HVC_PLATINUM': '💎',
        'HVC_DIAMOND': '💠',
        'HVC_GOLD': '🥇',
        'REGULER': '📋'
    };

    // Smart formatting for summary (handles underscore-delimited data)
    const formatSummary = (raw) => {
        // Known keys used in formatting logic
        const knownKeys = ['NoTiket', 'Nama Pelanggan', 'NIK', 'CP', 'Email', 'OrderID', 'Dan', 'Tgl Kejadian', 'Detail case', 'Capt lightshoot', 'Loker', 'CC SMG', 'Solusi', 'Pool ID', 'Gaul', 'Hasil cek tools', 'Tanggal cek tools', 'Note', 'KATEGORI', 'Status Nomor di DSC', 'Active_Sub Stat'];

        // Check if summary uses underscore delimiters
        if (raw && raw.includes('_')) {
            const parts = raw.split('_').map(p => p.trim()).filter(p => p);

            // Heuristic: If we match known keys, we format them specially
            // Otherwise we just display the text
            if (parts.length >= 2) {
                let formattedLines = [];
                let i = 0;

                // Handle first part (usually initial detail/subject)
                // If it's not a key, treat it as header/detail
                if (!knownKeys.some(k => parts[0].toLowerCase().startsWith(k.toLowerCase()))) {
                    formattedLines.push(`_${esc(parts[0])}_`);
                    i++;
                }

                while (i < parts.length) {
                    const current = parts[i];
                    // Check if current part starts with a known key
                    const matchedKey = knownKeys.find(k => current.toLowerCase().startsWith(k.toLowerCase()));

                    if (matchedKey) {
                        // If it's a key, try to find the value
                        // Sometimes value is in the same part (Key Value) or next part
                        // But usually the structure is Key _ Value

                        // If current is just the Key, take next part as value
                        if (current.toLowerCase() === matchedKey.toLowerCase() && i + 1 < parts.length) {
                            formattedLines.push(`${matchedKey} _${esc(parts[i + 1])}_`);
                            i += 2;
                        } else {
                            // Maybe "Key Value" is already in one string?
                            // Or the structure is inconsistent.
                            // Let's just output current line as is but escape it
                            formattedLines.push(esc(current));
                            i++;
                        }
                    } else {
                        // Unknown part, just append
                        formattedLines.push(esc(current));
                        i++;
                    }
                }

                return formattedLines.join('\n');
            }
        }

        return esc(raw);
    };

    let message = `📋 *New Work Order ID:* \`${esc(orderId)}\`\n`;
    message += `*Status:* ${statusEmoji[status] || '📋'} ${esc(status)}\n`;
    message += `*Tier:* ${tierEmoji[tier] || '📋'} ${esc(tier)}\n`;
    message += `*Source:* ${esc(source)}\n\n`;

    // Custom format for SQM tickets
    if (summary.includes('[SQM]')) {
        message += `${esc(orderId)}    ${esc(summary)}  ${esc(tier)}\n`;
    } else {
        message += `${formatSummary(summary)}\n\n`;

        if (locationInfo) {
            message += `${esc(locationInfo)}\n\n`;
        }

        message += `${esc(tier)}\n\n`;
        message += `OPEN ${esc(reportedDate)}\n`;
        message += `EXP ${esc(expiredDate)}\n`;

        if (bookingDate) {
            message += `BOOKING ${esc(bookingDate)}\n`;
        }
    }

    return message;
}

/**
 * Get a page for scraping - uses browser monitor's page if running,
 * otherwise creates a new headless browser with saved session
 */
async function getScrapePage() {
    // First, try to use the browser monitor's page (already logged in)
    const monitorPage = getPageInstance();
    if (monitorPage) {
        console.log('📡 Using active browser monitor session (GOOD!)');
        return { page: monitorPage, isShared: true };
    }

    // WARNING: Browser monitor is not running!
    console.log('');
    console.log('⚠️ ============================================');
    console.log('⚠️  BROWSER MONITOR TIDAK AKTIF!');
    console.log('⚠️  Untuk scraping website dengan login:');
    console.log('⚠️  1. Buka Browser Monitor di halaman Scraper');
    console.log('⚠️  2. Login di browser tersebut');
    console.log('⚠️  3. BIARKAN BROWSER TETAP TERBUKA');
    console.log('⚠️  4. Baru klik Run Scraper');
    console.log('⚠️ ============================================');
    console.log('');

    // If browser monitor is not running, create own headless browser
    if (!ownBrowser) {
        console.log('🌐 Creating headless browser with saved session...');

        const userDataDir = getUserDataDir();

        // --- PTERODACTYL FALLBACK PATHS ---
        const fallbackPaths = [
            process.env.PUPPETEER_EXECUTABLE_PATH,
            '/usr/bin/google-chrome',
            '/usr/bin/chromium-browser',
            '/usr/bin/chromium',
            '/usr/bin/google-chrome-stable',
            '/usr/bin/google-chrome-unstable',
            '/home/container/.cache/puppeteer/chrome/linux-143.0.7499.169/chrome-linux64/chrome'
        ];

        let executablePath = undefined;
        for (const p of fallbackPaths) {
            if (p && fs.existsSync(p)) {
                executablePath = p;
                console.log(`🚀 Found Chromium at: ${p}`);
                break;
            }
        }

        if (!executablePath) {
            console.log('⚠️ WARNING: No system chromium found. Puppeteer will try to use the downloaded one.');
        }

        ownBrowser = await puppeteer.launch({
            headless: 'new',
            executablePath: executablePath,
            userDataDir: userDataDir,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--disable-gpu',
                '--no-first-run',
                '--no-zygote'
            ],
            defaultViewport: {
                width: 1280,
                height: 800
            }
        });

        ownPage = await ownBrowser.newPage();
        console.log('✅ Headless browser ready');
    }

    return { page: ownPage, isShared: false };
}

/**
 * Close own browser if we created one
 */
async function closeOwnBrowser() {
    if (ownBrowser) {
        await ownBrowser.close();
        ownBrowser = null;
        ownPage = null;
        console.log('🛑 Headless browser closed');
    }
}

// Scrape once using Puppeteer (with session)
export async function scrapeOnce(baseUrl, onNewWorkOrder, options = {}) {
    if (isScrapingNow) {
        throw new Error("Scraping Insera sedang berjalan, silakan coba beberapa saat lagi.");
    }
    isScrapingNow = true;
    try {
        // --- CONSTRUCT URL WITH FILTERS ---
        // 1. Get filter config
        const config = getConfig();
        let targetUrl = baseUrl;

        // --- AUTO SHIFT DATES LOGIC ---
        if (config.autoShiftDates === 'true' && config.filterDateTo) {
            try {
                const now = new Date();
                // Parse database configs with +07:00 (WIB) offset to prevent server timezone drift
                const configTo = new Date(config.filterDateTo.includes('+') || config.filterDateTo.includes('Z') ? config.filterDateTo : config.filterDateTo + '+07:00');
                const configFrom = new Date(config.filterDateFrom ? (config.filterDateFrom.includes('+') || config.filterDateFrom.includes('Z') ? config.filterDateFrom : config.filterDateFrom + '+07:00') : now);

                if (!isNaN(configTo.getTime()) && !isNaN(configFrom.getTime())) {
                    // Get today's date in WIB
                    const todayWibStr = formatToWIB(now).slice(0, 10); // YYYY-MM-DD

                    // Reset both to midnight WIB (+07:00) to calculate pure calendar days difference
                    const d1 = new Date(todayWibStr + 'T00:00:00+07:00');
                    const configToDateStr = formatToWIB(configTo).slice(0, 10);
                    const d2 = new Date(configToDateStr + 'T00:00:00+07:00');

                    const daysDiff = Math.floor((d1.getTime() - d2.getTime()) / (24 * 60 * 60 * 1000));

                    if (daysDiff > 0) {
                        console.log(`📅 [Scraper] Auto-shifting dates forward by ${daysDiff} days...`);

                        const newTo = new Date(configTo);
                        newTo.setDate(configTo.getDate() + daysDiff);

                        const newFrom = new Date(configFrom);
                        newFrom.setDate(configFrom.getDate() + daysDiff);

                        // Format back to YYYY-MM-DDTHH:mm (HTML datetime-local format) in WIB
                        const fmtTo = formatToWIB(newTo).slice(0, 16).replace(' ', 'T');
                        const fmtFrom = formatToWIB(newFrom).slice(0, 16).replace(' ', 'T');

                        // Update config in database
                        saveConfig('filterDateFrom', fmtFrom);
                        saveConfig('filterDateTo', fmtTo);

                        // Update local config object for current scrape run
                        config.filterDateFrom = fmtFrom;
                        config.filterDateTo = fmtTo;

                        console.log(`✅ [Scraper] Dates updated: ${fmtFrom} to ${fmtTo}`);
                    }
                }
            } catch (err) {
                console.error('❌ [Scraper] Failed to auto-shift dates:', err.message);
            }
        }

        // 2. Check if we have filters to apply (skip completely if skipConfigOverrides is true)
        if (!options.skipConfigOverrides && (config.filterDateFrom || config.filterDateTo || config.filterWorkzone || config.filterStatus)) {
            console.log('🔧 Applying manual filters to URL...');

            const urlObj = new URL(baseUrl);

            // Helper to set params (overwrite existing)
            const setParam = (key, value) => {
                if (value) {
                    urlObj.searchParams.delete(key);
                    urlObj.searchParams.set(key, value);
                }
            };

            // Helper to append params (for duplicate keys like reported_date_filter range)
            const appendParam = (key, value) => {
                if (value) {
                    urlObj.searchParams.append(key, value);
                }
            };

            // Clear complex range keys before appending new ones
            if (config.filterDateFrom || config.filterDateTo) {
                urlObj.searchParams.delete('d-5564009-fn_reported_date_filter');
            }

            // Reported Date (Two entries for range)
            if (config.filterDateFrom) {
                // Formatting date to expected format if needed (e.g. YYYY-MM-DD HH:mm)
                // The input is YYYY-MM-DDTHH:mm, we need to replace T with space and encode
                // But URLSearchParams handles encoding. We just need format.
                const fmtDate = config.filterDateFrom.replace('T', ' ');
                appendParam('d-5564009-fn_reported_date_filter', fmtDate);
            }

            if (config.filterDateTo) {
                const fmtDate = config.filterDateTo.replace('T', ' ');
                appendParam('d-5564009-fn_reported_date_filter', fmtDate);
            }

            // Workzone
            if (!options.skipConfigOverrides && config.filterWorkzone) {
                setParam('d-5564009-fn_C_WORK_ZONE', config.filterWorkzone);
            }

            // Status (Using the key inferred from typical Joget apps or user example if available)
            // User example didn't explicitly show fn_status but showed d-5564009-fn_status_date_filter which is different
            // However, typical pattern is fn_C_TICKET_STATUS or similar. 
            // The user request shows d-5564009-fn_C_TICKET_STATUS in the long URL.
            if (!options.skipConfigOverrides && config.filterStatus) {
                setParam('d-5564009-fn_C_TICKET_STATUS', config.filterStatus);
            }

            // Page Size (Limit)
            // Default to configured value or 100 if explicitly requested, otherwise default to 30
            const pageSize = config.filterPageSize || '100';
            setParam('d-5564009-ps', pageSize);

            // Generate valid page number (always start at 1 for scraping)
            setParam('d-5564009-p', '1');

            targetUrl = urlObj.toString();
        }

        console.log(`🔍 Scraping: ${targetUrl}`);

        const { page, isShared } = await getScrapePage();

        // If using shared browser, create a new tab for scraping
        let scrapePage = page;
        let shouldCloseTab = false;

        if (isShared) {
            // Use the same page but save current URL
            const currentUrl = page.url();
            console.log(`📍 Current browser URL: ${currentUrl}`);
            await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 60000 });
            // Note: This will change the browser monitor view temporarily
        } else {
            await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 60000 });
        }

        // Wait a bit for dynamic content
        await new Promise(resolve => setTimeout(resolve, 2000));

        // Check if we are logged in. If not (and not currently on login page), force navigation to login and login.
        const loggedIn = await isLoggedIn(page);
        if (!loggedIn && !(await isLoginPage(page))) {
            console.log('🔐 Session is guest/not logged in. Navigating to login page for auto-login...');
            const { loadCredentials } = await import('./auth.js');
            const credentials = loadCredentials();
            if (credentials) {
                await page.goto(credentials.loginUrl || "https://insera-sso.telkom.co.id/jw/web/login", {
                    waitUntil: 'networkidle2',
                    timeout: 45000
                });
                const loginResult = await performAutoLogin(page);
                if (loginResult.success) {
                    console.log('✅ Auto-login successful! Returning to target URL...');
                    await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 60000 });
                } else {
                    console.log('⚠️ Forced auto-login failed:', loginResult.message);
                }
            }
        }

        // Check if we're on login page and auto-login if needed
        if (await isLoginPage(page)) {
            console.log('🔐 Login page detected during scraping, attempting auto-login...');
            const loginResult = await performAutoLogin(page);

            if (loginResult.success) {
                console.log('✅ Auto-login successful!');

                // Check for TOTP page after initial login
                await new Promise(resolve => setTimeout(resolve, 2000));
                if (await isLoginPage(page)) {
                    console.log('🔐 TOTP page detected, entering code...');
                    await handleTOTPPage(page);
                }

                // Wait for SSO to redirect back to target URL
                console.log('⏳ Waiting for SSO redirect...');
                await new Promise(resolve => setTimeout(resolve, 3000));

                // Check if we're still on login page after waiting
                const currentUrl = page.url();
                console.log(`📍 Current URL after login: ${currentUrl}`);

                // If SSO didn't redirect, navigate back to target URL
                if (await isLoginPage(page)) {
                    console.log(`📍 Still on login page, navigating to target URL: ${targetUrl}`);
                    await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 30000 });
                    await new Promise(resolve => setTimeout(resolve, 2000));
                }
            } else {
                console.log('⚠️ Auto-login failed:', loginResult.message);
                console.log('⚠️ WARNING: Page might be showing login form - session may have expired');
            }
        }

        // Get page HTML
        const html = await page.content();

        // DEBUG: Count tables and rows
        const $ = cheerio.load(html);
        const tableCount = $('table').length;
        const rowCount = $('table tbody tr').length;
        console.log(`📊 Found ${tableCount} tables, ${rowCount} rows`);

        // DEBUG: Sample first few rows
        $('table tbody tr').slice(0, 3).each((i, row) => {
            const cells = $(row).find('td').map((j, cell) => $(cell).text().trim().substring(0, 30)).get();
            console.log(`📝 Row ${i}: [${cells.slice(0, 5).join(' | ')}...]`);
        });

        const workOrders = parseWorkOrders(html);

        console.log(`📋 Found ${workOrders.length} work orders`);
        
        if (workOrders.length === 0) {
            console.log(`🔍 [DEBUG] HTML Snippet (first 1500 chars):`, html.substring(0, 1500).replace(/\s+/g, ' '));
        }

        if (workOrders.length > 0) {
            console.log(`📌 Sample work order:`, JSON.stringify(workOrders[0], null, 2));
        }

        // Notify for each work order
        for (const wo of workOrders) {
            // 1. Check if we need to scrape details (add missing coords)
            // REVERTED: User requested to disable this due to performance issues
            /*
            if (wo.uuid) {
                // Check DB
                const existing = getWorkOrderById(wo.orderId);
                if (!existing || (!existing.latitude && !existing.longitude)) {
                    // Coordinate missing, let's scrape details
                    const details = await scrapeTicketDetails(page, wo.uuid, wo.orderId);
                    if (details) {
                        wo.latitude = details.lat;
                        wo.longitude = details.lng;
                        wo.streetAddress = details.streetAddress;

                        // Save to DB immediately
                        updateWorkOrderCoordinates(wo.orderId, details.lat, details.lng, details.streetAddress);
                    }
                    // Small delay to be polite
                    await new Promise(r => setTimeout(r, 2000));
                }
            }
            */

            if (onNewWorkOrder) {
                onNewWorkOrder(wo);
            }
        }

        return {
            count: workOrders.length,
            timestamp: formatToWIB(),
            data: workOrders
        };
    } catch (error) {
        console.error('❌ Scraping error:', error.message);
        throw error;
    } finally {
        isScrapingNow = false;
    }
}

// Start auto-scraping with interval
export async function startScraping(url, intervalMs = 120000, onNewWorkOrder) {
    if (isScrapingActive) {
        console.log('⚠️ Scraping already active');
        return;
    }

    isScrapingActive = true;
    saveConfig('autoScrapActive', 'true'); // Persist
    console.log(`🚀 Starting auto-scrape every ${intervalMs / 1000}s (${intervalMs / 60000} minutes)`);

    // Initial scrape (wrapped in try-catch to not block interval setup)
    try {
        console.log('🚀 Triggering initial scrape...');
        const result = await scrapeOnce(url, async (workOrder) => {
            console.log(`🔎 Scraper found new WO: ${workOrder.orderId}`);
            if (onNewWorkOrder) {
                try {
                    console.log(`🔄 Processing callback for WO: ${workOrder.orderId}`);
                    await onNewWorkOrder(workOrder);
                    console.log(`✅ Callback processed for WO: ${workOrder.orderId}`);
                } catch (cbErr) {
                    console.error(`❌ Callback failed for WO ${workOrder.orderId}:`, cbErr);
                }
            }
        });
        console.log(`✅ Initial scrape done. Count: ${result.count}`);
    } catch (error) {
        console.error('❌ Initial scrape error (will retry on next interval):', error.message);
    }

    scrapeInterval = setInterval(async () => {
        try {
            console.log(`⏰ Auto-scrape triggered at ${new Date().toLocaleTimeString('id-ID')}`);
            await scrapeOnce(url, async (workOrder) => {
                console.log(`🔎 Interval Scraper found new WO: ${workOrder.orderId}`);
                if (onNewWorkOrder) {
                    try {
                        await onNewWorkOrder(workOrder);
                        console.log(`✅ CB processed for WO: ${workOrder.orderId}`);
                    } catch (cbErr) {
                        console.error(`❌ CB failed for WO ${workOrder.orderId}:`, cbErr);
                    }
                }
            });
        } catch (error) {
            console.error('❌ Auto-scrape error (will retry on next interval):', error.message);
        }
    }, intervalMs);
}

export async function stopScraping() {
    if (scrapeInterval) {
        clearInterval(scrapeInterval);
        scrapeInterval = null;
    }
    isScrapingActive = false;

    await closeOwnBrowser();

    console.log('🛑 Auto-scraping stopped');
}

export function isScrapingRunning() {
    return isScrapingActive;
}

/**
 * Scrape details for a single ticket on demand
 * Returns the updated work order object with address/coords
 */
export async function scrapeSingleTicket(orderId) {
    console.log(`🔎 [Manual Scrape] Searching for ${orderId} via Search Bar...`);

    // 1. Get browser page
    const { page, isShared } = await getScrapePage();

    // Ensure we are on the dashboard/base URL first or at least have the nav bar
    const config = getConfig();
    const baseUrl = config.targetUrl;

    try {
        // If we are not on a page with the search bar, go to base URL
        let searchInput = await page.$('input[placeholder*="Find Incident"]');

        if (!searchInput) {
            console.log('🔄 Search bar not found, navigating to dashboard...');
            await page.goto(baseUrl, { waitUntil: 'networkidle2', timeout: 60000 });
            // Wait for it to be actually visible
            searchInput = await page.waitForSelector('input[placeholder*="Find Incident"]', { visible: true, timeout: 15000 });
        }

        if (!searchInput) {
            throw new Error('Could not find "Find Incident" search bar on the page.');
        }

        // 2. Clear and Type Order ID (Robust Method)
        // Use evaluate to safely clear and focus, bypassing "not clickable" issues if covered
        /* javascript-obfuscator:disable */
        await page.evaluate((id) => {
            const input = document.querySelector('input[placeholder*="Find Incident"]');
            if (input) {
                input.value = ''; // Clear directly
                input.focus();
            }
        }, orderId);
        /* javascript-obfuscator:enable */


        // Type to ensure events trigger, then Enter
        await page.keyboard.type(orderId);
        await page.keyboard.press('Enter');

        console.log(`⏳ Searching for ${orderId}...`);

        // 3. Wait for navigation or result
        // The search might redirect to detail page OR filter the list.
        await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 60000 }).catch(e => console.log('⚠️ Navigation timeout or didn\'t happen, checking current state...'));

        // 4. Check where we are
        const url = page.url();
        console.log(`📍 Current URL after search: ${url}`);

        let uuid = null;
        if (url.includes('_mode=edit') && url.includes('id=')) {
            // Likely detail page
            const match = url.match(/id=([^&]+)/);
            if (match) uuid = match[1];
        } else {
            // Maybe we are still on list page (filtered)?
            // Check if table contains our ID
            try {
                // Wait for ANY edit link to appear, usually the first one is our result if filtered
                const linkSelector = `a[href*="_mode=edit"][href*="id="]`;
                const link = await page.waitForSelector(linkSelector, { visible: true, timeout: 5000 });

                if (link) {
                    console.log('📂 Found ticket in list, clicking to view details...');
                    // Use evaluate click to be robust against "Node not clickable"
                    /* javascript-obfuscator:disable */
                    await page.evaluate((el) => el.click(), link);
                    /* javascript-obfuscator:enable */


                    await page.waitForNavigation({ waitUntil: 'networkidle2' });

                    // Now we should be on detail page
                    const newUrl = page.url();
                    const match = newUrl.match(/id=([^&]+)/);
                    if (match) uuid = match[1];
                }
            } catch (e) {
                console.log('⚠️ Could not find ticket link in list after search (or already on detail page?)');
            }
        }

        if (!uuid) {
            // Fallback: try to grab UUID from URL if we missed it
            const match = page.url().match(/id=([^&]+)/);
            if (match) uuid = match[1];
        }

        if (!uuid) {
            throw new Error(`Could not navigate to detail page for ${orderId}. Search might have returned no results.`);
        }

        console.log(`✅ On detail page for ${orderId} (UUID: ${uuid})`);

        // 5. Scrape Details
        const details = await scrapeTicketDetails(page, uuid, orderId);

        if (!details) {
            throw new Error('Failed to scrape details or no coordinates found.');
        }

        // 6. Update DB (Upsert)
        updateWorkOrderCoordinates(orderId, details.lat, details.lng, details.streetAddress);

        return {
            orderId,
            latitude: details.lat,
            longitude: details.lng,
            streetAddress: details.streetAddress
        };

    } catch (error) {
        console.error(`❌ [Manual Scrape] Error for ${orderId}:`, error.message);
        throw error;
    }
}

/**
 * Scrapes both Reguler tickets and Proactive Inbox (SQM & UNSPEC OHI) sequentially.
 * Prevents overlapping with other scraper runs using isScrapingNow.
 */
export async function scrapeProactiveAndReguler(regulerBaseUrl, proactiveBaseUrl) {
    if (isScrapingNow) {
        throw new Error("Scraping Insera sedang berjalan, silakan coba beberapa saat lagi.");
    }
    isScrapingNow = true;
    try {
        console.log('🔍 [Scraper] Starting proactive & reguler scraping process...');

        const { page, isShared } = await getScrapePage();

        // --- 1. SCRAPE REGULER TICKETS ---
        console.log(`🔍 [Scraper] Navigating to Reguler URL: ${regulerBaseUrl}`);
        await page.goto(regulerBaseUrl, { waitUntil: 'networkidle2', timeout: 60000 });
        await new Promise(resolve => setTimeout(resolve, 2000));
        
        // Auto login if guest
        const loggedInReg = await isLoggedIn(page);
        if (!loggedInReg && !(await isLoginPage(page))) {
            console.log('🔐 Session is guest. Navigating to login page...');
            const { loadCredentials } = await import('./auth.js');
            const credentials = loadCredentials();
            if (credentials) {
                await page.goto(credentials.loginUrl || "https://insera-sso.telkom.co.id/jw/web/login", {
                    waitUntil: 'networkidle2',
                    timeout: 45000
                });
                const loginResult = await performAutoLogin(page);
                if (loginResult.success) {
                    await page.goto(regulerBaseUrl, { waitUntil: 'networkidle2', timeout: 60000 });
                }
            }
        }
        if (await isLoginPage(page)) {
            const loginResult = await performAutoLogin(page);
            if (loginResult.success) {
                await new Promise(resolve => setTimeout(resolve, 3000));
                if (await isLoginPage(page)) {
                    await handleTOTPPage(page);
                }
                await page.goto(regulerBaseUrl, { waitUntil: 'networkidle2', timeout: 60000 });
            }
        }

        const htmlReg1 = await page.content();
        let regulerTickets = parseWorkOrders(htmlReg1);
        console.log(`📋 [Scraper] Found ${regulerTickets.length} reguler tickets on page 1`);

        // Check page 2 for reguler if page 1 is full
        if (regulerTickets.length >= 30) {
            try {
                const regulerUrlP2 = regulerBaseUrl.replace('d-5564009-p=1', 'd-5564009-p=2');
                console.log(`📋 [Scraper] Reguler Page 1 full, navigating to Page 2: ${regulerUrlP2}`);
                await page.goto(regulerUrlP2, { waitUntil: 'networkidle2', timeout: 45000 });
                await new Promise(resolve => setTimeout(resolve, 2000));
                const htmlReg2 = await page.content();
                const regulerTicketsP2 = parseWorkOrders(htmlReg2);
                console.log(`📋 [Scraper] Found ${regulerTicketsP2.length} reguler tickets on page 2`);
                regulerTickets = [...regulerTickets, ...regulerTicketsP2];
            } catch (err) {
                console.error('⚠️ Failed to scrape reguler page 2:', err.message);
            }
        }

        // Deduplicate Reguler tickets and keep only customer source
        const seenRegIds = new Set();
        const finalReguler = [];
        for (const wo of regulerTickets) {
            if (!seenRegIds.has(wo.orderId)) {
                seenRegIds.add(wo.orderId);
                if (wo.sourceTicket === 'CUSTOMER') {
                    finalReguler.push(wo);
                }
            }
        }

        // --- 2. SCRAPE PROACTIVE TICKETS (SQM & UNSPEC) ---
        let proactiveTickets = [];
        let pageNum = 1;
        let hasMore = true;

        while (hasMore && pageNum <= 5) {
            const paginatedProactiveUrl = proactiveBaseUrl
                .replace(/d-6878233-p=\d+/, `d-6878233-p=${pageNum}`)
                .replace(/d-6878233-ps=\d+/, 'd-6878233-ps=100');

            console.log(`🔍 [Scraper] Navigating to Proactive URL Page ${pageNum}: ${paginatedProactiveUrl}`);
            await page.goto(paginatedProactiveUrl, { waitUntil: 'networkidle2', timeout: 60000 });
            await new Promise(resolve => setTimeout(resolve, 2000));

            // Check login just in case
            if (await isLoginPage(page)) {
                const loginResult = await performAutoLogin(page);
                if (loginResult.success) {
                    await new Promise(resolve => setTimeout(resolve, 3000));
                    await page.goto(paginatedProactiveUrl, { waitUntil: 'networkidle2', timeout: 60000 });
                }
            }

            const htmlProactive = await page.content();
            const pageTickets = parseWorkOrders(htmlProactive);
            console.log(`📋 [Scraper] Found ${pageTickets.length} proactive tickets on page ${pageNum}`);
            proactiveTickets = [...proactiveTickets, ...pageTickets];

            if (pageTickets.length < 100) {
                hasMore = false;
            } else {
                pageNum++;
            }
        }

        // Deduplicate proactive tickets
        const seenProactiveIds = new Set();
        const finalProactive = [];
        for (const wo of proactiveTickets) {
            if (!seenProactiveIds.has(wo.orderId)) {
                seenProactiveIds.add(wo.orderId);
                finalProactive.push(wo);
            }
        }

        // Filter into SQM (PROACTIVE_TICKET) and UNSPEC (PROACTIVE_OHI)
        const sqmTickets = finalProactive.filter(wo => {
            const repBy = (wo.reportedBy || '').toUpperCase();
            const src = (wo.sourceTicket || '').toUpperCase();
            return repBy.includes('PROACTIVE_TICKET') || src.includes('PROACTIVE_TICKET');
        });

        const unspecTickets = finalProactive.filter(wo => {
            const repBy = (wo.reportedBy || '').toUpperCase();
            const src = (wo.sourceTicket || '').toUpperCase();
            return repBy.includes('PROACTIVE_OHI') || src.includes('PROACTIVE_OHI');
        });

        console.log(`✅ [Scraper] Scraped summary: Reguler=${finalReguler.length}, SQM=${sqmTickets.length}, UNSPEC=${unspecTickets.length}`);
        return {
            reguler: finalReguler,
            sqm: sqmTickets,
            unspec: unspecTickets
        };

    } finally {
        isScrapingNow = false;
    }
}
