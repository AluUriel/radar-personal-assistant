export type Source = "Slack" | "Email" | "Discord";
export type Priority = "Now" | "Today" | "Waiting";

export interface Evidence {
  title: string;
  detail: string;
  kind: "issue" | "decision" | "conversation";
  url?: string;
}

export interface InboxItem {
  id: string;
  source: Source;
  priority: Priority;
  score: number;
  sender: string;
  location: string;
  time: string;
  title: string;
  excerpt: string;
  ask: string;
  why: string[];
  messages: Array<{ author: string; time: string; body: string; mine?: boolean }>;
  suggestion: string;
  evidence: Evidence[];
  permalink?: string;
}

export const demoItems: InboxItem[] = [
  {
    id: "slack-heating",
    source: "Slack",
    priority: "Now",
    score: 96,
    sender: "Maya Chen",
    location: "#customer-support",
    time: "18 min ago",
    title: "Customer blocked after the update",
    excerpt: "Can you confirm today whether restarting the controller is safe and what information we should request?",
    ask: "Confirm the next step and the diagnostic information needed.",
    why: ["Customer blocked", "Direct question", "Needs an answer today"],
    messages: [
      { author: "Maya", time: "09:42", body: "The machine stopped heating after the update. They already tried a complete power cycle." },
      { author: "Maya", time: "09:44", body: "Can you confirm today whether restarting the controller is safe and what information we should request?" },
    ],
    suggestion: "Yes, a complete power cycle is safe as a first step. Before requesting another update, I need the serial number, the version shown in Settings, and the approximate time of the last attempt. I can then check whether it matches the known issue and provide the next step.",
    evidence: [
      { kind: "issue", title: "SW-128 · Heating recovery", detail: "The runbook requires the serial number, version, and attempt time before escalation." },
      { kind: "decision", title: "Decision · Safe restart", detail: "A power cycle does not alter saved profiles or calibration." },
      { kind: "conversation", title: "Resolved case · EU-0142", detail: "The same symptom was resolved after confirming the version before recovery." },
    ],
  },
  {
    id: "email-intercom",
    source: "Email",
    priority: "Today",
    score: 82,
    sender: "Intercom Support",
    location: "Gmail · Inbox",
    time: "1 h ago",
    title: "Re: Wi-Fi disconnects every night",
    excerpt: "The customer confirmed they use a separate 2.4 GHz network. What should we check next?",
    ask: "Give support a concrete diagnostic sequence.",
    why: ["Pending follow-up", "Customer case", "New information provided"],
    messages: [
      { author: "Intercom", time: "08:31", body: "The customer confirmed they use a separate 2.4 GHz network and that the problem occurs around 02:00." },
      { author: "Intercom", time: "08:32", body: "What should we check next?" },
    ],
    suggestion: "Thanks. Since they already confirmed 2.4 GHz, let’s check whether the router changes channels or restarts around 02:00. Please ask for the router model and a screenshot of its automatic channel settings. A factory reset is not needed yet; first, let’s compare that time with the connectivity events.",
    evidence: [
      { kind: "issue", title: "Wi-Fi Stability · Diagnostics", detail: "Check restarts and automatic channel selection before resetting the machine." },
      { kind: "conversation", title: "Intercom · Overnight case", detail: "A scheduled router restart caused disconnections at the same time." },
    ],
  },
  {
    id: "discord-firmware",
    source: "Discord",
    priority: "Today",
    score: 74,
    sender: "Leo R.",
    location: "#firmware-testing",
    time: "2 h ago",
    title: "Is the scale fix already in beta?",
    excerpt: "I saw the PR was closed, but I cannot find confirmation of the build that contains it.",
    ask: "Confirm whether a fix is deployed or explain what evidence is missing.",
    why: ["Direct mention", "Version question", "May unblock testing"],
    messages: [
      { author: "Leo", time: "07:18", body: "@alu Is the scale fix already in beta? I saw the PR was closed, but I cannot find confirmation of the build that contains it." },
    ],
    suggestion: "The PR is closed, but that alone does not confirm it is in beta. I will verify the build and firmware pin before giving you a version. For now, I would not assume the fix is available for testing.",
    evidence: [
      { kind: "decision", title: "Release policy", detail: "A merged PR does not prove deployment; verify the build and channel pins." },
      { kind: "issue", title: "Scale drift fix", detail: "Implementation is complete; promotion status is still unverified." },
    ],
  },
  {
    id: "slack-review",
    source: "Slack",
    priority: "Waiting",
    score: 51,
    sender: "Noah",
    location: "#software-team",
    time: "yesterday",
    title: "Review the copy for the next beta",
    excerpt: "When you have a moment, can you review the testing section?",
    ask: "Review a document with no immediate blocker.",
    why: ["Explicit request", "No deadline", "No customer blocker"],
    messages: [
      { author: "Noah", time: "yesterday · 16:20", body: "When you have a moment, can you review the testing section for the next beta?" },
    ],
    suggestion: "Yes, I will review it. I will focus on whether the tests describe observable actions and expected outcomes, and I will leave comments if any hardware or version gate is missing.",
    evidence: [
      { kind: "decision", title: "Guide · What to test", detail: "Write observable actions and expected outcomes, not an engineering changelog." },
    ],
  },
];
