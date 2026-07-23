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
    const content = await page.content().catch(() => "");
    /* javascript-obfuscator:disable */
    const detected =
      (url.includes("insera-sso.telkom.co.id") && (url.includes("/login") || url.includes("/jw/web/login"))) ||
      (url.includes("/login") && (content.includes("fake-username") || content.includes('name="username"'))) ||
      content.includes('id="pin"');
    /* javascript-obfuscator:enable */

    if (detected) {
      console.log(`🔎 Login/OTP page detected. URL: ${url}`);
    }
    return detected;
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
    const content = await page.content().catch(() => "");
    return content.toLowerCase().includes("logout");
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

    console.log("🔐 Starting auto-login...");
    console.log(`📍 Current URL: ${page.url()}`);

    if (!page.url().includes("insera-sso.telkom.co.id")) {
      console.log(`🌐 Navigating to SSO login: ${credentials.loginUrl || "https://insera-sso.telkom.co.id/jw/web/login"}`);
      await page.goto(credentials.loginUrl || "https://insera-sso.telkom.co.id/jw/web/login", {
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

      console.log("📤 Submitting login form...");
      /* javascript-obfuscator:disable */
      await clickAndWaitNavigation(page, async () => {
        await page.evaluate(() => {
          const btn = document.getElementById("fake-login");
          if (btn) btn.click();
        });
      });
      /* javascript-obfuscator:enable */
    } else {
      console.log("ℹ️ Generic login form detected");
      const username = await page.$('input[name="username"], input[id="username"], input[type="text"]');
      const password = await page.$('input[name="password"], input[id="password"], input[type="password"]');
      if (!username || !password) return { success: false, message: "Login fields not found" };

      console.log(`⌨️ Typing username: ${credentials.username}`);
      await username.click({ clickCount: 3 });
      await username.type(credentials.username, { delay: 50 });
      console.log("⌨️ Typing password...");
      await password.click({ clickCount: 3 });
      await password.type(credentials.password, { delay: 50 });
      console.log("📤 Submitting login form...");
      await clickAndWaitNavigation(page, async () => {
        await page.keyboard.press("Enter");
      });
    }

    console.log("⏳ Waiting login response...");
    await new Promise((r) => setTimeout(r, 1500));
    if (await isLoginPage(page)) {
      console.log("🔐 Still on login/OTP page, trying OTP handler...");
      await handleTOTPPage(page);
      await new Promise((r) => setTimeout(r, 1500));
    }

    const stillLogin = await isLoginPage(page);
    console.log(`📍 URL after login flow: ${page.url()}`);
    return stillLogin
      ? { success: false, message: "Still on login page" }
      : { success: true, message: "Login successful" };
  } catch (error) {
    console.error("❌ Auto-login failed:", error.message);
    return { success: false, message: error.message };
  }
}
