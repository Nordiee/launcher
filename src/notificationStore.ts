export type LauncherNotification = {
  id: string;
  title: string;
  message: string;
  kind: "info" | "success" | "error";
  createdAt: number;
  read: boolean;
  action?: "friends";
};

const STORAGE_KEY = "nordiee.notifications";
const MAX_NOTIFICATIONS = 30;

export function readNotifications(): LauncherNotification[] {
  try {
    const value = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
    return Array.isArray(value) ? value.filter(isNotification).slice(0, MAX_NOTIFICATIONS) : [];
  } catch {
    return [];
  }
}

export function saveNotifications(notifications: LauncherNotification[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(notifications.slice(0, MAX_NOTIFICATIONS)));
}

function isNotification(value: unknown): value is LauncherNotification {
  if (!value || typeof value !== "object") return false;
  const notification = value as Partial<LauncherNotification>;
  return typeof notification.id === "string" && typeof notification.title === "string" && typeof notification.message === "string" && typeof notification.createdAt === "number" && typeof notification.read === "boolean" && ["info", "success", "error"].includes(notification.kind ?? "") && (notification.action === undefined || notification.action === "friends");
}
