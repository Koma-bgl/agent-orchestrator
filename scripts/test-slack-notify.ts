/**
 * Quick script to test Slack notification for PR creation.
 * Usage: SLACK_BOT_TOKEN=xoxb-... npx tsx scripts/test-slack-notify.ts
 */
import slackPlugin from "@composio/ao-plugin-notifier-slack";

const token = process.env.SLACK_BOT_TOKEN;
if (!token) {
  console.error("Set SLACK_BOT_TOKEN env var");
  process.exit(1);
}

const notifier = slackPlugin.create({
  botToken: token,
  channel: "#ai-research",
});

await notifier.notify({
  type: "pr.created",
  sessionId: "test-session-1",
  projectId: "my-project",
  message: "test-session-1 opened a PR (#42)",
  priority: "action",
  timestamp: new Date(),
  data: {
    prUrl: "https://github.com/org/repo/pull/42",
    prNumber: 42,
    prTitle: "Fix the thing",
    branch: "fix/the-thing",
  },
});

console.log("Sent to #ai-research");
