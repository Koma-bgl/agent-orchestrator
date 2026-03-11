/**
 * Agent Orchestrator — Core Type Definitions
 *
 * This file defines ALL interfaces and types that the system uses.
 * Every plugin, CLI command, and web API route builds against these.
 *
 * Architecture: 8 plugin slots + core services
 *   1. Runtime    — where sessions execute (tmux, docker, k8s, process)
 *   2. Agent      — AI coding tool (claude-code, codex, aider)
 *   3. Workspace  — code isolation (worktree, clone)
 *   4. Tracker    — issue tracking (github, linear, jira)
 *   5. SCM        — source platform + PR/CI/reviews (github, gitlab)
 *   6. Notifier   — push notifications (desktop, slack, webhook)
 *   7. Terminal   — human interaction UI (iterm2, web, none)
 *   8. Lifecycle Manager (core, not pluggable)
 */

// =============================================================================
// SESSION
// =============================================================================

/** Unique session identifier, e.g. "my-app-1", "backend-12" */
export type SessionId = string;

/** Session lifecycle states */
export type SessionStatus =
  | "spawning"
  | "working"
  | "pr_open"
  | "ci_failed"
  | "review_pending"
  | "changes_requested"
  | "approved"
  | "mergeable"
  | "merge_conflicts"
  | "merged"
  | "cleanup"
  | "needs_input"
  | "stuck"
  | "errored"
  | "killed"
  | "done"
  | "terminated";

/** Activity state as detected by the agent plugin */
export type ActivityState =
  | "active" // agent is processing (thinking, writing code)
  | "ready" // agent finished its turn, alive and waiting for input
  | "idle" // agent has been inactive for a while (stale)
  | "waiting_input" // agent is asking a question / permission prompt
  | "blocked" // agent hit an error or is stuck
  | "exited"; // agent process is no longer running

/** Activity state constants */
export const ACTIVITY_STATE = {
  ACTIVE: "active" as const,
  READY: "ready" as const,
  IDLE: "idle" as const,
  WAITING_INPUT: "waiting_input" as const,
  BLOCKED: "blocked" as const,
  EXITED: "exited" as const,
} satisfies Record<string, ActivityState>;

/** Result of activity detection, carrying both the state and an optional timestamp. */
export interface ActivityDetection {
  state: ActivityState;
  /** When activity was last observed (e.g., agent log file mtime) */
  timestamp?: Date;
}

/** Default threshold (ms) before a "ready" session becomes "idle". */
export const DEFAULT_READY_THRESHOLD_MS = 300_000; // 5 minutes

/** Session status constants */
export const SESSION_STATUS = {
  SPAWNING: "spawning" as const,
  WORKING: "working" as const,
  PR_OPEN: "pr_open" as const,
  CI_FAILED: "ci_failed" as const,
  REVIEW_PENDING: "review_pending" as const,
  CHANGES_REQUESTED: "changes_requested" as const,
  APPROVED: "approved" as const,
  MERGEABLE: "mergeable" as const,
  MERGE_CONFLICTS: "merge_conflicts" as const,
  MERGED: "merged" as const,
  CLEANUP: "cleanup" as const,
  NEEDS_INPUT: "needs_input" as const,
  STUCK: "stuck" as const,
  ERRORED: "errored" as const,
  KILLED: "killed" as const,
  DONE: "done" as const,
  TERMINATED: "terminated" as const,
} satisfies Record<string, SessionStatus>;

/** Statuses that indicate the session is in a terminal (dead) state. */
export const TERMINAL_STATUSES: ReadonlySet<SessionStatus> = new Set([
  "killed",
  "terminated",
  "done",
  "cleanup",
  "errored",
  "merged",
]);

/** Activity states that indicate the session is no longer running. */
export const TERMINAL_ACTIVITIES: ReadonlySet<ActivityState> = new Set(["exited"]);

/** Statuses that must never be restored (e.g. already merged). */
export const NON_RESTORABLE_STATUSES: ReadonlySet<SessionStatus> = new Set(["merged"]);

/** Check if a session is in a terminal (dead) state. */
export function isTerminalSession(session: {
  status: SessionStatus;
  activity: ActivityState | null;
}): boolean {
  return (
    TERMINAL_STATUSES.has(session.status) ||
    (session.activity !== null && TERMINAL_ACTIVITIES.has(session.activity))
  );
}

/** Check if a session can be restored. */
export function isRestorable(session: {
  status: SessionStatus;
  activity: ActivityState | null;
}): boolean {
  return isTerminalSession(session) && !NON_RESTORABLE_STATUSES.has(session.status);
}

/** A running agent session */
export interface Session {
  /** Unique session ID, e.g. "my-app-3" */
  id: SessionId;

  /** Which project this session belongs to */
  projectId: string;

  /** Current lifecycle status */
  status: SessionStatus;

  /** Activity state from agent plugin (null = not yet determined) */
  activity: ActivityState | null;

  /** Git branch name */
  branch: string | null;

  /** Issue identifier (if working on an issue) */
  issueId: string | null;

  /** PR info (once PR is created) */
  pr: PRInfo | null;

  /** Workspace path on disk */
  workspacePath: string | null;

  /** Runtime handle for communicating with the session */
  runtimeHandle: RuntimeHandle | null;

  /** Agent session info (summary, cost, etc.) */
  agentInfo: AgentSessionInfo | null;

  /** When the session was created */
  createdAt: Date;

  /** Last activity timestamp */
  lastActivityAt: Date;

  /** When this session was last restored (undefined if never restored) */
  restoredAt?: Date;

  /** Metadata key-value pairs */
  metadata: Record<string, string>;
}

/** Config for creating a new session */
export interface SessionSpawnConfig {
  projectId: string;
  issueId?: string;
  branch?: string;
  prompt?: string;
  /** Override the agent plugin for this session (e.g. "codex", "claude-code") */
  agent?: string;
}

/** Config for creating an orchestrator session */
export interface OrchestratorSpawnConfig {
  projectId: string;
  systemPrompt?: string;
}

// =============================================================================
// RUNTIME — Plugin Slot 1
// =============================================================================

/**
 * Runtime determines WHERE and HOW agent sessions execute.
 * tmux, docker, kubernetes, child processes, SSH, cloud sandboxes, etc.
 */
export interface Runtime {
  readonly name: string;

  /** Create a new session environment and return a handle */
  create(config: RuntimeCreateConfig): Promise<RuntimeHandle>;

  /** Destroy a session environment */
  destroy(handle: RuntimeHandle): Promise<void>;

  /** Send a text message/prompt to the running agent */
  sendMessage(handle: RuntimeHandle, message: string): Promise<void>;

  /** Capture recent output from the session */
  getOutput(handle: RuntimeHandle, lines?: number): Promise<string>;

  /** Check if the session environment is still alive */
  isAlive(handle: RuntimeHandle): Promise<boolean>;

  /** Send raw keystrokes to the session (no escaping, no Ctrl-U clear) */
  sendKeys?(handle: RuntimeHandle, keys: string): Promise<void>;

  /** Get resource metrics (uptime, memory, etc.) */
  getMetrics?(handle: RuntimeHandle): Promise<RuntimeMetrics>;

  /** Get info needed to attach a human to this session (for Terminal plugin) */
  getAttachInfo?(handle: RuntimeHandle): Promise<AttachInfo>;
}

export interface RuntimeCreateConfig {
  sessionId: SessionId;
  workspacePath: string;
  launchCommand: string;
  environment: Record<string, string>;
}

/** Opaque handle returned by runtime.create() */
export interface RuntimeHandle {
  /** Runtime-specific identifier (tmux session name, container ID, pod name, etc.) */
  id: string;
  /** Which runtime created this handle */
  runtimeName: string;
  /** Runtime-specific data */
  data: Record<string, unknown>;
}

export interface RuntimeMetrics {
  uptimeMs: number;
  memoryMb?: number;
  cpuPercent?: number;
}

export interface AttachInfo {
  /** How to connect: tmux attach, docker exec, SSH, web URL, etc. */
  type: "tmux" | "docker" | "ssh" | "web" | "process";
  /** For tmux: session name. For docker: container ID. For web: URL. */
  target: string;
  /** Optional: command to run to attach */
  command?: string;
}

// =============================================================================
// AGENT — Plugin Slot 2
// =============================================================================

/**
 * Agent adapter for a specific AI coding tool.
 * Knows how to launch, detect activity, and extract session info.
 */
export interface Agent {
  readonly name: string;

  /** Process name to look for (e.g. "claude", "codex", "aider") */
  readonly processName: string;

  /** Get the shell command to launch this agent */
  getLaunchCommand(config: AgentLaunchConfig): string;

  /** Get environment variables for the agent process */
  getEnvironment(config: AgentLaunchConfig): Record<string, string>;

  /**
   * Detect what the agent is currently doing from terminal output.
   * @deprecated Use getActivityState() instead - this uses hacky terminal parsing.
   */
  detectActivity(terminalOutput: string): ActivityState;

  /**
   * Get current activity state using agent-native mechanism (JSONL, SQLite, etc.).
   * This is the preferred method for activity detection.
   * @param readyThresholdMs - ms before "ready" becomes "idle" (default: DEFAULT_READY_THRESHOLD_MS)
   */
  getActivityState(session: Session, readyThresholdMs?: number): Promise<ActivityDetection | null>;

  /** Check if agent process is running (given runtime handle) */
  isProcessRunning(handle: RuntimeHandle): Promise<boolean>;

  /** Extract information from agent's internal data (summary, cost, session ID) */
  getSessionInfo(session: Session): Promise<AgentSessionInfo | null>;

  /**
   * Optional: get a launch command that resumes a previous session.
   * Returns null if no previous session is found (caller falls back to getLaunchCommand).
   */
  getRestoreCommand?(session: Session, project: ProjectConfig): Promise<string | null>;

  /** Optional: run setup BEFORE agent is launched (e.g. write permission settings) */
  preLaunchSetup?(workspacePath: string): Promise<void>;

  /** Optional: run setup after agent is launched (e.g. configure MCP servers) */
  postLaunchSetup?(session: Session): Promise<void>;

  /**
   * Optional: Set up agent-specific hooks/config in the workspace for automatic metadata updates.
   * Called once per workspace during ao init/start and when creating new worktrees.
   *
   * Each agent plugin implements this for their own config format:
   * - Claude Code: writes .claude/settings.json with PostToolUse hook
   * - Codex: whatever config mechanism Codex uses
   * - Aider: .aider.conf.yml or similar
   * - OpenCode: its own config
   *
   * CRITICAL: The dashboard depends on metadata being auto-updated when agents
   * run git/gh commands. Without this, PRs created by agents never show up.
   */
  setupWorkspaceHooks?(workspacePath: string, config: WorkspaceHooksConfig): Promise<void>;
}

export interface AgentLaunchConfig {
  sessionId: SessionId;
  projectConfig: ProjectConfig;
  issueId?: string;
  prompt?: string;
  permissions?: "skip" | "default" | "dontAsk" | "acceptEdits";
  model?: string;
  /**
   * System prompt to pass to the agent for orchestrator context.
   * - Claude Code: --append-system-prompt
   * - Codex: --system-prompt or AGENTS.md
   * - Aider: --system-prompt flag
   * - OpenCode: equivalent mechanism
   *
   * For short prompts only. For long prompts, use systemPromptFile instead
   * to avoid shell/tmux truncation issues.
   */
  systemPrompt?: string;
  /**
   * Path to a file containing the system prompt.
   * Preferred over systemPrompt for long prompts (e.g. orchestrator prompts)
   * because inlining 2000+ char prompts in shell commands causes truncation.
   *
   * When set, takes precedence over systemPrompt.
   * - Claude Code: --append-system-prompt "$(cat /path/to/file)"
   * - Codex/Aider: similar shell substitution
   */
  systemPromptFile?: string;
}

export interface WorkspaceHooksConfig {
  /** Data directory where session metadata files are stored */
  dataDir: string;
  /** Optional session ID (may not be known at ao init time) */
  sessionId?: string;
}

export interface AgentSessionInfo {
  /** Agent's auto-generated summary of what it's working on */
  summary: string | null;
  /** True when summary is a fallback (e.g. truncated first user message), not a real agent summary */
  summaryIsFallback?: boolean;
  /** Agent's internal session ID (for resume) */
  agentSessionId: string | null;
  /** Estimated cost so far */
  cost?: CostEstimate;
  /** Human-readable description of what the agent is currently doing (e.g. "Reading src/index.ts") */
  progressText?: string | null;
}

export interface CostEstimate {
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
}

// =============================================================================
// WORKSPACE — Plugin Slot 3
// =============================================================================

/**
 * Workspace manages code isolation — how each session gets its own copy of the repo.
 */
export interface Workspace {
  readonly name: string;

  /** Create an isolated workspace for a session */
  create(config: WorkspaceCreateConfig): Promise<WorkspaceInfo>;

  /** Destroy a workspace */
  destroy(workspacePath: string): Promise<void>;

  /** List existing workspaces for a project */
  list(projectId: string): Promise<WorkspaceInfo[]>;

  /** Optional: run hooks after workspace creation (symlinks, installs, etc.) */
  postCreate?(info: WorkspaceInfo, project: ProjectConfig): Promise<void>;

  /** Optional: check if a workspace exists and is a valid git repo */
  exists?(workspacePath: string): Promise<boolean>;

  /** Optional: restore a workspace (e.g. recreate a worktree for an existing branch) */
  restore?(config: WorkspaceCreateConfig, workspacePath: string): Promise<WorkspaceInfo>;
}

export interface WorkspaceCreateConfig {
  projectId: string;
  project: ProjectConfig;
  sessionId: SessionId;
  branch: string;
}

export interface WorkspaceInfo {
  path: string;
  branch: string;
  sessionId: SessionId;
  projectId: string;
}

// =============================================================================
// TRACKER — Plugin Slot 4
// =============================================================================

/**
 * Issue/task tracker integration — GitHub Issues, Linear, Jira, etc.
 */
export interface Tracker {
  readonly name: string;

  /** Fetch issue details */
  getIssue(identifier: string, project: ProjectConfig): Promise<Issue>;

  /** Check if issue is completed/closed */
  isCompleted(identifier: string, project: ProjectConfig): Promise<boolean>;

  /** Generate a URL for the issue */
  issueUrl(identifier: string, project: ProjectConfig): string;

  /** Extract a human-readable label from an issue URL (e.g., "INT-1327", "#42") */
  issueLabel?(url: string, project: ProjectConfig): string;

  /** Generate a git branch name for the issue */
  branchName(identifier: string, project: ProjectConfig): string;

  /** Generate a prompt for the agent to work on this issue */
  generatePrompt(identifier: string, project: ProjectConfig): Promise<string>;

  /** Optional: list issues with filters */
  listIssues?(filters: IssueFilters, project: ProjectConfig): Promise<Issue[]>;

  /** Optional: update issue state */
  updateIssue?(identifier: string, update: IssueUpdate, project: ProjectConfig): Promise<void>;

  /** Optional: create a new issue */
  createIssue?(input: CreateIssueInput, project: ProjectConfig): Promise<Issue>;

  /** Optional: fetch comments on an issue */
  getComments?(identifier: string, project: ProjectConfig): Promise<TrackerComment[]>;
}

export interface Issue {
  id: string;
  title: string;
  description: string;
  url: string;
  state: "open" | "in_progress" | "closed" | "cancelled";
  labels: string[];
  assignee?: string;
  priority?: number;
}

export interface TrackerComment {
  id: string;
  author: string;
  body: string;
  createdAt: Date;
  url: string;
}

export interface IssueFilters {
  state?: "open" | "closed" | "all";
  /** Filter by exact workflow state name (e.g. "Ready to start") */
  statusName?: string;
  labels?: string[];
  assignee?: string;
  limit?: number;
}

export interface IssueUpdate {
  state?: "open" | "in_progress" | "review" | "closed";
  /** Move to exact workflow state by name (e.g. "In Progress") */
  statusName?: string;
  labels?: string[];
  assignee?: string;
  comment?: string;
}

export interface CreateIssueInput {
  title: string;
  description: string;
  labels?: string[];
  assignee?: string;
  priority?: number;
}

// =============================================================================
// SCM — Plugin Slot 5
// =============================================================================

/**
 * Source code management platform — PR lifecycle, CI checks, code reviews.
 * This is the richest plugin interface, covering the full PR pipeline.
 */
export interface SCM {
  readonly name: string;

  // --- PR Lifecycle ---

  /** Detect if a session has an open PR (by branch name) */
  detectPR(session: Session, project: ProjectConfig): Promise<PRInfo | null>;

  /** Get current PR state */
  getPRState(pr: PRInfo): Promise<PRState>;

  /** Get PR summary with stats (state, title, additions, deletions). Optional. */
  getPRSummary?(pr: PRInfo): Promise<{
    state: PRState;
    title: string;
    additions: number;
    deletions: number;
  }>;

  /** Merge a PR */
  mergePR(pr: PRInfo, method?: MergeMethod): Promise<void>;

  /** Rebase a PR branch onto the base branch (server-side, non-destructive).
   *  Optional — not all SCM providers support this. */
  rebasePR?(pr: PRInfo): Promise<void>;

  /** Close a PR without merging */
  closePR(pr: PRInfo): Promise<void>;

  // --- CI Tracking ---

  /** Get individual CI check statuses */
  getCIChecks(pr: PRInfo): Promise<CICheck[]>;

  /** Get overall CI summary */
  getCISummary(pr: PRInfo): Promise<CIStatus>;

  // --- Review Tracking ---

  /** Get all reviews on a PR */
  getReviews(pr: PRInfo): Promise<Review[]>;

  /** Get the overall review decision */
  getReviewDecision(pr: PRInfo): Promise<ReviewDecision>;

  /** Get pending (unresolved) review comments */
  getPendingComments(pr: PRInfo): Promise<ReviewComment[]>;

  /** Get automated review comments (bots, linters, security scanners) */
  getAutomatedComments(pr: PRInfo): Promise<AutomatedComment[]>;

  // --- Merge Readiness ---

  /** Check if PR is ready to merge */
  getMergeability(pr: PRInfo): Promise<MergeReadiness>;

  // --- Comments ---

  /** Post a comment on a PR (text or with image attachments) */
  postComment?(pr: PRInfo, body: string, images?: string[]): Promise<string>;

  /** Add an emoji reaction to a PR comment */
  addReaction?(
    commentId: string,
    pr: PRInfo,
    reaction: string,
    commentType: "issue_comment" | "review_comment",
  ): Promise<void>;

  /** Resolve a review thread by its GraphQL node ID */
  resolveThread?(threadId: string): Promise<void>;

  /** Get list of files changed in a PR */
  getChangedFiles?(pr: PRInfo): Promise<string[]>;
}

// --- PR Types ---

export interface PRInfo {
  number: number;
  url: string;
  title: string;
  owner: string;
  repo: string;
  branch: string;
  baseBranch: string;
  isDraft: boolean;
}

export type PRState = "open" | "merged" | "closed";

/** PR state constants */
export const PR_STATE = {
  OPEN: "open" as const,
  MERGED: "merged" as const,
  CLOSED: "closed" as const,
} satisfies Record<string, PRState>;

export type MergeMethod = "merge" | "squash" | "rebase";

// --- CI Types ---

export interface CICheck {
  name: string;
  status: "pending" | "running" | "passed" | "failed" | "skipped";
  url?: string;
  conclusion?: string;
  startedAt?: Date;
  completedAt?: Date;
}

export type CIStatus = "pending" | "passing" | "failing" | "none";

/** CI status constants */
export const CI_STATUS = {
  PENDING: "pending" as const,
  PASSING: "passing" as const,
  FAILING: "failing" as const,
  NONE: "none" as const,
} satisfies Record<string, CIStatus>;

// --- Review Types ---

export interface Review {
  author: string;
  state: "approved" | "changes_requested" | "commented" | "dismissed" | "pending";
  body?: string;
  submittedAt: Date;
}

export type ReviewDecision = "approved" | "changes_requested" | "pending" | "none";

export interface ReviewComment {
  id: string;
  /** GraphQL node ID of the review thread (for resolving). Only present for review_comment. */
  threadId?: string;
  author: string;
  body: string;
  path?: string;
  line?: number;
  isResolved: boolean;
  createdAt: Date;
  url: string;
  /** Distinguishes inline review comments from general PR conversation comments */
  commentType: "review_comment" | "issue_comment";
}

export interface AutomatedComment {
  id: string;
  botName: string;
  body: string;
  path?: string;
  line?: number;
  severity: "error" | "warning" | "info";
  createdAt: Date;
  url: string;
}

// --- Merge Readiness ---

export interface MergeReadiness {
  mergeable: boolean;
  ciPassing: boolean;
  approved: boolean;
  noConflicts: boolean;
  blockers: string[];
}

// =============================================================================
// NOTIFIER — Plugin Slot 6 (PRIMARY INTERFACE)
// =============================================================================

/**
 * Notifier is the PRIMARY interface between the orchestrator and the human.
 * The human walks away after spawning agents. Notifications bring them back.
 *
 * Push, not pull. The human never polls.
 */
export interface Notifier {
  readonly name: string;

  /** Push a notification to the human */
  notify(event: OrchestratorEvent): Promise<void>;

  /** Push a notification with actionable buttons/links */
  notifyWithActions?(event: OrchestratorEvent, actions: NotifyAction[]): Promise<void>;

  /** Post a message to a channel (for team-visible notifiers like Slack) */
  post?(message: string, context?: NotifyContext): Promise<string | null>;
}

export interface NotifyAction {
  label: string;
  url?: string;
  callbackEndpoint?: string;
}

export interface NotifyContext {
  sessionId?: SessionId;
  projectId?: string;
  prUrl?: string;
  channel?: string;
}

// =============================================================================
// TERMINAL — Plugin Slot 7
// =============================================================================

/**
 * Terminal manages how humans view/interact with running sessions.
 * Opens IDE tabs, browser windows, or terminal sessions.
 */
export interface Terminal {
  readonly name: string;

  /** Open a session for human interaction */
  openSession(session: Session): Promise<void>;

  /** Open all sessions for a project */
  openAll(sessions: Session[]): Promise<void>;

  /** Check if a session is already open in a tab/window */
  isSessionOpen?(session: Session): Promise<boolean>;
}

// =============================================================================
// EVENTS
// =============================================================================

/** Priority levels for events — determines notification routing */
export type EventPriority = "urgent" | "action" | "warning" | "info";

/** All orchestrator event types */
export type EventType =
  // Session lifecycle
  | "session.spawned"
  | "session.working"
  | "session.exited"
  | "session.killed"
  | "session.stuck"
  | "session.needs_input"
  | "session.errored"
  // PR lifecycle
  | "pr.created"
  | "pr.updated"
  | "pr.merged"
  | "pr.closed"
  // CI
  | "ci.passing"
  | "ci.failing"
  | "ci.fix_sent"
  | "ci.fix_failed"
  // Reviews
  | "review.pending"
  | "review.approved"
  | "review.changes_requested"
  | "review.comments_sent"
  | "review.comments_unresolved"
  // Automated reviews
  | "automated_review.found"
  | "automated_review.fix_sent"
  // Merge
  | "merge.ready"
  | "merge.conflicts"
  | "merge.completed"
  // Reactions
  | "reaction.triggered"
  | "reaction.escalated"
  // Verification
  | "verify.started"
  | "verify.completed"
  | "verify.failed"
  // Queue poller
  | "queue.polled"
  | "queue.session_spawned"
  | "queue.spawn_failed"
  | "queue.cap_reached"
  // Summary
  | "summary.all_complete";

/** An event emitted by the orchestrator */
export interface OrchestratorEvent {
  id: string;
  type: EventType;
  priority: EventPriority;
  sessionId: SessionId;
  projectId: string;
  timestamp: Date;
  message: string;
  data: Record<string, unknown>;
}

// =============================================================================
// REACTIONS
// =============================================================================

/** A configured automatic reaction to an event */
export interface ReactionConfig {
  /** Whether this reaction is enabled */
  auto: boolean;

  /** What to do: send message to agent, notify human, auto-merge, or fetch & forward review comments */
  action: "send-to-agent" | "send-comments-to-agent" | "notify" | "auto-merge";

  /** Message to send (for send-to-agent) */
  message?: string;

  /** Priority for notifications */
  priority?: EventPriority;

  /** How many times to retry send-to-agent before escalating */
  retries?: number;

  /** Escalate to human notification after this many failures or this duration */
  escalateAfter?: number | string;

  /** Threshold duration for time-based triggers (e.g. "10m" for stuck detection) */
  threshold?: string;

  /** Whether to include a summary in the notification */
  includeSummary?: boolean;
}

export interface ReactionResult {
  reactionType: string;
  success: boolean;
  action: string;
  message?: string;
  escalated: boolean;
}

// =============================================================================
// CONFIGURATION
// =============================================================================

/**
 * Agent persona identifier — maps to a .md file in the personas directory.
 * Built-in: security-auditor, code-reviewer, test-writer, bug-fixer, refactorer, full-stack-dev.
 * Custom: drop any .md file into the personas directory and reference it by filename (without extension).
 */
export type AgentPersona = string;

/** Top-level orchestrator configuration (from agent-orchestrator.yaml) */
export interface OrchestratorConfig {
  /**
   * Path to the config file (set automatically during load).
   * Used for hash-based directory structure.
   * All paths are auto-derived from this location.
   */
  configPath: string;

  /** Web dashboard port (defaults to 3000) */
  port?: number;

  /** Terminal WebSocket server port (defaults to 3001) */
  terminalPort?: number;

  /** Direct terminal WebSocket server port (defaults to 3003) */
  directTerminalPort?: number;

  /** Milliseconds before a "ready" session becomes "idle" (default: 300000 = 5 min) */
  readyThresholdMs: number;

  /** Directory containing agent persona .md files (default: ./personas) */
  personasDir?: string;

  /** Default plugin selections */
  defaults: DefaultPlugins;

  /** Project configurations */
  projects: Record<string, ProjectConfig>;

  /** Notification channel configs */
  notifiers: Record<string, NotifierConfig>;

  /** Notification routing by priority */
  notificationRouting: Record<EventPriority, string[]>;

  /** Default reaction configs */
  reactions: Record<string, ReactionConfig>;
}

export interface DefaultPlugins {
  runtime: string;
  agent: string;
  workspace: string;
  notifiers: string[];
}

export interface ProjectConfig {
  /** Display name */
  name: string;

  /** GitHub repo in "owner/repo" format */
  repo: string;

  /** Local path to the repo */
  path: string;

  /** Default branch (main, master, next, develop, etc.) */
  defaultBranch: string;

  /** Session name prefix (e.g. "app" → "app-1", "app-2") */
  sessionPrefix: string;

  /** Override default runtime */
  runtime?: string;

  /** Override default agent */
  agent?: string;

  /** Override default workspace */
  workspace?: string;

  /** Issue tracker configuration */
  tracker?: TrackerConfig;

  /** SCM configuration (usually inferred from repo) */
  scm?: SCMConfig;

  /** Files/dirs to symlink into workspaces */
  symlinks?: string[];

  /** Commands to run after workspace creation */
  postCreate?: string[];

  /** Agent-specific configuration */
  agentConfig?: AgentSpecificConfig;

  /** Per-project reaction overrides */
  reactions?: Record<string, Partial<ReactionConfig>>;

  /** Pre-built agent personas to activate (e.g. ["security-auditor", "test-writer"]) */
  agentPersonas?: AgentPersona[];

  /** Inline rules/instructions passed to every agent prompt */
  agentRules?: string;

  /** Path to a file containing agent rules (relative to project path) */
  agentRulesFile?: string;

  /** Rules for the orchestrator agent (stored, reserved for future use) */
  orchestratorRules?: string;

  /** Visual verification config for this project */
  verify?: VerifyConfig;

  /** Queue poller config — auto-spawn sessions from tracker issues */
  queuePoller?: QueuePollerConfig;

  /** Worktree cleanup config — auto-remove worktrees after PR merge */
  worktreeCleanup?: WorktreeCleanupConfig;
}

export interface QueuePollerConfig {
  /** Enable the queue poller for this project */
  enabled: boolean;
  /** Polling interval — "30s", "5m", "1h" or milliseconds */
  interval: string | number;
  /** Maximum concurrent active sessions for this project */
  maxSessions: number;
  /** Filters for which issues to pick up */
  filters?: {
    labels?: string[];
    /** Exact workflow state name (e.g. "Ready to start") */
    statusName?: string;
    assignee?: string;
  };
  /** Actions to take after spawning a session */
  onSpawn?: {
    /** Move issue to this workflow state (e.g. "In Progress") */
    moveToStatus?: string;
    /** Add this label to the issue */
    addLabel?: string;
    /** Remove this label from the issue */
    removeLabel?: string;
  };
  /** Max issues to fetch per poll (default 50) */
  limit?: number;
}

export interface WorktreeCleanupConfig {
  /** Enable automatic worktree cleanup after PR merge */
  enabled: boolean;
  /** Grace period before cleanup — "1d", "6h", "30m" or milliseconds */
  delayAfterMerge: string | number;
}

export interface TrackerConfig {
  plugin: string;
  /** Plugin-specific config (e.g. teamId for Linear) */
  [key: string]: unknown;
}

export interface SCMConfig {
  plugin: string;
  [key: string]: unknown;
}

export interface NotifierConfig {
  plugin: string;
  [key: string]: unknown;
}

export interface AgentSpecificConfig {
  permissions?: "skip" | "default" | "dontAsk" | "acceptEdits";
  model?: string;
  /**
   * OAuth token for Claude Code headless/server use.
   * Generated via `claude setup-token` (valid for 1 year).
   * Passed as CLAUDE_CODE_OAUTH_TOKEN env var to avoid daily re-login.
   * Supports ${ENV_VAR} syntax for referencing environment variables.
   */
  oauthToken?: string;
  [key: string]: unknown;
}

// =============================================================================
// VISUAL VERIFICATION
// =============================================================================

/** Auth strategy for visual verification screenshots */
export type VerifyAuthStrategy = "none" | "firebase-password" | "stored";

/** Configuration for visual verification of agent changes */
export interface VerifyConfig {
  /** Whether visual verification is enabled */
  enabled: boolean;

  /** Auth configuration for the target app */
  auth: VerifyAuthConfig;

  /** Base URL of the app to screenshot (e.g. "http://localhost:3000") */
  baseUrl: string;

  /** Pages to capture after PR is created */
  paths: VerifyPageConfig[];

  /** Viewport dimensions */
  viewport?: { width: number; height: number };

  /** Whether to post screenshots as PR comments */
  postToPR?: boolean;

  /**
   * Glob patterns for files that indicate visible UI changes.
   * Verification only runs if the PR touches at least one file matching these patterns.
   * If empty/omitted, verification always runs.
   * Example: ["src/components/**", "src/app/**", "**\/*.tsx", "**\/*.css"]
   */
  filePatterns?: string[];
}

/** Auth configuration for visual verification */
export interface VerifyAuthConfig {
  /** How to authenticate */
  strategy: VerifyAuthStrategy;

  /** URL to navigate to before login (for firebase-password strategy) */
  loginUrl?: string;

  /** Username/email — supports ${ENV_VAR} syntax */
  username?: string;

  /** Password — supports ${ENV_VAR} syntax */
  password?: string;

  /** Path to persisted auth state JSON (for stored strategy) */
  storageStatePath?: string;

  /**
   * CSS selectors for the login flow elements.
   * Use when login is triggered by a button that opens an in-page dialog/modal.
   * If omitted, defaults are used (common input[type=email], input[type=password], etc.)
   */
  selectors?: LoginSelectors;
}

/**
 * CSS selectors for the login flow.
 * Covers apps where login is triggered by clicking a button that opens
 * an in-page dialog/modal with email + password fields.
 */
export interface LoginSelectors {
  /** Selector for the button that opens the login dialog (e.g. "button:has-text('Login')") */
  loginButton?: string;

  /** Selector for the email/username input inside the dialog */
  emailInput?: string;

  /** Selector for the password input inside the dialog */
  passwordInput?: string;

  /** Selector for the submit button inside the dialog */
  submitButton?: string;

  /** Selector to wait for after successful login (e.g. "[data-testid='dashboard']") */
  successIndicator?: string;
}

/** A page to screenshot during verification */
export interface VerifyPageConfig {
  /** URL path to navigate to (e.g. "/dashboard") */
  url: string;

  /** Human-readable name for this page */
  name: string;

  /** Optional: wait for a specific selector before capturing */
  waitForSelector?: string;

  /** Optional: delay in ms after page load before capture */
  delayMs?: number;
}

/** Result of a visual verification run */
export interface VerifyResult {
  /** Whether verification completed successfully */
  success: boolean;

  /** Screenshot file paths */
  screenshots: VerifyScreenshot[];

  /** Error message if verification failed */
  error?: string;
}

/** A captured screenshot */
export interface VerifyScreenshot {
  /** Page name */
  name: string;

  /** URL that was captured */
  url: string;

  /** Local file path to the screenshot */
  filePath: string;
}

// =============================================================================
// PLUGIN SYSTEM
// =============================================================================

/** Plugin slot types */
export type PluginSlot =
  | "runtime"
  | "agent"
  | "workspace"
  | "tracker"
  | "scm"
  | "notifier"
  | "terminal";

/** Plugin manifest — what every plugin exports */
export interface PluginManifest {
  /** Plugin name (e.g. "tmux", "claude-code", "github") */
  name: string;

  /** Which slot this plugin fills */
  slot: PluginSlot;

  /** Human-readable description */
  description: string;

  /** Version */
  version: string;
}

/** What a plugin module must export */
export interface PluginModule<T = unknown> {
  manifest: PluginManifest;
  create(config?: Record<string, unknown>): T;
}

// =============================================================================
// SESSION METADATA (flat file format)
// =============================================================================

/**
 * Session metadata stored as flat key=value files.
 * Matches the existing bash script format for backwards compatibility.
 *
 * Note: In the new architecture, session files are named with user-facing names
 * (e.g., "int-1") and contain a tmuxName field for the globally unique tmux name
 * (e.g., "a3b4c5d6e7f8-int-1").
 */
export interface SessionMetadata {
  worktree: string;
  branch: string;
  status: string;
  tmuxName?: string; // Globally unique tmux session name (includes hash)
  issue?: string;
  pr?: string;
  summary?: string;
  project?: string;
  agent?: string; // Agent plugin name (e.g. "codex", "claude-code") — persisted for lifecycle
  createdAt?: string;
  runtimeHandle?: string;
  restoredAt?: string;
  mergedAt?: string; // ISO timestamp when PR was merged
  worktreeCleanedAt?: string; // ISO timestamp when worktree was cleaned up
  dashboardPort?: number;
  terminalWsPort?: number;
  directTerminalWsPort?: number;
}

// =============================================================================
// SERVICE INTERFACES (core, not pluggable)
// =============================================================================

/** Session manager — CRUD for sessions */
export interface SessionManager {
  spawn(config: SessionSpawnConfig): Promise<Session>;
  spawnOrchestrator(config: OrchestratorSpawnConfig): Promise<Session>;
  restore(sessionId: SessionId): Promise<Session>;
  list(projectId?: string): Promise<Session[]>;
  get(sessionId: SessionId): Promise<Session | null>;
  kill(sessionId: SessionId): Promise<void>;
  cleanup(projectId?: string, options?: { dryRun?: boolean }): Promise<CleanupResult>;
  send(sessionId: SessionId, message: string): Promise<void>;
}

export interface CleanupResult {
  killed: string[];
  skipped: string[];
  errors: Array<{ sessionId: string; error: string }>;
}

/** Lifecycle manager — state machine + reaction engine */
export interface LifecycleManager {
  /** Start the lifecycle polling loop */
  start(intervalMs?: number): void;

  /** Stop the lifecycle polling loop */
  stop(): void;

  /** Get current state for all sessions */
  getStates(): Map<SessionId, SessionStatus>;

  /** Force-check a specific session now */
  check(sessionId: SessionId): Promise<void>;
}

/** Plugin registry — discovery + loading */
export interface PluginRegistry {
  /** Register a plugin, optionally with config to pass to create() */
  register(plugin: PluginModule, config?: Record<string, unknown>): void;

  /** Get a plugin by slot and name */
  get<T>(slot: PluginSlot, name: string): T | null;

  /** List plugins for a slot */
  list(slot: PluginSlot): PluginManifest[];

  /** Load built-in plugins, optionally with orchestrator config for plugin settings */
  loadBuiltins(
    config?: OrchestratorConfig,
    importFn?: (pkg: string) => Promise<unknown>,
  ): Promise<void>;

  /** Load plugins from config (npm packages, local paths) */
  loadFromConfig(
    config: OrchestratorConfig,
    importFn?: (pkg: string) => Promise<unknown>,
  ): Promise<void>;
}

// =============================================================================
// ERROR DETECTION HELPERS
// =============================================================================

/**
 * Detect if an error indicates that an issue was not found in the tracker.
 * Used by spawn validation to distinguish "not found" from other errors (auth, network, etc).
 *
 * Uses specific patterns to avoid matching infrastructure errors like "API key not found",
 * "Team not found", "Configuration not found", etc.
 */
export function isIssueNotFoundError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const message = (err as Error).message?.toLowerCase() || "";

  // Match issue-specific not-found patterns
  return (
    (message.includes("issue") &&
      (message.includes("not found") || message.includes("does not exist"))) ||
    message.includes("no issue found") ||
    message.includes("could not find issue") ||
    // GitHub: "no issue found" or "could not resolve to an Issue"
    message.includes("could not resolve to an issue") ||
    // Linear: "Issue <id> not found" or "No issue with identifier"
    message.includes("no issue with identifier")
  );
}

/** Thrown when a session cannot be restored (e.g. merged, still working). */
export class SessionNotRestorableError extends Error {
  constructor(
    public readonly sessionId: string,
    public readonly reason: string,
  ) {
    super(`Session ${sessionId} cannot be restored: ${reason}`);
    this.name = "SessionNotRestorableError";
  }
}

/** Thrown when a workspace is missing and cannot be recreated. */
export class WorkspaceMissingError extends Error {
  constructor(
    public readonly path: string,
    public readonly detail?: string,
  ) {
    super(`Workspace missing at ${path}${detail ? `: ${detail}` : ""}`);
    this.name = "WorkspaceMissingError";
  }
}
