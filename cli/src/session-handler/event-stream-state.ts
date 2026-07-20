// Pure event-stream derivation functions for session lifecycle state.
// These functions derive lifecycle decisions from an event buffer array.
// Zero imports from thread-session-runtime.ts, store.ts, or state.ts.
// Only types from @opencode-ai/sdk/v2 and the getOpencodeEventSessionId helper.

import type {
  Event as OpenCodeEvent,
  Message as OpenCodeMessage,
  Part,
} from '@opencode-ai/sdk/v2'
import { getOpencodeEventSessionId } from './opencode-session-event-log.js'

type QueueQuestionHandoffStartedEvent = {
  type: 'queue.question-handoff-started'
  properties: {
    sessionID: string
  }
}

export type EventBufferEvent = OpenCodeEvent | QueueQuestionHandoffStartedEvent

export type EventBufferEntry = {
  event: EventBufferEvent
  timestamp: number
  eventIndex?: number
}

export function getEventBufferSessionId(event: EventBufferEvent): string | undefined {
  if (event.type === 'queue.question-handoff-started') {
    return event.properties.sessionID
  }
  return getOpencodeEventSessionId(event)
}

type AssistantMessage = Extract<OpenCodeMessage, { role: 'assistant' }>
type UserMessage = Extract<OpenCodeMessage, { role: 'user' }>

function getTaskChildSessionId({
  part,
}: {
  part: Extract<Part, { type: 'tool' }>
}): string | undefined {
  // Event-shape reference:
  // - cli/src/session-handler/event-stream-fixtures/real-session-task-three-parallel-sleeps.jsonl
  // - In real task events, state.metadata.sessionId appears on running/completed
  //   tool updates and is the canonical child-session identifier.
  // We intentionally do not parse state.output because it is user-facing text
  // and can change format across providers/versions.
  const metadataValue = (part.state as { metadata?: unknown }).metadata
  const metadataSessionId =
    metadataValue && typeof metadataValue === 'object'
      ? (metadataValue as { sessionId?: unknown }).sessionId
      : undefined
  if (typeof metadataSessionId === 'string' && metadataSessionId.length > 0) {
    return metadataSessionId
  }
  return undefined
}

// Extracts a parent→child task edge from a single event.
//
// `parentSessionId` controls filtering:
//   - When provided: only returns edges whose parent (part.sessionID) matches.
//     Used by the depth-1 shortcuts (getDerivedSubtaskIndex / AgentType /
//     SubagentSessions) which only look at direct children of mainSessionId.
//   - When undefined: returns any task edge regardless of parent session.
//     Used by the graph-aware chain walker (getDerivedSubtaskChain) which
//     must see edges emitted by subagents at arbitrary depth.
//
// `parentSessionId` is also returned so callers can build the full graph
// without re-reading the part.
function getTaskCandidateFromEvent({
  event,
  parentSessionId,
}: {
  event: EventBufferEvent
  /**
   * When provided, only return task edges whose parent (part.sessionID) matches.
   * When undefined, return any task edge regardless of parent session.
   */
  parentSessionId?: string
}): {
  parentSessionId: string
  assistantMessageId: string
  childSessionId: string
  subagentType?: string
  description?: string
} | undefined {
  if (event.type !== 'message.part.updated') {
    return undefined
  }

  const part = event.properties.part
  if (parentSessionId !== undefined && part.sessionID !== parentSessionId) {
    return undefined
  }
  if (part.type !== 'tool' || part.tool !== 'task' || part.state.status === 'pending') {
    return undefined
  }

  const childSessionId = getTaskChildSessionId({ part })
  if (!childSessionId) {
    return undefined
  }

  const subagentType = part.state.input?.subagent_type
  const description = part.state.input?.description
  return {
    parentSessionId: part.sessionID,
    assistantMessageId: part.messageID,
    childSessionId,
    subagentType: typeof subagentType === 'string' ? subagentType : undefined,
    description: typeof description === 'string' ? description : undefined,
  }
}

export type DerivedSubagentSession = {
  childSessionId: string
  subagentType?: string
  description?: string
  timestamp: number
}

// Scans backward for most recent session-scoped lifecycle event.
// Returns true if the latest lifecycle event for sessionId is session.status busy.
export function isSessionBusy({
  events,
  sessionId,
  upToIndex,
}: {
  events: EventBufferEntry[]
  sessionId: string
  upToIndex?: number
}): boolean {
  const end = upToIndex ?? events.length - 1
  for (let i = end; i >= 0; i--) {
    const entry = events[i]
    if (!entry) {
      continue
    }
     const e = entry.event
     const eid = getEventBufferSessionId(e)
    if (eid !== sessionId) {
      continue
    }
    if (e.type === 'session.idle') {
      return false
    }
    if (e.type === 'session.status') {
      return e.properties.status.type === 'busy'
    }
  }
  return false
}

export function didQuestionQueueHandoffSinceLatestQuestionAsked({
  events,
  sessionId,
  upToIndex,
}: {
  events: EventBufferEntry[]
  sessionId: string
  upToIndex?: number
}): boolean {
  const end = upToIndex ?? events.length - 1
  for (let i = end; i >= 0; i--) {
    const entry = events[i]
    if (!entry) {
      continue
    }
    const event = entry.event
    const eventSessionId = getEventBufferSessionId(event)
    if (eventSessionId !== sessionId) {
      continue
    }
    if (event.type === 'queue.question-handoff-started') {
      return true
    }
    if (event.type === 'question.asked') {
      return false
    }
  }
  return false
}

export function derivePendingPermissionRequests({
  events,
  sessionId,
}: {
  events: EventBufferEntry[]
  sessionId: string
}): string[] {
  const permissions = new Set<string>()

  for (const entry of events) {
    const event = entry.event
    const eventSessionId = getEventBufferSessionId(event)
    if (eventSessionId !== sessionId) {
      continue
    }

    if (event.type === 'permission.asked') {
      permissions.add(event.properties.id)
      continue
    }

    if (event.type === 'permission.replied') {
      permissions.delete(event.properties.requestID)
    }
  }

  return [...permissions]
}

export function isAssistantMessageNaturalCompletion({
  message,
}: {
  message: AssistantMessage
}): boolean {
  if (typeof message.time.completed !== 'number') {
    return false
  }
  if (message.error) {
    return false
  }
  // finish="tool-calls" means the model's last step was tool execution.
  // Mid-turn tool-call steps don't get footers — the footer comes from the
  // final text response (finish="stop") that follows. If the turn ends with
  // only tool-calls and no text follow-up, no footer is emitted. This is
  // acceptable since models almost always follow up with text after tools.
  return message.finish !== 'tool-calls'
}

export function hasAssistantMessageCompletedBefore({
  events,
  sessionId,
  messageId,
  upToIndex,
}: {
  events: EventBufferEntry[]
  sessionId: string
  messageId: string
  upToIndex?: number
}): boolean {
  const end = upToIndex ?? events.length - 1
  for (let i = end; i >= 0; i--) {
    const entry = events[i]
    if (!entry) {
      continue
    }
    const event = entry.event
    if (event.type !== 'message.updated') {
      continue
    }
    const info = event.properties.info
    if (info.sessionID !== sessionId || info.role !== 'assistant' || info.id !== messageId) {
      continue
    }
    if (typeof info.time.completed === 'number') {
      return true
    }
  }
  return false
}

export function getLatestUserMessage({
  events,
  sessionId,
  upToIndex,
}: {
  events: EventBufferEntry[]
  sessionId: string
  upToIndex?: number
}): UserMessage | undefined {
  const end = upToIndex ?? events.length - 1
  let latestUserMessage: UserMessage | undefined
  for (let i = end; i >= 0; i--) {
    const entry = events[i]
    if (!entry) {
      continue
    }
    const event = entry.event
    if (event.type !== 'message.updated') {
      continue
    }
    const info = event.properties.info
    if (info.sessionID !== sessionId || info.role !== 'user') {
      continue
    }
    if (!latestUserMessage) {
      latestUserMessage = info
      continue
    }
    if (info.time.created > latestUserMessage.time.created) {
      latestUserMessage = info
    }
  }
  return latestUserMessage
}

export function getCurrentTurnStartTime({
  events,
  sessionId,
  upToIndex,
}: {
  events: EventBufferEntry[]
  sessionId: string
  upToIndex?: number
}): number | undefined {
  const latestUserMessage = getLatestUserMessage({
    events,
    sessionId,
    upToIndex,
  })
  return latestUserMessage?.time.created
}

// Token total helper — sum of input + output + reasoning + cache.read + cache.write
function getTokenTotal(tokens: {
  input: number
  output: number
  reasoning: number
  cache: { read: number; write: number }
}): number {
  return tokens.input + tokens.output + tokens.reasoning + tokens.cache.read + tokens.cache.write
}

// Scans backward for most recent message.updated with role=assistant for sessionId.
// Extracts model, providerID, agent, tokensUsed.
export function getLatestRunInfo({
  events,
  sessionId,
  upToIndex,
}: {
  events: EventBufferEntry[]
  sessionId: string
  upToIndex?: number
}): {
  model: string | undefined
  providerID: string | undefined
  agent: string | undefined
  tokensUsed: number
} {
  const result = {
    model: undefined as string | undefined,
    providerID: undefined as string | undefined,
    agent: undefined as string | undefined,
    tokensUsed: 0,
  }
  const end = upToIndex ?? events.length - 1
  for (let i = end; i >= 0; i--) {
    const entry = events[i]
    if (!entry) {
      continue
    }
    const e = entry.event
    if (e.type !== 'message.updated') {
      continue
    }
    const msg = e.properties.info
    if (msg.sessionID !== sessionId || msg.role !== 'assistant') {
      continue
    }
    return {
      model: msg.modelID,
      providerID: msg.providerID,
      agent: msg.mode,
      tokensUsed: msg.tokens
        ? getTokenTotal(msg.tokens)
        : 0,
    }
  }
  return result
}

export function getAssistantMessageIdsForLatestUserTurn({
  events,
  sessionId,
  upToIndex,
}: {
  events: EventBufferEntry[]
  sessionId: string
  upToIndex?: number
}): Set<string> {
  const latestUserMessage = getLatestUserMessage({
    events,
    sessionId,
    upToIndex,
  })
  if (!latestUserMessage) {
    return new Set<string>()
  }
  const end = upToIndex === undefined ? events.length : upToIndex + 1
  const assistantMessageIds = new Set<string>()
  for (let i = 0; i < end; i++) {
    const entry = events[i]
    if (!entry) {
      continue
    }
    const e = entry.event
    if (e.type !== 'message.updated') {
      continue
    }
    const msg = e.properties.info
    if (msg.sessionID !== sessionId || msg.role !== 'assistant') {
      continue
    }
    if (msg.parentID === latestUserMessage.id) {
      assistantMessageIds.add(msg.id)
    }
  }
  return assistantMessageIds
}

export function getLatestAssistantMessageIdForLatestUserTurn({
  events,
  sessionId,
  upToIndex,
}: {
  events: EventBufferEntry[]
  sessionId: string
  upToIndex?: number
}): string | undefined {
  const latestUserMessage = getLatestUserMessage({
    events,
    sessionId,
    upToIndex,
  })
  if (!latestUserMessage) {
    return undefined
  }
  const end = upToIndex ?? events.length - 1
  let latestAssistantMessage:
    | Extract<OpenCodeMessage, { role: 'assistant' }>
    | undefined
  for (let i = end; i >= 0; i--) {
    const entry = events[i]
    if (!entry) {
      continue
    }
    const event = entry.event
    if (event.type !== 'message.updated') {
      continue
    }
    const info = event.properties.info
    if (info.sessionID !== sessionId || info.role !== 'assistant') {
      continue
    }
    if (info.parentID !== latestUserMessage.id) {
      continue
    }
    if (!latestAssistantMessage) {
      latestAssistantMessage = info
      continue
    }
    if (info.time.created > latestAssistantMessage.time.created) {
      latestAssistantMessage = info
    }
  }
  return latestAssistantMessage?.id
}

type EventBufferedAssistantMessage = AssistantMessage & {
  partsSummary?: Array<{ id: string; type: string }>
}

function hasRenderablePartSummary(message: EventBufferedAssistantMessage): boolean {
  if (!('partsSummary' in message) || !Array.isArray(message.partsSummary)) {
    return false
  }
  return message.partsSummary.some((part) => {
    return part.type === 'text' || part.type === 'tool'
  })
}

function hasAssistantPartEvidence({
  events,
  sessionId,
  messageId,
  upToIndex,
}: {
  events: EventBufferEntry[]
  sessionId: string
  messageId: string
  upToIndex?: number
}): boolean {
  const end = upToIndex ?? events.length - 1
  for (let i = end; i >= 0; i--) {
    const entry = events[i]
    if (!entry) {
      continue
    }
    const event = entry.event
    if (event.type === 'message.updated') {
      const info = event.properties.info as EventBufferedAssistantMessage
      if (info.sessionID !== sessionId || info.role !== 'assistant' || info.id !== messageId) {
        continue
      }
      if (hasRenderablePartSummary(info)) {
        return true
      }
      continue
    }
    if (event.type !== 'message.part.updated') {
      continue
    }
    const { part } = event.properties
    if (part.messageID !== messageId) {
      continue
    }
    if (part.type === 'text' || part.type === 'tool') {
      return true
    }
  }
  return false
}

function hasAssistantStepFinished({
  events,
  messageId,
  upToIndex,
}: {
  events: EventBufferEntry[]
  messageId: string
  upToIndex?: number
}): boolean {
  const end = upToIndex ?? events.length - 1
  for (let i = end; i >= 0; i--) {
    const entry = events[i]
    if (!entry || entry.event.type !== 'message.part.updated') {
      continue
    }
    const { part } = entry.event.properties
    if (part.messageID !== messageId) {
      continue
    }
    if (part.type === 'step-finish') {
      return true
    }
  }
  return false
}

export function doesLatestUserTurnHaveNaturalCompletion({
  events,
  sessionId,
  upToIndex,
}: {
  events: EventBufferEntry[]
  sessionId: string
  upToIndex?: number
}): boolean {
  const latestAssistantMessageId = getLatestAssistantMessageIdForLatestUserTurn({
    events,
    sessionId,
    upToIndex,
  })
  if (!latestAssistantMessageId) {
    return false
  }

  const end = upToIndex ?? events.length - 1
  let latestAssistantMessage: EventBufferedAssistantMessage | undefined
  for (let i = end; i >= 0; i--) {
    const entry = events[i]
    if (!entry) {
      continue
    }
    const event = entry.event
    if (event.type !== 'message.updated') {
      continue
    }
    const info = event.properties.info
    if (info.sessionID !== sessionId || info.role !== 'assistant') {
      continue
    }
    if (info.id !== latestAssistantMessageId) {
      continue
    }
    latestAssistantMessage = info as EventBufferedAssistantMessage
    if (isAssistantMessageNaturalCompletion({ message: info })) {
      return true
    }
    break
  }

  if (!latestAssistantMessage) {
    return false
  }
  if (latestAssistantMessage.error) {
    return false
  }
  if (latestAssistantMessage.finish === 'tool-calls') {
    return false
  }
  return hasAssistantStepFinished({
    events,
    messageId: latestAssistantMessageId,
    upToIndex,
  }) && hasAssistantPartEvidence({
    events,
    sessionId,
    messageId: latestAssistantMessageId,
    upToIndex,
  })
}

export function isAssistantMessageInLatestUserTurn({
  events,
  sessionId,
  messageId,
  upToIndex,
}: {
  events: EventBufferEntry[]
  sessionId: string
  messageId: string
  upToIndex?: number
}): boolean {
  const assistantMessageIds = getAssistantMessageIdsForLatestUserTurn({
    events,
    sessionId,
    upToIndex,
  })
  return assistantMessageIds.has(messageId)
}

// Returns a stable 1-based subtask index for candidateSessionId.
// Indexing scope is the parent assistant message that spawned the task tool calls,
// so numbering restarts at 1 for each assistant message.
export function getDerivedSubtaskIndex({
  events,
  mainSessionId,
  candidateSessionId,
  upToIndex,
}: {
  events: EventBufferEntry[]
  mainSessionId: string
  candidateSessionId: string
  upToIndex?: number
}): number | undefined {
  return getDerivedSubtaskIndexForParent({
    events,
    parentSessionId: mainSessionId,
    candidateSessionId,
    upToIndex,
  })
}

// Internal: same as getDerivedSubtaskIndex but parameterized by the parent
// session ID instead of being hardcoded to mainSessionId. Used by the chain
// label builder to compute per-hop indices within each parent's assistant
// message. Indexing scope is the parent assistant message that spawned the
// task tool calls (siblings under the same messageID), so numbering restarts
// at 1 for each assistant message.
function getDerivedSubtaskIndexForParent({
  events,
  parentSessionId,
  candidateSessionId,
  upToIndex,
}: {
  events: EventBufferEntry[]
  parentSessionId: string
  candidateSessionId: string
  upToIndex?: number
}): number | undefined {
  const end = upToIndex ?? events.length - 1
  let parentAssistantMessageId: string | undefined

  for (let i = end; i >= 0; i--) {
    const entry = events[i]
    if (!entry) {
      continue
    }
    const candidate = getTaskCandidateFromEvent({
      event: entry.event,
      parentSessionId,
    })
    if (!candidate) {
      continue
    }
    if (candidate.childSessionId !== candidateSessionId) {
      continue
    }
    parentAssistantMessageId = candidate.assistantMessageId
    break
  }

  if (!parentAssistantMessageId) {
    return undefined
  }

  const indexByChildSessionId = new Map<string, number>()
  for (let i = 0; i <= end; i++) {
    const entry = events[i]
    if (!entry) {
      continue
    }
    const candidate = getTaskCandidateFromEvent({
      event: entry.event,
      parentSessionId,
    })
    if (!candidate || candidate.assistantMessageId !== parentAssistantMessageId) {
      continue
    }
    if (!indexByChildSessionId.has(candidate.childSessionId)) {
      indexByChildSessionId.set(
        candidate.childSessionId,
        indexByChildSessionId.size + 1,
      )
    }
  }

  return indexByChildSessionId.get(candidateSessionId)
}

// Returns the subagent_type (e.g. "explore", "general") for a given child session.
// Used to build labels like "explore-1" instead of generic "task-1".
export function getDerivedSubtaskAgentType({
  events,
  mainSessionId,
  candidateSessionId,
}: {
  events: EventBufferEntry[]
  mainSessionId: string
  candidateSessionId: string
}): string | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const entry = events[i]
    if (!entry) {
      continue
    }
    const candidate = getTaskCandidateFromEvent({
      event: entry.event,
      parentSessionId: mainSessionId,
    })
    if (!candidate || candidate.childSessionId !== candidateSessionId) {
      continue
    }
    return candidate.subagentType
  }
  return undefined
}

export function getDerivedSubagentSessions({
  events,
  mainSessionId,
  upToIndex,
}: {
  events: EventBufferEntry[]
  mainSessionId: string
  upToIndex?: number
}): DerivedSubagentSession[] {
  const end = upToIndex ?? events.length - 1
  const seenChildSessionIds = new Set<string>()
  const sessions: DerivedSubagentSession[] = []

  for (let i = end; i >= 0; i--) {
    const entry = events[i]
    if (!entry) {
      continue
    }
    const candidate = getTaskCandidateFromEvent({
      event: entry.event,
      parentSessionId: mainSessionId,
    })
    if (!candidate || seenChildSessionIds.has(candidate.childSessionId)) {
      continue
    }

    seenChildSessionIds.add(candidate.childSessionId)
    sessions.push({
      childSessionId: candidate.childSessionId,
      subagentType: candidate.subagentType,
      description: candidate.description,
      timestamp: entry.timestamp,
    })
  }

  return sessions
}

/**
 * Returns the chain of session IDs from mainSessionId down to candidateSessionId
 * (inclusive of both endpoints, ordered root → leaf), or undefined if
 * candidateSessionId is not a descendant of mainSessionId in the task graph.
 *
 * The graph is reconstructed purely from `task` tool parts in the event stream:
 * each part with `part.state.metadata.sessionId` (child) and `part.sessionID`
 * (parent) defines a parent→child edge. There is no session.parentID field on
 * session events, so the graph is derived solely from task tool parts.
 *
 * - If candidateSessionId === mainSessionId, returns [mainSessionId].
 * - If candidateSessionId is not reachable from mainSessionId, returns undefined.
 * - Cycle-safe via a visited set.
 */
export function getDerivedSubtaskChain({
  events,
  mainSessionId,
  candidateSessionId,
  upToIndex,
}: {
  events: EventBufferEntry[]
  mainSessionId: string
  candidateSessionId: string
  upToIndex?: number
}): string[] | undefined {
  if (candidateSessionId === mainSessionId) {
    return [mainSessionId]
  }

  const end = upToIndex ?? events.length - 1

  // Build childSessionId → parentSessionId map from every task edge.
  // Last-write-wins: a child session ID is unique per spawn, so in practice
  // there is only one parent. If a duplicate appears (e.g., the same sessionId
  // is reused across compaction boundaries), the latest edge wins.
  const childToParent = new Map<string, string>()
  for (let i = 0; i <= end; i++) {
    const entry = events[i]
    if (!entry) {
      continue
    }
    const candidate = getTaskCandidateFromEvent({
      event: entry.event,
    })
    if (!candidate) {
      continue
    }
    childToParent.set(candidate.childSessionId, candidate.parentSessionId)
  }

  // Walk from candidate up to mainSessionId via parent links.
  const chain: string[] = [candidateSessionId]
  const visited = new Set<string>([candidateSessionId])
  let current = candidateSessionId
  while (true) {
    if (current === mainSessionId) {
      // chain is currently leaf → root; flip to root → leaf for the public
      // contract. Array.prototype.reverse mutates in place.
      chain.reverse()
      return chain
    }
    const parent = childToParent.get(current)
    if (!parent) {
      return undefined
    }
    if (visited.has(parent)) {
      // Defensive: cycle in the parent chain (shouldn't happen with unique
      // session ids, but guard against malformed fixtures / reused ids).
      return undefined
    }
    visited.add(parent)
    chain.push(parent)
    current = parent
  }
}

/**
 * Returns all descendant session IDs reachable from mainSessionId via task
 * tool edges (any depth), NOT including mainSessionId itself. Uses the same
 * parent→child graph as getDerivedSubtaskChain. Order is not guaranteed.
 *
 * Used by Layer 1 propagation (§5.6.2) to apply "Accept Always" rules to
 * every currently-known descendant session. Cycle-safe via a visited set.
 */
export function getDerivedDescendantSessions({
  events,
  mainSessionId,
  upToIndex,
}: {
  events: EventBufferEntry[]
  mainSessionId: string
  upToIndex?: number
}): string[] {
  const end = upToIndex ?? events.length - 1

  // Build parent → children adjacency from every task edge.
  const adjacency = new Map<string, Set<string>>()
  for (let i = 0; i <= end; i++) {
    const entry = events[i]
    if (!entry) {
      continue
    }
    const candidate = getTaskCandidateFromEvent({
      event: entry.event,
    })
    if (!candidate) {
      continue
    }
    let children = adjacency.get(candidate.parentSessionId)
    if (!children) {
      children = new Set<string>()
      adjacency.set(candidate.parentSessionId, children)
    }
    children.add(candidate.childSessionId)
  }

  // BFS from mainSessionId, collecting every reachable child.
  const visited = new Set<string>([mainSessionId])
  const queue: string[] = [mainSessionId]
  const descendants: string[] = []
  while (queue.length > 0) {
    const current = queue.shift()!
    const children = adjacency.get(current)
    if (!children) {
      continue
    }
    for (const child of children) {
      if (visited.has(child)) {
        // Defensive: cycle in the graph (shouldn't happen with unique
        // session ids, but guard against malformed fixtures / reused ids).
        continue
      }
      visited.add(child)
      descendants.push(child)
      queue.push(child)
    }
  }
  return descendants
}

export type DerivedSubtaskChainLabel = {
  sessionId: string
  /**
   * Leaf-style label, e.g. "investigate-2" or "task-1". Always populated for
   * hops after the root. Empty string for the root hop (mainSessionId).
   */
  label: string
  subagentType?: string
}

/**
 * Per-hop labels for the chain from mainSessionId to candidateSessionId.
 *
 * The returned array includes ALL hops root → leaf (so callers can index
 * consistently):
 *   - chain[0] === mainSessionId gets `{ label: '', subagentType: undefined }`
 *     (root has no parent task, so no label). Callers that only need leaf
 *     labels should skip the first entry.
 *   - Each subsequent hop's label is `${agentType || 'task'}-${index}` where
 *     index is the 1-based position of this child within the PARENT session's
 *     assistant message that spawned it (scoped per parent assistant message,
 *     exactly like getDerivedSubtaskIndex but parameterized by the hop's parent
 *     session).
 *
 * Returns undefined when the chain itself is undefined (candidate not
 * reachable from mainSessionId).
 *
 * Compaction note: the event buffer compaction preserves
 * `state.input.subagent_type` for `task` tool parts (see
 * thread-session-runtime.ts compactEventForEventBuffer), so labels survive
 * compaction. If `subagent_type` is ever lost, the label degrades to
 * `task-${index}` via the `agentType || 'task'` fallback.
 */
export function getDerivedSubtaskChainLabels({
  events,
  mainSessionId,
  candidateSessionId,
  upToIndex,
}: {
  events: EventBufferEntry[]
  mainSessionId: string
  candidateSessionId: string
  upToIndex?: number
}): DerivedSubtaskChainLabel[] | undefined {
  const chain = getDerivedSubtaskChain({
    events,
    mainSessionId,
    candidateSessionId,
    upToIndex,
  })
  if (!chain) {
    return undefined
  }

  const labels: DerivedSubtaskChainLabel[] = []
  for (let i = 0; i < chain.length; i++) {
    const sessionId = chain[i]!
    if (i === 0) {
      // Root hop: no parent task, so no label. Callers skip index 0 when
      // they only need leaf-style labels.
      labels.push({ sessionId, label: '' })
      continue
    }
    const parentSessionId = chain[i - 1]!
    const subagentType = getDerivedSubtaskAgentTypeForParent({
      events,
      parentSessionId,
      candidateSessionId: sessionId,
      upToIndex,
    })
    const index = getDerivedSubtaskIndexForParent({
      events,
      parentSessionId,
      candidateSessionId: sessionId,
      upToIndex,
    })
    // A reachable non-root hop always has a valid 1-based index. Fall back to
    // 0 only if the chain walker returned a session we can't find an edge for
    // (defensive — shouldn't happen for well-formed fixtures).
    const safeIndex = index ?? 0
    const label = `${subagentType || 'task'}-${safeIndex}`
    labels.push({ sessionId, label, subagentType })
  }
  return labels
}

// Internal: same as getDerivedSubtaskAgentType but parameterized by parent.
// Used by getDerivedSubtaskChainLabels to look up the subagent_type for any
// hop in the chain, not just depth-1 children of mainSessionId.
function getDerivedSubtaskAgentTypeForParent({
  events,
  parentSessionId,
  candidateSessionId,
  upToIndex,
}: {
  events: EventBufferEntry[]
  parentSessionId: string
  candidateSessionId: string
  upToIndex?: number
}): string | undefined {
  const end = upToIndex ?? events.length - 1
  for (let i = end; i >= 0; i--) {
    const entry = events[i]
    if (!entry) {
      continue
    }
    const candidate = getTaskCandidateFromEvent({
      event: entry.event,
      parentSessionId,
    })
    if (!candidate || candidate.childSessionId !== candidateSessionId) {
      continue
    }
    return candidate.subagentType
  }
  return undefined
}
