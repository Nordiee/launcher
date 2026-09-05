export type LauncherIssue = { message: string; details: string; createdAt: number };

const LAST_ISSUE_KEY = "nordiee.last-launcher-issue.v1";
const MAX_MESSAGE_LENGTH = 280;
const MAX_DETAILS_LENGTH = 900;

function clean(value: string, limit: number) {
  return value
    .replace(/[A-Za-z]:\\[^\s]*/g, "[path]")
    .replace(/\b[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\b/g, "[email]")
    .replace(/Bearer\s+[^\s]+/gi, "Bearer [redacted]")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, limit);
}

export function readLastLauncherIssue(): LauncherIssue | null {
  try {
    const value = localStorage.getItem(LAST_ISSUE_KEY);
    if (!value) return null;
    const issue = JSON.parse(value) as Partial<LauncherIssue>;
    return typeof issue.message === "string" && typeof issue.details === "string" && typeof issue.createdAt === "number" ? issue as LauncherIssue : null;
  } catch { return null; }
}

export function recordLauncherIssue(error: unknown) {
  const source = error instanceof Error ? error : new Error(typeof error === "string" ? error : "Unexpected launcher error");
  const issue: LauncherIssue = {
    message: clean(source.message || "Unexpected launcher error", MAX_MESSAGE_LENGTH),
    details: clean(source.stack || source.message || "No additional details", MAX_DETAILS_LENGTH),
    createdAt: Date.now(),
  };
  localStorage.setItem(LAST_ISSUE_KEY, JSON.stringify(issue));
  return issue;
}

export function clearLastLauncherIssue() {
  localStorage.removeItem(LAST_ISSUE_KEY);
}
