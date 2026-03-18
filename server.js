import express from "express";
import twilio from "twilio";
import Anthropic from "@anthropic-ai/sdk";
import { chromium } from "playwright";
import dotenv from "dotenv";
import fs from "fs";

dotenv.config();

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

// Load saved order profiles
const PROFILES_FILE = "./profiles.json";
function loadProfiles() {
  if (!fs.existsSync(PROFILES_FILE)) return {};
  return JSON.parse(fs.readFileSync(PROFILES_FILE, "utf8"));
}
function saveProfiles(profiles) {
  fs.writeFileSync(PROFILES_FILE, JSON.stringify(profiles, null, 2));
}

// Parse order intent with Claude
async function parseOrderIntent(message, phone) {
  const profiles = loadProfiles();
  const profile = profiles[phone] || {};

  const systemPrompt = `You are a food ordering assistant. Parse the user's text message into a structured order.
Extract:
- restaurant: the restaurant name (null if not specified)
- items: array of food items they want (empty array if just saying "usual" or "same as before")
- isUsual: true if they want their usual/regular order
- isSetup: true if they're trying to set up their profile/preferences
- deliveryAddress: address if mentioned (null otherwise)

User's saved profile: ${JSON.stringify(profile)}

Respond ONLY with valid JSON like:
{"restaurant": "Delhi Street", "items": ["butter chicken", "naan"], "isUsual": false, "isSetup": false, "deliveryAddress": null}`;

  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 500,
    system: systemPrompt,
    messages: [{ role: "user", content: message }],
  });

  const text = response.content[0].text.trim();
  const clean = text.replace(/```json|```/g, "").trim();
  return JSON.parse(clean);
}

// Send SMS reply
async function sendSMS(to, message) {
  await twilioClient.messages.create({
    body: message,
    from: process.env.TWILIO_PHONE_NUMBER,
    to,
  });
}

// Place order via DoorDash browser automation
async function placeOrderOnDoorDash(orderIntent, phone) {
  const profiles = loadProfiles();
  const profile = profiles[phone];

  if (!profile?.doordashEmail || !profile?.doordashPassword) {
    throw new Error("NO_PROFILE");
  }

  const restaurant = orderIntent.isUsual ? profile.usualRestaurant : orderIntent.restaurant;
  const items = orderIntent.isUsual ? profile.usualItems : orderIntent.items;
  const address = orderIntent.deliveryAddress || profile.defaultAddress;

  if (!restaurant) throw new Error("NO_RESTAURANT");
  if (!address) throw new Error("NO_ADDRESS");

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    // 1. Go to DoorDash and log in
    await page.goto("https://www.doordash.com/consumer/login/", { waitUntil: "networkidle" });
    await page.fill('input[name="email"]', profile.doordashEmail);
    await page.fill('input[name="password"]', profile.doordashPassword);
    await page.click('button[type="submit"]');
    await page.waitForNavigation({ waitUntil: "networkidle" });

    // 2. Search for the restaurant
    await page.goto(`https://www.doordash.com/search/store/${encodeURIComponent(restaurant)}/`, {
      waitUntil: "networkidle",
    });

    // Click first restaurant result
    const firstResult = page.locator('[data-testid="store-card"]').first();
    await firstResult.waitFor({ timeout: 10000 });
    await firstResult.click();
    await page.waitForLoadState("networkidle");

    // 3. Add items to cart
    for (const item of items) {
      const itemSearch = page.locator(`text=${item}`).first();
      try {
        await itemSearch.waitFor({ timeout: 5000 });
        await itemSearch.click();
        // Handle any modifier dialogs (just click confirm/add)
        const addBtn = page.locator('button:has-text("Add to Order"), button:has-text("Add")').first();
        if (await addBtn.isVisible({ timeout: 2000 })) {
          await addBtn.click();
        }
        await page.waitForTimeout(1000);
      } catch {
        console.log(`Item not found: ${item}`);
      }
    }

    // 4. Go to checkout
    const checkoutBtn = page.locator('button:has-text("Go to Checkout"), a:has-text("Go to Checkout")').first();
    await checkoutBtn.waitFor({ timeout: 10000 });
    await checkoutBtn.click();
    await page.waitForLoadState("networkidle");

    // 5. Confirm delivery address
    const addressField = page.locator('input[placeholder*="address"], input[name*="address"]').first();
    if (await addressField.isVisible({ timeout: 3000 })) {
      await addressField.fill(address);
      await page.waitForTimeout(1500);
      const suggestion = page.locator('[data-testid="address-suggestion"]').first();
      if (await suggestion.isVisible({ timeout: 2000 })) {
        await suggestion.click();
      }
    }

    // 6. Get order total before placing
    let orderTotal = "unknown";
    try {
      const totalEl = page.locator('[data-testid="order-total"], .order-total').first();
      orderTotal = await totalEl.textContent({ timeout: 3000 });
    } catch {}

    // 7. Place the order (use saved payment)
    const placeOrderBtn = page
      .locator('button:has-text("Place Order"), button:has-text("Confirm Order")')
      .first();
    await placeOrderBtn.waitFor({ timeout: 10000 });
    await placeOrderBtn.click();
    await page.waitForLoadState("networkidle");

    // 8. Get confirmation / ETA
    let eta = "30-45 minutes";
    try {
      const etaEl = page
        .locator('[data-testid="delivery-eta"], :has-text("minutes"), :has-text("arriving")')
        .first();
      eta = await etaEl.textContent({ timeout: 5000 });
    } catch {}

    await browser.close();
    return { success: true, restaurant, items, orderTotal, eta, address };
  } catch (err) {
    await browser.close();
    throw err;
  }
}

// Handle setup flow
async function handleSetup(phone, message) {
  const profiles = loadProfiles();
  const profile = profiles[phone] || { setupStep: "start" };

  const step = profile.setupStep || "start";

  if (step === "start" || message.toLowerCase().includes("setup")) {
    profiles[phone] = { ...profile, setupStep: "email" };
    saveProfiles(profiles);
    return "Welcome! Let's set up your food bot 🍕\n\nStep 1/5: What's your DoorDash email?";
  }

  if (step === "email") {
    profiles[phone] = { ...profile, doordashEmail: message.trim(), setupStep: "password" };
    saveProfiles(profiles);
    return "Got it! Step 2/5: What's your DoorDash password?\n\n(This is stored locally on your server only)";
  }

  if (step === "password") {
    profiles[phone] = { ...profile, doordashPassword: message.trim(), setupStep: "address" };
    saveProfiles(profiles);
    return "Step 3/5: What's your default delivery address?";
  }

  if (step === "address") {
    profiles[phone] = { ...profile, defaultAddress: message.trim(), setupStep: "restaurant" };
    saveProfiles(profiles);
    return "Step 4/5: What's your usual restaurant? (e.g., Delhi Street)";
  }

  if (step === "restaurant") {
    profiles[phone] = { ...profile, usualRestaurant: message.trim(), setupStep: "items" };
    saveProfiles(profiles);
    return "Step 5/5: What's your usual order? List items separated by commas.\n(e.g., butter chicken, garlic naan, mango lassi)";
  }

  if (step === "items") {
    const items = message.split(",").map((i) => i.trim());
    profiles[phone] = { ...profile, usualItems: items, setupStep: "done" };
    saveProfiles(profiles);
    return `✅ All set! Your profile is saved.\n\nNow just text me things like:\n• "order me lunch"\n• "get me my usual"\n• "order butter chicken from Delhi Street"\n• "order dinner from [any restaurant]"`;
  }

  return null;
}

// Main SMS webhook
app.post("/sms", async (req, res) => {
  const phone = req.body.From;
  const message = req.body.Body?.trim();

  res.status(200).send("<Response></Response>"); // Respond to Twilio immediately

  try {
    const profiles = loadProfiles();
    const profile = profiles[phone] || {};
    const isSettingUp = profile.setupStep && profile.setupStep !== "done";

    // Handle setup flow
    if (isSettingUp || message?.toLowerCase().includes("setup")) {
      const reply = await handleSetup(phone, message);
      if (reply) await sendSMS(phone, reply);
      return;
    }

    // Check profile exists
    if (!profile.doordashEmail) {
      await sendSMS(
        phone,
        "Hey! I need to set up your profile first.\nText me \"setup\" to get started 🍕"
      );
      return;
    }

    // Parse the order intent
    await sendSMS(phone, "Got it! Placing your order now... 🛵");

    const orderIntent = await parseOrderIntent(message, phone);

    if (orderIntent.isSetup) {
      const reply = await handleSetup(phone, message);
      if (reply) await sendSMS(phone, reply);
      return;
    }

    // Place the order
    const result = await placeOrderOnDoorDash(orderIntent, phone);

    await sendSMS(
      phone,
      `✅ Order placed!\n\n🍽️ ${result.restaurant}\n📦 ${result.items.join(", ")}\n📍 ${result.address}\n💰 ${result.orderTotal}\n⏱️ ETA: ${result.eta}\n\nEnjoy your meal! 🎉`
    );
  } catch (err) {
    console.error("Order error:", err);

    let errorMsg = "❌ Something went wrong placing your order. Try again or check your DoorDash app.";

    if (err.message === "NO_PROFILE") {
      errorMsg = "You need to set up your profile first. Text \"setup\" to get started.";
    } else if (err.message === "NO_RESTAURANT") {
      errorMsg = "Which restaurant would you like to order from?";
    } else if (err.message === "NO_ADDRESS") {
      errorMsg = "I don't have a delivery address saved. Text \"setup\" to add one.";
    }

    await sendSMS(phone, errorMsg);
  }
});

// Health check
app.get("/", (req, res) => res.json({ status: "Food bot running 🍕" }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Food bot listening on port ${PORT}`));
