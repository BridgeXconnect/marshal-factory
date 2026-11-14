import { join } from "node:path";
import { REPORT_SERVER, REPORT_STAGE_TOOL } from "./factory";

// How a target repo reaches a factory checkout: Claude Code hooks, the factory-report MCP server.
// Pure, so the installer and the sandbox launch wire the same way from different factory roots.

export type Json = Record<string, unknown>;
type HookEntry = {
  matcher?: string;
  hooks: { type: string; command: string; async?: boolean; timeout?: number }[];
};

/** Ours, per event, in order. PostToolUse takes every tool so the reporter can send usage snapshots. */
function hooksFor(root: string): Record<string, HookEntry[]> {
  const reporter = { type: "command", command: `bun "${join(root, "hooks/report.ts")}"`, async: true, timeout: 20 };
  return {
    SessionStart: [{ hooks: [reporter] }],
    PreToolUse: [{ matcher: "Agent", hooks: [reporter] }],
    PostToolUse: [{ hooks: [reporter] }],
    SubagentStop: [{ hooks: [reporter] }],
    Stop: [{ hooks: [reporter] }],
    SessionEnd: [{ hooks: [reporter] }],
  };
}

/** hooks/budget.ts counts as ours so rewiring a repo from before the cap was removed drops it. */
const isOurs = (entry: HookEntry) => entry.hooks?.some((hook) => /hooks\/(report|budget)\.ts/.test(hook.command ?? ""));

export function withHooks(settings: Json, root: string): Json {
  const hooks = { ...((settings.hooks as Record<string, HookEntry[]>) ?? {}) };
  for (const [event, ours] of Object.entries(hooksFor(root))) {
    hooks[event] = [...(hooks[event] ?? []).filter((entry) => !isOurs(entry)), ...ours];
  }
  const permissions = (settings.permissions as Json) ?? {};
  const allow = new Set([...((permissions.allow as string[]) ?? []), REPORT_STAGE_TOOL]);
  const enabled = new Set([...((settings.enabledMcpjsonServers as string[]) ?? []), REPORT_SERVER]);
  return {
    ...settings,
    enabledMcpjsonServers: [...enabled],
    permissions: { ...permissions, allow: [...allow] },
    hooks,
  };
}

export const reportServer = (root: string) => ({ command: "bun", args: [join(root, "mcp/factory-report.ts")] });

/** Claude Code's hooks report its stages, so its server only validates. */
export function withServer(mcp: Json, root: string): Json {
  return { ...mcp, mcpServers: { ...((mcp.mcpServers as Json) ?? {}), [REPORT_SERVER]: { ...reportServer(root), env: { FACTORY_REPORTER: "hook" } } } };
}

/**
 * The `factory-report` section of a local Codex's config. Codex has no hooks, so the server posts each
 * report_stage itself (`FACTORY_REPORTER = "mcp"`). It names no job: one file serves every local job, so
 * the server reports for the factory branch checked out in the working directory it starts in, which is
 * how a local job's worktree names its job and attempt. A sandbox launch, which has one job, sets
 * FACTORY_JOB_KEY and FACTORY_ATTEMPT instead (runner/sandbox.ts).
 */
export function codexReportSection(root: string) {
  const { command, args } = reportServer(root);
  return `[mcp_servers.${REPORT_SERVER}]\ncommand = ${JSON.stringify(command)}\nargs = ${JSON.stringify(args)}\nenv = { FACTORY_REPORTER = "mcp" }\n`;
}

const TABLE_HEADER = /^\s*\[\[?\s*([^\]]*?)\s*\]\]?\s*(#.*)?$/;
const OURS = new RegExp(`^mcp_servers\\s*\\.\\s*"?${REPORT_SERVER}"?\\s*(\\.|$)`);

/**
 * `toml` with the factory-report server wired for a local Codex, changing nothing else: the file is
 * edited as text, so comments and every other table stay byte for byte. Appended when absent; an
 * existing section is replaced in place only when it does not already run this checkout's server
 * with `FACTORY_REPORTER = "mcp"`. A server written as an inline key of `[mcp_servers]` is not ours to
 * rewrite, so it throws.
 */
export function withCodexReportServer(toml: string, root: string): string {
  const section = codexReportSection(root);
  const lines = toml.split("\n");
  const ours = (line: string) => OURS.test(TABLE_HEADER.exec(line)?.[1] ?? "");
  const first = lines.findIndex(ours);
  if (first === -1) {
    if (new RegExp(`^\\s*"?${REPORT_SERVER}"?\\s*=`, "m").test(toml)) throw new Error(`${REPORT_SERVER} is already set inline under [mcp_servers]; edit it by hand`);
    const body = toml.trimEnd();
    return body === "" ? section : `${body}\n\n${section}`;
  }
  let end = first;
  while (end < lines.length && (end === first || !TABLE_HEADER.test(lines[end]!) || ours(lines[end]!))) end++;
  const block = lines.slice(first, end).join("\n");
  const wired = block.includes(JSON.stringify(reportServer(root).args[0])) && /FACTORY_REPORTER\s*=\s*"mcp"/.test(block);
  if (wired) return toml;
  const kept = [...lines.slice(0, first), ...section.trimEnd().split("\n"), ...(end < lines.length ? [""] : []), ...lines.slice(end)];
  return kept.join("\n");
}

/** The factory checkouts a repo's committed wiring points at, read from its settings and .mcp.json text. */
export function wiredRoots(...files: (string | null)[]) {
  const roots = new Set<string>();
  for (const text of files) {
    for (const match of (text ?? "").matchAll(/(\/[^"\s]*?)\/(?:hooks\/(?:report|budget)|mcp\/factory-report)\.ts/g)) roots.add(match[1]!);
  }
  return [...roots];
}

export const json = (value: Json) => `${JSON.stringify(value, null, 2)}\n`;
