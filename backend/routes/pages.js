const express = require("express");
const jwt = require("jsonwebtoken");
const auth = require("../middleware/auth");

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || "fallback-secret-change-in-production-12345";

// Helper to get current user from JWT cookie or auth header
function getUser(req) {
  try {
    const token = req.cookies?.auth_token || req.cookies?.token || req.headers.authorization?.split(" ")[1];
    if (!token) return null;
    return jwt.verify(token, JWT_SECRET);
  } catch (e) {
    return null;
  }
}

// ── Auth check middleware (redirect to /login if no valid JWT, or /settings if profile incomplete) ──
function requireAuth(req, res, next) {
  const user = getUser(req);
  if (!user) {
    if (req.headers["x-requested-with"] === "XMLHttpRequest") {
      return res.status(401).json({ ok: false, redirect: "/login" });
    }
    return res.redirect("/login");
  }
  req.pageUser = user;

  // Enforce profile completion guard (e.g. newly registered via Google OAuth)
  const isCompleted = user.isProfileCompleted === 1 || user.isProfileCompleted === true;
  if (!isCompleted && !req.path.startsWith("/settings") && req.path !== "/logout") {
    if (req.headers["x-requested-with"] === "XMLHttpRequest") {
      return res.status(200).json({ ok: false, redirect: "/settings" });
    }
    return res.redirect("/settings");
  }
  next();
}

const BUILD_VERSION = Date.now();

// ── Helper: render a page inside the layout shell (or JSON fragment for SPA router) ──
function renderPage(res, req, pageName, extra = {}) {
  // Prevent browser & proxy caches from serving SPA JSON fragments to full-page browser navigations!
  res.setHeader("Vary", "X-Requested-With, Accept");

  const isSecFetchDocument = req.headers["sec-fetch-dest"] === "document";
  const acceptsHtml = req.headers["accept"] && req.headers["accept"].includes("text/html");
  const isXhr = req.headers["x-requested-with"] === "XMLHttpRequest" && !isSecFetchDocument && !acceptsHtml;

  if (isXhr) {
    res.render(`pages/${pageName}`, {
      user: req.pageUser,
      activePage: pageName,
      appVersion: BUILD_VERSION,
      ...extra
    }, (err, html) => {
      if (err) {
        return res.status(500).json({ ok: false, error: err.message });
      }
      res.json({
        ok: true,
        page: pageName,
        html: html,
        pageCSS: pageName,
        pageJS: pageName,
        appVersion: BUILD_VERSION,
        user: req.pageUser
      });

    });
  } else {
    res.render("layout", {
      page: pageName,
      pageCSS: pageName,
      pageJS: pageName,
      appVersion: BUILD_VERSION,
      user: req.pageUser,
      ...extra
    });
  }
}

const auditStore = require("../stores/auditStore");

function checkPageRole(allowedRoles = ["devops", "admin", "super_admin"]) {
  return (req, res, next) => {
    const user = req.pageUser;
    if (user && !allowedRoles.includes(user.userType)) {
      console.error(
        `\x1b[31m[SECURITY ALERT] Unauthorized access attempt by @${user.username} (${user.userType}) to restricted route: ${req.originalUrl}\x1b[0m`
      );
      try {
        auditStore.logAction(
          user.username,
          `UNAUTHORIZED ACCESS ATTEMPT to ${req.originalUrl}`,
          "System",
          "Denied",
          "User Management"
        );
      } catch (e) {}
    }
    next();
  };
}

// ── Public Pages ──
router.get("/login", (req, res) => {
  const user = getUser(req);
  if (user) {
    return res.redirect("/");
  }
  res.render("login");
});

// ── Protected Pages ──
router.get("/", requireAuth, (req, res) => renderPage(res, req, "dashboard"));
router.get("/monitoring", requireAuth, checkPageRole(), (req, res) => renderPage(res, req, "monitoring"));
router.get("/audit-logs", requireAuth, checkPageRole(), (req, res) => renderPage(res, req, "audit-logs"));
router.get("/pipelines", requireAuth, (req, res) => renderPage(res, req, "pipelines"));
router.get("/build", requireAuth, (req, res) => renderPage(res, req, "build-logs"));
router.get("/certificates", requireAuth, checkPageRole(), (req, res) => renderPage(res, req, "certificates"));

const projectStore = require("../stores/projectStore");
const repositoryStore = require("../stores/repositoryStore");

router.get("/repos", requireAuth, async (req, res) => {
  const projects = await projectStore.listProjects().catch(() => []);
  const activeProj = projects.find(p => p.isActive) || projects[0];
  const repos = activeProj ? await repositoryStore.listRepositories(activeProj.id).catch(() => []) : [];
  renderPage(res, req, "repositories", { repos, activeProject: activeProj });
});
router.get("/repos/connect", requireAuth, async (req, res) => {
  const projects = await projectStore.listProjects().catch(() => []);
  const activeProj = projects.find(p => p.isActive) || projects[0];
  const repos = activeProj ? await repositoryStore.listRepositories(activeProj.id).catch(() => []) : [];
  renderPage(res, req, "repositories", { repos, activeProject: activeProj });
});
router.get("/branches", requireAuth, (req, res) => renderPage(res, req, "branches"));
router.get("/change-requests", requireAuth, (req, res) => renderPage(res, req, "change-requests"));
router.get("/change-requests/new", requireAuth, (req, res) => renderPage(res, req, "change-requests"));
router.get("/file-browser", requireAuth, (req, res) => renderPage(res, req, "file-browser"));
router.get("/file-browser/*", requireAuth, (req, res) => renderPage(res, req, "file-browser"));

router.get("/approvals", requireAuth, checkPageRole(), (req, res) => renderPage(res, req, "approvals"));
router.get("/builds", requireAuth, checkPageRole(), (req, res) => renderPage(res, req, "build-history"));
router.get("/scaling", requireAuth, checkPageRole(), (req, res) => renderPage(res, req, "scaling"));
router.get("/beta", requireAuth, checkPageRole(), (req, res) => renderPage(res, req, "beta-environment"));
router.get("/release", requireAuth, checkPageRole(), (req, res) => renderPage(res, req, "release"));

router.get("/team", requireAuth, (req, res) => renderPage(res, req, "team-access"));
router.get("/setup", requireAuth, checkPageRole(), (req, res) => renderPage(res, req, "setup-wizard"));
router.get("/setup/:step", requireAuth, checkPageRole(), (req, res) => renderPage(res, req, "setup-wizard"));

router.get("/admin/users", requireAuth, checkPageRole(), (req, res) => renderPage(res, req, "admin-users"));
const credManager = require("../services/credentialManager");

router.get("/project-settings", requireAuth, checkPageRole(), (req, res) => renderPage(res, req, "project-settings"));
router.get("/settings/project", requireAuth, (req, res) => res.redirect("/project-settings"));

router.get("/settings", requireAuth, async (req, res) => {
  const creds = await credManager.listCredentials(req.pageUser.username).catch(() => []);
  renderPage(res, req, "settings", { credentials: creds });
});
router.get("/settings/:tab", requireAuth, async (req, res) => {
  if (req.params.tab === "project") return res.redirect("/project-settings");
  const creds = await credManager.listCredentials(req.pageUser.username).catch(() => []);
  renderPage(res, req, "settings", { credentials: creds });
});
router.get("/new-project", requireAuth, checkPageRole(), (req, res) => renderPage(res, req, "new-project"));

// ── Catch-all: redirect unknown routes to dashboard ──
router.get("*", requireAuth, (req, res) => res.redirect("/"));

module.exports = router;

