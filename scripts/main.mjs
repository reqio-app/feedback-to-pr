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

const alreadyHandled = (branch) => {
  const remote = shQuiet(`git ls-remote --heads origin ${branch}`);
  if (remote.ok && remote.out) return true;
  // A merged-and-deleted branch leaves no ref, so ask for PRs in any state.
  const prs = shQuiet(`gh pr list --head ${branch} --state all --json number --limit 1`);
  return prs.ok && prs.out.trim() !== "" && prs.out.trim() !== "[]";
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

const runAgent = (brief) => {
  const command = process.env.REQIO_AGENT_COMMAND || "npx -y @anthropic-ai/claude-code@latest -p";
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
        : "Opened automatically from a Reqio bug report.",
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
  parts.push(
    "> Your own CI does not run on this pull request: GitHub suppresses workflow triggers for",
    "> commits made with the default token. The test result above is the check, unless you have",
    "> swapped in a PAT or GitHub App.",
  );
  return parts.filter((p) => p !== "").join("\n");
};

const handleOne = async (cfg, summary, opts) => {
  const branch = `${opts.branchPrefix}${summary.id}`;
  if (alreadyHandled(branch)) {
    console.log(`[reqio] ${summary.id} already has ${branch}, skipping.`);
    return false;
  }

  const feature = await getFeature(cfg, summary.id);
  if (feature.category !== "ERROR") return false;

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

  const created = shQuiet(
    `gh pr create --base ${opts.baseBranch} --head ${branch} --title "${subject.replace(/"/g, '\\"')}" --body-file "${bodyFile}"${draft ? " --draft" : ""}`,
  );
  if (!created.ok) {
    console.error(`[reqio] could not open a pull request for ${feature.id}: ${created.out}`);
    return false;
  }
  const prUrl = created.out.split("\n").filter(Boolean).pop();

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

  const approved = await listFeatures(cfg, { status: "IN_PROGRESS", category: "ERROR" });
  const pending = opts.autoApprove
    ? await listFeatures(cfg, { status: "NEEDS_ACTION", category: "ERROR" })
    : [];
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
