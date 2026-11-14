import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG_PATH } from "../lib/config";
import { json, withCodexReportServer, withHooks, withServer, type Json } from "../lib/target-wiring";

// Wires a target repo to this checkout: hooks, the factory-report MCP server, the playbook; and, once per
// machine, the same server into a local Codex's own config, which has no hooks and no .mcp.json.
// Re-running converges on the same files and merges with what the repo already has.

const root = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");

const readJson = (path: string): Json =>
  existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Json) : {};

function write(path: string, content: string) {
  if (existsSync(path) && readFileSync(path, "utf8") === content) {
    console.log(`unchanged ${path}`);
    return;
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  console.log(`wrote     ${path}`);
}

const target = process.argv[2];
if (!target || !existsSync(join(target, ".git"))) {
  console.error("usage: bun scripts/install-target.ts <path to a git repo>");
  process.exit(1);
}

// Cleanup walks the repos listed in the config; the file holds secrets, so it stays owner-only.
const configPath = CONFIG_PATH;
const config = readJson(configPath);
const factory = (config.factory as Json | undefined) ?? {};
const repo = resolve(target);
if (!existsSync(configPath)) {
  console.log(`skipped   factory.repos: ${configPath} does not exist yet; add ${repo} there by hand`);
} else if (!((factory.repos as string[] | undefined) ?? []).includes(repo)) {
  factory.repos = [...((factory.repos as string[] | undefined) ?? []), repo];
  writeFileSync(configPath, json({ ...config, factory }));
  chmodSync(configPath, 0o600);
  console.log(`added     ${repo} to factory.repos in ${configPath}`);
}

const settingsPath = join(target, ".claude/settings.json");
write(settingsPath, json(withHooks(readJson(settingsPath), root)));
const mcpPath = join(target, ".mcp.json");
write(mcpPath, json(withServer(readJson(mcpPath), root)));
write(
  join(target, ".agents/playbooks/factory.md"),
  readFileSync(join(root, "playbooks/factory.md"), "utf8"),
);

// A local Codex reads only its own config ($CODEX_HOME or ~/.codex), and its server must post stages itself.
// Only the factory-report table is added or updated; no Codex install (no folder) is left alone.
const codexHome = process.env.CODEX_HOME ?? join(homedir(), ".codex");
if (!existsSync(codexHome)) {
  console.log(`skipped   ${join(codexHome, "config.toml")}: no Codex folder here, so no local Codex to wire`);
} else {
  const codexPath = join(codexHome, "config.toml");
  try {
    write(codexPath, withCodexReportServer(existsSync(codexPath) ? readFileSync(codexPath, "utf8") : "", root));
  } catch (error) {
    console.log(`skipped   ${codexPath}: ${(error as Error).message}`);
  }
}

// Claude Code puts isolated subagents in .claude/worktrees/; linting them breaks the repo's lint.
const eslintConfig = ["eslint.config.mjs", "eslint.config.js", "eslint.config.ts"]
  .map((name) => join(target, name))
  .find(existsSync);
if (eslintConfig) {
  const text = readFileSync(eslintConfig, "utf8");
  if (text.includes(".claude/")) console.log(`unchanged ${eslintConfig}`);
  else if (text.includes("globalIgnores([")) write(eslintConfig, text.replace("globalIgnores([", 'globalIgnores([\n    ".claude/**",'));
  else console.log(`skipped   ${eslintConfig}: add ".claude/**" to its ignores by hand`);
}
