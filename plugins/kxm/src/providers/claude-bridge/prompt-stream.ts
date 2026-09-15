// Long-lived streaming-input prompt for query().
// Vendored from pi-claude-bridge 0.7.0 (provider path only).

export type PromptUserMessage = {
  type: "user";
  message: { role: "user"; content: unknown };
  parent_tool_use_id: null;
  priority?: string;
};

export interface PromptStream {
  stream: AsyncGenerator<PromptUserMessage>;
  push: (msg: PromptUserMessage) => Promise<void>;
  end: () => void;
  fail: (error: Error) => void;
}

export function makePromptStream(): PromptStream {
  type Item = { msg: PromptUserMessage; resolve: () => void; reject: (e: Error) => void };
  const queue: Item[] = [];
  let inflight: Item | null = null;
  let wake: (() => void) | null = null;
  let done = false;
  let failure: Error | null = null;

  const kick = () => {
    wake?.();
    wake = null;
  };

  async function* gen(): AsyncGenerator<PromptUserMessage> {
    try {
      while (true) {
        while (queue.length === 0 && !done && !failure) {
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
        }
        if (failure) throw failure;
        const item = queue.shift();
        if (!item) return;
        inflight = item;
        try {
          yield item.msg;
          item.resolve();
        } finally {
          item.reject(new Error("prompt stream closed"));
          inflight = null;
        }
      }
    } finally {
      done = true;
    }
  }

  return {
    stream: gen(),
    push: (msg) =>
      failure || done
        ? Promise.reject(failure ?? new Error("prompt stream closed"))
        : new Promise<void>((resolve, reject) => {
            queue.push({ msg, resolve, reject });
            kick();
          }),
    end: () => {
      done = true;
      kick();
    },
    fail: (error) => {
      if (failure) return;
      failure = error;
      queue.splice(0).forEach((item) => item.reject(error));
      inflight?.reject(error);
      kick();
    },
  };
}

export function userMessage(
  content: unknown,
  priority?: string,
): PromptUserMessage {
  return {
    type: "user",
    message: { role: "user", content },
    parent_tool_use_id: null,
    ...(priority ? { priority } : {}),
  };
}
