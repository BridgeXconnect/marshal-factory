import "./test-guard";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { factorySchema } from "../lib/config";
import { commitIdentity, emailProblem, resolveCommitIdentity, setCommitIdentity, TEST_COMMIT_IDENTITY } from "../lib/commit-identity";
import { baseLayers } from "../lib/sandbox-image-build";

// The author of the factory's commits: configured, else the gh account's noreply address, else the
// runner refuses to start. The old author email was no real address and Vercel refused its commits.
const OLD = "marshal-factory@users.noreply.github.com";
const CONFIGURED = "4242+configured@users.noreply.github.com";
const noGh = async () => assert.fail("gh is not asked when the email is configured");

// A configured email wins, and gh is never asked.
assert.deepEqual(await resolveCommitIdentity({ name: "marshal-factory", email: CONFIGURED }, noGh), { name: "marshal-factory", email: CONFIGURED });
assert.deepEqual(
  factorySchema.parse({ commitAuthor: { email: "owner@example.com" } }).commitAuthor,
  { name: "marshal-factory", email: "owner@example.com" },
  "any real address may be configured; the name defaults",
);

// Unset: the gh login gives <id>+<login>@users.noreply.github.com.
const defaults = factorySchema.parse({}).commitAuthor;
assert.deepEqual(defaults, { name: "marshal-factory" }, "no email by default, so none is made up");
assert.deepEqual(await resolveCommitIdentity(defaults, async () => ({ id: 77, login: "someone", name: "x" })), {
  name: "marshal-factory",
  email: "77+someone@users.noreply.github.com",
});

// No config and no gh: a loud error that names the fix, never a fallback address.
for (const broken of [
  async () => {
    throw new Error("gh: To get started with GitHub CLI, please run:  gh auth login\nmore");
  },
  async () => ({ message: "Bad credentials" }),
  async () => ({ id: "77", login: "someone" }),
]) {
  await assert.rejects(resolveCommitIdentity(defaults, broken), (error: Error) => {
    assert.match(error.message, /^No commit author email: factory\.commitAuthor\.email is not set/);
    assert.match(error.message, /gh auth login/);
    assert.doesNotMatch(error.message, /\n/, "one line for the runner's log");
    return true;
  });
}

// The old address, and any noreply address GitHub cannot tie to an account, is refused.
for (const bad of [OLD, "someone@users.noreply.github.com", "not an email", ""]) {
  assert.ok(emailProblem(bad), `${JSON.stringify(bad)} is refused`);
  assert.throws(() => factorySchema.parse({ commitAuthor: { email: bad } }), `config with ${JSON.stringify(bad)} does not load`);
}
assert.match(emailProblem(OLD)!, /without an account id/);
for (const good of [CONFIGURED, "owner@example.com"]) assert.equal(emailProblem(good), null, good);

// The runner's identity: set at start-up; a regression run without one gets the test identity.
assert.deepEqual(commitIdentity(), TEST_COMMIT_IDENTITY);
setCommitIdentity({ name: "marshal-factory", email: CONFIGURED });
assert.equal(commitIdentity().email, CONFIGURED);
setCommitIdentity(undefined);

// The image bakes no author: each launch writes the runner's (see sandbox and lifecycle regressions).
const layers = baseLayers({
  appName: "a",
  t3Version: "t",
  claudeCodeVersion: "c",
  codexVersion: "x",
  playwrightMcpVersion: "p",
  pstack: { repo: "o/r", commit: "0".repeat(40), version: "1" },
}).join("\n");
assert.doesNotMatch(layers, /user\.(name|email)/, "no identity in the image");
assert.match(layers, /credential\.https:\/\/github\.com\.helper factory/, "the rest of the git config stays");

// No source outside the regressions can produce the old address.
const root = join(import.meta.dirname, "..");
let found = "";
try {
  found = execFileSync("git", ["-C", root, "grep", "-l", "--untracked", "-F", OLD, "--", ".", ":!scripts/*-regressions.ts"], { encoding: "utf8" });
} catch (error) {
  if ((error as { status?: number }).status !== 1) throw error;
}
assert.equal(found, "", `the old address is gone from source: ${found}`);

console.log("commit identity regressions passed");
