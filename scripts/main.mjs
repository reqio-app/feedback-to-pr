import { execFileSync, execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { appendFileSync } from "node:fs";
import path from "node:path";
import {
  config,
  listFeatures,
  getFeature,
  getScreenshot,
  getConversationThread,
  setDeveloperNote,
  setStatus,
  emitAgentEvent,
} from "./reqio.mjs";
import { buildBrief } from "./prompt.mjs";

// bypassPermissions is not optional in CI: -p alone still enforces permission
// checks, and a prompt the agent cannot display is a refusal to edit anything.
// Every supported agent needs its own version of this (Codex bypasses its
// sandbox, Gemini runs yolo) because none of them can ask a human here.
const DEFAULT_AGENT_COMMAND =
  "npx -y @anthropic-ai/claude-code@latest -p --permission-mode bypassPermissions";
const WORK_DIR = ".reqio-agent";
const QUESTIONS_FILE = path.join(WORK_DIR, "questions.md");

/**
 * The heading the dashboard looks for to offer "Ask the reporter". It must stay
 * byte-identical to `copy.agent.questions.marker` in the Reqio web app; if they
 * drift, the affordance silently stops appearing.
 */
const QUESTIONS_MARKER = "## Questions for the reporter";

const sh = (cmd, opts = {}) => execSync(cmd, { encoding: "utf8", stdio: "pipe", ...opts }).trim();
const shQuiet = (cmd, opts = {}) => {
  try {
    return { ok: true, out: sh(cmd, opts) };
  } catch (error) {
    return { ok: false, out: `${error.stdout ?? ""}${error.stderr ?? ""}`.trim() };
  }
};

const setOutput = (key, value) => {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
};

const bool = (raw) => String(raw).toLowerCase() === "true";

// ---------------------------------------------------------------------------
// merged mode: a human merged the agent's PR, so tell the reporter
// ---------------------------------------------------------------------------

const runMerged = async (cfg) => {
  const branch = process.env.REQIO_BRANCH || "";
  const prefix = process.env.REQIO_BRANCH_PREFIX || "reqio/feature-";
  if (!branch.startsWith(prefix)) {
    console.log(`[reqio] ${branch || "(no branch)"} is not an agent branch, nothing to do.`);
    setOutput("handled", "0");
    return;
  }
  const featureId = branch.slice(prefix.length);
  const completionKind = process.env.REQIO_COMPLETION_KIND || "NEXT_UPDATE";

  // Entering COMPLETED is what fires Reqio's notification to the reporter
  // (ADR 0012). This one call is the entire payoff of the loop.
  await setStatus(cfg, featureId, "COMPLETED", completionKind);
  console.log(`[reqio] ${featureId} marked COMPLETED (${completionKind}). Reporter notified.`);
  setOutput("handled", "1");
};

// ---------------------------------------------------------------------------
// poll mode
// ---------------------------------------------------------------------------

/**
 * The scope rule is not "bugs". A bug qualifies because it arrives
 * self-describing - screenshot, page URL, what broke - so the report itself is
 * the brief. A feature request is a wish until somebody writes the spec, and
 * the place they write it is the developer note, which the brief already
 * labels as trusted team input distinct from the untrusted reporter text.
 *
 * So: work on anything self-describing, or anything a human has briefed.
 *
 * The note this action writes back is not a brief, and must not make a request
 * re-qualify on a later run. The branch check in `alreadyHandled` is the real
 * idempotency guard; this only stops a request the agent has already touched
 * from looking human-briefed to a reader of the code.
 */
const AGENT_AUTHORED_NOTE_PREFIXES = ["Pull request: ", QUESTIONS_MARKER];

const isWorkable = (feature) => {
  if (feature.category === "ERROR") return true;
  const note = (feature.developerNote ?? "").trim();
  if (!note) return false;
  return !AGENT_AUTHORED_NOTE_PREFIXES.some((prefix) => note.startsWith(prefix));
};

/** The pull request on this branch, in any state, or null if there is none. */
const findPullRequest = (branch) => {
  const listed = shQuiet(
    `gh pr list --head ${branch} --state all --json number,url,state,isDraft --limit 1`,
  );
  if (!listed.ok) return null;
  const body = listed.out.trim();
  if (!body || body === "[]") return null;
  try {
    const [pr] = JSON.parse(body);
    return pr ?? null;
  } catch {
    // Unparseable output is not evidence of absence. Report a claim so a
    // duplicate is never opened on a guess.
    return { number: null, url: null, state: "UNKNOWN", isDraft: false };
  }
};

/**
 * Whether this request is spoken for. The branch is still the claim, but a
 * DRAFT pull request is not a claim - it is an unfinished attempt, and the
 * whole point of the questions flow is that a later run reads the reporter's
 * answer and resumes from that draft. Treating any pull request as final broke
 * that, and made a transient failure (a missing credential, a sandbox that
 * cannot start) cost the request permanently: the tombstone it left behind
 * could never be retried.
 *
 * So: a draft is retryable, a ready or merged or closed pull request is not.
 * A leftover branch with no pull request is retryable too - it means an earlier
 * run pushed and then failed to open one, which is exactly what happens when
 * the repository has not allowed Actions to create pull requests yet.
 */
const claimFor = (branch) => {
  const pr = findPullRequest(branch);
  if (pr) return { handled: !(pr.state === "OPEN" && pr.isDraft), pr };
  return { handled: false, pr: null };
};

const prepareWorkDir = (feature, screenshot) => {
  rmSync(WORK_DIR, { recursive: true, force: true });
  mkdirSync(WORK_DIR, { recursive: true });
  if (screenshot?.image) {
    const ext = screenshot.mimeType === "image/png" ? "png" : "jpg";
    writeFileSync(path.join(WORK_DIR, `screenshot.${ext}`), Buffer.from(screenshot.image, "base64"));
  }
  writeFileSync(path.join(WORK_DIR, "report.json"), JSON.stringify(feature, null, 2));
};

/**
 * The agent is driven by text a stranger wrote, so it is spawned WITHOUT the
 * credentials this action holds. `execSync` inherits the whole environment by
 * default, which would hand a prompt-injected agent the repo token and the
 * Reqio key. Only the model key and the ordinary runner variables survive.
 *
 * Denylist rather than allowlist on purpose: `agent-command` is user-swappable,
 * so an unknown provider's key must still reach the agent it belongs to.
 */
const SECRETS_WITHHELD_FROM_AGENT = [
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "REQIO_API_KEY",
  "REQIO_PROJECT_ID",
  "REQIO_BASE_URL",
];

const agentEnv = () => {
  const env = { ...process.env };
  for (const key of SECRETS_WITHHELD_FROM_AGENT) delete env[key];
  return env;
};

/**
 * An OMITTED agent-command means "use the default". An explicitly EMPTY one
 * means the user picked a non-default agent and has not pasted its invocation
 * yet, so falling back to the default would launch Claude Code against, say,
 * an OPENAI_API_KEY and fail deep in the run with an unrelated-looking error.
 * `||` cannot tell those apart because "" is falsy; `??` plus a trim check can.
 */
const resolveAgentCommand = () => {
  const raw = process.env.REQIO_AGENT_COMMAND ?? DEFAULT_AGENT_COMMAND;
  const command = raw.trim();
  if (!command) {
    throw new Error(
      "agent-command is empty. Set it to your coding agent's headless invocation, " +
        "or remove the input entirely to use the default (Claude Code).",
    );
  }
  return command;
};

const runAgent = (brief) => {
  const command = resolveAgentCommand();
  try {
    const out = execSync(command, {
      input: brief,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      env: agentEnv(),
      maxBuffer: 64 * 1024 * 1024,
      timeout: 30 * 60 * 1000,
    });
    return { ok: true, log: out };
  } catch (error) {
    return { ok: false, log: `${error.stdout ?? ""}\n${error.stderr ?? ""}`.trim() || String(error) };
  }
};

const readQuestions = () => {
  if (!existsSync(QUESTIONS_FILE)) return null;
  const body = readFileSync(QUESTIONS_FILE, "utf8").trim();
  return body || null;
};

const hasCodeChanges = () => {
  // The agent's own scratch directory is never part of the change set.
  const status = shQuiet(`git status --porcelain -- . ":(exclude)${WORK_DIR}"`);
  return status.ok && status.out !== "";
};

const restoreTestFiles = () => {
  const changed = shQuiet("git diff --name-only");
  if (!changed.ok || !changed.out) return [];
  const testFiles = changed.out
    .split("\n")
    .filter((f) => /(^|\/)(tests?|__tests__|spec)\//.test(f) || /\.(test|spec)\.[a-z]+$/.test(f));
  for (const file of testFiles) shQuiet(`git checkout -- "${file}"`);
  return testFiles;
};

const prBody = ({ feature, baseUrl, projectId, questions, testResult, agentFailed }) => {
  const link = `${baseUrl}/dashboard/projects/${projectId}?feature=${feature.id}`;
  const parts = [
    agentFailed
      ? "The agent could not complete this one. Opening as a draft so nothing is lost."
      : questions
        ? "The agent stopped before writing code because the report is missing detail."
        : feature.category === "ERROR"
          ? "Opened automatically from a Reqio bug report."
          : "Opened automatically from a Reqio request the team wrote a brief for.",
    "",
    `**Report:** ${feature.title}`,
    feature.pageUrl ? `**Page:** ${feature.pageUrl}` : "",
    `**Reqio thread:** ${link}`,
    "",
  ];
  if (questions) parts.push("### Open questions", "", questions, "");
  if (testResult) {
    parts.push(
      "### Tests",
      "",
      testResult.ok ? "Passed inside the agent job." : "FAILED inside the agent job.",
      "",
      "```",
      testResult.out.slice(-3000),
      "```",
      "",
    );
  }
  // The second sentence must follow the test section that is actually present.
  // Pointing at "the test result above" when no test-command is configured
  // sends the reviewer looking for a check that was never run.
  parts.push(
    "> Your own CI does not run on this pull request: GitHub suppresses workflow triggers for",
    "> commits made with the default token, unless you have swapped in a PAT or GitHub App.",
    testResult
      ? "> The test result above is the check."
      : "> No test-command is configured, so nothing here has been verified by a machine.",
  );
  return parts.filter((p) => p !== "").join("\n");
};

const handleOne = async (cfg, summary, opts) => {
  const branch = `${opts.branchPrefix}${summary.id}`;
  const claim = claimFor(branch);
  if (claim.handled) {
    console.log(`[reqio] ${summary.id} already has ${branch}, skipping.`);
    return false;
  }
  if (claim.pr) {
    console.log(`[reqio] ${summary.id} has an unfinished draft, resuming ${claim.pr.url}`);
  }

  // Retrying an existing branch force-pushes over it, and --force-with-lease
  // needs a remote-tracking ref to lease against or it refuses on stale info.
  // Absent (a first attempt) is fine; the lease simply has nothing to compare.
  shQuiet(`git fetch origin ${branch}:refs/remotes/origin/${branch} --force`);

  const feature = await getFeature(cfg, summary.id);
  if (!isWorkable(feature)) {
    console.log(`[reqio] ${summary.id} is neither a bug nor briefed, skipping.`);
    return false;
  }

  // Auto mode picks up work nobody has moved yet, so the agent moves it itself.
  // That is what tells the reporter work has started, and it must happen before
  // the long agent run rather than after it.
  if (summary.status === "NEEDS_ACTION") {
    await setStatus(cfg, summary.id, "IN_PROGRESS");
  }

  const [screenshot, thread] = await Promise.all([
    getScreenshot(cfg, summary.id),
    getConversationThread(cfg, summary.id),
  ]);

  sh(`git checkout -B ${branch} ${opts.baseBranch}`);
  prepareWorkDir(feature, screenshot);

  const brief = buildBrief({
    feature,
    thread,
    hasScreenshot: Boolean(screenshot?.image),
    allowTestEdits: opts.allowTestEdits,
    testCommand: opts.testCommand,
  });

  const agentRun = runAgent(brief);
  const questions = readQuestions();

  if (!opts.allowTestEdits) {
    const reverted = restoreTestFiles();
    if (reverted.length) console.log(`[reqio] reverted agent edits to ${reverted.length} test file(s).`);
  }

  const changed = hasCodeChanges();
  const draft = Boolean(questions) || !agentRun.ok || !changed;

  // Same credential scrub as the agent spawn: this command executes code the
  // agent just wrote, so it is no more trusted than the agent itself.
  let testResult = null;
  if (changed && opts.testCommand) testResult = shQuiet(opts.testCommand, { env: agentEnv() });

  // A draft with no diff still needs a commit for the branch to exist.
  rmSync(path.join(WORK_DIR, "report.json"), { force: true });
  if (!changed) {
    writeFileSync(
      path.join(WORK_DIR, "agent-log.md"),
      `# Agent log\n\n${questions ? `## Questions\n\n${questions}\n\n` : ""}## Output\n\n\`\`\`\n${agentRun.log.slice(-6000)}\n\`\`\`\n`,
    );
  } else {
    rmSync(WORK_DIR, { recursive: true, force: true });
  }

  sh(`git add -A`);
  const subject = draft ? `wip: ${feature.title}` : `fix: ${feature.title}`;
  execFileSync("git", ["commit", "-m", subject.slice(0, 70), "-m", `Reqio request ${feature.id}`], {
    stdio: "pipe",
  });
  sh(`git push --force-with-lease origin ${branch}`);

  const body = prBody({
    feature,
    baseUrl: cfg.baseUrl,
    projectId: cfg.projectId,
    questions,
    testResult,
    agentFailed: !agentRun.ok,
  });
  const bodyFile = path.join(process.env.RUNNER_TEMP || ".", `reqio-pr-${feature.id}.md`);
  writeFileSync(bodyFile, body);

  const quotedTitle = `"${subject.replace(/"/g, '\\"')}"`;
  let prUrl;

  if (claim.pr) {
    // Resuming the draft this run inherited: the force-push already replaced
    // its commits, so only the title, body and draft state still need to catch
    // up with the new outcome. Opening a second pull request on the same head
    // is not possible anyway.
    const edited = shQuiet(
      `gh pr edit ${claim.pr.number} --title ${quotedTitle} --body-file "${bodyFile}"`,
    );
    if (!edited.ok) {
      console.error(`[reqio] could not update pull request for ${feature.id}: ${edited.out}`);
      return false;
    }
    // An attempt that now has code and no open questions has stopped being a
    // draft, and nobody will review what still looks unfinished.
    if (!draft) {
      const ready = shQuiet(`gh pr ready ${claim.pr.number}`);
      if (!ready.ok) console.error(`[reqio] could not mark ${claim.pr.url} ready: ${ready.out}`);
    }
    prUrl = claim.pr.url;
  } else {
    const created = shQuiet(
      `gh pr create --base ${opts.baseBranch} --head ${branch} --title ${quotedTitle} --body-file "${bodyFile}"${draft ? " --draft" : ""}`,
    );
    if (!created.ok) {
      console.error(`[reqio] could not open a pull request for ${feature.id}: ${created.out}`);
      return false;
    }
    prUrl = created.out.split("\n").filter(Boolean).pop();
  }

  const note = questions
    ? `${QUESTIONS_MARKER}\n${questions}\n\nDraft pull request: ${prUrl}`
    : `Pull request: ${prUrl}`;
  await setDeveloperNote(cfg, feature.id, note);

  await emitAgentEvent(
    cfg,
    questions
      ? { kind: "agent.needs_context", featureId: feature.id, questions, draftPrUrl: prUrl }
      : { kind: "agent.pr_opened", featureId: feature.id, prUrl },
  );

  console.log(`[reqio] ${feature.id} -> ${prUrl}${draft ? " (draft)" : ""}`);
  return true;
};

const runPoll = async (cfg) => {
  const opts = {
    branchPrefix: process.env.REQIO_BRANCH_PREFIX || "reqio/feature-",
    autoApprove: bool(process.env.REQIO_AUTO_APPROVE),
    maxPrs: Math.max(1, Number(process.env.REQIO_MAX_PRS || "3")),
    testCommand: (process.env.REQIO_TEST_COMMAND || "").trim(),
    allowTestEdits: bool(process.env.REQIO_ALLOW_TEST_EDITS),
    baseBranch:
      (process.env.REQIO_BASE_BRANCH || "").trim() ||
      shQuiet("gh repo view --json defaultBranchRef -q .defaultBranchRef.name").out ||
      "main",
  };

  // Validate before touching the network or git: a misconfigured command should
  // fail on an empty run, not after branching and opening a pull request.
  resolveAgentCommand();

  // No category filter here: `isWorkable` decides per request, and it needs the
  // developer note, which only the detail endpoint returns.
  const approved = await listFeatures(cfg, { status: "IN_PROGRESS" });
  const pending = opts.autoApprove ? await listFeatures(cfg, { status: "NEEDS_ACTION" }) : [];
  const candidates = [...approved, ...pending];

  if (candidates.length === 0) {
    console.log("[reqio] no approved bugs waiting.");
    setOutput("handled", "0");
    return;
  }

  sh(`git config user.name "reqio-agent[bot]"`);
  sh(`git config user.email "agent@reqio.app"`);
  sh(`git fetch origin ${opts.baseBranch} --depth=1 || true`);

  let handled = 0;
  for (const candidate of candidates) {
    if (handled >= opts.maxPrs) {
      console.log(`[reqio] stopping at max-prs-per-run=${opts.maxPrs}. ${candidates.length - handled} left for the next run.`);
      break;
    }
    try {
      if (await handleOne(cfg, candidate, opts)) handled += 1;
    } catch (error) {
      // One bad report must not strand the rest of the queue.
      console.error(`[reqio] ${candidate.id} failed: ${error.message}`);
    } finally {
      shQuiet(`git checkout ${opts.baseBranch}`);
      shQuiet(`git reset --hard origin/${opts.baseBranch}`);
      rmSync(WORK_DIR, { recursive: true, force: true });
    }
  }
  setOutput("handled", String(handled));
};

const main = async () => {
  const cfg = config();
  if ((process.env.REQIO_MODE || "poll") === "merged") return runMerged(cfg);
  return runPoll(cfg);
};

main().catch((error) => {
  console.error(`[reqio] ${error.message}`);
  process.exit(1);
});
