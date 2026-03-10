import {
  validateUrl,
  type PluginModule,
  type Notifier,
  type OrchestratorEvent,
  type NotifyAction,
  type NotifyContext,
  type EventPriority,
  CI_STATUS,
} from "@composio/ao-core";

export const manifest = {
  name: "slack",
  slot: "notifier" as const,
  description: "Notifier plugin: Slack webhook notifications",
  version: "0.1.0",
};

const PRIORITY_EMOJI: Record<EventPriority, string> = {
  urgent: ":rotating_light:",
  action: ":point_right:",
  warning: ":warning:",
  info: ":information_source:",
};

function buildBlocks(event: OrchestratorEvent, actions?: NotifyAction[]): unknown[] {
  const blocks: unknown[] = [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: `${PRIORITY_EMOJI[event.priority]} ${event.type} — ${event.sessionId}`,
        emoji: true,
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: event.message,
      },
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `*Project:* ${event.projectId} | *Priority:* ${event.priority} | *Time:* <!date^${Math.floor(event.timestamp.getTime() / 1000)}^{date_short_pretty} {time}|${event.timestamp.toISOString()}>`,
        },
      ],
    },
  ];

  // Add PR link if available (type-guarded)
  const prUrl = typeof event.data.prUrl === "string" ? event.data.prUrl : undefined;
  if (prUrl) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `:github: <${prUrl}|View Pull Request>`,
      },
    });
  }

  // Add CI status if available (type-guarded)
  const ciStatus = typeof event.data.ciStatus === "string" ? event.data.ciStatus : undefined;
  if (ciStatus) {
    const ciEmoji = ciStatus === CI_STATUS.PASSING ? ":white_check_mark:" : ":x:";
    blocks.push({
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `${ciEmoji} CI: ${ciStatus}`,
        },
      ],
    });
  }

  // Add action buttons
  if (actions && actions.length > 0) {
    const elements = actions
      .filter((a) => a.url || a.callbackEndpoint)
      .map((action) => {
        if (action.url) {
          return {
            type: "button",
            text: { type: "plain_text", text: action.label, emoji: true },
            url: action.url,
          };
        }
        const sanitized = action.label
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "_")
          .replace(/^_|_$/g, "");
        const idx = actions.indexOf(action);
        const actionId = sanitized ? `${sanitized}_${idx}` : `action_${idx}`;
        return {
          type: "button",
          text: { type: "plain_text", text: action.label, emoji: true },
          action_id: `ao_${actionId}`,
          value: action.callbackEndpoint,
        };
      });

    if (elements.length > 0) {
      blocks.push({
        type: "actions",
        elements,
      });
    }
  }

  blocks.push({ type: "divider" });

  return blocks;
}

async function postToWebhook(webhookUrl: string, payload: Record<string, unknown>): Promise<void> {
  const response = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Slack webhook failed (${response.status}): ${body}`);
  }
}

/**
 * Post a message using the Slack Web API (chat.postMessage).
 * Requires a Bot Token with `chat:write` scope.
 */
async function postToSlackApi(
  token: string,
  channel: string,
  text: string,
  blocks?: unknown[],
): Promise<string | null> {
  const payload: Record<string, unknown> = { channel, text };
  if (blocks) payload.blocks = blocks;

  const response = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Slack API failed (${response.status}): ${body}`);
  }

  const result = (await response.json()) as { ok: boolean; error?: string; ts?: string };
  if (!result.ok) {
    throw new Error(`Slack API error: ${result.error}`);
  }

  return result.ts ?? null;
}

export function create(config?: Record<string, unknown>): Notifier {
  const webhookUrl = (config?.webhookUrl ?? config?.webhook) as string | undefined;
  const defaultChannel = config?.channel as string | undefined;
  const username = (config?.username as string) ?? "Agent Orchestrator";

  // Support Bot Token from config or env var (SLACK_BOT_TOKEN)
  const botToken = (config?.botToken as string | undefined) ?? process.env.SLACK_BOT_TOKEN;

  // Determine transport: prefer Bot Token API if available, fall back to webhook
  const useApi = Boolean(botToken && defaultChannel);

  if (!webhookUrl && !botToken) {
    console.warn("[notifier-slack] No webhookUrl or SLACK_BOT_TOKEN configured — notifications will be no-ops");
  } else if (webhookUrl) {
    validateUrl(webhookUrl, "notifier-slack");
  }

  if (botToken && !defaultChannel) {
    console.warn("[notifier-slack] SLACK_BOT_TOKEN set but no channel configured — Bot API requires a channel");
  }

  /** Send a message using the best available transport */
  async function send(
    text: string,
    channel: string | undefined,
    blocks?: unknown[],
  ): Promise<string | null> {
    const targetChannel = channel ?? defaultChannel;

    // Prefer Bot Token API when available
    if (botToken && targetChannel) {
      return postToSlackApi(botToken, targetChannel, text, blocks);
    }

    // Fall back to webhook
    if (webhookUrl) {
      const payload: Record<string, unknown> = { username, text };
      if (targetChannel) payload.channel = targetChannel;
      if (blocks) payload.blocks = blocks;
      await postToWebhook(webhookUrl, payload);
      return null;
    }

    return null;
  }

  return {
    name: "slack",

    async notify(event: OrchestratorEvent): Promise<void> {
      if (!webhookUrl && !useApi) return;

      const blocks = buildBlocks(event);
      const fallbackText = `${PRIORITY_EMOJI[event.priority]} ${event.type} — ${event.sessionId}: ${event.message}`;
      await send(fallbackText, undefined, blocks);
    },

    async notifyWithActions(event: OrchestratorEvent, actions: NotifyAction[]): Promise<void> {
      if (!webhookUrl && !useApi) return;

      const blocks = buildBlocks(event, actions);
      const fallbackText = `${PRIORITY_EMOJI[event.priority]} ${event.type} — ${event.sessionId}: ${event.message}`;
      await send(fallbackText, undefined, blocks);
    },

    async post(message: string, context?: NotifyContext): Promise<string | null> {
      if (!webhookUrl && !useApi) return null;

      const channel = context?.channel ?? defaultChannel;
      return send(message, channel);
    },
  };
}

export default { manifest, create } satisfies PluginModule<Notifier>;
