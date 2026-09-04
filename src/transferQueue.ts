import type { LibraryGame } from "./libraryCache";

export type TransferKind = "install" | "repair" | "update";
export type QueuedTransfer = { id: string; game: LibraryGame; kind: TransferKind; installRoot?: string };

const transferQueueEvent = "nordiee-transfer-queue-changed";
let currentTransferQueue: QueuedTransfer[] = [];
let activeQueueKey = "nordiee.transferQueue";

function queueKey(accountEmail: string) {
  return `nordiee.transferQueue.${accountEmail.trim().toLocaleLowerCase()}`;
}

function storedQueue(key: string): QueuedTransfer[] {
  try {
    const saved = JSON.parse(localStorage.getItem(key) ?? "[]");
    return Array.isArray(saved) ? saved.filter((transfer): transfer is QueuedTransfer => typeof transfer?.id === "string" && typeof transfer?.kind === "string" && typeof transfer?.game?.id === "string" && typeof transfer?.game?.title === "string" && (transfer.installRoot === undefined || typeof transfer.installRoot === "string")) : [];
  } catch {
    return [];
  }
}

export function activateTransferQueue(accountEmail: string) {
  activeQueueKey = queueKey(accountEmail);
  currentTransferQueue = storedQueue(activeQueueKey);
  window.dispatchEvent(new CustomEvent<QueuedTransfer[]>(transferQueueEvent, { detail: currentTransferQueue }));
  return currentTransferQueue;
}

export function readTransferQueue() {
  return currentTransferQueue;
}

export function publishTransferQueue(nextQueue: QueuedTransfer[]) {
  currentTransferQueue = nextQueue;
  localStorage.setItem(activeQueueKey, JSON.stringify(nextQueue));
  window.dispatchEvent(new CustomEvent<QueuedTransfer[]>(transferQueueEvent, { detail: nextQueue }));
}

export function enqueueTransfer(transfer: QueuedTransfer) {
  publishTransferQueue([...currentTransferQueue, transfer]);
}

export function takeNextTransfer() {
  const [next, ...remaining] = currentTransferQueue;
  publishTransferQueue(remaining);
  return next;
}

export function clearTransferQueue() {
  publishTransferQueue([]);
}

export function removeTransferFromQueue(id: string) {
  publishTransferQueue(currentTransferQueue.filter((transfer) => transfer.id !== id));
}

export function moveTransferInQueue(id: string, direction: -1 | 1) {
  const index = currentTransferQueue.findIndex((transfer) => transfer.id === id);
  const targetIndex = index + direction;
  if (index < 0 || targetIndex < 0 || targetIndex >= currentTransferQueue.length) return;
  const nextQueue = [...currentTransferQueue];
  [nextQueue[index], nextQueue[targetIndex]] = [nextQueue[targetIndex], nextQueue[index]];
  publishTransferQueue(nextQueue);
}

export function listenForTransferQueue(listener: (queue: QueuedTransfer[]) => void) {
  const handleChange = (event: Event) => listener((event as CustomEvent<QueuedTransfer[]>).detail);
  window.addEventListener(transferQueueEvent, handleChange);
  return () => window.removeEventListener(transferQueueEvent, handleChange);
}
