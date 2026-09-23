/** Announce an inbox request at most once per process. The id is claimed before the send, so a
 * request read back from the hub and the same request arriving on the event stream cannot both
 * announce it; a failed send releases the claim, so the request stays retryable. */
export async function deliverInboxNotification(
  messageId: string,
  delivered: Set<string>,
  notify: () => Promise<void>,
): Promise<boolean> {
  if (delivered.has(messageId)) return false;
  delivered.add(messageId);
  try {
    await notify();
  } catch (error) {
    delivered.delete(messageId);
    throw error;
  }
  return true;
}
