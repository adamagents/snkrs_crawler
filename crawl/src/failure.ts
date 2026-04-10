import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CALLBACK_TIMEOUT_MS } from "./utils/constants";
import type { FailurePayload, FollowUpTaskPayload } from "./types";

export function ensureDirectory(directoryPath: string): void {
  fs.mkdirSync(directoryPath, { recursive: true });
}

export function writeFailureLog(errorPayload: FailurePayload, logDirectory = path.join(process.cwd(), "logs")): string {
  ensureDirectory(logDirectory);
  const fileName = `snkrs-crawler-${new Date().toISOString().replace(/[:.]/g, "-")}.log.json`;
  const filePath = path.join(logDirectory, fileName);

  fs.writeFileSync(filePath, `${JSON.stringify(errorPayload, null, 2)}${os.EOL}`, "utf8");
  return filePath;
}

export function buildFollowUpTask(repoPath: string, logPaths: string[]): FollowUpTaskPayload {
  const logSummary = logPaths.length > 0 ? ` Failing log paths: ${logPaths.join(", ")}.` : "";

  return {
    repos: [repoPath],
    baseBranch: "main",
    targetSubdir: ".",
    prompt: `Review the failing log paths first, identify every root cause behind the failed task, fix the underlying issues in this repository, validate locally where possible, and summarize the verified results.${logSummary}`,
  };
}

export function buildFailurePayload(
  error: unknown,
  { repoPath = process.cwd(), logPaths = [], phase = "crawl" }: { repoPath?: string; logPaths?: string[]; phase?: string } = {},
): FailurePayload {
  const err = error instanceof Error ? error : new Error(String(error));

  return {
    status: "failure",
    phase,
    message: "Crawler execution failed.",
    calling_agent_response: `Failure during ${phase}: ${err.message}`,
    error: {
      name: err.name,
      message: err.message,
      stack: err.stack ?? null,
    },
    log_paths: logPaths,
    follow_up_task: buildFollowUpTask(repoPath, logPaths),
  };
}

export async function postJson(url: string, payload: unknown, fetchImpl: typeof fetch = fetch): Promise<void> {
  const response = await fetchImpl(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(CALLBACK_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`Hub callback failed with ${response.status} ${response.statusText}.`);
  }
}

export async function maybeSendFailureCallback(payload: FailurePayload, fetchImpl: typeof fetch = fetch): Promise<void> {
  const callbackUrl = process.env.MOLTENBOT_FAILURE_CALLBACK_URL;

  if (!callbackUrl) {
    return;
  }

  await postJson(callbackUrl, payload, fetchImpl);
}
