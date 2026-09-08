import fs from "node:fs";
import path from "node:path";

const target = process.argv[2] || "all";
const productionApiBase = "https://live-events-website.onrender.com";
const definitions = {
  public: { source: "public-site", destination: "dist/public-site", required: ["index.html", "style.css", "script.js", "manifest.webmanifest", "public-sw.js", "assets/public-icons/live-events-192.png", "assets/public-icons/live-events-512.png"] },
  admin: { source: "admin-site", destination: "dist/admin-site", required: ["index.html", "admin.css", "admin.js", "admin-manifest.json", "admin-sw.js", "admin-offline.html", "admin-offline.css", "admin-offline.js", "_redirects", "_headers"] },
};
const builds = target === "all" ? Object.entries(definitions) : [[target, definitions[target]]];
if (!builds[0][1]) throw new Error(`Unknown build target: ${target}`);
for (const [name, definition] of builds) {
  for (const file of definition.required)
    if (!fs.existsSync(path.join(definition.source, file))) throw new Error(`Missing ${name} build asset: ${file}`);
  fs.rmSync(definition.destination, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(definition.destination), { recursive: true });
  fs.cpSync(definition.source, definition.destination, { recursive: true });

  const replacePlaceholder = (token, value) => {
    const indexPath = path.join(definition.destination, "index.html");
    const html = fs.readFileSync(indexPath, "utf8");
    const replaced = html.replaceAll(token, value);
    fs.writeFileSync(indexPath, replaced);
  };

  if (name === "admin") {
    JSON.parse(fs.readFileSync(path.join(definition.source, "admin-manifest.json"), "utf8"));
    const apiBase = String(process.env.ADMIN_API_BASE_URL || productionApiBase).replace(/\/$/, "");
    replacePlaceholder("__ADMIN_API_BASE_URL__", apiBase);
  }
  if (name === "public") {
    const apiBase = String(process.env.PUBLIC_API_BASE_URL || productionApiBase).replace(/\/$/, "");
    replacePlaceholder("__PUBLIC_API_BASE_URL__", apiBase);
  }
  console.log(`${name} deployment package built (${definition.required.length} validated assets).`);
}
