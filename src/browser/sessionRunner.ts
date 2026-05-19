import chalk from "chalk";
import type { RunOracleOptions } from "../oracle.js";
import { formatTokenCount } from "../oracle/runUtils.js";
import { formatFinishLine } from "../oracle/finishLine.js";
import type { BrowserSessionConfig, BrowserRuntimeMetadata } from "../sessionStore.js";
import { runBrowserMode } from "../browserMode.js";
import type { BrowserRunResult } from "../browserMode.js";
import { assembleBrowserPrompt } from "./prompt.js";
import { BrowserAutomationError } from "../oracle/errors.js";
import type { BrowserLogger, BrowserRunArtifact } from "./types.js";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

export interface BrowserExecutionResult {
  usage: {
    inputTokens: number;
    outputTokens: number;
    reasoningTokens: number;
    totalTokens: number;
  };
  elapsedMs: number;
  runtime: BrowserRuntimeMetadata;
  answerText: string;
  tabUrl?: string;
  artifacts?: BrowserRunArtifact[];
  savedArtifacts?: string[];
}

interface RunBrowserSessionArgs {
  runOptions: RunOracleOptions;
  browserConfig: BrowserSessionConfig;
  cwd: string;
  log: (message?: string) => void;
}

export interface BrowserSessionRunnerDeps {
  assemblePrompt?: typeof assembleBrowserPrompt;
  executeBrowser?: typeof runBrowserMode;
  persistRuntimeHint?: (runtime: BrowserRuntimeMetadata) => Promise<void> | void;
}

export async function runBrowserSessionExecution(
  { runOptions, browserConfig, cwd, log }: RunBrowserSessionArgs,
  deps: BrowserSessionRunnerDeps = {},
): Promise<BrowserExecutionResult> {
  const assemblePrompt = deps.assemblePrompt ?? assembleBrowserPrompt;
  const executeBrowser = deps.executeBrowser ?? runBrowserMode;
  const promptArtifacts = await assemblePrompt(runOptions, { cwd });
  if (runOptions.verbose) {
    log(
      chalk.dim(
        `[verbose] Browser config: ${JSON.stringify({
          ...browserConfig,
        })}`,
      ),
    );
    log(chalk.dim(`[verbose] Browser prompt length: ${promptArtifacts.composerText.length} chars`));
    if (promptArtifacts.attachments.length > 0) {
      const attachmentList = promptArtifacts.attachments
        .map((attachment) => attachment.displayPath)
        .join(", ");
      log(chalk.dim(`[verbose] Browser attachments: ${attachmentList}`));
      if (promptArtifacts.bundled) {
        log(
          chalk.yellow(
            `[browser] Bundled ${promptArtifacts.bundled.originalCount} files into ${promptArtifacts.bundled.bundlePath}.`,
          ),
        );
      }
    } else if (
      runOptions.file &&
      runOptions.file.length > 0 &&
      promptArtifacts.attachmentMode === "inline"
    ) {
      log(chalk.dim("[verbose] Browser will paste file contents inline (no uploads)."));
    }
  }
  if (promptArtifacts.bundled) {
    log(
      chalk.dim(
        `Packed ${promptArtifacts.bundled.originalCount} files into 1 bundle (contents counted in token estimate).`,
      ),
    );
  }
  const headerLine = `Launching browser mode (${runOptions.model}) with ~${promptArtifacts.estimatedInputTokens.toLocaleString()} tokens.`;
  const automationLogger: BrowserLogger = ((message?: string) => {
    if (typeof message !== "string") return;
    const shouldAlwaysPrint = message.startsWith("[browser] ") && /fallback|retry/i.test(message);
    if (!runOptions.verbose && !shouldAlwaysPrint) return;
    log(message);
  }) as BrowserLogger;
  automationLogger.verbose = Boolean(runOptions.verbose);
  automationLogger.sessionLog = runOptions.verbose ? log : () => {};

  log(headerLine);
  log(chalk.dim("This run can take up to an hour (usually ~10 minutes)."));
  if (runOptions.verbose) {
    log(chalk.dim("Chrome automation does not stream output; this may take a minute..."));
  }
  const persistRuntimeHint = deps.persistRuntimeHint ?? (() => {});
  let browserResult: BrowserRunResult;
  try {
    browserResult = await executeBrowser({
      prompt: promptArtifacts.composerText,
      attachments: promptArtifacts.attachments,
      fallbackSubmission: promptArtifacts.fallback
        ? {
            prompt: promptArtifacts.fallback.composerText,
            attachments: promptArtifacts.fallback.attachments,
          }
        : undefined,
      config: browserConfig,
      log: automationLogger,
      heartbeatIntervalMs: runOptions.heartbeatIntervalMs,
      verbose: runOptions.verbose,
      downloadArtifacts: Boolean(runOptions.downloadArtifactsDir),
      runtimeHintCb: async (runtime) => {
        await persistRuntimeHint({
          ...runtime,
          controllerPid: runtime.controllerPid ?? process.pid,
        });
      },
    });
  } catch (error) {
    if (error instanceof BrowserAutomationError) {
      throw error;
    }
    const message = error instanceof Error ? error.message : "Browser automation failed.";
    throw new BrowserAutomationError(message, { stage: "execute-browser" }, error);
  }
  if (!runOptions.silent) {
    log(chalk.bold("Answer:"));
    log(browserResult.answerMarkdown || browserResult.answerText || chalk.dim("(no text output)"));
    if (browserResult.tabUrl) {
      log("");
      log(chalk.dim(`Conversation URL: ${browserResult.tabUrl}`));
    }
    log("");
  }
  const savedArtifacts = await writeBrowserArtifacts(
    runOptions.downloadArtifactsDir,
    browserResult.artifacts,
    log,
  );
  const answerText = browserResult.answerMarkdown || browserResult.answerText || "";
  const usage = {
    inputTokens: promptArtifacts.estimatedInputTokens,
    outputTokens: browserResult.answerTokens,
    reasoningTokens: 0,
    totalTokens: promptArtifacts.estimatedInputTokens + browserResult.answerTokens,
  };
  const tokensDisplay = [
    usage.inputTokens,
    usage.outputTokens,
    usage.reasoningTokens,
    usage.totalTokens,
  ]
    .map((value) => formatTokenCount(value))
    .join("/");
  const tokensPart = (() => {
    const parts = tokensDisplay.split("/");
    if (parts.length !== 4) return tokensDisplay;
    return `↑${parts[0]} ↓${parts[1]} ↻${parts[2]} Δ${parts[3]}`;
  })();
  const { line1, line2 } = formatFinishLine({
    elapsedMs: browserResult.tookMs,
    model: `${runOptions.model}[browser]`,
    tokensPart,
    detailParts: [
      runOptions.file && runOptions.file.length > 0 ? `files=${runOptions.file.length}` : null,
    ],
  });
  log(chalk.blue(line1));
  if (line2) {
    log(chalk.dim(line2));
  }
  return {
    usage,
    elapsedMs: browserResult.tookMs,
    runtime: {
      chromePid: browserResult.chromePid,
      chromePort: browserResult.chromePort,
      chromeHost: browserResult.chromeHost,
      userDataDir: browserResult.userDataDir,
      controllerPid: browserResult.controllerPid ?? process.pid,
      tabUrl: browserResult.tabUrl,
    },
    answerText,
    tabUrl: browserResult.tabUrl,
    artifacts: browserResult.artifacts,
    savedArtifacts,
  };
}

async function writeBrowserArtifacts(
  targetDir: string | undefined,
  artifacts: BrowserRunArtifact[] | undefined,
  log: (message?: string) => void,
): Promise<string[]> {
  if (!targetDir || !Array.isArray(artifacts) || artifacts.length === 0) {
    return [];
  }
  const normalizedTarget = path.resolve(targetDir);
  await fsp.mkdir(normalizedTarget, { recursive: true });
  const saved: string[] = [];
  for (let index = 0; index < artifacts.length; index += 1) {
    const artifact = artifacts[index];
    if (!artifact?.contentBase64) continue;
    const fileName = sanitizeArtifactFileName(artifact.fileName || `artifact-${index + 1}.bin`);
    const targetPath = uniqueArtifactPath(normalizedTarget, fileName);
    await fsp.writeFile(targetPath, Buffer.from(artifact.contentBase64, "base64"));
    saved.push(targetPath);
    log(chalk.dim(`Saved browser artifact to ${targetPath}`));
  }
  return saved;
}

function sanitizeArtifactFileName(fileName: string): string {
  const cleaned = fileName.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
  return cleaned || "artifact.bin";
}

function uniqueArtifactPath(dir: string, fileName: string): string {
  const parsed = path.parse(fileName);
  const base = parsed.name || "artifact";
  const ext = parsed.ext || "";
  let candidate = path.join(dir, `${base}${ext}`);
  let counter = 2;
  while (fs.existsSync(candidate)) {
    candidate = path.join(dir, `${base}-${counter}${ext}`);
    counter += 1;
  }
  return candidate;
}
