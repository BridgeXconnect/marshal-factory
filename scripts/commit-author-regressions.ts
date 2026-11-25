import "./test-guard";
import assert from "node:assert/strict";

const { COMMIT_NAME, identityArgs, noreplyEmail, resolveCommitAuthor } = await import("../lib/commit-author");
const { factorySchema, loadConfig, TEST_COMMIT_EMAIL } = await import("../lib/config");
const { baseLayers } = await import("../lib/sandbox-image-build");
const { commitAuthor, commitAuthorRuntime } = await import("../runner/commit-author");

// The address GitHub ties to no account, which Vercel rejects as a commit author.
const UNOWNED = "marshal-factory@users.noreply.github.com";
const noGh = async () => {
  throw new Error("gh was asked although an email is configured");
};

// A configured email is used as is, under the factory's name.
assert.deepEqual(await resolveCommitAuthor("factory@example.com", noGh), { name: COMMIT_NAME, email: "factory@example.com" });
assert.equal(COMMIT_NAME, "marshal-factory");
assert.deepEqual(identityArgs({ name: COMMIT_NAME, email: "factory@example.com" }), ["-c", "user.name=marshal-factory", "-c", "user.email=factory@example.com"]);

// Unset, it is the gh account's noreply address in GitHub's <id>+<login> form.
assert.equal(noreplyEmail({ id: 42, login: "someone" }), "42+someone@users.noreply.github.com");
assert.deepEqual(await resolveCommitAuthor(undefined, async () => ({ id: 42, login: "someone" })), { name: COMMIT_NAME, email: "42+someone@users.noreply.github.com" });

// Unset with no gh account, it fails with a message that names the fix, never falling back.
await assert.rejects(
  resolveCommitAuthor(undefined, async () => {
    throw new Error("gh: To use GitHub CLI, please run: gh auth login\nmore");
  }),
  (error: Error) => {
    assert.match(error.message, /^No commit author email: set factory\.commitEmail in the factory config, or log gh in \(gh auth login\)/);
    assert.match(error.message, /gh api user failed: gh: To use GitHub CLI, please run: gh auth login$/, "with gh's first line only");
    assert.ok(!error.message.includes(UNOWNED));
    return true;
  },
);

// The unowned address cannot be produced: not configured, not baked into the image.
await assert.rejects(resolveCommitAuthor(UNOWNED, noGh), /is a GitHub noreply address no account owns/);
await assert.rejects(resolveCommitAuthor("someone@users.noreply.github.com", noGh), /no account owns/);
assert.ok(!baseLayers(factorySchema.parse({}).sandbox).some((layer) => /user\.(name|email)/.test(layer)), "the image sets no commit identity");

// The setting is optional and must be an email.
assert.equal(factorySchema.parse({}).commitEmail, undefined);
assert.throws(() => factorySchema.parse({ commitEmail: "not an email" }));

// The runner resolves the configured email once, without asking gh.
assert.equal(loadConfig().factory.commitEmail, TEST_COMMIT_EMAIL);
commitAuthorRuntime.ghUser = noGh;
const first = commitAuthor();
assert.equal(commitAuthor(), first, "resolved once");
assert.deepEqual(await first, { name: COMMIT_NAME, email: TEST_COMMIT_EMAIL });

console.log("commit-author regressions passed");
