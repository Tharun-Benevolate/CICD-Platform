// server.js — Benevolate CI/CD Platform entry point.
//
// Merged from:
//   main project:  server.js  (organized middleware/ routes/ stores/ config/ structure)
//   mergeproject:  server.js  (adds betaOrgStore, releasePromotionStore, public beta routes)
//
// Architecture:
//   - Thin entry point: wires middleware, mounts routes, starts server.
//   - All route logic lives in ./routes/*.js
//   - In production, React app is built to ./public/ by `npm run build` in the client dir.
//   - In development, Vite proxies /api calls here from :5173.

require("dotenv").config();
const express     = require("express");
const fs          = require("fs");
const path        = require("path");
const cookieParser= require("cookie-parser");
const auth        = require("./middleware/auth");
const db          = require("./config/db");
const aws         = require("./config/aws");
const store       = require("./stores/projectStore");
const auditStore  = require("./stores/auditStore");
const userStore   = require("./stores/userStore");
const betaOrgStore= require("./stores/betaOrgStore");
const releaseStore= require("./stores/releasePromotionStore");
const betaImageStore = require("./stores/betaImageStore");

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Core middleware ───────────────────────────────────────────────────────
app.use(express.json({ limit: "10mb" }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, "public"), { index: false }));

// ── Pre-auth routes (no session required) ────────────────────────────────
app.use("/api", require("./routes/auth"));
app.use("/api/webhooks", require("./routes/webhooks"));
app.use("/api", require("./routes/oauth")); // GitHub + Slack OAuth callbacks (needs auth cookie from redirect)

// ── Public beta routing helpers (called by deployed apps at login) ────────
// These are intentionally unauthenticated — the deployed golf app calls these
// at login time to know whether to route the user to prod-beta.
app.get("/api/public/is-beta-org", async (req, res) => {
  try {
    const { orgId } = req.query;
    if (!orgId) return res.json({ isBeta: false });
    const isBetaOrg = await betaOrgStore.isBetaOrg(orgId);
    if (!isBetaOrg) return res.json({ isBeta: false });

    const projects   = await store.listProjects().catch(() => []);
    let betaFleetUp  = false;
    for (const p of projects) {
      if (!p.prodBetaServiceName || !p.ecsClusterName) continue;
      try {
        const svc = await aws.describeEcsService(p.region || "us-east-1", p.ecsClusterName, p.prodBetaServiceName);
        if ((svc?.desiredCount || 0) > 0 && (svc?.runningCount || 0) > 0) { betaFleetUp = true; break; }
      } catch { /* ignore */ }
    }
    res.json({ isBeta: betaFleetUp, betaFleetUp });
  } catch (err) {
    res.status(500).json({ isBeta: false, error: err.message });
  }
});

app.get("/api/public/org-for-domain", async (req, res) => {
  try {
    const { domain } = req.query;
    if (!domain) return res.json({ orgId: null });
    const orgId = await betaOrgStore.orgIdForDomain(domain);
    res.json({ orgId });
  } catch (err) {
    res.status(500).json({ orgId: null, error: err.message });
  }
});

// ── Global auth middleware for all remaining /api routes ──────────────────
app.use("/api", (req, res, next) => {
  if (req.path === "/health") return next();
  auth.requireAuth(req, res, next);
});

// ── Health check ──────────────────────────────────────────────────────────
app.get("/api/health", async (req, res) => {
  const { getActiveLabel } = require("./config/db");
  let awsStatus = "unchecked";
  try {
    const region     = process.env.AWS_REGION || "us-east-1";
    const awsPromise = aws.checkCredentials(region);
    const timeout    = new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 3000));
    const result     = await Promise.race([awsPromise, timeout]);
    awsStatus        = result?.ok ? "ok" : "error";
  } catch {
    awsStatus = "unreachable";
  }
  res.json({ ok: true, db: getActiveLabel(), aws: awsStatus, uptime: process.uptime() });
});

// ── Protected route modules ───────────────────────────────────────────────
// Overview / Infra
app.use("/api", require("./routes/projects"));
app.use("/api", require("./routes/terraform"));
app.use("/api", require("./routes/setup"));
app.use("/api", require("./routes/pipeline"));
app.use("/api", require("./routes/build"));
app.use("/api", require("./routes/deploy"));

// Source control
app.use("/api", require("./routes/repos"));
app.use("/api", require("./routes/github"));
app.use("/api", require("./routes/fileBrowser"));
app.use("/api", require("./routes/changeRequests"));
app.use("/api", require("./routes/reviews"));

// Access + credentials
app.use("/api", require("./routes/access"));
app.use("/api", require("./routes/credentials"));

// Beta environment + release promotion (from mergeproject)
// Mount betaRelease BEFORE deploy so /bluegreen/status routes take precedence
app.use("/api", require("./routes/betaRelease"));

// User
app.use("/api", require("./routes/notifications"));
app.use("/api", require("./routes/profile"));
app.use("/api", require("./routes/appLogs"));

// ── Serve React SPA for all non-API routes ────────────────────────────────
app.get("*", (req, res) => {
  const indexPath = path.join(__dirname, "public", "index.html");
  if (fs.existsSync(indexPath)) {
    res.sendFile(indexPath);
  } else {
    const clientUrl = process.env.CLIENT_URL || "http://localhost:5173";
    res.redirect(`${clientUrl}${req.originalUrl}`);
  }
});

// ── Startup ───────────────────────────────────────────────────────────────
async function start() {
  try {
    // Connect to database (with Aurora fallback)
    await db.verifyConnection();

    // Run schema migrations (self-healing — safe to re-run on every start)
    await userStore.ensureSchema?.();
    await store.ensureSchema?.();
    await auditStore.ensureSchema?.();
    await betaOrgStore.ensureSchema?.();
    await releaseStore.ensureSchema?.();
    await betaImageStore.ensureSchema?.();
    // Auto-cleanup beta images older than 10 days that were never deployed
    betaImageStore.cleanupStaleImages().catch(() => {});

    app.listen(PORT, () => {
      console.log(`\n🚀 Benevolate server running → http://localhost:${PORT}`);
      console.log(`   Environment: ${process.env.NODE_ENV || "development"}`);
    });
  } catch (err) {
    console.error("✘  Startup failed:", err.message);
    process.exit(1);
  }
}

start();
