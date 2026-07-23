import { spawn } from 'child_process';

const PROXY_API =
    process.env.PROXY_API_URL ||
    'https://api.proxyscrape.com/v4/free-proxy-list/get?request=display_proxies&proxy_format=protocolipport&format=text&country=id';

const TEST_URL = process.env.PROXY_TEST_URL || 'https://oss-incident.telkom.co.id';
const FETCH_TTL_MS = Number(process.env.PROXY_LIST_TTL_MS || 5 * 60 * 1000);
const TEST_TIMEOUT_MS = Number(process.env.PROXY_TEST_TIMEOUT_MS || 12000);
const MAX_PROBE = Number(process.env.PROXY_MAX_PROBE || 12);

let cachedList = [];
let cachedAt = 0;
let currentProxy = null;
const deadUntil = new Map(); // proxyUrl -> timestamp

function proxyEnabled() {
    const flag = (process.env.PROXY_ENABLED || 'true').toLowerCase();
    return flag === '1' || flag === 'true' || flag === 'yes';
}

function normalizeProxy(raw) {
    const line = String(raw || '').trim();
    if (!line) return null;
    if (line.includes('://')) return line;
    return `http://${line}`;
}

function toChromeProxyServer(proxyUrl) {
    // Chrome --proxy-server accepts http://host:port or socks5://host:port
    try {
        const u = new URL(proxyUrl);
        const protocol = u.protocol.replace(':', '');
        if (protocol === 'socks4') {
            // Chromium has limited socks4 support; prefer socks5 when possible
            return `socks4://${u.hostname}:${u.port}`;
        }
        if (protocol === 'socks5' || protocol === 'socks') {
            return `socks5://${u.hostname}:${u.port}`;
        }
        return `http://${u.hostname}:${u.port}`;
    } catch {
        return proxyUrl;
    }
}

function isMarkedDead(proxyUrl) {
    const until = deadUntil.get(proxyUrl);
    if (!until) return false;
    if (Date.now() > until) {
        deadUntil.delete(proxyUrl);
        return false;
    }
    return true;
}

export function markProxyDead(proxyUrl, cooldownMs = 15 * 60 * 1000) {
    if (!proxyUrl) return;
    deadUntil.set(proxyUrl, Date.now() + cooldownMs);
    if (currentProxy === proxyUrl) currentProxy = null;
    console.warn(`☠️ [Proxy] Marked dead for ${Math.round(cooldownMs / 60000)}m: ${proxyUrl}`);
}

async function fetchProxyList() {
    const now = Date.now();
    if (cachedList.length && now - cachedAt < FETCH_TTL_MS) {
        return cachedList;
    }

    console.log(`🌐 [Proxy] Fetching Indonesia free proxies from ProxyScrape...`);
    const res = await fetch(PROXY_API, { signal: AbortSignal.timeout(20000) });
    if (!res.ok) {
        throw new Error(`ProxyScrape API HTTP ${res.status}`);
    }
    const text = await res.text();
    const list = text
        .split(/\r?\n/)
        .map(normalizeProxy)
        .filter(Boolean);

    // Prefer HTTP(S) first (more reliable with curl + Chromium), then SOCKS5, then SOCKS4
    const rank = (p) => {
        if (p.startsWith('http://') || p.startsWith('https://')) return 0;
        if (p.startsWith('socks5://')) return 1;
        if (p.startsWith('socks4://')) return 2;
        return 3;
    };
    list.sort((a, b) => rank(a) - rank(b));

    cachedList = list;
    cachedAt = now;
    console.log(`📋 [Proxy] Got ${list.length} Indonesia proxies`);
    return list;
}

function runCurlProbe(proxyUrl, testUrl) {
    return new Promise((resolve) => {
        let u;
        try {
            u = new URL(proxyUrl);
        } catch {
            resolve(false);
            return;
        }

        const protocol = u.protocol.replace(':', '');
        const hostPort = `${u.hostname}:${u.port}`;
        const args = ['-I', '-s', '-o', '/dev/null', '-w', '%{http_code}', '--max-time', String(Math.ceil(TEST_TIMEOUT_MS / 1000))];

        if (protocol === 'socks5' || protocol === 'socks') {
            args.push('--socks5-hostname', hostPort);
        } else if (protocol === 'socks4') {
            args.push('--socks4', hostPort);
        } else {
            args.push('-x', `http://${hostPort}`);
        }
        args.push(testUrl);

        const child = spawn('curl', args, { windowsHide: true });
        let out = '';
        const timer = setTimeout(() => {
            child.kill('SIGKILL');
            resolve(false);
        }, TEST_TIMEOUT_MS + 2000);

        child.stdout.on('data', (d) => {
            out += d.toString();
        });
        child.on('error', () => {
            clearTimeout(timer);
            resolve(false);
        });
        child.on('close', () => {
            clearTimeout(timer);
            const code = out.trim();
            // Any HTTP response (even 401/403/302) means TCP path to Telkom works via proxy
            resolve(/^\d{3}$/.test(code) && code !== '000');
        });
    });
}

async function testProxy(proxyUrl) {
    console.log(`🔎 [Proxy] Probing ${proxyUrl} → ${TEST_URL}`);
    const ok = await runCurlProbe(proxyUrl, TEST_URL);
    if (ok) {
        console.log(`✅ [Proxy] UP: ${proxyUrl}`);
    } else {
        console.log(`❌ [Proxy] DOWN/timeout: ${proxyUrl}`);
    }
    return ok;
}

/**
 * Return a working Indonesia proxy for Chromium, or null.
 * Honors PROXY_URL override. Auto-rotates when current is dead.
 */
export async function getWorkingProxy(forceRefresh = false) {
    if (!proxyEnabled()) {
        console.log('ℹ️ [Proxy] PROXY_ENABLED=false — direct connection');
        return null;
    }

    if (process.env.PROXY_URL) {
        const fixed = normalizeProxy(process.env.PROXY_URL);
        currentProxy = fixed;
        return {
            proxyUrl: fixed,
            chromeArg: `--proxy-server=${toChromeProxyServer(fixed)}`
        };
    }

    if (!forceRefresh && currentProxy && !isMarkedDead(currentProxy)) {
        return {
            proxyUrl: currentProxy,
            chromeArg: `--proxy-server=${toChromeProxyServer(currentProxy)}`
        };
    }

    let list = [];
    try {
        list = await fetchProxyList();
    } catch (err) {
        console.error(`❌ [Proxy] Failed to fetch list: ${err.message}`);
        return null;
    }

    if (!list.length) {
        console.warn('⚠️ [Proxy] No Indonesia proxies available from ProxyScrape right now');
        return null;
    }

    const candidates = list.filter((p) => !isMarkedDead(p)).slice(0, MAX_PROBE);
    for (const proxyUrl of candidates) {
        if (await testProxy(proxyUrl)) {
            currentProxy = proxyUrl;
            return {
                proxyUrl,
                chromeArg: `--proxy-server=${toChromeProxyServer(proxyUrl)}`
            };
        }
        markProxyDead(proxyUrl, 10 * 60 * 1000);
    }

    // Exhausted probe window — refresh list next time
    cachedAt = 0;
    console.warn('⚠️ [Proxy] No working Indonesia proxy found in probe window');
    return null;
}

export function getCurrentProxyUrl() {
    return currentProxy || process.env.PROXY_URL || null;
}

export async function rotateProxy(reason = 'navigation failure') {
    console.warn(`🔄 [Proxy] Rotating proxy (${reason})...`);
    if (currentProxy) markProxyDead(currentProxy, 20 * 60 * 1000);
    currentProxy = null;
    cachedAt = 0; // force list refresh
    return getWorkingProxy(true);
}
