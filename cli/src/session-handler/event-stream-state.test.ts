// Fixture-driven tests for pure event-stream derivation helpers.
// Focuses on assistant message completion boundaries instead of session.idle.

import fs from 'node:fs'
import path from 'node:path'
import type { Message as OpenCodeMessage } from '@opencode-ai/sdk/v2'
import { describe, expect, test } from 'vitest'
import { type OpencodeEventLogEntry } from './opencode-session-event-log.js'
import {
  derivePendingPermissionRequests,
  getAssistantMessageIdsForLatestUserTurn,
  getDerivedDescendantSessions,
  getDerivedSubagentSessions,
  getEventBufferSessionId,
  getCurrentTurnStartTime,
  getDerivedSubtaskAgentType,
  getDerivedSubtaskChain,
  getDerivedSubtaskChainLabels,
  getDerivedSubtaskIndex,
  getLatestAssistantMessageIdForLatestUserTurn,
  getLatestRunInfo,
  hasAssistantMessageCompletedBefore,
  doesLatestUserTurnHaveNaturalCompletion,
  isAssistantMessageInLatestUserTurn,
  isAssistantMessageNaturalCompletion,
  isSessionBusy,
  type EventBufferEntry,
} from './event-stream-state.js'

const fixturesDir = path.join(import.meta.dirname, 'event-stream-fixtures')
type AssistantMessage = Extract<OpenCodeMessage, { role: 'assistant' }>

function loadFixture(filename: string): EventBufferEntry[] {
  const content = fs.readFileSync(path.join(fixturesDir, filename), 'utf8')
  return content
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const parsed = JSON.parse(line) as OpencodeEventLogEntry
      return { event: parsed.event, timestamp: parsed.timestamp }
    })
}

function getSessionId(events: EventBufferEntry[]): string {
  for (const entry of events) {
    const sessionId = getEventBufferSessionId(entry.event)
    if (sessionId) {
      return sessionId
    }
  }
  throw new Error('No sessionId found in fixture')
}

function getAssistantMessages(events: EventBufferEntry[], sessionId: string) {
  const messagesById = new Map<string, AssistantMessage>()
  events.forEach((entry) => {
    if (entry.event.type !== 'message.updated') {
      return
    }
    const info = entry.event.properties.info
    if (info.sessionID !== sessionId || info.role !== 'assistant') {
      return
    }
    messagesById.set(info.id, info)
  })
  return [...messagesById.values()]
}

function getAssistantMessageById({
  events,
  sessionId,
  messageId,
}: {
  events: EventBufferEntry[]
  sessionId: string
  messageId: string
}): AssistantMessage {
  const message = getAssistantMessages(events, sessionId).find((candidate) => {
    return candidate.id === messageId
  })
  if (!message) {
    throw new Error(`Assistant message ${messageId} not found`)
  }
  return message
}

// Test fixtures omit the top-level event `id` for brevity. The SDK event types
// require it, so inject a synthetic id when missing. Derivation never reads the
// top-level id (only properties.id / info.id), so the value is irrelevant.
let syntheticEventIdCounter = 0
function eventEntry(
  event: Omit<EventBufferEntry['event'], 'id'> & { id?: string },
): EventBufferEntry {
  const withId = ('id' in event && event.id
    ? event
    : { ...event, id: `evt_${++syntheticEventIdCounter}` }) as EventBufferEntry['event']
  return { event: withId, timestamp: 1 }
}

function findAssistantCompletionEventIndex({
  events,
  sessionId,
  messageId,
}: {
  events: EventBufferEntry[]
  sessionId: string
  messageId: string
}): number {
  const index = events.findIndex((entry) => {
    if (entry.event.type !== 'message.updated') {
      return false
    }
    const info = entry.event.properties.info
    return info.sessionID === sessionId
      && info.role === 'assistant'
      && info.id === messageId
      && typeof info.time.completed === 'number'
  })
  if (index === -1) {
    throw new Error(`Completed assistant message ${messageId} not found`)
  }
  return index
}

describe('session-normal-completion', () => {
  const events = loadFixture('session-normal-completion.jsonl')
  const sessionId = getSessionId(events)
  const latestAssistantMessageId = getLatestAssistantMessageIdForLatestUserTurn({
    events,
    sessionId,
  })

  test('latest assistant message completes naturally', () => {
    if (!latestAssistantMessageId) {
      throw new Error('Expected latest assistant message')
    }
    const message = getAssistantMessageById({
      events,
      sessionId,
      messageId: latestAssistantMessageId,
    })
    expect(isAssistantMessageNaturalCompletion({ message })).toBe(true)
  })

  test('latest user turn start time comes from the latest user message', () => {
    expect(getCurrentTurnStartTime({ events, sessionId })).toBe(1772636294845)
  })

  test('completion history only appears after the completed update lands', () => {
    if (!latestAssistantMessageId) {
      throw new Error('Expected latest assistant message')
    }
    const completionIndex = findAssistantCompletionEventIndex({
      events,
      sessionId,
      messageId: latestAssistantMessageId,
    })
    expect(hasAssistantMessageCompletedBefore({
      events,
      sessionId,
      messageId: latestAssistantMessageId,
      upToIndex: completionIndex - 1,
    })).toBe(false)
    expect(hasAssistantMessageCompletedBefore({
      events,
      sessionId,
      messageId: latestAssistantMessageId,
    })).toBe(true)
  })

  test('completion history survives later non-completed duplicate updates', () => {
    const messageId = 'msg_duplicate_completion'
    const duplicateEvents: EventBufferEntry[] = [
      eventEntry({
        type: 'message.updated',
        properties: {
          sessionID: sessionId,
          info: {
            id: messageId,
            sessionID: sessionId,
            role: 'assistant',
            time: { created: 1, completed: 2 },
            parentID: 'msg_user',
            modelID: 'deterministic-v2',
            providerID: 'deterministic-provider',
            mode: 'build',
            agent: 'build',
            path: { cwd: '/test', root: '/test' },
            cost: 0,
            tokens: {
              input: 1,
              output: 1,
              reasoning: 0,
              cache: { read: 0, write: 0 },
            },
            finish: 'stop',
          },
        },
      }),
      eventEntry({
        type: 'message.updated',
        properties: {
          sessionID: sessionId,
          info: {
            id: messageId,
            sessionID: sessionId,
            role: 'assistant',
            time: { created: 1 },
            parentID: 'msg_user',
            modelID: 'deterministic-v2',
            providerID: 'deterministic-provider',
            mode: 'build',
            agent: 'build',
            path: { cwd: '/test', root: '/test' },
            cost: 0,
            finish: 'stop',
          },
        },
      }),
    ]

    expect(hasAssistantMessageCompletedBefore({
      events: duplicateEvents,
      sessionId,
      messageId,
    })).toBe(true)
  })

  test('getLatestRunInfo', () => {
    expect(getLatestRunInfo({ events, sessionId })).toEqual({
      model: 'deterministic-v2',
      providerID: 'deterministic-provider',
      agent: 'build',
      tokensUsed: 2,
    })
  })
})

describe('derivePendingPermissionRequests', () => {
  test('tracks unresolved permission requests', () => {
    const sessionId = 'ses_pending_permission'
    const events = [
      eventEntry({
        type: 'permission.asked',
        properties: {
          id: 'perm_1',
          sessionID: sessionId,
          permission: 'bash',
          patterns: ['*'],
          always: [],
          metadata: {},
        },
      }),
      eventEntry({
        type: 'permission.asked',
        properties: {
          id: 'perm_2',
          sessionID: sessionId,
          permission: 'edit',
          patterns: ['src/**'],
          always: [],
          metadata: {},
        },
      }),
      eventEntry({
        type: 'permission.replied',
        properties: {
          requestID: 'perm_1',
          sessionID: sessionId,
          reply: 'once',
        },
      }),
    ]

    expect(derivePendingPermissionRequests({ events, sessionId })).toMatchInlineSnapshot(`
      [
        "perm_2",
      ]
    `)
  })
})

describe('session-explicit-abort', () => {
  const events = loadFixture('session-explicit-abort.jsonl')
  const sessionId = getSessionId(events)
  const assistantMessages = getAssistantMessages(events, sessionId)
  const latestAssistant = assistantMessages[assistantMessages.length - 1]

  test('aborted assistant message is not a natural completion', () => {
    if (!latestAssistant) {
      throw new Error('Expected assistant message in fixture')
    }
    expect(isAssistantMessageNaturalCompletion({ message: latestAssistant })).toBe(false)
  })
})

describe('session-user-interruption', () => {
  const events = loadFixture('session-user-interruption.jsonl')
  const sessionId = getSessionId(events)
  const firstAssistantId = 'msg_cb95be135001I1vqtzLtT4Q1iQ'
  const slowSleepAssistantId = 'msg_cb95be39e001huREyY2wfjgV1M'
  const followupAssistantId = 'msg_cb95beeb8001MuEOER9WprXsPC'

  test('latest user turn only includes the follow-up assistant message', () => {
    expect(isAssistantMessageInLatestUserTurn({
      events,
      sessionId,
      messageId: firstAssistantId,
    })).toBe(false)
    expect(isAssistantMessageInLatestUserTurn({
      events,
      sessionId,
      messageId: slowSleepAssistantId,
    })).toBe(false)
    expect(isAssistantMessageInLatestUserTurn({
      events,
      sessionId,
      messageId: followupAssistantId,
    })).toBe(true)
  })

  test('latest user turn start time follows the follow-up user message', () => {
    expect(getCurrentTurnStartTime({ events, sessionId })).toBe(1772636335777)
  })
})

describe('session-two-completions-same-session', () => {
  const events = loadFixture('session-two-completions-same-session.jsonl')
  const sessionId = getSessionId(events)
  const assistantMessages = getAssistantMessages(events, sessionId)
  const firstAssistant = assistantMessages[0]
  const secondAssistant = assistantMessages[1]

  test('latest user turn points at the second completion only', () => {
    if (!firstAssistant || !secondAssistant) {
      throw new Error('Expected two assistant messages in fixture')
    }
    expect(isAssistantMessageInLatestUserTurn({
      events,
      sessionId,
      messageId: firstAssistant.id,
    })).toBe(false)
    expect(isAssistantMessageInLatestUserTurn({
      events,
      sessionId,
      messageId: secondAssistant.id,
    })).toBe(true)
    expect(getLatestAssistantMessageIdForLatestUserTurn({
      events,
      sessionId,
    })).toBe(secondAssistant.id)
  })
})

describe('session-concurrent-messages-serialized', () => {
  const events = loadFixture('session-concurrent-messages-serialized.jsonl')
  const sessionId = getSessionId(events)
  const latestAssistantMessageId = getLatestAssistantMessageIdForLatestUserTurn({
    events,
    sessionId,
  })

  test('fixture latest turn is still incomplete even though an older turn completed', () => {
    expect(doesLatestUserTurnHaveNaturalCompletion({
      events,
      sessionId,
    })).toBe(false)
    if (!latestAssistantMessageId) {
      throw new Error('Expected latest assistant message')
    }
    const message = getAssistantMessageById({
      events,
      sessionId,
      messageId: latestAssistantMessageId,
    })
    expect(message.id).toBe(latestAssistantMessageId)
  })
})

describe('session-tool-call-noisy-stream', () => {
  const events = loadFixture('session-tool-call-noisy-stream.jsonl')
  const sessionId = getSessionId(events)
  const latestAssistantMessageId = getLatestAssistantMessageIdForLatestUserTurn({
    events,
    sessionId,
  })

  test('fixture ends busy on a tool-call handoff message', () => {
    expect(isSessionBusy({ events, sessionId })).toBe(true)
    if (!latestAssistantMessageId) {
      throw new Error('Expected latest assistant message')
    }
    const message = getAssistantMessageById({
      events,
      sessionId,
      messageId: latestAssistantMessageId,
    })
    expect(isAssistantMessageNaturalCompletion({ message })).toBe(false)
  })

  test('getLatestRunInfo still works through dense tool events', () => {
    expect(getLatestRunInfo({ events, sessionId })).toEqual({
      model: 'deterministic-v2',
      providerID: 'deterministic-provider',
      agent: 'build',
      tokensUsed: 0,
    })
  })
})

describe('session-voice-queued-followup', () => {
  const events = loadFixture('session-voice-queued-followup.jsonl')
  const sessionId = getSessionId(events)

  test('latest user turn start moves to the queued follow-up', () => {
    expect(getCurrentTurnStartTime({ events, sessionId })).toBe(1772636414577)
  })
})

describe('synthetic-question-followup', () => {
  const sessionId = 'ses_question'
  const events: EventBufferEntry[] = [
    {
      timestamp: 1,
      event: {
        id: 'evt_user_1',
        type: 'message.updated',
        properties: {
          sessionID: sessionId,
          info: {
            id: 'msg_user_1',
            sessionID: sessionId,
            role: 'user',
            time: { created: 1 },
            agent: 'build',
            model: {
              providerID: 'deterministic-provider',
              modelID: 'deterministic-v2',
            },
          },
        },
      },
    },
    {
      timestamp: 2,
      event: {
        id: 'evt_asst_1',
        type: 'message.updated',
        properties: {
          sessionID: sessionId,
          info: {
            id: 'msg_asst_1',
            sessionID: sessionId,
            role: 'assistant',
            time: { created: 2, completed: 3 },
            parentID: 'msg_user_1',
            modelID: 'deterministic-v2',
            providerID: 'deterministic-provider',
            mode: 'build',
            agent: 'build',
            path: { cwd: '/test', root: '/test' },
            cost: 0,
            tokens: {
              input: 1,
              output: 1,
              reasoning: 0,
              cache: { read: 0, write: 0 },
            },
            finish: 'stop',
          },
        },
      },
    },
    {
      timestamp: 4,
      event: {
        id: 'evt_user_2',
        type: 'message.updated',
        properties: {
          sessionID: sessionId,
          info: {
            id: 'msg_user_2',
            sessionID: sessionId,
            role: 'user',
            time: { created: 4 },
            agent: 'build',
            model: {
              providerID: 'deterministic-provider',
              modelID: 'deterministic-v2',
            },
          },
        },
      },
    },
  ]

  test('latest user turn flips immediately after the follow-up user message', () => {
    expect(isAssistantMessageInLatestUserTurn({
      events,
      sessionId,
      messageId: 'msg_asst_1',
    })).toBe(false)
    expect(getCurrentTurnStartTime({ events, sessionId })).toBe(4)
  })
})

describe('real-session-task-normal', () => {
  const events = loadFixture('real-session-task-normal.jsonl')
  const sessionId = getSessionId(events)
  const latestAssistantMessageId = getLatestAssistantMessageIdForLatestUserTurn({
    events,
    sessionId,
  })

  test('latest assistant completion is terminal', () => {
    if (!latestAssistantMessageId) {
      throw new Error('Expected latest assistant message')
    }
    const message = getAssistantMessageById({
      events,
      sessionId,
      messageId: latestAssistantMessageId,
    })
    expect(isAssistantMessageNaturalCompletion({ message })).toBe(true)
  })

  test('getLatestRunInfo has model info', () => {
    expect(getLatestRunInfo({ events, sessionId })).toEqual({
      model: 'gemini-2.5-flash',
      providerID: 'cached-google-real-events',
      agent: 'build',
      tokensUsed: 39025,
    })
  })
})

describe('real-session-task-user-interruption', () => {
  const events = loadFixture('real-session-task-user-interruption.jsonl')
  const sessionId = getSessionId(events)
  const childSessionId = 'ses_3464f3a1dffeBBD0d15EqnGjAh'
  const firstAssistantId = 'msg_cb9b0ba96001SpPjgzxWPmRuW9'
  const secondAssistantId = 'msg_cb9b1ae5c001E5G3Ql6aXNpst2'

  test('tool-call handoff assistant is not a natural completion but the resumed reply is', () => {
    const firstAssistant = getAssistantMessageById({
      events,
      sessionId,
      messageId: firstAssistantId,
    })
    const secondAssistant = getAssistantMessageById({
      events,
      sessionId,
      messageId: secondAssistantId,
    })
    // The first message finished with tool-calls — not a natural completion
    // (footer is deferred to session.idle). The second message IS natural.
    expect(isAssistantMessageNaturalCompletion({ message: firstAssistant })).toBe(false)
    expect(isAssistantMessageNaturalCompletion({ message: secondAssistant })).toBe(true)
  })

  test('latest user turn keeps both assistant messages for the same user turn', () => {
    const assistantIds = getAssistantMessageIdsForLatestUserTurn({ events, sessionId })
    expect(assistantIds.has(firstAssistantId)).toBe(true)
    expect(assistantIds.has(secondAssistantId)).toBe(true)
    expect(getLatestAssistantMessageIdForLatestUserTurn({
      events,
      sessionId,
    })).toBe(secondAssistantId)
  })

  test('getDerivedSubtaskIndex starts at 1 for first task of assistant message', () => {
    expect(getDerivedSubtaskIndex({
      events,
      mainSessionId: sessionId,
      candidateSessionId: childSessionId,
    })).toBe(1)
  })

  test('getDerivedSubtaskIndex restarts at 1 for a newer assistant message', () => {
    const firstTaskEvent = events.find((entry) => {
      if (entry.event.type !== 'message.part.updated') {
        return false
      }
      const part = entry.event.properties.part
      if (part.sessionID !== sessionId) {
        return false
      }
      if (part.type !== 'tool' || part.tool !== 'task') {
        return false
      }
      if (part.state.status !== 'running' && part.state.status !== 'completed') {
        return false
      }
      return part.state.metadata?.sessionId === childSessionId
    })
    if (!firstTaskEvent) {
      throw new Error('Expected to find task tool event in fixture')
    }

    const secondChildSessionId = 'ses_synthetic_child_2'
    const thirdChildSessionId = 'ses_synthetic_child_3'
    const syntheticAssistantMessageId = 'msg_synthetic_new_assistant'

    const secondTaskEvent = structuredClone(firstTaskEvent)
    if (secondTaskEvent.event.type !== 'message.part.updated') {
      throw new Error('Expected message.part.updated event')
    }
    const secondTaskPart = secondTaskEvent.event.properties.part
    if (secondTaskPart.type !== 'tool' || secondTaskPart.tool !== 'task') {
      throw new Error('Expected task tool part')
    }
    if (secondTaskPart.state.status !== 'completed') {
      throw new Error('Expected completed task tool part')
    }
    secondTaskPart.id = `${secondTaskPart.id}-synthetic-2`
    secondTaskPart.messageID = syntheticAssistantMessageId
    secondTaskPart.state = {
      ...secondTaskPart.state,
      metadata: {
        ...(secondTaskPart.state.metadata || {}),
        sessionId: secondChildSessionId,
      },
      output: `task_id: ${secondChildSessionId}`,
    }

    const thirdTaskEvent = structuredClone(secondTaskEvent)
    if (thirdTaskEvent.event.type !== 'message.part.updated') {
      throw new Error('Expected message.part.updated event')
    }
    const thirdTaskPart = thirdTaskEvent.event.properties.part
    if (thirdTaskPart.type !== 'tool' || thirdTaskPart.tool !== 'task') {
      throw new Error('Expected task tool part')
    }
    if (thirdTaskPart.state.status !== 'completed') {
      throw new Error('Expected completed task tool part')
    }
    thirdTaskPart.id = `${thirdTaskPart.id}-synthetic-3`
    thirdTaskPart.messageID = syntheticAssistantMessageId
    thirdTaskPart.state = {
      ...thirdTaskPart.state,
      metadata: {
        ...(thirdTaskPart.state.metadata || {}),
        sessionId: thirdChildSessionId,
      },
      output: `task_id: ${thirdChildSessionId}`,
    }

    const lastTimestamp = events[events.length - 1]?.timestamp || 0
    const augmentedEvents: EventBufferEntry[] = [
      ...events,
      {
        timestamp: lastTimestamp + 1,
        event: secondTaskEvent.event,
      },
      {
        timestamp: lastTimestamp + 2,
        event: thirdTaskEvent.event,
      },
    ]

    expect(getDerivedSubtaskIndex({
      events: augmentedEvents,
      mainSessionId: sessionId,
      candidateSessionId: childSessionId,
    })).toBe(1)
    expect(getDerivedSubtaskIndex({
      events: augmentedEvents,
      mainSessionId: sessionId,
      candidateSessionId: secondChildSessionId,
    })).toBe(1)
    expect(getDerivedSubtaskIndex({
      events: augmentedEvents,
      mainSessionId: sessionId,
      candidateSessionId: thirdChildSessionId,
    })).toBe(2)
  })

  test('getDerivedSubtaskIndex returns undefined for unknown session', () => {
    expect(getDerivedSubtaskIndex({
      events,
      mainSessionId: sessionId,
      candidateSessionId: 'ses_nonexistent',
    })).toBe(undefined)
  })

  test('getDerivedSubagentSessions returns latest tasks first with agent labels', () => {
    const firstTaskEvent = events.find((entry) => {
      if (entry.event.type !== 'message.part.updated') {
        return false
      }
      const part = entry.event.properties.part
      if (part.sessionID !== sessionId) {
        return false
      }
      if (part.type !== 'tool' || part.tool !== 'task') {
        return false
      }
      return part.state.status === 'running' || part.state.status === 'completed'
    })
    if (!firstTaskEvent || firstTaskEvent.event.type !== 'message.part.updated') {
      throw new Error('Expected to find task tool event in fixture')
    }

    const newerTaskEvent = structuredClone(firstTaskEvent)
    if (newerTaskEvent.event.type !== 'message.part.updated') {
      throw new Error('Expected message.part.updated event')
    }
    const newerTaskPart = newerTaskEvent.event.properties.part
    if (newerTaskPart.type !== 'tool' || newerTaskPart.tool !== 'task') {
      throw new Error('Expected task tool part')
    }
    if (newerTaskPart.state.status !== 'running' && newerTaskPart.state.status !== 'completed') {
      throw new Error('Expected running or completed task tool part')
    }
    newerTaskPart.id = `${newerTaskPart.id}-newer`
    newerTaskPart.state = {
      ...newerTaskPart.state,
      input: {
        ...newerTaskPart.state.input,
        description: 'inspect recent task output',
        subagent_type: 'explore',
      },
      metadata: {
        ...(newerTaskPart.state.metadata || {}),
        sessionId: 'ses_newer_child',
      },
    }

    const latestTimestamp = events[events.length - 1]?.timestamp || 0
    const augmentedEvents: EventBufferEntry[] = [
      ...events,
      {
        timestamp: latestTimestamp + 1,
        event: newerTaskEvent.event,
      },
    ]

    expect(getDerivedSubagentSessions({
      events: augmentedEvents,
      mainSessionId: sessionId,
    })).toMatchInlineSnapshot(`
      [
        {
          "childSessionId": "ses_newer_child",
          "description": "inspect recent task output",
          "subagentType": "explore",
          "timestamp": 1772641957983,
        },
        {
          "childSessionId": "ses_3464f3a1dffeBBD0d15EqnGjAh",
          "description": undefined,
          "subagentType": undefined,
          "timestamp": 1772641955371,
        },
      ]
    `)
  })
})

describe('real-session-action-buttons', () => {
  const events = loadFixture('real-session-action-buttons.jsonl')
  const sessionId = getSessionId(events)
  const toolCallAssistantId = 'msg_cb9b55c3b001hXC9qxjVxLMypM'
  const finalAssistantId = 'msg_cb9b5ddd1001FALqKNM6xW98u6'

  test('tool-call handoff assistant is not a natural completion but final reply is', () => {
    const toolCallAssistant = getAssistantMessageById({
      events,
      sessionId,
      messageId: toolCallAssistantId,
    })
    const finalAssistant = getAssistantMessageById({
      events,
      sessionId,
      messageId: finalAssistantId,
    })
    // The tool-call message has finish="tool-calls" — not a natural completion
    // (footer is deferred to session.idle). The final text message IS natural.
    expect(isAssistantMessageNaturalCompletion({ message: toolCallAssistant })).toBe(false)
    expect(isAssistantMessageNaturalCompletion({ message: finalAssistant })).toBe(true)
  })

  test('latest user turn keeps both assistant messages for the same user turn', () => {
    const assistantIds = getAssistantMessageIdsForLatestUserTurn({ events, sessionId })
    expect(assistantIds.has(toolCallAssistantId)).toBe(true)
    expect(assistantIds.has(finalAssistantId)).toBe(true)
    expect(getLatestAssistantMessageIdForLatestUserTurn({
      events,
      sessionId,
    })).toBe(finalAssistantId)
  })
})

describe('real-session-permission-external-file', () => {
  const events = loadFixture('real-session-permission-external-file.jsonl')
  const sessionId = getSessionId(events)

  test('permission flow has no terminal assistant completion yet', () => {
    const latestAssistantMessageId = getLatestAssistantMessageIdForLatestUserTurn({
      events,
      sessionId,
    })
    expect(latestAssistantMessageId).toBeDefined()
    if (!latestAssistantMessageId) {
      return
    }
    const message = getAssistantMessageById({
      events,
      sessionId,
      messageId: latestAssistantMessageId,
    })
    expect(isAssistantMessageNaturalCompletion({ message })).toBe(false)
  })
})

describe('real-session-footer-suppressed-on-pre-idle-interrupt', () => {
  const events = loadFixture('real-session-footer-suppressed-on-pre-idle-interrupt.jsonl')
  const sessionId = getSessionId(events)
  const oldAssistantId = 'msg_cbda8f408001VATHNUi9l05XqA'
  const abortedAssistantId = 'msg_cbda90cef001GOQW8EQxkUz9b5'
  const latestAssistantId = 'msg_cbda91463001DvEB6YMCXayZNj'

  test('latest user turn ignores stale assistant messages from the interrupted turn', () => {
    expect(isAssistantMessageInLatestUserTurn({
      events,
      sessionId,
      messageId: oldAssistantId,
    })).toBe(false)
    expect(isAssistantMessageInLatestUserTurn({
      events,
      sessionId,
      messageId: abortedAssistantId,
    })).toBe(false)
    expect(isAssistantMessageInLatestUserTurn({
      events,
      sessionId,
      messageId: latestAssistantId,
    })).toBe(true)
  })
})

// Depth-3 fixture for the graph-aware chain derivation.
//
// Topology (hand-built):
//   ses_ROOT (mainSessionId)
//     └─ task → ses_PM        (project-manager, child 1 of msg_ROOT_asst)
//          ├─ task → ses_INV2  (investigate,  child 1 of msg_PM_asst)
//          └─ task → ses_INV   (investigate,  child 2 of msg_PM_asst) ← leaf
//               └─ read /home/kimaki/.local/foo → permission.asked on ses_INV
//
// The ses_INV2 sibling exists only to verify per-hop indexing is scoped to the
// PARENT assistant message: ses_INV must be `investigate-2`, not
// `investigate-1`, even though it's the only "investigate" child of ses_ROOT.
describe('real-session-nested-task-permission', () => {
  const events = loadFixture('real-session-nested-task-permission.jsonl')
  const mainSessionId = 'ses_ROOT'

  test('getDerivedSubtaskChain returns the full root→leaf chain for the depth-2 leaf', () => {
    expect(getDerivedSubtaskChain({
      events,
      mainSessionId,
      candidateSessionId: 'ses_INV',
    })).toMatchInlineSnapshot(`
      [
        "ses_ROOT",
        "ses_PM",
        "ses_INV",
      ]
    `)
  })

  test('getDerivedSubtaskChain returns the root→depth-1 chain for a direct child', () => {
    expect(getDerivedSubtaskChain({
      events,
      mainSessionId,
      candidateSessionId: 'ses_PM',
    })).toMatchInlineSnapshot(`
      [
        "ses_ROOT",
        "ses_PM",
      ]
    `)
  })

  test('getDerivedSubtaskChain returns a single-element chain when candidate === main', () => {
    expect(getDerivedSubtaskChain({
      events,
      mainSessionId,
      candidateSessionId: 'ses_ROOT',
    })).toMatchInlineSnapshot(`
      [
        "ses_ROOT",
      ]
    `)
  })

  test('getDerivedSubtaskChain returns undefined for a session not in the graph', () => {
    expect(getDerivedSubtaskChain({
      events,
      mainSessionId,
      candidateSessionId: 'ses_nonexistent',
    })).toBe(undefined)
  })

  test('getDerivedSubtaskChainLabels returns root + per-hop labels with correct per-parent indices', () => {
    // ses_PM is the only child of msg_ROOT_asst  → index 1 → "project-manager-1"
    // ses_INV is the SECOND child of msg_PM_asst → index 2 → "investigate-2"
    // (ses_INV2 was emitted first under msg_PM_asst, so it claims index 1.)
    expect(getDerivedSubtaskChainLabels({
      events,
      mainSessionId,
      candidateSessionId: 'ses_INV',
    })).toMatchInlineSnapshot(`
      [
        {
          "label": "",
          "sessionId": "ses_ROOT",
        },
        {
          "label": "project-manager-1",
          "sessionId": "ses_PM",
          "subagentType": "project-manager",
        },
        {
          "label": "investigate-2",
          "sessionId": "ses_INV",
          "subagentType": "investigate",
        },
      ]
    `)
  })

  test('getDerivedSubtaskChainLabels returns root + depth-1 label for a direct child', () => {
    expect(getDerivedSubtaskChainLabels({
      events,
      mainSessionId,
      candidateSessionId: 'ses_PM',
    })).toMatchInlineSnapshot(`
      [
        {
          "label": "",
          "sessionId": "ses_ROOT",
        },
        {
          "label": "project-manager-1",
          "sessionId": "ses_PM",
          "subagentType": "project-manager",
        },
      ]
    `)
  })

  test('compaction-safe: real compaction preserves state.input.subagent_type for task tools', () => {
    // Mirror the actual compaction behavior in
    // thread-session-runtime.ts compactEventForEventBuffer:
    //   - tool parts: state.input = {} (always)
    //   - task tools: state.input.subagent_type is restored from the original
    //   - state.metadata is untouched (so metadata.sessionId survives)
    // After this transform the chain must still resolve and the labels must
    // stay identical (subagent_type survives).
    const compactedEvents: EventBufferEntry[] = events.map((entry) => {
      const event = entry.event
      if (event.type !== 'message.part.updated') {
        return entry
      }
      const part = event.properties.part
      if (part.type !== 'tool') {
        return entry
      }
      const cloned = structuredClone(event)
      const clonedPart = cloned.properties.part
      if (clonedPart.type !== 'tool') {
        return entry
      }
      const state = clonedPart.state
      const preservedSubagentType =
        clonedPart.tool === 'task'
          ? state.input?.subagent_type
          : undefined
      state.input = {}
      if (typeof preservedSubagentType === 'string') {
        state.input.subagent_type = preservedSubagentType
      }
      return { ...entry, event: cloned }
    })

    expect(getDerivedSubtaskChain({
      events: compactedEvents,
      mainSessionId,
      candidateSessionId: 'ses_INV',
    })).toMatchInlineSnapshot(`
      [
        "ses_ROOT",
        "ses_PM",
        "ses_INV",
      ]
    `)

    // Labels are unchanged because real compaction preserves subagent_type.
    expect(getDerivedSubtaskChainLabels({
      events: compactedEvents,
      mainSessionId,
      candidateSessionId: 'ses_INV',
    })).toMatchInlineSnapshot(`
      [
        {
          "label": "",
          "sessionId": "ses_ROOT",
        },
        {
          "label": "project-manager-1",
          "sessionId": "ses_PM",
          "subagentType": "project-manager",
        },
        {
          "label": "investigate-2",
          "sessionId": "ses_INV",
          "subagentType": "investigate",
        },
      ]
    `)
  })

  test('compaction defense-in-depth: a hypothetical full strip of subagent_type degrades labels to task-N', () => {
    // If a future compaction change ever drops subagent_type for task tools,
    // labels must degrade gracefully to `task-${index}` rather than crashing.
    // The chain itself must still resolve (it reads metadata.sessionId, not
    // input). This test documents the expected fallback shape.
    const strippedEvents: EventBufferEntry[] = events.map((entry) => {
      const event = entry.event
      if (event.type !== 'message.part.updated') {
        return entry
      }
      const part = event.properties.part
      if (part.type !== 'tool' || part.tool !== 'task') {
        return entry
      }
      const cloned = structuredClone(event)
      const clonedPart = cloned.properties.part
      if (clonedPart.type !== 'tool' || clonedPart.tool !== 'task') {
        return entry
      }
      // Aggressive strip: wipe the entire input AND any metadata subagent hint.
      clonedPart.state.input = {}
      return { ...entry, event: cloned }
    })

    expect(getDerivedSubtaskChain({
      events: strippedEvents,
      mainSessionId,
      candidateSessionId: 'ses_INV',
    })).toMatchInlineSnapshot(`
      [
        "ses_ROOT",
        "ses_PM",
        "ses_INV",
      ]
    `)

    expect(getDerivedSubtaskChainLabels({
      events: strippedEvents,
      mainSessionId,
      candidateSessionId: 'ses_INV',
    })).toMatchInlineSnapshot(`
      [
        {
          "label": "",
          "sessionId": "ses_ROOT",
        },
        {
          "label": "task-1",
          "sessionId": "ses_PM",
          "subagentType": undefined,
        },
        {
          "label": "task-2",
          "sessionId": "ses_INV",
          "subagentType": undefined,
        },
      ]
    `)
  })

  test('depth-1 backward compat: getDerivedSubtaskIndex sees direct children but not depth-2 leaves', () => {
    // ses_PM is a direct child of ses_ROOT → index 1.
    expect(getDerivedSubtaskIndex({
      events,
      mainSessionId,
      candidateSessionId: 'ses_PM',
    })).toBe(1)

    // ses_INV is a depth-2 leaf (child of ses_PM, not ses_ROOT). The depth-1
    // shortcut must NOT see it — that's why the chain walker exists.
    expect(getDerivedSubtaskIndex({
      events,
      mainSessionId,
      candidateSessionId: 'ses_INV',
    })).toBe(undefined)
  })

  test('depth-1 backward compat: getDerivedSubtaskAgentType only resolves direct children', () => {
    expect(getDerivedSubtaskAgentType({
      events,
      mainSessionId,
      candidateSessionId: 'ses_PM',
    })).toBe('project-manager')

    // Depth-2 leaf is invisible to the depth-1 shortcut.
    expect(getDerivedSubtaskAgentType({
      events,
      mainSessionId,
      candidateSessionId: 'ses_INV',
    })).toBe(undefined)
  })

  test('depth-1 backward compat: getDerivedSubagentSessions lists only direct children of main', () => {
    expect(getDerivedSubagentSessions({
      events,
      mainSessionId,
    })).toMatchInlineSnapshot(`
      [
        {
          "childSessionId": "ses_PM",
          "description": "manage the work",
          "subagentType": "project-manager",
          "timestamp": 1005,
        },
      ]
    `)
  })

  test('cycle safety: cyclic parent edges terminate and return undefined', () => {
    // Build a disconnected cycle ses_A ↔ ses_B by cloning a real task edge
    // from the fixture and repointing parent/child session ids. Neither node
    // is reachable from ses_ROOT, so the chain walker must return undefined.
    // Without cycle detection (the visited set in getDerivedSubtaskChain) the
    // walker would loop A→B→A→B→... forever and the test would time out.
    const taskEntry = events.find((entry) => {
      if (entry.event.type !== 'message.part.updated') {
        return false
      }
      const part = entry.event.properties.part
      return part.type === 'tool' && part.tool === 'task' && part.state.status === 'running'
    })
    if (!taskEntry || taskEntry.event.type !== 'message.part.updated') {
      throw new Error('Expected task event in fixture')
    }

    // Edge 1: ses_A → task → ses_B
    const edgeAToB = structuredClone(taskEntry)
    if (edgeAToB.event.type !== 'message.part.updated') {
      throw new Error('Expected message.part.updated')
    }
    {
      const part = edgeAToB.event.properties.part
      if (part.type !== 'tool' || part.tool !== 'task') {
        throw new Error('Expected task tool part')
      }
      if (part.state.status !== 'running') {
        throw new Error('Expected running task tool part')
      }
      part.id = 'prt_cycle_A_to_B'
      part.callID = 'call_cycle_A_to_B'
      part.messageID = 'msg_cycle_A_asst'
      part.sessionID = 'ses_A'
      edgeAToB.event.properties.sessionID = 'ses_A'
      part.state = {
        ...part.state,
        metadata: {
          ...(part.state.metadata || {}),
          sessionId: 'ses_B',
        },
      }
      edgeAToB.timestamp = 1
    }

    // Edge 2: ses_B → task → ses_A  (closes the cycle)
    const edgeBToA = structuredClone(taskEntry)
    if (edgeBToA.event.type !== 'message.part.updated') {
      throw new Error('Expected message.part.updated')
    }
    {
      const part = edgeBToA.event.properties.part
      if (part.type !== 'tool' || part.tool !== 'task') {
        throw new Error('Expected task tool part')
      }
      if (part.state.status !== 'running') {
        throw new Error('Expected running task tool part')
      }
      part.id = 'prt_cycle_B_to_A'
      part.callID = 'call_cycle_B_to_A'
      part.messageID = 'msg_cycle_B_asst'
      part.sessionID = 'ses_B'
      edgeBToA.event.properties.sessionID = 'ses_B'
      part.state = {
        ...part.state,
        metadata: {
          ...(part.state.metadata || {}),
          sessionId: 'ses_A',
        },
      }
      edgeBToA.timestamp = 2
    }

    const cyclicEvents: EventBufferEntry[] = [edgeAToB, edgeBToA]

    expect(getDerivedSubtaskChain({
      events: cyclicEvents,
      mainSessionId: 'ses_ROOT',
      candidateSessionId: 'ses_A',
    })).toBe(undefined)
  })

  test('upToIndex honored: truncating before the ses_PM→ses_INV edge drops ses_INV', () => {
    // Locate the ses_PM → ses_INV task edge in the fixture.
    const invEdgeIndex = events.findIndex((entry) => {
      if (entry.event.type !== 'message.part.updated') {
        return false
      }
      const part = entry.event.properties.part
      if (part.type !== 'tool' || part.tool !== 'task') {
        return false
      }
      if (part.sessionID !== 'ses_PM') {
        return false
      }
      const metadata = (part.state as { metadata?: { sessionId?: string } }).metadata
      return metadata?.sessionId === 'ses_INV'
    })
    expect(invEdgeIndex).toBeGreaterThan(0)

    // Truncating just before the edge excludes ses_INV from the graph.
    expect(getDerivedSubtaskChain({
      events,
      mainSessionId,
      candidateSessionId: 'ses_INV',
      upToIndex: invEdgeIndex - 1,
    })).toBe(undefined)

    // Including the edge index resolves the full chain.
    expect(getDerivedSubtaskChain({
      events,
      mainSessionId,
      candidateSessionId: 'ses_INV',
      upToIndex: invEdgeIndex,
    })).toEqual(['ses_ROOT', 'ses_PM', 'ses_INV'])

    // Labels also respect the truncation: undefined when the edge is dropped.
    expect(getDerivedSubtaskChainLabels({
      events,
      mainSessionId,
      candidateSessionId: 'ses_INV',
      upToIndex: invEdgeIndex - 1,
    })).toBe(undefined)
  })

  test('getDerivedSubtaskChain returns undefined for empty events when candidate !== main', () => {
    expect(getDerivedSubtaskChain({
      events: [],
      mainSessionId: 'ses_ROOT',
      candidateSessionId: 'ses_other',
    })).toBe(undefined)

    // Self-chain still resolves even with empty events — it short-circuits
    // before the graph walk.
    expect(getDerivedSubtaskChain({
      events: [],
      mainSessionId: 'ses_ROOT',
      candidateSessionId: 'ses_ROOT',
    })).toEqual(['ses_ROOT'])
  })

  test('getDerivedDescendantSessions returns all descendants of ses_ROOT (any depth)', () => {
    // Graph: ses_ROOT → ses_PM → {ses_INV, ses_INV2}
    // Descendants of ses_ROOT = [ses_PM, ses_INV, ses_INV2] in any order.
    expect(
      getDerivedDescendantSessions({
        events,
        mainSessionId,
      }).sort(),
    ).toEqual(['ses_INV', 'ses_INV2', 'ses_PM'])
  })

  test('getDerivedDescendantSessions returns depth-2 descendants when rooted at ses_PM', () => {
    expect(
      getDerivedDescendantSessions({
        events,
        mainSessionId: 'ses_PM',
      }).sort(),
    ).toEqual(['ses_INV', 'ses_INV2'])
  })

  test('getDerivedDescendantSessions returns [] for a leaf session', () => {
    // ses_INV has no task children.
    expect(
      getDerivedDescendantSessions({
        events,
        mainSessionId: 'ses_INV',
      }),
    ).toEqual([])
  })

  test('getDerivedDescendantSessions returns [] for a session not in the graph', () => {
    expect(
      getDerivedDescendantSessions({
        events,
        mainSessionId: 'ses_nonexistent',
      }),
    ).toEqual([])
  })

  test('getDerivedDescendantSessions returns [] for mainSessionId with no children on empty events', () => {
    expect(
      getDerivedDescendantSessions({
        events: [],
        mainSessionId: 'ses_ROOT',
      }),
    ).toEqual([])
  })

  test('getDerivedDescendantSessions is cycle-safe: a disconnected cycle terminates', () => {
    // Reuse the same cyclic fixture shape as the chain-walker cycle test:
    // build ses_A ↔ ses_B and verify the BFS visited set prevents infinite
    // loops. Descendants of ses_ROOT must exclude the cycle entirely (neither
    // ses_A nor ses_B is reachable from ses_ROOT).
    const taskEntry = events.find((entry) => {
      if (entry.event.type !== 'message.part.updated') {
        return false
      }
      const part = entry.event.properties.part
      return part.type === 'tool' && part.tool === 'task' && part.state.status === 'running'
    })
    if (!taskEntry || taskEntry.event.type !== 'message.part.updated') {
      throw new Error('Expected task event in fixture')
    }

    // Edge 1: ses_A → task → ses_B
    const edgeAToB = structuredClone(taskEntry)
    if (edgeAToB.event.type !== 'message.part.updated') {
      throw new Error('Expected message.part.updated')
    }
    {
      const part = edgeAToB.event.properties.part
      if (part.type !== 'tool' || part.tool !== 'task') {
        throw new Error('Expected task tool part')
      }
      if (part.state.status !== 'running') {
        throw new Error('Expected running task tool part')
      }
      part.id = 'prt_desc_cycle_A_to_B'
      part.callID = 'call_desc_cycle_A_to_B'
      part.messageID = 'msg_desc_cycle_A_asst'
      part.sessionID = 'ses_A'
      edgeAToB.event.properties.sessionID = 'ses_A'
      part.state = {
        ...part.state,
        metadata: {
          ...(part.state.metadata || {}),
          sessionId: 'ses_B',
        },
      }
      edgeAToB.timestamp = 1
    }

    // Edge 2: ses_B → task → ses_A (closes the cycle)
    const edgeBToA = structuredClone(taskEntry)
    if (edgeBToA.event.type !== 'message.part.updated') {
      throw new Error('Expected message.part.updated')
    }
    {
      const part = edgeBToA.event.properties.part
      if (part.type !== 'tool' || part.tool !== 'task') {
        throw new Error('Expected task tool part')
      }
      if (part.state.status !== 'running') {
        throw new Error('Expected running task tool part')
      }
      part.id = 'prt_desc_cycle_B_to_A'
      part.callID = 'call_desc_cycle_B_to_A'
      part.messageID = 'msg_desc_cycle_B_asst'
      part.sessionID = 'ses_B'
      edgeBToA.event.properties.sessionID = 'ses_B'
      part.state = {
        ...part.state,
        metadata: {
          ...(part.state.metadata || {}),
          sessionId: 'ses_A',
        },
      }
      edgeBToA.timestamp = 2
    }

    const cyclicEvents: EventBufferEntry[] = [edgeAToB, edgeBToA]

    // ses_ROOT is not connected to the cycle, so it has no descendants here.
    expect(
      getDerivedDescendantSessions({
        events: cyclicEvents,
        mainSessionId: 'ses_ROOT',
      }),
    ).toEqual([])

    // Starting from ses_A would visit ses_B then stop (ses_A already visited).
    // Without cycle detection the BFS would loop A→B→A→B→... forever.
    expect(
      getDerivedDescendantSessions({
        events: cyclicEvents,
        mainSessionId: 'ses_A',
      }).sort(),
    ).toEqual(['ses_B'])
  })

  test('getDerivedDescendantSessions honors upToIndex', () => {
    // Locate the ses_PM → ses_INV edge in the fixture.
    const invEdgeIndex = events.findIndex((entry) => {
      if (entry.event.type !== 'message.part.updated') {
        return false
      }
      const part = entry.event.properties.part
      if (part.type !== 'tool' || part.tool !== 'task') {
        return false
      }
      if (part.sessionID !== 'ses_PM') {
        return false
      }
      const metadata = (part.state as { metadata?: { sessionId?: string } }).metadata
      return metadata?.sessionId === 'ses_INV'
    })
    expect(invEdgeIndex).toBeGreaterThan(0)

    // Truncating just before the ses_PM→ses_INV edge drops both depth-2 leaves.
    // (ses_INV2 is emitted earlier in the fixture, but we still drop ses_INV;
    // to keep the assertion robust we only assert that ses_INV is absent.)
    const beforeInv = getDerivedDescendantSessions({
      events,
      mainSessionId,
      upToIndex: invEdgeIndex - 1,
    })
    expect(beforeInv).not.toContain('ses_INV')

    // Including the edge index resolves every descendant.
    const atInv = getDerivedDescendantSessions({
      events,
      mainSessionId,
      upToIndex: invEdgeIndex,
    }).sort()
    expect(atInv).toEqual(['ses_INV', 'ses_INV2', 'ses_PM'])
  })
})
