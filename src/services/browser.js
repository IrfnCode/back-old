import puppeteer from 'puppeteer';
import path from 'path';
import { fileURLToPath } from 'url';
import { rm } from 'fs/promises';
import { isLoginPage, performAutoLogin, handleTOTPPage } from './auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Browser instance
let browser = null;
let page = null;
let screenshotInterval = null;
let wsClients = new Set();
let autoLoginEnabled = true; // Auto-login flag

// User data directory for session persistence
const userDataDir = path.join(__dirname, '../../browser-data');

/**
 * Initialize browser with persistent session
 */
export async function launchBrowser(url = 'about:blank') {
    if (browser) {
        console.log('⚠️ Browser already running');
        return { success: false, error: 'Browser already running' };
    }

    try {
        console.log('🚀 Launching browser...');

        const isHeadless = process.env.NODE_ENV === 'production' || process.platform === 'linux';
        browser = await puppeteer.launch({
            headless: isHeadless ? 'shell' : false, // Run headless in production/linux to save RAM
            userDataDir: userDataDir, // Persist session/cookies
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--disable-gpu',
                '--disable-features=Vulkan',
                '--disable-gpu-sandbox',
                '--disable-software-rasterizer',
                '--disable-extensions',
                '--no-zygote',
                '--js-flags="--max-old-space-size=256"',
                '--window-size=1280,800'
            ],
            defaultViewport: {
                width: 1280,
                height: 800
            }
        });

        page = await browser.newPage();

        // Navigate to URL if provided
        if (url && url !== 'about:blank') {
            await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });

            // Check if we landed on login page and auto-login if enabled
            if (autoLoginEnabled && await isLoginPage(page)) {
                console.log('🔐 Login page detected, attempting auto-login...');
                const loginResult = await performAutoLogin(page);
                if (loginResult.success) {
                    console.log('✅ Auto-login successful!');

                    // Check for TOTP page after initial login
                    await new Promise(resolve => setTimeout(resolve, 2000));
                    if (await isLoginPage(page)) {
                        console.log('🔐 TOTP page detected, entering code...');
                        await handleTOTPPage(page);
                    }
                } else {
                    console.log('⚠️ Auto-login failed:', loginResult.message);
                }
            }
        }

        // Start screenshot streaming
        startScreenshotStream();

        console.log('✅ Browser launched successfully');
        return { success: true, message: 'Browser launched' };
    } catch (error) {
        console.error('❌ Failed to launch browser:', error.message);
        return { success: false, error: error.message };
    }
}

/**
 * Close browser
 */
export async function closeBrowser() {
    try {
        stopScreenshotStream();

        if (browser) {
            await browser.close();
            browser = null;
            page = null;
            console.log('🛑 Browser closed');
        }

        return { success: true, message: 'Browser closed' };
    } catch (error) {
        console.error('❌ Failed to close browser:', error.message);
        return { success: false, error: error.message };
    }
}

/**
 * Navigate to URL
 */
export async function navigate(url) {
    if (!page) {
        return { success: false, error: 'Browser not running' };
    }

    try {
        await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });

        // Check if we landed on login page and auto-login if enabled
        if (autoLoginEnabled && await isLoginPage(page)) {
            console.log('🔐 Login page detected during navigation, attempting auto-login...');
            const loginResult = await performAutoLogin(page);
            if (loginResult.success) {
                console.log('✅ Auto-login successful!');

                // Check for TOTP page after initial login
                await new Promise(resolve => setTimeout(resolve, 2000));
                if (await isLoginPage(page)) {
                    console.log('🔐 TOTP page detected, entering code...');
                    await handleTOTPPage(page);
                }
            }
        }

        return { success: true, message: `Navigated to ${url}` };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

/**
 * Click at coordinates
 */
export async function click(x, y) {
    if (!page) {
        return { success: false, error: 'Browser not running' };
    }

    try {
        await page.mouse.click(x, y);
        return { success: true, message: `Clicked at (${x}, ${y})` };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

/**
 * Type text
 */
export async function type(text) {
    if (!page) {
        return { success: false, error: 'Browser not running' };
    }

    try {
        await page.keyboard.type(text);
        return { success: true, message: 'Text typed' };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

/**
 * Press key (Enter, Tab, Backspace, etc)
 */
export async function pressKey(key) {
    if (!page) {
        return { success: false, error: 'Browser not running' };
    }

    try {
        await page.keyboard.press(key);
        return { success: true, message: `Key pressed: ${key}` };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

/**
 * Get single screenshot (Disabled to save CPU)
 */
export async function getScreenshot() {
    return null;
}

/**
 * Start screenshot streaming (Disabled)
 */
function startScreenshotStream() {
    // Disabled to save CPU
}

/**
 * Stop screenshot streaming (Disabled)
 */
function stopScreenshotStream() {
    // Disabled to save CPU
}

/**
 * Add WebSocket client
 */
export function addWsClient(ws) {
    wsClients.add(ws);
    console.log(`📡 WebSocket client connected. Total: ${wsClients.size}`);
}

/**
 * Remove WebSocket client
 */
export function removeWsClient(ws) {
    wsClients.delete(ws);
    console.log(`📡 WebSocket client disconnected. Total: ${wsClients.size}`);
}

/**
 * Get browser status
 */
export function getBrowserStatus() {
    return {
        isRunning: browser !== null,
        currentUrl: page ? page.url() : null,
        clientCount: wsClients.size
    };
}

/**
 * Get current page URL
 */
export async function getCurrentUrl() {
    if (!page) {
        return null;
    }
    return page.url();
}

/**
 * Get the current browser instance (for scraper to use)
 */
export function getBrowserInstance() {
    return browser;
}

/**
 * Get the current page instance (for scraper to use)
 */
export function getPageInstance() {
    return page;
}

/**
 * Get user data dir path
 */
export function getUserDataDir() {
    return userDataDir;
}

/**
 * Enable or disable auto-login
 */
export function setAutoLogin(enabled) {
    autoLoginEnabled = enabled;
    console.log(`🔐 Auto-login ${enabled ? 'enabled' : 'disabled'}`);
}

/**
 * Get auto-login status
 */
export function isAutoLoginEnabled() {
    return autoLoginEnabled;
}

/**
 * Trigger auto-login on current page (manual trigger)
 */
export async function triggerAutoLogin() {
    if (!page) {
        return { success: false, error: 'Browser not running' };
    }

    try {
        console.log('🔐 Manual auto-login triggered...');
        const loginResult = await performAutoLogin(page);

        if (loginResult.success) {
            // Check for TOTP page after initial login
            await new Promise(resolve => setTimeout(resolve, 2000));
            if (await isLoginPage(page)) {
                console.log('🔐 TOTP page detected, entering code...');
                await handleTOTPPage(page);
            }
        }

        return loginResult;
    } catch (error) {
        return { success: false, error: error.message };
    }
}

/**
 * Clear browser cache by removing user data directory
 */
export async function clearBrowserCache() {
    try {
        await closeBrowser();
        // Wait for file locks to release
        await new Promise(r => setTimeout(r, 1000));

        console.log(`🧹 Clearing browser cache at: ${userDataDir}`);
        await rm(userDataDir, { recursive: true, force: true });
        console.log('✅ Browser cache cleared');

        return { success: true, message: 'Browser cache cleared successfully' };
    } catch (error) {
        console.error('❌ Failed to clear browser cache:', error.message);
        return { success: false, error: error.message };
    }
}
