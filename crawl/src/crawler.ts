import fs from "node:fs";
import os from "node:os";
import { buildFailurePayload, maybeSendFailureCallback, writeFailureLog } from "./failure";
import { fetchText } from "./network";
import { normalizeLaunchItems, parseInitialState, pickUserAgent } from "./parser";
import type { CrawlOptions, FailurePayload, SuccessPayload } from "./types";
import { DEFAULT_FEED_URL, DEFAULT_USER_AGENTS } from "./utils/constants";

export async function writeStdoutJson(payload: unknown, targetPath?: string): Promise<void> {
  const text = `${JSON.stringify(payload, null, 2)}${os.EOL}`;

  if (targetPath) {
    fs.writeFileSync(targetPath, text, "utf8");
    return;
  }

  process.stdout.write(text);
}

export async function crawlSnkrs({
  feedUrl = process.env.SNKRS_FEED_URL || DEFAULT_FEED_URL,
  outputPath = process.env.SNKRS_OUTPUT_PATH,
  userAgents = process.env.SNKRS_USER_AGENTS
    ? process.env.SNKRS_USER_AGENTS.split(/\r?\n|,/)
        .map((value) => value.trim())
        .filter(Boolean)
    : [...DEFAULT_USER_AGENTS],
  seed = process.env.SNKRS_USER_AGENT_SEED || Date.now(),
}: CrawlOptions = {},
deps: Parameters<typeof crawlSnkrsWithDeps>[1] = {},
): Promise<SuccessPayload> {
  return crawlSnkrsWithDeps(
    {
      feedUrl,
      outputPath,
      userAgents,
      seed,
    },
    deps,
  );
}

export async function crawlSnkrsWithDeps(
  { feedUrl = DEFAULT_FEED_URL, outputPath, userAgents = [...DEFAULT_USER_AGENTS], seed = Date.now() }: CrawlOptions = {},
  {
    fetchTextImpl = fetchText,
    parseInitialStateImpl = parseInitialState,
    normalizeLaunchItemsImpl = normalizeLaunchItems,
    writeStdoutJsonImpl = writeStdoutJson,
  }: {
    fetchTextImpl?: typeof fetchText;
    parseInitialStateImpl?: typeof parseInitialState;
    normalizeLaunchItemsImpl?: typeof normalizeLaunchItems;
    writeStdoutJsonImpl?: typeof writeStdoutJson;
  } = {},
): Promise<SuccessPayload> {
  const userAgent = pickUserAgent(userAgents, seed);
  const html = await fetchTextImpl(feedUrl, { userAgent });
  const state = parseInitialStateImpl(html);
  const items = normalizeLaunchItemsImpl(state);

  const payload: SuccessPayload = {
    status: "success",
    source: feedUrl,
    requested_at_utc: new Date().toISOString(),
    item_count: items.length,
    items,
    warnings: [
      "This implementation uses the public Nike launch page only.",
      "Free proxies are volatile; the crawler rotates through a US pool and falls back to direct requests when needed.",
    ],
  };

  await writeStdoutJsonImpl(payload, outputPath);
  return payload;
}

export async function runCli(
  {
    crawlSnkrsImpl = crawlSnkrs,
    buildFailurePayloadImpl = buildFailurePayload,
    writeFailureLogImpl = writeFailureLog,
    maybeSendFailureCallbackImpl = maybeSendFailureCallback,
    writeStdoutJsonImpl = writeStdoutJson,
  }: {
    crawlSnkrsImpl?: typeof crawlSnkrs;
    buildFailurePayloadImpl?: typeof buildFailurePayload;
    writeFailureLogImpl?: typeof writeFailureLog;
    maybeSendFailureCallbackImpl?: typeof maybeSendFailureCallback;
    writeStdoutJsonImpl?: typeof writeStdoutJson;
  } = {},
): Promise<void> {
  try {
    await crawlSnkrsImpl();
  } catch (error) {
    const preliminaryPayload = buildFailurePayloadImpl(error, { repoPath: process.cwd() });
    const logPath = writeFailureLogImpl(preliminaryPayload);
    const failurePayload: FailurePayload = buildFailurePayloadImpl(error, {
      repoPath: process.cwd(),
      logPaths: [logPath],
    });

    try {
      await maybeSendFailureCallbackImpl(failurePayload);
    } catch (callbackError) {
      failurePayload.callback_error = {
        name: callbackError instanceof Error ? callbackError.name : "Error",
        message: callbackError instanceof Error ? callbackError.message : String(callbackError),
      };
    }

    await writeStdoutJsonImpl(failurePayload);
    process.exitCode = 1;
  }
}
