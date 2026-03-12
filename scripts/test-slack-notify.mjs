/**
 * Quick script to test Slack notification for PR creation.
 * Usage: SLACK_BOT_TOKEN=xoxb-... node scripts/test-slack-notify.mjs
 */

const token = process.env.SLACK_BOT_TOKEN;
if (!token) {
  console.error("Set SLACK_BOT_TOKEN env var");
  process.exit(1);
}

const now = new Date();
const ts = Math.floor(now.getTime() / 1000);

const blocks = [
  {
    type: "header",
    text: {
      type: "plain_text",
      text: ":point_right: pr.created — test-session-1",
      emoji: true,
    },
  },
  {
    type: "section",
    text: {
      type: "mrkdwn",
      text: "test-session-1 opened a PR (#42)",
    },
  },
  {
    type: "context",
    elements: [
      {
        type: "mrkdwn",
        text: `*Project:* my-project | *Priority:* action | *Time:* <!date^${ts}^{date_short_pretty} {time}|${now.toISOString()}>`,
      },
    ],
  },
  {
    type: "section",
    text: {
      type: "mrkdwn",
      text: ":github: <https://github.com/org/repo/pull/42|View Pull Request>",
    },
  },
  { type: "divider" },
];

const response = await fetch("https://slack.com/api/chat.postMessage", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
  },
  body: JSON.stringify({
    channel: "#ai-research",
    text: ":point_right: pr.created — test-session-1: test-session-1 opened a PR (#42)",
    blocks,
  }),
});

const result = await response.json();
if (!result.ok) {
  console.error("Slack API error:", result.error);
  process.exit(1);
}
console.log("Sent to #ai-research");
