/**
 * Every tunable number for the CRM lives here. Change these rather than editing
 * the engines, and document any change in docs/CRM_PROTOCOL.md.
 */

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export const CRM_CONFIG = {
  /** Leads per batch. One batch is one person's day. */
  batchSize: envInt("BATCH_SIZE", 25),

  /**
   * How many batches of each kind to keep queued ahead of the team. The engine
   * tops the queue back up every run rather than cutting the whole backlog at
   * once, so a batch is only ever created against a fresh lead score.
   */
  queueDepthBrokerage: envInt("QUEUE_DEPTH_BROKERAGE", 4),
  queueDepthBroker: envInt("QUEUE_DEPTH_BROKER", 2),

  /** Working days allowed per batch before it counts as late. */
  slaDays: envInt("BATCH_SLA_DAYS", 1),

  /** Days past due before a batch escalates from Overdue to Critically Overdue. */
  criticalOverdueDays: envInt("BATCH_CRITICAL_DAYS", 3),

  /**
   * Dubai works Monday–Friday; Saturday and Sunday are skipped when computing
   * due dates so a Friday batch is not born a day late.
   * 0 = Sunday … 6 = Saturday.
   */
  weekendDays: [6, 0] as number[],

  /** Only brokerages at or above this score are worth a person's time. */
  minLeadScoreBrokerage: envInt("MIN_LEAD_SCORE_BROKERAGE", 40),
  minLeadScoreBroker: envInt("MIN_LEAD_SCORE_BROKER", 35),

  /** Default targets seeded on new periods. Humans adjust them in Notion. */
  defaultDailyTouches: envInt("TARGET_DAILY_TOUCHES", 25),
  defaultDailyBatches: envInt("TARGET_DAILY_BATCHES", 1),
  defaultDailyReplies: envInt("TARGET_DAILY_REPLIES", 3),
  defaultDailyMeetings: envInt("TARGET_DAILY_MEETINGS", 1),

  /** How many days of Target rows to keep ahead of today. */
  targetHorizonDays: envInt("TARGET_HORIZON_DAYS", 14),
} as const;

/** Pipeline stages, in order. Index doubles as pipeline depth for reporting. */
export const STAGES = [
  "🆕 New Lead",
  "🎯 Queued",
  "📩 Connection Sent",
  "💬 Replied",
  "📞 Contacted",
  "🤝 Meeting Booked",
  "🎬 Demo Done",
  "📄 Proposal Sent",
  "✅ Won",
  "❌ Lost",
  "😴 Nurture",
] as const;

export type Stage = (typeof STAGES)[number];

export const STAGE_NEW: Stage = "🆕 New Lead";
export const STAGE_QUEUED: Stage = "🎯 Queued";

/** Stages that mean the lead has actually been reached out to. */
export const WORKED_STAGES: readonly string[] = [
  "📩 Connection Sent",
  "💬 Replied",
  "📞 Contacted",
  "🤝 Meeting Booked",
  "🎬 Demo Done",
  "📄 Proposal Sent",
  "✅ Won",
  "❌ Lost",
  "😴 Nurture",
];

/** Stages that mean the lead replied to us. */
export const REPLIED_STAGES: readonly string[] = [
  "💬 Replied",
  "📞 Contacted",
  "🤝 Meeting Booked",
  "🎬 Demo Done",
  "📄 Proposal Sent",
  "✅ Won",
];

/** Stages that mean a meeting happened or is booked. */
export const MEETING_STAGES: readonly string[] = [
  "🤝 Meeting Booked",
  "🎬 Demo Done",
  "📄 Proposal Sent",
  "✅ Won",
];

/** A lead in one of these is finished — never re-batch it. */
export const TERMINAL_STAGES: readonly string[] = ["✅ Won", "❌ Lost"];

export const BATCH_STATUS = {
  queued: "Queued",
  inProgress: "In Progress",
  completed: "Completed",
  delayed: "Delayed",
  cancelled: "Cancelled",
} as const;

export const DELAY_STATUS = {
  onTrack: "On Track",
  dueToday: "Due Today",
  overdue: "Overdue",
  critical: "Critically Overdue",
  doneOnTime: "Done On Time",
  doneLate: "Done Late",
} as const;
