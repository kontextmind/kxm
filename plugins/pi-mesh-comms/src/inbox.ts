export async function deliverInboxNotification(
  messageId: string,
  delivered: Set<string>,
  notify: () => Promise<void>,
): Promise<boolean> {
  if (delivered.has(messageId)) return false;
  await notify();
  delivered.add(messageId);
  return true;
}
