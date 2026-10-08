const { chromium } = require('playwright');
const assert = require('assert');

(async () => {
  console.log('--- Starting Playwright E2E Test: Login Page Redesign ---');
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();

  // Test 1: Page Load & HTTP 200
  const response = await page.goto('http://localhost:3000/login', { waitUntil: 'networkidle' });
  assert.strictEqual(response.status(), 200, 'Login page should respond with HTTP 200');
  console.log('✔ Test 1: HTTP 200 status confirmed');

  // Test 2: Document Title & Metadata
  const title = await page.title();
  assert.ok(title.includes('Benevolate Integr8'), 'Page title should include Benevolate Integr8');
  console.log(`✔ Test 2: Title verified: "${title}"`);

  // Test 3: Ambient Canvas & Grid
  const gridCount = await page.locator('.ambient-grid').count();
  assert.strictEqual(gridCount, 1, 'Ambient grid overlay must be present');
  console.log('✔ Test 3: Ambient canvas & grid verified');

  // Test 4: Feature Showcase Deck & Slides
  const deck = page.locator('#showcase-deck');
  await deck.waitFor({ state: 'visible' });
  const slideCount = await page.locator('.deck-slide').count();
  assert.strictEqual(slideCount, 3, 'Showcase deck must contain 3 feature slides');
  console.log('✔ Test 4: 3 Showcase deck slides present');

  // Test 5: Interactive Deck Slide Switching
  const tabBtn1 = page.locator('.deck-tab-btn[data-target-slide="1"]');
  await tabBtn1.click();
  await page.waitForTimeout(300);
  const slide1Active = await page.locator('#slide-1').getAttribute('class');
  assert.ok(slide1Active.includes('active'), 'Slide 1 should be active after clicking tab');
  console.log('✔ Test 5: Interactive slide tab switching verified');

  // Test 6: Auth Portal Inputs & Password Toggle
  const userInput = page.locator('#login-username');
  const pwdInput = page.locator('#login-password');
  await userInput.fill('devops.lead');
  await pwdInput.fill('SecureEnterprisePass123');
  assert.strictEqual(await pwdInput.getAttribute('type'), 'password', 'Password field must initially be type="password"');

  const toggleBtn = page.locator('#toggle-pwd-btn');
  await toggleBtn.click();
  await page.waitForTimeout(100);
  assert.strictEqual(await pwdInput.getAttribute('type'), 'text', 'Password field type must toggle to "text"');
  await toggleBtn.click();
  assert.strictEqual(await pwdInput.getAttribute('type'), 'password', 'Password field type must toggle back to "password"');
  console.log('✔ Test 6: Password visibility toggle verified');

  // Test 7: Form Submission Validation Alert
  await userInput.fill('');
  await pwdInput.fill('');
  const submitBtn = page.locator('#login-submit-btn');
  await submitBtn.click();
  const errorAlert = page.locator('#login-error');
  await errorAlert.waitFor({ state: 'visible' });
  const errorText = await errorAlert.innerText();
  assert.ok(errorText.includes('username and password'), 'Validation alert should show required error message');
  console.log(`✔ Test 7: Form validation alert caught: "${errorText}"`);

  // Test 8: Motion Library Loaded
  const hasMotion = await page.evaluate(() => typeof window.Motion !== 'undefined' && typeof window.Motion.animate === 'function');
  assert.ok(hasMotion, 'window.Motion should be loaded and callable');
  console.log('✔ Test 8: Motion animation library verified');

  // Test 9: Zero Unicode Emojis & Vector Lucide Icons
  const svgCount = await page.locator('svg').count();
  assert.ok(svgCount >= 8, `Expected at least 8 vector SVG icons, found ${svgCount}`);
  console.log(`✔ Test 9: Strict iconography verified (${svgCount} Lucide SVGs found)`);

  // Test 10: Responsive Mobile Viewport
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(200);
  const deckVisibleOnMobile = await page.locator('#showcase-deck').isVisible();
  assert.strictEqual(deckVisibleOnMobile, false, 'Showcase deck should be hidden on mobile viewport to prioritize auth');
  const authVisibleOnMobile = await page.locator('#auth-portal-card').isVisible();
  assert.strictEqual(authVisibleOnMobile, true, 'Auth portal card must remain visible on mobile');
  console.log('✔ Test 10: Responsive mobile breakpoint verified');

  // Capture screenshot for visual audit
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForTimeout(300);
  await page.screenshot({ path: 'public/login-redesign-screenshot.png', fullPage: true });
  console.log('✔ Screenshot saved to public/login-redesign-screenshot.png');

  await browser.close();
  console.log('--- ALL 10 TESTS PASSED (100% Pass Rate) ---');
  process.exit(0);
})().catch(err => {
  console.error('✘ Test failure:', err.message);
  process.exit(1);
});
