export type SourceKind = "slack" | "gmail" | "discord" | "intercom";

export interface NormalizedConversation {
  id: string;
  source: SourceKind;
  externalId: string;
  title: string;
  location: string;
  participantNames: string[];
  permalink?: string;
  updatedAt: string;
  messages: NormalizedMessage[];
  request: null | {
    summary: string;
    lastActivityAt: string;
    signals: {
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
    };
  };
}

export interface NormalizedMessage {
  id: string;
  conversationId: string;
  externalId: string;
  sender: string;
  senderIsOwner: boolean;
  content: string;
  sentAt: string;
  contentHash: string;
  deleted: boolean;
}

export interface SyncBatch {
  syncRunId: string;
  source: SourceKind;
  startedAt: string;
  completedAt: string;
  conversations: NormalizedConversation[];
  nextCursor?: string;
  coverage: { complete: boolean; detail: string };
}

export interface SourceAdapter {
  readonly source: SourceKind;
  verifyIdentity(): Promise<{ account: string; workspace?: string }>;
  sync(cursor?: string): Promise<SyncBatch>;
}
