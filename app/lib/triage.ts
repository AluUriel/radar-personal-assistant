export interface TriageSignals {
  explicitAsk?: boolean;
  directMention?: boolean;
  customerImpact?: boolean;
  blocker?: boolean;
  approvalOrReview?: boolean;
  deadlineToday?: boolean;
  newerRepliesAfterOwner?: boolean;
  staleFollowUp?: boolean;
  fyiOnly?: boolean;
  acknowledgementOnly?: boolean;
  ownerAlreadyAnswered?: boolean;
}

export type TriagePriority = "now" | "today" | "waiting";

const weights: Array<[keyof TriageSignals, number, string]> = [
  ["customerImpact", 25, "Customer impact"],
  ["blocker", 22, "Blocks someone"],
  ["explicitAsk", 18, "Explicit ask"],
  ["deadlineToday", 16, "Due today"],
  ["directMention", 12, "Direct mention"],
  ["approvalOrReview", 11, "Approval or review requested"],
  ["newerRepliesAfterOwner", 9, "New replies after your last answer"],
  ["staleFollowUp", 7, "Unresolved follow-up"],
  ["fyiOnly", -18, "FYI only"],
  ["acknowledgementOnly", -28, "Acknowledgement only"],
  ["ownerAlreadyAnswered", -35, "Already answered"],
];

export function scoreTriage(signals: TriageSignals) {
  let rawScore = 20;
  const positiveReasons: string[] = [];
  const negativeReasons: string[] = [];

  for (const [signal, weight, label] of weights) {
    if (!signals[signal]) continue;
    rawScore += weight;
    (weight > 0 ? positiveReasons : negativeReasons).push(label);
  }

  const score = Math.max(0, Math.min(100, rawScore));
  let priority: TriagePriority = "waiting";
  if (score >= 78 || (signals.customerImpact && signals.blocker)) priority = "now";
  else if (score >= 48 || signals.deadlineToday || signals.explicitAsk) priority = "today";

  return { score, priority, positiveReasons, negativeReasons } as const;
}

export function isActionable(signals: TriageSignals) {
  if (signals.acknowledgementOnly || signals.fyiOnly || signals.ownerAlreadyAnswered) return false;
  return Boolean(
    signals.explicitAsk ||
      signals.directMention ||
      signals.blocker ||
      signals.approvalOrReview ||
      signals.newerRepliesAfterOwner ||
      signals.staleFollowUp,
  );
}
