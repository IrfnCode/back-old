import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { initDatabase, getConfig, saveConfig, getAllWorkOrders, addWorkOrder, clearOldWorkOrders, updateWorkOrder, deleteWorkOrder, getWorkOrderById, deleteAllWorkOrders, workOrderExists, getWorkOrderByOrderId, getWorkOrdersByServiceNo, updateWorkOrderStatus, getAllTeams, getTeamById, createTeam, updateTeam, deleteTeam, addTeamMember, updateTeamMember, deleteTeamMember, getTeamMembers, getAllRekap, getRekapById, addRekap, getAllDatekRekap, getAllPsbRekap, updateRekap, deleteRekap, getAllTelegramChats, getChatByUsername, syncRekapToWorkOrders, getGroupMembers, getAllGroupMembers, clearGroupMembers, getScheduleStatuses, upsertScheduleStatus, deleteScheduleStatus, getScheduleEntriesWithStatus, getScheduleNames, getPerformanceConfig, savePerformanceConfig, getPerformanceStats, getRekapByReportedBy, getPerformanceSummary, getAllTeamMembers, getWorkersForDate, updateWorkOrderCoordinates, getOpenWorkOrdersWithCoords } from './services/database.js';
import * as XLSX from 'xlsx';
import { startScraping, stopScraping, scrapeOnce, formatWorkOrderMessage, calculateExpiredDate, isScrapingRunning } from './services/scraper.js';
import { initTelegramBots, sendTestMessage, sendWorkOrderNotification, sendFormattedMessage, broadcastPerformance } from './services/telegram.js';
import {
  launchBrowser,
  closeBrowser,
  navigate,
  click,
  type,
  pressKey,
  getScreenshot,
  getBrowserStatus,
  addWsClient,
  removeWsClient,
  triggerAutoLogin,
  clearBrowserCache,
  setAutoLogin,
  isAutoLoginEnabled
} from './services/browser.js';
import { testConnection as testGdocsConnection, exportToSheets, syncRekapToSheets, syncDatekToExternal, syncDatekFromExternal } from './services/gdocs.js';
import { formatToWIB } from './utils/time.js';
import {
  parseAndSaveSchedule,
  getScheduleMappings,
  updateScheduleMapping,
  updateScheduleEntry,
  getTodayWorkers,
  getWorkersToTag,
  sendWorkOrderWithRotation,
  startAutoSend,
  stopAutoSend,
  isAutoSendRunning,
  getAllTeamMembersForMapping,
  getTodaySchedulePreview,
  clearAllSchedule
} from './services/schedule.js';
import multer from 'multer';
import os from 'os';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { initDailySync, syncClosedTickets } from './services/dailySync.js';
import { sendDailyReport, initDailyReport, restartDailyReport, stopDailyReport } from './services/dailyReport.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.SERVER_PORT || process.env.PORT || 3333;

// CORS configuration - allow multiple origins
const allowedOrigins = process.env.CORS_ORIGINS
  ? process.env.CORS_ORIGINS.split(',').map(o => o.trim())
  : ['http://localhost:4321', 'http://localhost:3000'];

// Middleware
app.use(cors({
  origin: function (origin, callback) {
    // Allow requests with no origin (mobile apps, curl, etc.)
    if (!origin) return callback(null, true);

    // Allow all localhost and vercel/cloudflare domains
    if (
      allowedOrigins.includes(origin) ||
      origin.includes('localhost') ||
      origin.includes('vercel.app') ||
      origin.includes('trycloudflare.com') ||
      origin.includes('irfncode.my.id') ||
      origin.includes('172.0.0.0')
    ) {
      return callback(null, true);
    }

    callback(new Error('Not allowed by CORS'));
  },
  credentials: true
}));
app.use(express.json());

// Initialize database
initDatabase();

// SSE clients for real-time updates
let sseClients = [];

// Send event to all SSE clients
function broadcastToClients(data) {
  sseClients.forEach(client => {
    client.write(`data: ${JSON.stringify(data)} \n\n`);
  });
}

// =========================
// API Routes
// =========================

// AI Database Query Endpoint (for Cloudflare Worker)
app.post('/api/ai/query', (req, res) => {
  try {
    const { sql } = req.body;
    const authHeader = req.headers.authorization;
    const secret = process.env.BRIDGE_SECRET;

    if (!secret) {
      console.warn("⚠️ BRIDGE_SECRET is not configured in .env!");
      return res.status(500).json({ error: "Server misconfiguration: BRIDGE_SECRET not set." });
    }

    if (!authHeader || authHeader !== `Bearer ${secret}`) {
      return res.status(401).json({ error: "Unauthorized access to AI bridge." });
    }

    // Security: Only allow SELECT
    const cleanSql = sql.trim().toUpperCase();
    if (!cleanSql.startsWith('SELECT')) {
      return res.status(403).json({ error: "Only SELECT queries are allowed." });
    }

    // Execute query using the existing db instance
    // Assuming initDatabase exported the db instance, or we can use better-sqlite3 directly here
    // For safety, we'll re-import or use a helper if available. 
    // Since we don't have direct access to the `db` variable from database.js here without modifying it,
    // we'll quickly spin up a read-only connection here for AI just like the separate bridge did.
    const Database = require('better-sqlite3');
    const dbPath = path.join(__dirname, '../data/database.sqlite');
    const aiDb = new Database(dbPath, { readonly: true });

    const stmt = aiDb.prepare(sql);
    const results = stmt.all();
    aiDb.close();

    res.json(results);
  } catch (error) {
    console.error("AI Bridge Error:", error.message);
    res.status(500).json({ error: error.message });
  }
});

// Get current configuration
app.get('/api/config', (req, res) => {
  try {
    const config = getConfig();
    res.json(config);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Save generic config (multiple keys)
app.post('/api/config', (req, res) => {
  try {
    const configData = req.body;

    // Save each key-value pair
    Object.keys(configData).forEach(key => {
      saveConfig(key, configData[key]);
    });

    res.json({ success: true, message: 'Configuration saved' });

    // Trigger restarts if specific services are affected
    if (configData.dailyReportEnabled !== undefined || configData.dailyReportInterval !== undefined) {
      restartDailyReport();
    }
    if (configData.dailySyncEnabled !== undefined || configData.dailySyncInterval !== undefined) {
      initDailySync();
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Daily Report & Sync Config
app.get('/api/daily-report/config', (req, res) => {
  try {
    const config = getConfig();
    res.json({
      syncApiUrl: config.syncApiUrl || 'https://insera.irfncode.my.id/api/reports/closed-tickets',
      dailySyncInterval: config.dailySyncInterval || '30',
      dailySyncEnabled: config.dailySyncEnabled === 'true',
      manualInputLogic: config.manualInputLogic !== 'false', // default true
      dailyReportInterval: config.dailyReportInterval || '0',
      dailyReportEnabled: config.dailyReportEnabled === 'true'
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/daily-report/manual-sync', async (req, res) => {
  try {
    const result = await syncClosedTickets(true); // true = isManual
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/daily-report/manual-send', async (req, res) => {
  try {
    const result = await sendDailyReport();
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Save scraper configuration
app.post('/api/config/scraper', (req, res) => {
  try {
    const { targetUrl, frequency, filterDateFrom, filterDateTo, filterWorkzone, filterStatus, filterPageSize, autoShiftDates } = req.body;

    // If autoShiftDates is enabled, perform an immediate shift calculation before saving
    let finalFrom = filterDateFrom;
    let finalTo = filterDateTo;

    if (autoShiftDates === 'true' && filterDateTo) {
      try {
        const nowWib = new Date(new Date().getTime() + (new Date().getTimezoneOffset() * 60000) + (7 * 3600000));
        const configTo = new Date(filterDateTo.replace('T', ' '));
        const configFrom = new Date(filterDateFrom.replace('T', ' '));
        const targetTo = new Date(nowWib);
        targetTo.setHours(23, 0, 0, 0);

        if (targetTo.getTime() > configTo.getTime()) {
          const daysDiff = Math.floor((targetTo.getTime() - configTo.getTime()) / (24 * 60 * 60 * 1000));
          if (daysDiff > 0) {
            const newTo = new Date(configTo);
            newTo.setDate(configTo.getDate() + daysDiff);
            const newFrom = new Date(configFrom);
            newFrom.setDate(configFrom.getDate() + daysDiff);
            
            // Format to YYYY-MM-DD HH:mm:ss then to T format
            const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jakarta', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
            finalTo = formatter.format(newTo).replace(', ', 'T').slice(0, 16);
            finalFrom = formatter.format(newFrom).replace(', ', 'T').slice(0, 16);
          }
        }
      } catch (err) {
        console.error('Immediate shift error:', err.message);
      }
    }

    saveConfig('targetUrl', targetUrl);
    saveConfig('frequency', frequency);
    saveConfig('filterDateFrom', finalFrom);
    saveConfig('filterDateTo', finalTo);
    saveConfig('filterWorkzone', filterWorkzone);
    saveConfig('filterStatus', filterStatus);
    saveConfig('filterPageSize', filterPageSize);
    saveConfig('autoShiftDates', autoShiftDates);
    res.json({ success: true, message: 'Scraper configuration saved', shifted: finalTo !== filterDateTo });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Save Telegram configuration
app.post('/api/config/telegram', (req, res) => {
  try {
    const { botToken, chatId, datekBotToken, datekChatId } = req.body;
    saveConfig('telegramBotToken', botToken);
    saveConfig('telegramChatId', chatId);
    saveConfig('datekBotToken', datekBotToken);
    saveConfig('datekChatId', datekChatId);

    // Re-initialize bots
    initTelegramBots(botToken, datekBotToken);

    res.json({ success: true, message: 'Telegram configuration saved' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Test Telegram Bot
app.post('/api/telegram/test', async (req, res) => {
  try {
    const { type } = req.body; // 'gangguan' or 'datek'
    const config = getConfig();

    // Select chat ID based on type, fallback to main chatId if datekChatId not set
    let chatId = type === 'datek' ? (config.datekChatId || process.env.DATEK_CHAT_ID) : (config.telegramChatId || process.env.TELEGRAM_CHAT_ID);
    if (type === 'datek' && !chatId) chatId = config.telegramChatId || process.env.TELEGRAM_CHAT_ID;

    if (!chatId) {
      return res.status(400).json({ error: `Chat ID not configured for ${type}` });
    }

    await sendTestMessage(chatId, type);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get all known telegram chats
app.get('/api/telegram/chats', (req, res) => {
  try {
    const chats = getAllTelegramChats();
    res.json(chats);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// =========================
// Group Members API Routes
// =========================

// Get all group members (optionally filter by chat_id)
app.get('/api/group-members', (req, res) => {
  try {
    const { chatId } = req.query;
    if (chatId) {
      const members = getGroupMembers(chatId);
      res.json(members);
    } else {
      const members = getAllGroupMembers();
      res.json(members);
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Clear group members for a specific chat
app.delete('/api/group-members/:chatId', (req, res) => {
  try {
    const deletedCount = clearGroupMembers(req.params.chatId);
    res.json({ success: true, deleted: deletedCount });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Send message to specific chat (supports chat_id or @username)
app.post('/api/telegram/send', async (req, res) => {
  try {
    let { chatId, message } = req.body;

    if (!chatId || !message) {
      return res.status(400).json({ error: 'chatId and message are required' });
    }

    // Handle @username format - try to lookup from database first
    if (typeof chatId === 'string' && !chatId.startsWith('-') && !chatId.match(/^-?\d+$/)) {
      // It looks like a username, try to find in database
      const username = chatId.startsWith('@') ? chatId.substring(1) : chatId;
      const chat = getChatByUsername(username);

      if (chat) {
        // Found in database, use the chat_id
        chatId = chat.chat_id;
        console.log(`📨 Resolved @${username} to chat_id: ${chatId} `);
      } else {
        // Not found in database, try as public channel/group
        chatId = chatId.startsWith('@') ? chatId : '@' + chatId;
        console.log(`📨 Username @${username} not in database, trying as public chat`);
      }
    }

    await sendFormattedMessage(chatId, message);
    res.json({ success: true, message: 'Message sent' });
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

// Get all work orders
app.get('/api/workorders', (req, res) => {
  try {
    const workOrders = getAllWorkOrders();
    res.json(workOrders);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Create new work order manually
app.post('/api/workorders', (req, res) => {
  try {
    const { orderId, summary, customerType, workzone, customerSegment, reportedDate, team } = req.body;

    if (!orderId || !summary) {
      return res.status(400).json({ error: 'Order ID and Summary are required' });
    }

    // Calculate expired date based on reported date and customer type
    const expiredDate = calculateExpiredDate(reportedDate, customerType);

    const workOrder = {
      orderId,
      title: summary.substring(0, 100),
      summary,
      description: summary.substring(0, 200),
      customerType: customerType || 'REGULER',
      customerSegment: customerSegment || null,
      workzone: workzone || null,
      reportedDate: reportedDate || new Date().toISOString(),
      expiredDate,
      team: team || null,
      status: 'OPEN',
      priority: 'Normal',
      source: 'Manual'
    };

    addWorkOrder(workOrder);
    broadcastToClients({ type: 'new_workorder', data: workOrder });

    res.json({ success: true, message: 'Work order created', data: workOrder });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// (Moved to bottom of file with Auto-Send logic)

// Start auto-scraping
app.post('/api/scrape/start', (req, res) => {
  try {
    const config = getConfig();
    if (!config.targetUrl) {
      return res.status(400).json({ error: 'Target URL not configured' });
    }

    // Minimum 2 minutes interval to avoid spam
    const intervalMs = config.frequency === '2m' ? 120000 :
      config.frequency === '5m' ? 300000 :
        config.frequency === '15m' ? 900000 :
          config.frequency === '1h' ? 3600000 : 120000; // Default to 2 minutes

    console.log(`⏱️ Auto - scrape interval set to: ${intervalMs / 1000} seconds`);

    startScraping(config.targetUrl, intervalMs, async (workOrder) => {
      // Check if work order already exists
      if (workOrderExists(workOrder.orderId)) {
        console.log(`⏭️ Skipping duplicate in auto - scrape: ${workOrder.orderId} `);
        return;
      }

      // Add to database
      addWorkOrder(workOrder);
      broadcastToClients({ type: 'new_workorder', data: workOrder });

      // Auto-send if enabled
      if (isAutoSendRunning()) {
        try {
          await sendWorkOrderWithRotation(workOrder);
        } catch (error) {
          console.error('❌ Auto-send error:', error.message);
        }
      }
    });

    res.json({ success: true, message: 'Auto-scraping started' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Stop auto-scraping
app.post('/api/scrape/stop', (req, res) => {
  try {
    stopScraping();
    res.json({ success: true, message: 'Auto-scraping stopped' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Test Telegram message
app.post('/api/telegram/test', async (req, res) => {
  try {
    const config = getConfig();
    if (!config.telegramBotToken || !config.telegramChatId) {
      return res.status(400).json({ error: 'Telegram not configured' });
    }

    await sendTestMessage(config.telegramChatId);
    res.json({ success: true, message: 'Test message sent' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// SSE endpoint for real-time updates
app.get('/api/workorders/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');

  // Send initial data
  const workOrders = getAllWorkOrders();
  res.write(`data: ${JSON.stringify({ type: 'init', data: workOrders })} \n\n`);

  // Add client to list
  sseClients.push(res);

  // Remove client on close
  req.on('close', () => {
    sseClients = sseClients.filter(client => client !== res);
  });
});

// Clear old work orders
app.delete('/api/workorders/old', (req, res) => {
  try {
    clearOldWorkOrders();
    res.json({ success: true, message: 'Old work orders cleared' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: formatToWIB(),
    uptime: process.uptime()
  });
});

// =========================
// System Monitoring Routes
// =========================

// Get system stats (CPU, RAM, etc.)
app.get('/api/system/stats', async (req, res) => {
  try {
    const cpus = os.cpus();
    const totalMemory = os.totalmem();
    const freeMemory = os.freemem();
    const usedMemory = totalMemory - freeMemory;

    // Calculate CPU usage
    const cpuUsage = await getCpuUsage();

    // Get load average (Unix only, returns [0,0,0] on Windows)
    const loadAvg = os.loadavg();

    // System info
    const systemInfo = {
      hostname: os.hostname(),
      platform: os.platform(),
      arch: os.arch(),
      release: os.release(),
      nodeVersion: process.version,
      pid: process.pid
    };

    // Memory info
    const memoryInfo = {
      total: totalMemory,
      used: usedMemory,
      free: freeMemory,
      usedPercent: Math.round((usedMemory / totalMemory) * 100 * 100) / 100
    };

    // CPU info
    const cpuInfo = {
      model: cpus[0]?.model || 'Unknown',
      cores: cpus.length,
      usage: cpuUsage,
      loadAvg: {
        '1min': loadAvg[0],
        '5min': loadAvg[1],
        '15min': loadAvg[2]
      }
    };

    // Process info
    const processInfo = {
      uptime: process.uptime(),
      memoryUsage: process.memoryUsage(),
      cpuUsage: process.cpuUsage()
    };

    // Network interfaces
    const networkInterfaces = os.networkInterfaces();
    const networks = [];
    for (const [name, interfaces] of Object.entries(networkInterfaces)) {
      for (const iface of interfaces) {
        if (!iface.internal && iface.family === 'IPv4') {
          networks.push({
            name,
            address: iface.address,
            netmask: iface.netmask
          });
        }
      }
    }

    res.json({
      timestamp: formatToWIB(),
      system: systemInfo,
      memory: memoryInfo,
      cpu: cpuInfo,
      process: processInfo,
      network: networks
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Helper function to calculate CPU usage
async function getCpuUsage() {
  return new Promise((resolve) => {
    const cpus1 = os.cpus();

    setTimeout(() => {
      const cpus2 = os.cpus();
      let totalIdle = 0;
      let totalTick = 0;

      for (let i = 0; i < cpus1.length; i++) {
        const cpu1 = cpus1[i];
        const cpu2 = cpus2[i];

        const idle1 = cpu1.times.idle;
        const idle2 = cpu2.times.idle;

        const total1 = cpu1.times.user + cpu1.times.nice + cpu1.times.sys + cpu1.times.idle + cpu1.times.irq;
        const total2 = cpu2.times.user + cpu2.times.nice + cpu2.times.sys + cpu2.times.idle + cpu2.times.irq;

        totalIdle += (idle2 - idle1);
        totalTick += (total2 - total1);
      }

      const usage = totalTick > 0 ? Math.round((1 - totalIdle / totalTick) * 100 * 100) / 100 : 0;
      resolve(usage);
    }, 100);
  });
}

// Get PM2 logs

app.get('/api/system/logs', async (req, res) => {
  try {
    const { lines = 100, type = 'all' } = req.query;
    const numLines = Math.min(parseInt(lines) || 100, 500); // Max 500 lines

    // PM2 log paths - adjust based on your app name
    const homeDir = os.homedir();
    const pm2LogDir = path.join(homeDir, '.pm2', 'logs');

    // Try common app names
    const appNames = ['backend-api', 'backend', 'app', 'index'];
    let outLogPath = null;
    let errLogPath = null;

    // Find log files
    for (const appName of appNames) {
      const outPath = path.join(pm2LogDir, `${appName} -out.log`);
      const errPath = path.join(pm2LogDir, `${appName} -error.log`);

      if (fs.existsSync(outPath)) {
        outLogPath = outPath;
        errLogPath = errPath;
        break;
      }
    }

    // If not found, try to list available logs
    let availableLogs = [];
    if (fs.existsSync(pm2LogDir)) {
      availableLogs = fs.readdirSync(pm2LogDir).filter(f => f.endsWith('.log'));

      // Auto-detect from available logs
      if (!outLogPath && availableLogs.length > 0) {
        const outLog = availableLogs.find(f => f.endsWith('-out.log'));
        const errLog = availableLogs.find(f => f.endsWith('-error.log'));
        if (outLog) outLogPath = path.join(pm2LogDir, outLog);
        if (errLog) errLogPath = path.join(pm2LogDir, errLog);
      }
    }

    // Read last N lines from a file
    const readLastLines = (filePath, n) => {
      if (!filePath || !fs.existsSync(filePath)) {
        return [];
      }

      try {
        const content = fs.readFileSync(filePath, 'utf-8');
        const allLines = content.split('\n').filter(line => line.trim());
        return allLines.slice(-n);
      } catch (err) {
        console.error(`Error reading log file ${filePath}: `, err.message);
        return [];
      }
    };

    const result = {
      timestamp: formatToWIB(),
      logDir: pm2LogDir,
      availableLogs,
      logs: {}
    };

    if (type === 'all' || type === 'out') {
      result.logs.out = {
        path: outLogPath,
        lines: readLastLines(outLogPath, numLines)
      };
    }

    if (type === 'all' || type === 'error') {
      result.logs.error = {
        path: errLogPath,
        lines: readLastLines(errLogPath, numLines)
      };
    }

    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get scraper status
app.get('/api/scrape/status', (req, res) => {
  try {
    const isActive = isScrapingRunning();
    res.json({
      active: isActive,
      uptime: isActive ? process.uptime() : 0
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Delete all work orders
app.delete('/api/workorders/all', (req, res) => {
  try {
    const deletedCount = deleteAllWorkOrders();
    broadcastToClients({ type: 'delete_all_workorders' });
    res.json({ success: true, message: `Deleted ${deletedCount} work orders`, count: deletedCount });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Export work orders to XLSX
app.get('/api/workorders/export', (req, res) => {
  try {
    const workOrders = getAllWorkOrders();

    // Transform data for export
    const exportData = workOrders.map(wo => ({
      'NO INC': wo.order_id,
      'TTR Customer': wo.ttr_customer || '',
      'Summary': wo.summary || wo.title,
      'Customer Type': wo.customer_type,
      'Customer Segment': wo.customer_segment || '',
      'Workzone': wo.workzone,
      'Reported Date': wo.reported_date,
      'Expired Date': wo.expired_date,
      'Status': wo.status,
      'Team': wo.team || '',
      'Witel': wo.witel || ''
    }));

    // Create workbook and worksheet
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.json_to_sheet(exportData);

    // Set column widths
    ws['!cols'] = [
      { wch: 15 },  // NO INC
      { wch: 12 },  // TTR Customer
      { wch: 50 },  // Summary
      { wch: 15 },  // Customer Type
      { wch: 15 },  // Customer Segment
      { wch: 15 },  // Workzone
      { wch: 20 },  // Reported Date
      { wch: 20 },  // Expired Date
      { wch: 10 },  // Status
      { wch: 15 },  // Team
      { wch: 15 },  // Witel
    ];

    XLSX.utils.book_append_sheet(wb, ws, 'Work Orders');

    // Generate buffer
    const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

    // Send file
    const filename = `workorders_${new Date().toISOString().split('T')[0]}.xlsx`;
    res.setHeader('Content-Disposition', `attachment; filename = "${filename}"`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buffer);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// =========================
// Workorder CRUD Routes
// =========================

// Get single work order
app.get('/api/workorders/:id', (req, res) => {
  try {
    const workOrder = getWorkOrderById(req.params.id);
    if (!workOrder) {
      return res.status(404).json({ error: 'Work order not found' });
    }
    res.json(workOrder);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Update work order
app.put('/api/workorders/:id', (req, res) => {
  try {
    const updated = updateWorkOrder(req.params.id, req.body);
    if (!updated) {
      return res.status(404).json({ error: 'Work order not found or no valid fields provided' });
    }

    const workOrder = getWorkOrderById(req.params.id);
    broadcastToClients({ type: 'update_workorder', data: workOrder });

    res.json({ success: true, message: 'Work order updated', data: workOrder });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Delete work order
app.delete('/api/workorders/:id', (req, res) => {
  try {
    const deleted = deleteWorkOrder(req.params.id);
    if (!deleted) {
      return res.status(404).json({ error: 'Work order not found' });
    }

    broadcastToClients({ type: 'delete_workorder', data: { id: req.params.id } });

    res.json({ success: true, message: 'Work order deleted' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Send work order to Telegram manually
app.post('/api/workorders/:id/send', async (req, res) => {
  try {
    const config = getConfig();
    if (!config.telegramBotToken || !config.telegramChatId) {
      return res.status(400).json({ error: 'Telegram not configured' });
    }

    const workOrder = getWorkOrderById(req.params.id);
    if (!workOrder) {
      return res.status(404).json({ error: 'Work order not found' });
    }

    // Get team members to tag if teamId is provided
    let teamMembers = [];
    if (req.body.teamId) {
      teamMembers = getTeamMembers(req.body.teamId);
    }

    // Format and send message
    // If we have team members, we append their usernames
    // Format and send message
    // If we have team members, we append their usernames
    let extraFooter = '';

    if (teamMembers.length > 0) {
      const mentions = teamMembers
        .filter(m => m.telegram_username)
        .map(m => {
          let username = m.telegram_username.startsWith('@') ? m.telegram_username : `@${m.telegram_username} `;
          // Only escape characters that definitely break markdown v1 structure in usernames
          // Telegram usernames are alphanumeric + underscore, so we should allow underscores.
          return username;
        })
        .join(' ');

      if (mentions) {
        extraFooter = mentions;
      }
    }

    await sendWorkOrderNotification(config.telegramChatId, workOrder, extraFooter);

    res.json({ success: true, message: 'Work order sent to Telegram' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// =========================
// Team Management Routes
// =========================

// Get all teams
app.get('/api/teams', (req, res) => {
  try {
    const teams = getAllTeams();
    res.json(teams);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get team by id
app.get('/api/teams/:id', (req, res) => {
  try {
    const team = getTeamById(req.params.id);
    if (!team) {
      return res.status(404).json({ error: 'Team not found' });
    }
    res.json(team);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Create team
app.post('/api/teams', (req, res) => {
  try {
    const { name } = req.body;
    if (!name) {
      return res.status(400).json({ error: 'Team name is required' });
    }
    const team = createTeam(name);
    res.json(team);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Update team
app.put('/api/teams/:id', (req, res) => {
  try {
    const { name } = req.body;
    if (!name) {
      return res.status(400).json({ error: 'Team name is required' });
    }
    const updated = updateTeam(req.params.id, name);
    if (!updated) {
      return res.status(404).json({ error: 'Team not found' });
    }
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Delete team
app.delete('/api/teams/:id', (req, res) => {
  try {
    const deleted = deleteTeam(req.params.id);
    if (!deleted) {
      return res.status(404).json({ error: 'Team not found' });
    }
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// =========================
// Team Member Routes
// =========================

// Add team member
app.post('/api/teams/:id/members', (req, res) => {
  try {
    const { name, telegramUsername, nik, fullName } = req.body;
    if (!name) {
      return res.status(400).json({ error: 'Name is required' });
    }
    const member = addTeamMember(req.params.id, name, telegramUsername, nik, fullName);
    res.json(member);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Update team member
app.put('/api/members/:id', (req, res) => {
  try {
    const { name, telegramUsername, nik, fullName } = req.body;
    if (!name) {
      return res.status(400).json({ error: 'Name is required' });
    }
    const updated = updateTeamMember(req.params.id, name, telegramUsername, nik, fullName);
    if (!updated) {
      return res.status(404).json({ error: 'Member not found' });
    }
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Delete team member
app.delete('/api/members/:id', (req, res) => {
  try {
    const deleted = deleteTeamMember(req.params.id);
    if (!deleted) {
      return res.status(404).json({ error: 'Member not found' });
    }
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// =========================
// Technician WO Map API
// =========================

// Get open work orders for technician map
app.get('/api/wo/list', (req, res) => {
  try {
    const workOrders = getOpenWorkOrdersWithCoords();
    res.json(workOrders);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Update work order coordinates
app.put('/api/workorders/:id/coordinates', (req, res) => {
  try {
    const { latitude, longitude, street_address } = req.body;
    const wo = getWorkOrderById(req.params.id);
    if (!wo) return res.status(404).json({ error: 'Work order not found' });

    updateWorkOrderCoordinates(wo.order_id, latitude, longitude, street_address || null);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// =========================
// Performance API Routes
// =========================

// Get performance summary (aggregated totals per technician)
app.get('/api/performance', (req, res) => {
  try {
    const { startDate, endDate, tipeTicket } = req.query;
    const tipeArr = tipeTicket ? tipeTicket.split(',').map(c => c.trim().toUpperCase()).filter(Boolean) : null;
    const stats = getPerformanceSummary(startDate || null, endDate || null, tipeArr);
    const config = getPerformanceConfig();
    res.json({ data: stats, config });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get performance stats (detailed, with period grouping)
app.get('/api/performance/stats', (req, res) => {
  try {
    const { startDate, endDate, period, tipeTicket } = req.query;
    const tipeArr = tipeTicket ? tipeTicket.split(',').map(c => c.trim().toUpperCase()).filter(Boolean) : null;
    const stats = getPerformanceStats(startDate || null, endDate || null, period || 'daily', tipeArr);
    const config = getPerformanceConfig();
    res.json({ data: stats, config });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get tickets closed by a specific technician (drill-down)
app.get('/api/performance/:name/tickets', (req, res) => {
  try {
    const { startDate, endDate, tipeTicket } = req.query;
    const tipeArr = tipeTicket ? tipeTicket.split(',').map(c => c.trim().toUpperCase()).filter(Boolean) : null;
    const tickets = getRekapByReportedBy(req.params.name, startDate || null, endDate || null, tipeArr);
    res.json(tickets);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get performance config
app.get('/api/performance/config', (req, res) => {
  try {
    const config = getPerformanceConfig();
    res.json(config);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Save performance config
app.post('/api/performance/config', (req, res) => {
  try {
    const { minClosePerDay, minClosePerMonth, minClosePerYear } = req.body;

    // Validate inputs if provided
    if (minClosePerDay !== undefined && minClosePerDay < 0) return res.status(400).json({ error: 'minClosePerDay must be positive' });
    if (minClosePerMonth !== undefined && minClosePerMonth < 0) return res.status(400).json({ error: 'minClosePerMonth must be positive' });
    if (minClosePerYear !== undefined && minClosePerYear < 0) return res.status(400).json({ error: 'minClosePerYear must be positive' });

    const config = savePerformanceConfig(
      minClosePerDay !== undefined ? parseInt(minClosePerDay) : undefined,
      minClosePerMonth !== undefined ? parseInt(minClosePerMonth) : undefined,
      minClosePerYear !== undefined ? parseInt(minClosePerYear) : undefined
    );
    res.json({ success: true, config });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Export performance data to Excel
app.get('/api/performance/export', (req, res) => {
  try {
    const { startDate, endDate, period, tipeTicket } = req.query;
    const tipeArr = tipeTicket ? tipeTicket.split(',').map(c => c.trim().toUpperCase()).filter(Boolean) : null;
    const stats = getPerformanceStats(startDate || null, endDate || null, period || 'daily', tipeArr);

    // Aggregate totals per technician
    const techTotals = new Map();
    stats.forEach(item => {
      const name = item.reported_by;
      if (!techTotals.has(name)) {
        techTotals.set(name, {
          name,
          full_name: item.full_name,
          workzone: item.workzone,
          team_name: item.team_name,
          total: 0
        });
      }
      techTotals.get(name).total += item.total_close;
    });

    const sorted = Array.from(techTotals.values()).sort((a, b) => b.total - a.total);

    // Sheet 1: Summary
    const summaryData = sorted.map((tech, idx) => ({
      'No': idx + 1,
      'Nama Teknisi': tech.full_name || tech.name,
      'Reported By': tech.name,
      'Workzone': tech.workzone || '-',
      'Team': tech.team_name || '-',
      'Total Closed': tech.total
    }));

    const wb = XLSX.utils.book_new();
    const wsSummary = XLSX.utils.json_to_sheet(summaryData);
    wsSummary['!cols'] = [
      { wch: 5 },   // No
      { wch: 25 },  // Nama Teknisi
      { wch: 20 },  // Reported By
      { wch: 12 },  // Workzone
      { wch: 15 },  // Team
      { wch: 12 },  // Total Closed
    ];
    XLSX.utils.book_append_sheet(wb, wsSummary, 'Ringkasan');

    // Sheet 2: Detail Tiket (all tickets per technician)
    const detailRows = [];
    let ticketNo = 1;
    for (const tech of sorted) {
      const tickets = getRekapByReportedBy(tech.name, startDate || null, endDate || null, tipeArr);
      tickets.forEach(t => {
        detailRows.push({
          'No': ticketNo++,
          'Teknisi': tech.full_name || tech.name,
          'NO INC': t.no_inc || '-',
          'NO INET': t.no_inet || '-',
          'RCA': t.rca || '-',
          'Keterangan': t.keterangan || '-',
          'Alamat': t.alamat || '-',
          'Kategori': t.category || 'REGULER',
          'Tipe Tiket': t.tipe_tiket || '-',
          'ODP': t.odp || '-',
          'Waktu Input': t.input_at || '-'
        });
      });
    }

    const wsDetail = XLSX.utils.json_to_sheet(detailRows);
    wsDetail['!cols'] = [
      { wch: 5 },   // No
      { wch: 22 },  // Teknisi
      { wch: 18 },  // NO INC
      { wch: 18 },  // NO INET
      { wch: 20 },  // RCA
      { wch: 30 },  // Keterangan
      { wch: 30 },  // Alamat
      { wch: 12 },  // Kategori
      { wch: 12 },  // Tipe Tiket
      { wch: 15 },  // ODP
      { wch: 20 },  // Waktu Input
    ];
    XLSX.utils.book_append_sheet(wb, wsDetail, 'Detail Tiket');

    const catLabel = tipeArr ? tipeArr.join('_') : 'ALL';
    const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    const filename = `performance_${catLabel}_${startDate || 'all'}_${endDate || 'all'}.xlsx`;
    res.setHeader('Content-Disposition', `attachment; filename = "${filename}"`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buffer);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get all team members (for performance page dropdown/list)
app.get('/api/members', (req, res) => {
  try {
    const members = getAllTeamMembers();
    res.json(members);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// =========================
// Rekap API Routes
// =========================

// Get all rekap (with optional date filter)
app.get('/api/rekap', (req, res) => {
  try {
    const { startDate, endDate, search } = req.query;
    console.log(`🔎 API Rekap Search: start = ${startDate}, end = ${endDate}, search = ${search} `);
    const rekaps = getAllRekap(startDate || null, endDate || null, search || null);
    res.json(rekaps);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get rekap by id
app.get('/api/rekap/:id', (req, res) => {
  try {
    const rekap = getRekapById(req.params.id);
    if (!rekap) {
      return res.status(404).json({ error: 'Rekap not found' });
    }
    res.json(rekap);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Create rekap manually
app.post('/api/rekap', (req, res) => {
  try {
    const { noInc, noInet, rca, keterangan, alamat, inputBy } = req.body;

    if (!noInc) {
      return res.status(400).json({ error: 'NO INC is required' });
    }

    const rekap = addRekap({
      noInc,
      noInet: noInet || null,
      rca: rca || null,
      keterangan: keterangan || null,
      alamat: alamat || null,
      inputBy: inputBy || 'Manual'
    });

    res.json({ success: true, data: rekap });

    // Sync to Google Sheets (async)
    syncRekapToSheets().catch(e => console.error('Sync error:', e));

    // Sync rekap to work orders (update status to CLOSED)
    syncRekapToWorkOrders();
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Update rekap
app.put('/api/rekap/:id', (req, res) => {
  try {
    const updated = updateRekap(req.params.id, req.body);
    if (!updated) {
      return res.status(404).json({ error: 'Rekap not found or no valid fields provided' });
    }

    const rekap = getRekapById(req.params.id);
    res.json({ success: true, data: rekap });

    // Sync to Google Sheets (async)
    syncRekapToSheets().catch(e => console.error('Sync error:', e));

    // Sync rekap to work orders (update status to CLOSED)
    syncRekapToWorkOrders();
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Delete rekap
app.delete('/api/rekap/:id', (req, res) => {
  try {
    const deleted = deleteRekap(req.params.id);
    if (!deleted) {
      return res.status(404).json({ error: 'Rekap not found' });
    }
    res.json({ success: true });

    // Sync to Google Sheets (async)
    syncRekapToSheets().catch(e => console.error('Sync error:', e));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// =========================
// Rekap-WorkOrder Sync
// =========================

// Sync rekap to work orders (update status to CLOSED)
app.post('/api/rekap/sync-workorders', (req, res) => {
  try {
    const result = syncRekapToWorkOrders();
    res.json({ success: true, ...result });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// =========================
// Google Docs API Routes
// =========================

// Test Google Sheets connection
app.get('/api/gdocs/test', async (req, res) => {
  try {
    const result = await testGdocsConnection();
    res.json(result);
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

// Export rekap to Google Sheets
app.post('/api/rekap/export', async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    const rekaps = getAllRekap(startDate || null, endDate || null);

    if (rekaps.length === 0) {
      return res.json({ success: false, error: 'Tidak ada data rekap untuk di-export' });
    }

    const result = await exportToSheets(rekaps);
    res.json(result);
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

// Sync DATEK to external Kendala Datek spreadsheet
app.post('/api/datek/sync-external', async (req, res) => {
  try {
    const result = await syncDatekToExternal();
    res.json(result || { success: false, error: 'Sync failed' });
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});


// Trigger sync TO external sheet manually
app.post('/api/datek/sync-to-external', async (req, res) => {
  try {
    const result = await syncDatekToExternal();
    res.json(result || { success: false, error: 'Sync failed (returned null)' });
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

// Sync Keterangan & Tindak Lanjut from external sheet back to database
app.post('/api/datek/sync-from-external', async (req, res) => {
  try {
    const result = await syncDatekFromExternal();
    res.json(result || { success: false, error: 'Reverse sync failed' });
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

// GET all DATEK entries
app.get('/api/datek', (req, res) => {
  try {
    const data = getAllDatekRekap();
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// CREATE new DATEK entry
app.post('/api/datek', (req, res) => {
  try {
    const rekap = {
      ...req.body,
      category: 'DATEK',
      tipeTiket: 'DATEK',
      inputBy: 'Web Admin', // Default inputter
      inputAt: formatToWIB()
    };

    // Generate NO INC if missing
    if (!rekap.noInc) {
      rekap.noInc = `DATEK - ${Date.now()} `;
    }

    const saved = addRekap(rekap);

    // Trigger async sync
    syncDatekToExternal().catch(e => console.error('Async sync error:', e));

    res.json({ success: true, data: saved });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// UPDATE DATEK entry
app.put('/api/datek/:id', (req, res) => {
  try {
    const { id } = req.params;
    const success = updateRekap(id, req.body);
    if (success) {
      res.json({ success: true });
    } else {
      res.status(404).json({ success: false, error: 'Entry not found' });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// DELETE DATEK entry
app.delete('/api/datek/:id', (req, res) => {
  try {
    const { id } = req.params;
    const success = deleteRekap(id);
    if (success) {
      res.json({ success: true });
    } else {
      res.status(404).json({ success: false, error: 'Entry not found' });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// =========================
// PSB API Routes
// =========================

// GET all PSB entries
app.get('/api/psb', (req, res) => {
  try {
    const data = getAllPsbRekap();
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// =========================
// Schedule & Auto-Send API Routes
// =========================

// Setup multer for file upload
const upload = multer({ storage: multer.memoryStorage() });

// Upload schedule Excel
app.post('/api/schedule/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const result = parseAndSaveSchedule(req.file.buffer);
    res.json({ success: true, ...result });
  } catch (error) {
    console.error('❌ Schedule upload error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get all schedule mappings
app.get('/api/schedule/mappings', (req, res) => {
  try {
    const mappings = getScheduleMappings();
    res.json(mappings);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Update schedule mapping
app.put('/api/schedule/mapping/:id', (req, res) => {
  try {
    const { teamMemberId } = req.body;
    const updated = updateScheduleMapping(req.params.id, teamMemberId);
    res.json({ success: updated });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Update schedule entry (shift)
app.put('/api/schedule/entry', (req, res) => {
  try {
    const { name, day, month, year, shift } = req.body;

    if (!name || !day || !month || !year || !shift) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const updated = updateScheduleEntry(name, parseInt(day), parseInt(month), parseInt(year), shift);
    res.json({ success: updated });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get all team members for mapping dropdown
app.get('/api/schedule/team-members', (req, res) => {
  try {
    const members = getAllTeamMembersForMapping();
    res.json(members);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get today's schedule preview
app.get('/api/schedule/today', (req, res) => {
  try {
    const schedule = getTodaySchedulePreview();
    res.json(schedule);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get workers for specific workzone today
app.get('/api/schedule/workers/:workzone', (req, res) => {
  try {
    const workers = getTodayWorkers(req.params.workzone);
    res.json(workers);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Start auto-send
app.post('/api/autosend/start', (req, res) => {
  try {
    startAutoSend();
    res.json({ success: true, message: 'Auto-send started' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Stop auto-send
app.post('/api/autosend/stop', (req, res) => {
  try {
    stopAutoSend();
    res.json({ success: true, message: 'Auto-send stopped' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get auto-send status
app.get('/api/autosend/status', (req, res) => {
  try {
    res.json({ active: isAutoSendRunning() });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Clear all schedule data
app.delete('/api/schedule/clear', (req, res) => {
  try {
    const result = clearAllSchedule();
    res.json({ success: true, ...result });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// =========================
// Browser API Routes
// =========================

// Get browser status
app.get('/api/browser/status', (req, res) => {
  try {
    const status = getBrowserStatus();
    res.json(status);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Launch browser
app.post('/api/browser/start', async (req, res) => {
  try {
    const { url } = req.body;
    const config = getConfig();
    const targetUrl = url || config.targetUrl || 'about:blank';

    const result = await launchBrowser(targetUrl);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Close browser
app.post('/api/browser/stop', async (req, res) => {
  try {
    const result = await closeBrowser();
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Navigate to URL
app.post('/api/browser/navigate', async (req, res) => {
  try {
    const { url } = req.body;
    if (!url) {
      return res.status(400).json({ error: 'URL is required' });
    }
    const result = await navigate(url);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Click at coordinates
app.post('/api/browser/click', async (req, res) => {
  try {
    const { x, y } = req.body;
    if (x === undefined || y === undefined) {
      return res.status(400).json({ error: 'Coordinates (x, y) are required' });
    }
    const result = await click(x, y);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Type text
app.post('/api/browser/type', async (req, res) => {
  try {
    const { text } = req.body;
    if (!text) {
      return res.status(400).json({ error: 'Text is required' });
    }
    const result = await type(text);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Press key
app.post('/api/browser/key', async (req, res) => {
  try {
    const { key } = req.body;
    if (!key) {
      return res.status(400).json({ error: 'Key is required' });
    }
    const result = await pressKey(key);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get single screenshot
app.get('/api/browser/screenshot', async (req, res) => {
  try {
    const screenshot = await getScreenshot();
    if (!screenshot) {
      return res.status(400).json({ error: 'Browser not running' });
    }
    res.json({ success: true, screenshot });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Trigger auto-login manually
app.post('/api/browser/login', async (req, res) => {
  try {
    const result = await triggerAutoLogin();
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Enable/disable auto-login
app.post('/api/browser/auto-login', (req, res) => {
  try {
    const { enabled } = req.body;
    setAutoLogin(enabled !== false);
    res.json({ success: true, autoLoginEnabled: isAutoLoginEnabled() });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get auto-login status
app.get('/api/browser/auto-login', (req, res) => {
  try {
    res.json({ autoLoginEnabled: isAutoLoginEnabled() });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Clear browser cache
app.post('/api/browser/clear-cache', async (req, res) => {
  try {
    const result = await clearBrowserCache();
    if (result.success) {
      res.json(result);
    } else {
      res.status(500).json(result);
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// =========================
// Auto-Send API Routes
// =========================

// Trigger manual scrape
app.post('/api/scrape', async (req, res) => {
  try {
    const config = getConfig();
    if (!config.targetUrl) {
      return res.status(400).json({ error: 'Target URL not configured' });
    }

    let newCount = 0;
    let skippedCount = 0;
    let updatedCount = 0;

    const result = await scrapeOnce(config.targetUrl, async (workOrder) => {
      // Check if work order already exists
      if (workOrderExists(workOrder.orderId)) {
        // Check if status changed to CLOSED/RESOLVED/CANCELLED
        const scrapedStatus = (workOrder.status || '').toUpperCase();
        if (['CLOSED', 'RESOLVED', 'CANCELLED'].includes(scrapedStatus)) {
          const existingWo = getWorkOrderByOrderId(workOrder.orderId);
          if (existingWo && existingWo.status !== scrapedStatus) {
            updateWorkOrderStatus(workOrder.orderId, scrapedStatus);
            updatedCount++;
            console.log(`✅ Updated status to ${scrapedStatus}: ${workOrder.orderId} `);
            broadcastToClients({ type: 'update_workorder', data: { ...existingWo, status: scrapedStatus } });
            return;
          }
        }
        skippedCount++;
        console.log(`⏭️ Skipping duplicate: ${workOrder.orderId} `);
        return;
      }

      // Add to database
      addWorkOrder(workOrder);
      newCount++;
      // Broadcast to SSE clients
      broadcastToClients({ type: 'new_workorder', data: workOrder });

      // Auto-send if enabled
      if (isAutoSendRunning()) {
        try {
          console.log(`🚀 Manual Scrape: Auto - sending WO ${workOrder.orderId} `);
          await sendWorkOrderWithRotation(workOrder);
        } catch (error) {
          console.error('❌ Manual Scrape Auto-send error:', error.message);
        }
      }
    });

    res.json({
      success: true,
      message: `Scrape completed.New: ${newCount}, Updated: ${updatedCount}, Skipped: ${skippedCount} `,
      result: { ...result, newCount, updatedCount, skippedCount }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ...

// =========================
// Schedule Calendar API Routes
// =========================

// Get schedule entries for a specific date with status
app.get('/api/schedule/calendar/:year/:month/:day', (req, res) => {
  try {
    const { year, month, day } = req.params;
    const entries = getScheduleEntriesWithStatus(
      parseInt(day),
      parseInt(month),
      parseInt(year)
    );
    res.json(entries);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get all schedule statuses for a month
app.get('/api/schedule/statuses/:year/:month', (req, res) => {
  try {
    const { year, month } = req.params;
    const statuses = getScheduleStatuses(parseInt(month), parseInt(year));
    res.json(statuses);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get all names in schedule for a month (for calendar view)
app.get('/api/schedule/names/:year/:month', (req, res) => {
  try {
    const { year, month } = req.params;
    const names = getScheduleNames(parseInt(month), parseInt(year));
    res.json(names);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Update/Create schedule status (ACTIVE, SAKIT, CUTI, IZIN, OFF)
app.put('/api/schedule/status', (req, res) => {
  try {
    const { excelName, day, month, year, status, note } = req.body;

    if (!excelName || !day || !month || !year || !status) {
      return res.status(400).json({ error: 'Missing required fields: excelName, day, month, year, status' });
    }

    const validStatuses = ['ACTIVE', 'SAKIT', 'CUTI', 'IZIN', 'LIBUR', 'OFF'];
    if (!validStatuses.includes(status.toUpperCase())) {
      return res.status(400).json({ error: `Invalid status.Must be one of: ${validStatuses.join(', ')} ` });
    }

    // If status is ACTIVE, delete the record instead
    if (status.toUpperCase() === 'ACTIVE') {
      deleteScheduleStatus(excelName, day, month, year);
      res.json({ success: true, message: 'Status reset to ACTIVE' });
    } else {
      const result = upsertScheduleStatus(excelName, day, month, year, status.toUpperCase(), note);
      res.json({ success: true, data: result });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Delete schedule status (reset to ACTIVE)
app.delete('/api/schedule/status', (req, res) => {
  try {
    const { excelName, day, month, year } = req.body;

    if (!excelName || !day || !month || !year) {
      return res.status(400).json({ error: 'Missing required fields: excelName, day, month, year' });
    }

    const deleted = deleteScheduleStatus(excelName, day, month, year);
    res.json({ success: true, deleted });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Bulk update statuses for a person (e.g., mark entire week as sick)
app.post('/api/schedule/status/bulk', (req, res) => {
  try {
    const { excelName, dates, status, note } = req.body;

    if (!excelName || !dates || !Array.isArray(dates) || !status) {
      return res.status(400).json({ error: 'Missing required fields: excelName, dates (array), status' });
    }

    const validStatuses = ['ACTIVE', 'SAKIT', 'CUTI', 'IZIN', 'LIBUR', 'OFF'];
    if (!validStatuses.includes(status.toUpperCase())) {
      return res.status(400).json({ error: `Invalid status.Must be one of: ${validStatuses.join(', ')} ` });
    }

    let updated = 0;
    for (const date of dates) {
      const { day, month, year } = date;
      if (status.toUpperCase() === 'ACTIVE') {
        deleteScheduleStatus(excelName, day, month, year);
      } else {
        upsertScheduleStatus(excelName, day, month, year, status.toUpperCase(), note);
      }
      updated++;
    }

    res.json({ success: true, updated });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// =========================
// Auto-Send API Routes
// =========================

app.get('/api/autosend/status', (req, res) => {
  try {
    const active = isAutoSendRunning();
    res.json({ active });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/autosend/start', async (req, res) => {
  try {
    console.log('🚀 API: Received /api/autosend/start request');
    startAutoSend();
    console.log('✅ Auto-send marked as active');

    // Send Telegram Notification
    const config = getConfig();
    const chatId = config.telegramChatId;
    console.log(`Debug Activation: ChatID from config: "${chatId}"`);

    if (chatId) {
      const message = `✅ Automatic Workorder Sending - Online`;
      try {
        console.log(`📨 Attempting to send activation message to ${chatId} `);
        const result = await sendFormattedMessage(chatId, message);
        console.log('✅ Activation message sent result:', JSON.stringify(result));
      } catch (err) {
        console.error('❌ Failed to send activation message:', err.message);
      }
    } else {
      console.warn('⚠️ No Chat ID found in config, skipping activation message');
    }

    res.json({ success: true, message: 'Auto-send started' });
  } catch (error) {
    console.error('❌ API Error /api/autosend/start:', error.message);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/autosend/stop', (req, res) => {
  try {
    stopAutoSend();
    res.json({ success: true, message: 'Auto-send stopped' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/telegram/broadcast/performance', async (req, res) => {
  try {
    const { date, period, chatId, tipeTicket } = req.body;
    const config = getConfig();

    // Use provided chatId or fallback to config
    const targetChatId = chatId || config.telegramChatId;

    if (!targetChatId) {
      return res.status(400).json({ error: 'Chat ID is required' });
    }

    if (!date) {
      return res.status(400).json({ error: 'Date is required' });
    }

    const tipeArr = tipeTicket && tipeTicket.length > 0 ? tipeTicket : null;
    const result = await broadcastPerformance(targetChatId, date, period || 'daily', tipeArr);
    res.json({ success: true, ...result });
  } catch (error) {
    console.error('❌ Broadcast performance error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// =========================
// Start Server with WebSocket
// =========================

const server = createServer(app);

// WebSocket server for browser streaming
const wss = new WebSocketServer({ server, path: '/ws/browser' });

wss.on('connection', (ws) => {
  addWsClient(ws);

  ws.on('close', () => {
    removeWsClient(ws);
  });

  ws.on('error', (error) => {
    console.error('WebSocket error:', error.message);
    removeWsClient(ws);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  const serverIp = process.env.SERVER_IP || 'localhost';
  console.log(`🚀 Backend server is running!`);
  console.log(`📡 Listening on Port: ${PORT} `);
  console.log(`🔗 API Health: http://${serverIp}:${PORT}/api/health`);
  console.log(`🔌 WebSocket: ws://${serverIp}:${PORT}/ws/browser`);

  try {
    const config = getConfig();
    const tokenGangguan = config.telegramBotToken || process.env.TELEGRAM_BOT_TOKEN;
    const tokenDatek = config.datekBotToken || process.env.DATEK_BOT_TOKEN;
    console.log(`Debug Init: Bot Tokens present? Gangguan=${!!tokenGangguan}, Datek=${!!tokenDatek}`);

    initTelegramBots(tokenGangguan, tokenDatek);
    console.log('📱 Telegram bots initialized');


    if (config.autoSendActive === 'true') {
      console.log('🔄 Auto-Send was active before restart. Resuming...');
      startAutoSend();
    }

    if (config.autoScrapActive === 'true' && config.targetUrl) {
      console.log('🔄 Auto-Scrap was active before restart. Resuming...');


      const intervalMs = config.frequency === '2m' ? 120000 :
        config.frequency === '5m' ? 300000 :
          config.frequency === '15m' ? 900000 :
            config.frequency === '1h' ? 3600000 : 120000;

      startScraping(config.targetUrl, intervalMs, async (workOrder) => {
        if (workOrderExists(workOrder.orderId)) {
          console.log(`⏭️ Skipping duplicate in resilient auto-scrape: ${workOrder.orderId}`);
          return;
        }
        addWorkOrder(workOrder);
        broadcastToClients({ type: 'new_workorder', data: workOrder });

        if (isAutoSendRunning()) {
          try {
            await sendWorkOrderWithRotation(workOrder);
          } catch (error) {
            console.error('❌ Auto-send error:', error.message);
          }
        }
      });
    }
  } catch (err) {
    console.error('❌ Failed to auto-initialize services:', err.message);
  }

  // Initialize Daily Sync for Tanjungpinang
  try {
    initDailySync();
    initDailyReport();
  } catch (e) {
    console.error('❌ Failed to initialize daily report/sync services:', e.message);
  }

  // Periodic reverse sync: pull Keterangan & Tindak Lanjut from external datek sheet every 1 minute
  setInterval(async () => {
    try {
      await syncDatekFromExternal();
    } catch (e) {
      console.error('❌ Periodic datek reverse sync error:', e.message);
    }
  }, 1 * 60 * 1000); // 1 minute
  console.log('🔄 Datek external reverse sync scheduled (every 1 minute)');
});

// Graceful shutdown handling untuk mencegah zombie process chrome
const gracefulShutdown = async (signal) => {
  console.log(`\n🛑 Received ${signal}. Cleaning up headless browsers...`);
  try {
    await stopScraping();
  } catch (e) {
    console.error('Error closing scraper browser:', e.message);
  }
  
  try {
    await closeBrowser();
  } catch (e) {
    console.error('Error closing main browser:', e.message);
  }
  
  console.log('✅ Cleanup complete. Exiting.');
  process.exit(0);
};

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
