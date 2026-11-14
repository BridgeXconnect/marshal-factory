import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codexReportSection, withCodexReportServer } from "../lib/target-wiring";

// A local Codex has no hooks and reads no .mcp.json, so install-target writes the factory-report server
// into its own config.toml: with FACTORY_REPORTER = "mcp", and nothing else in the file changed.

const ROOT = "/Users/test/marshal-factory";
const SERVER = `${ROOT}/mcp/factory-report.ts`;
const parse = (text: string) => Bun.TOML.parse(text) as Record<string, unknown> & { mcp_servers?: Record<string, unknown> };
const without = (parsed: ReturnType<typeof parse>) => {
  const servers = { ...parsed.mcp_servers };
  delete servers["factory-report"];
  return { ...parsed, mcp_servers: servers };
};
const wired = { command: "bun", args: [SERVER], env: { FACTORY_REPORTER: "mcp" } };

// A config shaped like a real one: top-level keys, a comment, a table with a sub-table, an array-valued key.
const ORIGINAL = `# my codex config
notify = [
    "/Applications/Notifier",
    "turn-ended",
]
model = "gpt-6.1-sol"

[mcp_servers.railway]
command = "railway"
args = ["mcp"]

[mcp_servers.node_repl]
command = "/bin/node_repl"
env_vars = ["A", "B"]

[mcp_servers.node_repl.env]
CODEX_HOME = "/h"
NOTE = "has [brackets] and a # hash"

[projects."/Users/test/code"]
trust_level = "trusted"
`;

// Appended: everything before it is byte for byte what it was, and it parses to the same plus our server.
{
  const next = withCodexReportServer(ORIGINAL, ROOT);
  assert.ok(next.startsWith(ORIGINAL.trimEnd()), "the existing file is untouched");
  assert.ok(next.includes('FACTORY_REPORTER = "mcp"'), "the written config names the mcp reporter");
  assert.deepEqual(without(parse(next)), without(parse(ORIGINAL)), "nothing else in the file changed");
  assert.deepEqual(parse(next).mcp_servers!["factory-report"], wired);
  assert.equal(next.endsWith("\n"), true);
  assert.equal(withCodexReportServer(next, ROOT), next, "writing it again changes nothing");
}

// An empty or missing file becomes just the section.
assert.equal(withCodexReportServer("", ROOT), codexReportSection(ROOT));
assert.deepEqual(parse(withCodexReportServer("", ROOT)).mcp_servers, { "factory-report": wired });

// A section pointing at another checkout, or reporting as a hook, is replaced in place; its neighbours are not touched.
for (const stale of [
  `[mcp_servers.factory-report]\ncommand = "bun"\nargs = ["/old/checkout/mcp/factory-report.ts"]\nenv = { FACTORY_REPORTER = "mcp" }\n`,
  `[mcp_servers.factory-report]\ncommand = "bun"\nargs = ["${SERVER}"]\nenv = { FACTORY_REPORTER = "hook" }\n`,
  `[mcp_servers.factory-report]\ncommand = "bun"\nargs = ["/old/mcp/factory-report.ts"]\n\n[mcp_servers.factory-report.env]\nFACTORY_REPORTER = "hook"\n`,
]) {
  const before = `${ORIGINAL.split("[mcp_servers.node_repl]")[0]}${stale}\n[mcp_servers.node_repl]${ORIGINAL.split("[mcp_servers.node_repl]")[1]}`;
  const next = withCodexReportServer(before, ROOT);
  assert.deepEqual(parse(next).mcp_servers!["factory-report"], wired, "the section now runs this checkout as the mcp reporter");
  assert.deepEqual(without(parse(next)), without(parse(before)), "and nothing else changed");
  assert.equal(next.split("[mcp_servers.factory-report").length - 1, 1, "there is exactly one table for it");
  assert.ok(next.startsWith(before.split("[mcp_servers.factory-report")[0]!), "text before it is byte for byte");
  assert.ok(next.endsWith(`[mcp_servers.node_repl]${ORIGINAL.split("[mcp_servers.node_repl]")[1]}`), "text after it is byte for byte");
}

// A hand-written section that already runs this checkout as the mcp reporter is left exactly as written, extra env and all.
{
  const mine = `${ORIGINAL}\n[mcp_servers.factory-report]\ncommand = "bun"\nargs = ["${SERVER}"]\nenv = { FACTORY_REPORTER = "mcp", FACTORY_JOB_KEY = "BRI-1", FACTORY_ATTEMPT = "1" }\n`;
  assert.equal(withCodexReportServer(mine, ROOT), mine);
}

// A server set inline under [mcp_servers] is not ours to rewrite.
assert.throws(() => withCodexReportServer(`[mcp_servers]\nfactory-report = { command = "x" }\n`, ROOT), /by hand/);

// The installer end to end, in a throwaway HOME so the real Codex config and the factory's own are never touched.
{
  const home = mkdtempSync(join(tmpdir(), "codex-wiring-"));
  const repo = join(home, "repo");
  mkdirSync(join(repo, ".git"), { recursive: true });
  const codexHome = join(home, "codex");
  const env = { ...process.env, HOME: home, CODEX_HOME: codexHome, MARSHAL_FACTORY_CONFIG: join(home, "none.json") };
  const run = () => execFileSync("bun", [join(import.meta.dirname, "install-target.ts"), repo], { env, encoding: "utf8" });

  assert.match(run(), /skipped\s+\S*config\.toml: no Codex folder/, "no Codex folder: nothing is created");
  assert.equal(existsSync(codexHome), false);

  mkdirSync(codexHome);
  writeFileSync(join(codexHome, "config.toml"), ORIGINAL);
  assert.match(run(), /wrote\s+\S*config\.toml/);
  const written = readFileSync(join(codexHome, "config.toml"), "utf8");
  assert.ok(written.startsWith(ORIGINAL.trimEnd()));
  assert.deepEqual(without(parse(written)), without(parse(ORIGINAL)));
  const server = parse(written).mcp_servers!["factory-report"] as typeof wired;
  assert.deepEqual(server.env, { FACTORY_REPORTER: "mcp" });
  assert.ok(server.args[0]!.endsWith("/mcp/factory-report.ts"));
  assert.match(run(), /unchanged\s+\S*config\.toml/, "running it again changes nothing");
  assert.equal(readFileSync(join(codexHome, "config.toml"), "utf8"), written);
}

console.log("codex wiring regressions passed");
