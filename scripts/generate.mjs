// Generates plugins.json and README.md from plugins/*/plugin.json.
// Usage: node scripts/generate.mjs [--check]
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const PLUGINS_DIR = join(ROOT, "plugins");
const FOLDER_RE = /^[\w-][\w.-]*$/;
const ENTRY_FILES = ["index.ts", "index.tsx", "index.js", "index.jsx"];
const PLATFORMS = {
    web: "Web and Vesktop",
    browser: "Browser extension",
    desktop: "Desktop (Discord app and Vesktop)",
    discordDesktop: "Discord desktop app",
    vesktop: "Vesktop",
    dev: "Developer builds"
};

const check = process.argv.includes("--check");
const errors = [];
const readJson = path => JSON.parse(readFileSync(path, "utf8"));
const escapeRegExp = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const source = readJson(join(ROOT, "source.json"));

function loadPlugin(folder) {
    const dir = join(PLUGINS_DIR, folder);
    const fail = msg => void errors.push(`plugins/${folder}: ${msg}`);

    if (!FOLDER_RE.test(folder)) return fail("invalid folder name");

    const entry = ENTRY_FILES.find(f => existsSync(join(dir, f)));
    if (!entry) return fail(`missing ${ENTRY_FILES.join(" / ")}`);
    if (!existsSync(join(dir, "plugin.json"))) return fail("missing plugin.json");
    if (!existsSync(join(dir, "README.md"))) return fail("missing README.md");

    const meta = readJson(join(dir, "plugin.json"));
    for (const key of ["name", "description", "category", "version"])
        if (typeof meta[key] !== "string" || !meta[key].trim()) fail(`plugin.json: "${key}" must be a non-empty string`);
    if (!Array.isArray(meta.authors) || !meta.authors.length || !meta.authors.every(a => typeof a?.name === "string"))
        fail('plugin.json: "authors" must be a list of { "name": string, "github"?: string }');
    if (meta.requirements !== undefined && !(Array.isArray(meta.requirements) && meta.requirements.every(r => typeof r === "string")))
        fail('plugin.json: "requirements" must be a list of strings');
    if (typeof meta.name !== "string") return;

    // Vencord registers plugins by the name passed to definePlugin, so plugin.json has to match it
    const code = readFileSync(join(dir, entry), "utf8");
    const nameRe = new RegExp(`definePlugin\\(\\{[\\s\\S]*?\\bname:\\s*["'\`]${escapeRegExp(meta.name)}["'\`]`);
    if (!nameRe.test(code)) fail(`plugin.json name "${meta.name}" does not match the name in ${entry}`);

    const target = folder.match(/\.(\w+)$/)?.[1];
    if (target && !(target in PLATFORMS)) fail(`unknown folder suffix ".${target}"`);

    return {
        name: meta.name,
        folder,
        description: meta.description,
        category: meta.category,
        version: meta.version,
        authors: (meta.authors ?? []).map(({ name, github }) => (github ? { name, github } : { name })),
        target: target ?? null,
        requirements: meta.requirements ?? []
    };
}

const plugins = readdirSync(PLUGINS_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory() && !d.name.startsWith("."))
    .map(d => d.name)
    .sort()
    .map(loadPlugin)
    .filter(Boolean)
    .sort((a, b) => a.name.localeCompare(b.name));

for (const [i, p] of plugins.entries())
    if (plugins.findIndex(q => q.name === p.name) !== i) errors.push(`duplicate plugin name "${p.name}"`);

if (errors.length) {
    console.error(errors.map(e => "✗ " + e).join("\n"));
    process.exit(1);
}

const manifest = { name: source.name, description: source.description, repository: source.repository, plugins };

const encodePath = p => p.split("/").map(encodeURIComponent).join("/");
const authorLink = a => (a.github ? `[${a.name}](https://github.com/${a.github})` : a.name);

function renderPlugin(p) {
    const rows = [
        ["Author", p.authors.map(authorLink).join(", ")],
        ["Version", p.version],
        ["Platforms", p.target ? PLATFORMS[p.target] : "All"],
        ...(p.requirements.length ? [["Requires", p.requirements.join("; ")]] : [])
    ];
    const folderPath = encodePath(`plugins/${p.folder}`);
    return [
        `#### ${p.name}`,
        "",
        p.description,
        "",
        "| | |",
        "| --- | --- |",
        ...rows.map(([k, v]) => `| **${k}** | ${v} |`),
        "",
        `[Details](${folderPath}/README.md) · [Source](${folderPath}) · [Download .zip](${source.repository}/releases/latest/download/${encodeURIComponent(p.folder)}.zip)`
    ].join("\n");
}

const categories = [...new Set(plugins.map(p => p.category))].sort((a, b) => a.localeCompare(b));
const pluginsMd = categories.map(category => [
    `### ${category}`,
    "",
    plugins.filter(p => p.category === category).map(renderPlugin).join("\n\n")
].join("\n")).join("\n\n");

// Mirrors GitHub's heading anchor ids so the table of contents links work
function slugger() {
    const seen = new Map();
    return text => {
        const base = text.trim().toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, "").replace(/\s/g, "-");
        const n = seen.get(base) ?? 0;
        seen.set(base, n + 1);
        return n ? `${base}-${n}` : base;
    };
}

let readme = readFileSync(join(import.meta.dirname, "README.template.md"), "utf8")
    .replace(/\r\n/g, "\n")
    .replaceAll("{{SOURCE_NAME}}", source.name)
    .replaceAll("{{SOURCE_DESCRIPTION}}", source.description)
    .replaceAll("{{REPOSITORY}}", source.repository)
    .replace("{{PLUGINS}}", pluginsMd);

const slug = slugger();
const toc = [];
let inCode = false;
for (const line of readme.split("\n")) {
    if (line.startsWith("```")) inCode = !inCode;
    const heading = !inCode && line.match(/^(#{2,4}) (.+)$/);
    if (!heading) continue;
    const anchor = slug(heading[2]);
    if (heading[2] !== "Table of Contents")
        toc.push(`${"  ".repeat(heading[1].length - 2)}- [${heading[2]}](#${anchor})`);
}
readme = readme.replace("{{TOC}}", toc.join("\n"));

const outputs = {
    "plugins.json": JSON.stringify(manifest, null, 4) + "\n",
    "README.md": readme
};

let stale = false;
for (const [file, content] of Object.entries(outputs)) {
    const path = join(ROOT, file);
    const current = existsSync(path) ? readFileSync(path, "utf8").replace(/\r\n/g, "\n") : null;
    if (current === content) continue;
    if (check) {
        console.error(`✗ ${file} is out of date. Run: node scripts/generate.mjs`);
        stale = true;
    } else {
        writeFileSync(path, content);
        console.log(`✓ wrote ${file}`);
    }
}
if (stale) process.exit(1);
console.log(`✓ ${plugins.length} plugins in ${categories.length} categories`);
