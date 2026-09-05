import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

test("public and administrator deployment sources are complete while root fallbacks remain", () => {
  for (const file of [
    "index.html", "style.css", "script.js", "admin.html", "admin.js", "admin.css",
    "public-site/index.html", "public-site/style.css", "public-site/script.js",
    "admin-site/index.html", "admin-site/admin.js", "admin-site/admin.css",
    "admin-site/admin-manifest.json", "admin-site/admin-sw.js", "admin-site/admin-offline.html",
    "admin-site/_headers", "admin-site/_redirects", "admin-site/netlify.toml",
  ]) assert.equal(fs.existsSync(file), true, `${file} should exist`);
});

test("administrator Netlify package contains no server secrets and remains noindex", () => {
  const files = ["admin-site/index.html", "admin-site/admin.js", "admin-site/_headers"];
  const content = files.map((file) => fs.readFileSync(file, "utf8")).join("\n");
  assert.doesNotMatch(content, /SUPABASE_SERVICE_ROLE_KEY|DATABASE_URL|BREVO_API_KEY|COOKIE_SECRET/);
  assert.match(content, /noindex/);
  assert.match(content, /__ADMIN_API_BASE_URL__/);
});

test("separate administrator service worker excludes API responses", () => {
  const worker = fs.readFileSync("admin-site/admin-sw.js", "utf8");
  assert.match(worker, /\/api\//);
  assert.doesNotMatch(worker, /orders|payments|customer records|access_token|refresh_token/i);
  const assets = worker.match(/SAFE_ASSETS\s*=\s*\[([^\]]+)/s)?.[1] || "";
  assert.doesNotMatch(assets, /index\.html/);
});
