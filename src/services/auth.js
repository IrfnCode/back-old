import { authenticator } from "otplib";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const configPath = path.join(__dirname, "../../config/credentials.json");

export function loadCredentials() {
  try {
    if (!fs.existsSync(configPath)) {
      console.error(`❌ Credentials file not found: ${configPath}`);
      return null;
    }
    const data = JSON.parse(fs.readFileSync(configPath, "utf8"));
    console.log(`✅ Credentials loaded from: ${configPath}`);
    return data;
  } catch (error) {
    console.error("❌ Failed to load credentials:", error.message);
    return null;
  }
}

export function generateTOTP(secret) {
  if (!secret) {
    console.error("❌ TOTP secret missing");
    return null;
  }
  const normalized = String(secret).replace(/[^a-zA-Z0-9]/g, "").toUpperCase().trim();
  const token = authenticator.generate(normalized);
  console.log(`🔐 Generated OTP: ${token}`);
  return token;
}

export async function isLoginPage(page) {
  try {
    if (!page || (typeof page.isClosed === "function" && page.isClosed())) {
      return false;
    }
    const url = page.url();

    /* javascript-obfuscator:disable */
    const detected = await page.evaluate(() => {
      const hasFake =
        !!document.querySelector("#fake-username") ||
        !!document.querySelector("#fake-password") ||
        !!document.querySelector("#j_username");
      const hasPin = !!document.querySelector("#pin, input[name='otp'], input[id='otp']");
      const hasPassword = !!document.querySelector('input[type="password"], input[name="password"], #password');
      const hasUser =
        !!document.querySelector('input[name="username"], #username, input[name="j_username"], #j_username, input[type="text"]');
      const bodyText = (document.body && document.body.innerText ? document.body.innerText : "").toLowerCase();
      const looksLikeLoginText =
        (bodyText.includes("username") && bodyText.includes("password")) ||
        bodyText.includes("sign in") ||
        bodyText.includes("log in") ||
        bodyText.includes("login");

      // Visible login form (Joget / SSO), not just the word "login" in scripts
      if (hasPin) return true;
      if (hasFake) return true;
      if (hasPassword && (hasUser || looksLikeLoginText)) return true;
      return false;
    });
    /* javascript-obfuscator:enable */

    const urlLooksLogin =
      url.includes("insera-sso.telkom.co.id") &&
      (url.includes("/login") || url.includes("/jw/web/login"));

    const result = !!(detected || urlLooksLogin);
    if (result) {
      console.log(`🔎 Login/OTP page detected. URL: ${url}`);
    }
    return result;
  } catch (error) {
    console.error("❌ Failed to detect login page:", error.message);
    return false;
  }
}

export async function isLoggedIn(page) {
  try {
    if (!page || (typeof page.isClosed === "function" && page.isClosed())) {
      return false;
    }

    // Do NOT scan raw HTML for the word "logout" — Joget JS bundles often contain it
    // even on the login page (false positive).
    /* javascript-obfuscator:disable */
    const loggedIn = await page.evaluate(() => {
      const logoutEl =
        document.querySelector('a[href*="logout" i]') ||
        document.querySelector('a[href*="logoff" i]') ||
        document.querySelector('[onclick*="logout" i]') ||
        Array.from(document.querySelectorAll("a, button")).find((el) => {
          const t = (el.textContent || "").trim().toLowerCase();
          return t === "logout" || t === "log out" || t === "sign out";
        });
      if (logoutEl) return true;

      // Ticket list / app chrome usually present when authenticated
      const hasTicketTable =
        !!document.querySelector("table tbody tr td") &&
        /INC\d+/i.test(document.body ? document.body.innerText : "");
      return hasTicketTable;
    });
    /* javascript-obfuscator:enable */

    return !!loggedIn;
  } catch (error) {
    console.error("❌ Failed to check if logged in:", error.message);
    return false;
  }
}

/**
 * Click/submit and wait for navigation together to avoid detached Frame errors
 */
async function clickAndWaitNavigation(page, actionFn, timeout = 60000) {
  await Promise.all([
    page.waitForNavigation({ waitUntil: "domcontentloaded", timeout }).catch((err) => {
      console.warn(`⚠️ waitForNavigation ended: ${err.message}`);
    }),
    actionFn()
  ]);
}

export async function handleTOTPPage(page) {
  const credentials = loadCredentials();
  if (!credentials) return { success: false, message: "Credentials not found" };

  console.log("🔐 Checking OTP page...");
  await new Promise((r) => setTimeout(r, 1500));

  const selectors = [
    'input[id="pin"]',
    'input[name="otp"]',
    'input[id="otp"]',
    'input[placeholder*="OTP" i]',
    'input[maxlength="6"]'
  ];

  let searchContext = page;
  let contextName = "main-page";
  try {
    /* javascript-obfuscator:disable */
    const iframeHandle = await page.$("#jqueryDialogFrame");
    if (iframeHandle) {
      const frame = await iframeHandle.contentFrame();
      if (frame) {
        searchContext = frame;
        contextName = "iframe#jqueryDialogFrame";
      }
    }
    /* javascript-obfuscator:enable */
  } catch {
    // ignore iframe check errors
  }

  let otpField = null;
  let foundSelector = "";
  try {
    for (const selector of selectors) {
      otpField = await searchContext.$(selector);
      if (otpField) {
        foundSelector = selector;
        break;
      }
    }
  } catch (error) {
    console.error(`❌ Frame error while checking OTP field:`, error.message);
  }

  if (!otpField) {
    console.error(`❌ OTP field not found in ${contextName}`);
    return { success: false, message: "OTP field not found" };
  }
  console.log(`✅ OTP field found: ${foundSelector} in ${contextName}`);

  const code = generateTOTP(credentials.totpSecret);
  if (!code) return { success: false, message: "TOTP secret invalid" };

  console.log("⌨️ Typing OTP...");
  await otpField.click({ clickCount: 3 });
  await otpField.type(code, { delay: 100 });
  console.log("📤 Submitting OTP...");
  /* javascript-obfuscator:disable */
  try {
    await clickAndWaitNavigation(page, async () => {
      const clicked = await searchContext.evaluate(() => {
        const btn =
          document.querySelector('button[type="submit"]') ||
          document.querySelector('input[type="submit"]') ||
          document.querySelector("#verify-btn");
        if (btn) {
          btn.click();
          return true;
        }
        return false;
      });
      if (!clicked) await page.keyboard.press("Enter");
    });
  } catch (error) {
    console.warn(`⚠️ OTP submit navigation issue: ${error.message}`);
    await page.keyboard.press("Enter").catch(() => {});
    await new Promise((r) => setTimeout(r, 3000));
  }
  /* javascript-obfuscator:enable */

  console.log("✅ OTP submitted");
  return { success: true, message: "TOTP submitted" };
}

export async function performAutoLogin(page) {
  const credentials = loadCredentials();
  if (!credentials) return { success: false, message: "Credentials not found" };

  try {
    if (!page || (typeof page.isClosed === "function" && page.isClosed())) {
      return { success: false, message: "Page is closed" };
    }

    console.log("🔐 Starting auto-login (SSO + OTP)...");
    console.log(`📍 Current URL: ${page.url()}`);

    // Always use Telkom SSO login page (do not fill Joget guest form on oss-incident)
    if (!page.url().includes("insera-sso.telkom.co.id")) {
      const ssoUrl = credentials.loginUrl || "https://insera-sso.telkom.co.id/jw/web/login";
      console.log(`🌐 Navigating to SSO login: ${ssoUrl}`);
      await page.goto(ssoUrl, {
        waitUntil: "domcontentloaded",
        timeout: 60000
      });
    }

    const fakeUsername = await page.$("#fake-username");
    const fakePassword = await page.$("#fake-password");

    if (fakeUsername && fakePassword) {
      console.log("✅ Telkom SSO fake-field login detected");
      /* javascript-obfuscator:disable */
      await page.evaluate(() => {
        const terms = document.getElementById("acceptTerms");
        if (terms && !terms.checked) terms.click();
      });
      /* javascript-obfuscator:enable */
      console.log("☑️ Terms accepted (if present)");

      console.log(`⌨️ Typing username: ${credentials.username}`);
      await fakeUsername.click({ clickCount: 3 });
      await fakeUsername.type(credentials.username, { delay: 30 });
      /* javascript-obfuscator:disable */
      await page.evaluate((username) => {
        const hiddenField = document.getElementById("j_username");
        if (hiddenField) hiddenField.value = username;
      }, credentials.username);
      /* javascript-obfuscator:enable */

      console.log("⌨️ Typing password...");
      await fakePassword.click({ clickCount: 3 });
      await fakePassword.type(credentials.password, { delay: 30 });
      /* javascript-obfuscator:disable */
      await page.evaluate((password) => {
        const hiddenField = document.getElementById("j_password");
        if (hiddenField) hiddenField.value = password;
      }, credentials.password);
      /* javascript-obfuscator:enable */

      console.log("📤 Submitting SSO login form...");
      /* javascript-obfuscator:disable */
      await clickAndWaitNavigation(page, async () => {
        await page.evaluate(() => {
          const btn = document.getElementById("fake-login");
          if (btn) btn.click();
        });
      });
      /* javascript-obfuscator:enable */
    } else {
      console.log("ℹ️ Generic SSO login form detected");
      const username = await page.$('input[name="username"], input[id="username"], input[type="text"]');
      const password = await page.$('input[name="password"], input[id="password"], input[type="password"]');
      if (!username || !password) return { success: false, message: "Login fields not found" };

      console.log(`⌨️ Typing username: ${credentials.username}`);
      await username.click({ clickCount: 3 });
      await username.type(credentials.username, { delay: 50 });
      console.log("⌨️ Typing password...");
      await password.click({ clickCount: 3 });
      await password.type(credentials.password, { delay: 50 });
      console.log("📤 Submitting SSO login form...");
      await clickAndWaitNavigation(page, async () => {
        await page.keyboard.press("Enter");
      });
    }

    // Always handle OTP/TOTP step after password submit
    console.log("⏳ Waiting for OTP page...");
    await new Promise((r) => setTimeout(r, 2500));

    /* javascript-obfuscator:disable */
    const needsOtp = await page.evaluate(() => {
      return !!(
        document.querySelector("#pin") ||
        document.querySelector('input[name="otp"]') ||
        document.querySelector('input[id="otp"]') ||
        document.querySelector("#jqueryDialogFrame")
      );
    });
    /* javascript-obfuscator:enable */

    if (needsOtp || (await isLoginPage(page))) {
      console.log("🔐 OTP step required — submitting TOTP...");
      const otpResult = await handleTOTPPage(page);
      if (!otpResult.success) {
        console.warn(`⚠️ OTP submit issue: ${otpResult.message}`);
      }
      await new Promise((r) => setTimeout(r, 2500));
    } else {
      console.log("ℹ️ No OTP field detected after password submit");
    }

    const stillLogin = await isLoginPage(page);
    const loggedIn = stillLogin ? false : await isLoggedIn(page);
    console.log(`📍 URL after login+OTP flow: ${page.url()} | loggedIn=${loggedIn}`);

    if (loggedIn || !stillLogin) {
      return { success: true, message: "Login successful" };
    }
    return { success: false, message: "Still on login/OTP page" };
  } catch (error) {
    console.error("❌ Auto-login failed:", error.message);
    return { success: false, message: error.message };
  }
}
