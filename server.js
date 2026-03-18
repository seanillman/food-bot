import express from "express";
import { chromium } from "playwright";
import dotenv from "dotenv";
import fs from "fs";

dotenv.config();

const app = express();
app.use(express.json());

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;
const PROFILES_FILE = "./profiles.json";

// â”€â”€â”€ Profile Storage â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function loadProfiles() {
  if (!fs.existsSync(PROFILES_FILE)) return {};
  return JSON.parse(fs.readFileSync(PROFILES_FILE, "utf8"));
}
function saveProfiles(p) {
  fs.writeFileSync(PROFILES_FILE, JSON.stringify(p, null, 2));
}

// â”€â”€â”€ Telegram Messaging â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function sendMessage(chatId, text) {
  await fetch(`${TELEGRAM_API}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
}

// â”€â”€â”€ Simple Free Text Parser (no AI needed) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function parseOrder(message) {
  const msg = message.toLowerCase().trim();

  // "usual" / "lunch" / "dinner" / "order me food" â†’ usual order
  const usualTriggers = ["usual", "lunch", "dinner", "breakfast", "food", "hungry", "order me", "get me food"];
  const isUsual = usualTriggers.some((t) => msg.includes(t)) && !msg.includes(" from ");

  // "order [item] from [restaurant]"
  const fromMatch = msg.match(/(?:order|get|want|gimme|i want)(.*?)from\s+(.+)/i);
  if (fromMatch) {
    const items = fromMatch[1].trim().split(/,|and/).map((i) => i.trim()).filter(Boolean);
    const restaurant = fromMatch[2].trim();
    return { isUsual: false, items, restaurant };
  }

  // "order from [restaurant]"
  const restaurantOnly = msg.match(/(?:order|get me).+from\s+(.+)/i);
  if (restaurantOnly) {
    return { isUsual: true, items: [], restaurant: restaurantOnly[1].trim() };
  }

  return { isUsual, items: [], restaurant: null };
}

// â”€â”€â”€ DoorDash Automation â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function placeOrder(chatId, orderIntent) {
  const profiles = loadProfiles();
  const profile = profiles[chatId];

  if (!profile?.doordashEmail) throw new Error("NO_PROFILE");

  const restaurant = orderIntent.restaurant || profile.usualRestaurant;
  const items = orderIntent.items.length ? orderIntent.items : profile.usualItems;
  const address = profile.defaultAddress;

  if (!restaurant) throw new Error("NO_RESTAURANT");
  if (!address) throw new Error("NO_ADDRESS");

  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    // Login
    await page.goto("https://www.doordash.com/consumer/login/", { waitUntil: "networkidle" });
    await page.fill('input[name="email"]', profile.doordashEmail);
    await page.fill('input[name="password"]', profile.doordashPassword);
    await page.click('button[type="submit"]');
    await page.waitForNavigation({ waitUntil: "networkidle" });

    // Search restaurant
    await page.goto(`https://www.doordash.com/search/store/${encodeURIComponent(restaurant)}/`, {
      waitUntil: "networkidle",
    });
    const firstResult = page.locator('[data-testid="store-card"]').first();
    await firstResult.waitFor({ timeout: 10000 });
    await firstResult.click();
    await page.waitForLoadState("networkidle");

    // Add items
    for (const item of items) {
      try {
        const el = page.locator(`text=${item}`).first();
        await el.waitFor({ timeout: 5000 });
        await el.click();
        const addBtn = page.locator('button:has-text("Add to Order"), button:has-text("Add")').first();
        if (await addBtn.isVisible({ timeout: 2000 })) await addBtn.click();
        await page.waitForTimeout(1000);
      } catch {
        console.log(`Item not found: ${item}`);
      }
    }

    // Checkout
    const checkoutBtn = page.locator('button:has-text("Go to Checkout"), a:has-text("Go to Checkout")').first();
    await checkoutBtn.waitFor({ timeout: 10000 });
    await checkoutBtn.click();
    await page.waitForLoadState("networkidle");

    // Get total
    let orderTotal = "";
    try {
      orderTotal = await page.locator('[data-testid="order-total"]').first().textContent({ timeout: 3000 });
    } catch {}

    // Place order
    const placeBtn = page.locator('button:has-text("Place Order"), button:has-text("Confirm Order")').first();
    await placeBtn.waitFor({ timeout: 10000 });
    await placeBtn.click();
    await page.waitForLoadState("networkidle");

    // Get ETA
    let eta = "30-45 minutes";
    try {
      eta = await page.locator('[data-testid="delivery-eta"]').first().textContent({ timeout: 5000 });
    } catch {}

    await browser.close();
    return { restaurant, items, orderTotal, eta, address };
  } catch (err) {
    await browser.close();
    throw err;
  }
}

// â”€â”€â”€ Setup Flow â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function handleSetup(chatId, message) {
  const profiles = loadProfiles();
  const profile = profiles[chatId] || {};
  const step = profile.setupStep || "start";

  const next = (update, reply) => {
    profiles[chatId] = { ...profile, ...update };
    saveProfiles(profiles);
    return reply;
  };

  if (step === "start" || message.toLowerCase() === "setup") {
    return next({ setupStep: "email" },
      "ðŸ‘‹ Welcome! Let's set up your food bot.\n\nStep 1/5: What's your DoorDash email?");
  }
  if (step === "email") return next({ doordashEmail: message, setupStep: "password" },
    "Step 2/5: What's your DoorDash password?\n(Stored only on your server)");
  if (step === "password") return next({ doordashPassword: message, setupStep: "address" },
    "Step 3/5: What's your default delivery address?");
  if (step === "address") return next({ defaultAddress: message, setupStep: "restaurant" },
    "Step 4/5: What's your usual restaurant? (e.g. Delhi Street)");
  if (step === "restaurant") return next({ usualRestaurant: message, setupStep: "items" },
    "Step 5/5: What's your usual order? Separate items with commas.\n(e.g. butter chicken, garlic naan)");
  if (step === "items") {
    const items = message.split(",").map((i) => i.trim());
    return next({ usualItems: items, setupStep: "done" },
      `âœ… You're all set!\n\nNow just message me things like:\nâ€¢ "order me lunch"\nâ€¢ "get me my usual"\nâ€¢ "order butter chicken from Delhi Street"\nâ€¢ "order dinner from anywhere"`);
  }
  return null;
}

// â”€â”€â”€ Telegram Webhook â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.post("/telegram", async (req, res) => {
  res.sendStatus(200);

  const msg = req.body?.message;
  if (!msg) return;

  const chatId = msg.chat.id;
  const text = msg.text?.trim();
  if (!text) return;

  const profiles = loadProfiles();
  const profile = profiles[chatId] || {};
  const isSettingUp = profile.setupStep && profile.setupStep !== "done";

  try {
    if (isSettingUp || text.toLowerCase() === "setup") {
      const reply = await handleSetup(chatId, text);
      if (reply) await sendMessage(chatId, reply);
      return;
    }

    if (!profile.doordashEmail) {
      await sendMessage(chatId, 'Hey! Send me "setup" first so I can save your details ðŸ•');
      return;
    }

    await sendMessage(chatId, "Got it! Placing your order now... ðŸ›µ");

    const orderIntent = parseOrder(text);
    const result = await placeOrder(chatId, orderIntent);

    await sendMessage(chatId,
      `âœ… Order placed!\n\nðŸ½ ${result.restaurant}\nðŸ“¦ ${result.items.join(", ")}\nðŸ“ ${result.address}\nðŸ’° ${result.orderTotal}\nâ± ETA: ${result.eta}\n\nEnjoy! ðŸŽ‰`
    );
  } catch (err) {
    const msgs = {
      NO_PROFILE: 'Send "setup" to get started.',
      NO_RESTAURANT: "Which restaurant do you want to order from?",
      NO_ADDRESS: 'No delivery address saved. Send "setup" to add one.',
    };
    await sendMessage(chatId, msgs[err.message] || "âŒ Something went wrong. Try again!");
  }
});

app.get("/", (_, res) => res.send("ðŸ• Food bot is running!"));

// Register Telegram webhook on startup
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`Running on port ${PORT}`);
  const url = process.env.PUBLIC_URL;
  if (url) {
    await fetch(`${TELEGRAM_API}/setWebhook?url=${url}/telegram`);
    console.log(`Telegram webhook set to ${url}/telegram`);
  }
});
