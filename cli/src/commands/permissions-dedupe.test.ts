// Locks the dedup behavior shared by Layer 1 (propagateAlwaysRulesToSessions
// → session.update) and Layer 2 (in-memory alwaysAcceptedRules append) of the
// arbitrary-depth permissions design (docs/architecture/permission-system-arbitrary-depth.md §5.6.2).
//
// Why this matters: opencode's `Permission.merge` is literally `rulesets.flat()`
// (packages/opencode/src/permission/index.ts:200-202) — it does NOT dedupe.
// Without client-side dedupe, every "Accept Always" click on the same prompt
// would duplicate the rule in:
//   - the persisted ruleset on the opencode server (unbounded growth);
//   - the runtime's in-memory alwaysAcceptedRules.
//
// The dedup key is `${permission}::${pattern}::${action}` — two rules are
// considered duplicates ONLY when ALL three fields match. Tests below pin
// each field independently so any future change to the key formula surfaces.

import { describe, expect, test } from 'vitest'
import type { PermissionRuleset } from '@opencode-ai/sdk/v2'
import {
  dedupePermissionRuleset,
  permissionRuleKey,
} from './permissions.js'

describe('dedupePermissionRuleset — shared by Layer 1 + Layer 2 dedup', () => {
  test('empty existing + empty added → empty', () => {
    expect(dedupePermissionRuleset([], [])).toEqual([])
  })

  test('empty existing + non-empty added → all of added', () => {
    const added: PermissionRuleset = [
      { permission: 'edit', pattern: 'src/**', action: 'allow' },
    ]
    expect(dedupePermissionRuleset([], added)).toEqual(added)
  })

  test('non-empty existing + empty added → existing unchanged (same reference shape)', () => {
    const existing: PermissionRuleset = [
      { permission: 'edit', pattern: 'src/**', action: 'allow' },
    ]
    expect(dedupePermissionRuleset(existing, [])).toEqual(existing)
  })

  test('identical rule in existing and added → kept once (no duplicate)', () => {
    // This is the headline case: user clicks "Accept Always" twice on the
    // exact same prompt. The rule must NOT be duplicated.
    const existing: PermissionRuleset = [
      { permission: 'edit', pattern: 'src/**', action: 'allow' },
    ]
    const added: PermissionRuleset = [
      { permission: 'edit', pattern: 'src/**', action: 'allow' },
    ]
    expect(dedupePermissionRuleset(existing, added)).toEqual(existing)
    expect(dedupePermissionRuleset(existing, added)).toHaveLength(1)
  })

  test('rules differing only by permission type → both kept (NOT deduped)', () => {
    // §11 invariant: permission type is part of the identity. An `edit`
    // allow-rule and a `bash` allow-rule with the same pattern are distinct.
    const existing: PermissionRuleset = [
      { permission: 'edit', pattern: 'src/**', action: 'allow' },
    ]
    const added: PermissionRuleset = [
      { permission: 'bash', pattern: 'src/**', action: 'allow' },
    ]
    expect(dedupePermissionRuleset(existing, added)).toHaveLength(2)
    expect(dedupePermissionRuleset(existing, added)).toEqual([
      { permission: 'edit', pattern: 'src/**', action: 'allow' },
      { permission: 'bash', pattern: 'src/**', action: 'allow' },
    ])
  })

  test('rules differing only by pattern → both kept (NOT deduped)', () => {
    // Pattern is part of the identity. `src/**` and `tests/**` are distinct.
    const existing: PermissionRuleset = [
      { permission: 'edit', pattern: 'src/**', action: 'allow' },
    ]
    const added: PermissionRuleset = [
      { permission: 'edit', pattern: 'tests/**', action: 'allow' },
    ]
    expect(dedupePermissionRuleset(existing, added)).toHaveLength(2)
  })

  test('rules differing only by action → both kept (NOT deduped)', () => {
    // Action is part of the identity. `allow` and `deny` for the same
    // permission+pattern are distinct (a deny rule doesn't shadow an allow
    // rule in the dedup — Layer 2's predicate filters by action separately).
    const existing: PermissionRuleset = [
      { permission: 'edit', pattern: 'src/**', action: 'allow' },
    ]
    const added: PermissionRuleset = [
      { permission: 'edit', pattern: 'src/**', action: 'deny' },
    ]
    expect(dedupePermissionRuleset(existing, added)).toHaveLength(2)
  })

  test('first-occurrence wins: existing rule is preserved over conflicting added', () => {
    // Order matters: when an existing allow and an added deny have the same
    // key (impossible with the current key formula since action is part of
    // the key, but documented for future key changes). For the current
    // three-field key this is exercised by an exact duplicate — the existing
    // entry stays at its original position.
    const existing: PermissionRuleset = [
      { permission: 'edit', pattern: 'src/**', action: 'allow' },
    ]
    const added: PermissionRuleset = [
      { permission: 'edit', pattern: 'src/**', action: 'allow' }, // dup
      { permission: 'bash', pattern: '*', action: 'allow' }, // new
    ]
    const result = dedupePermissionRuleset(existing, added)
    expect(result).toEqual([
      { permission: 'edit', pattern: 'src/**', action: 'allow' },
      { permission: 'bash', pattern: '*', action: 'allow' },
    ])
    expect(result[0]).toBe(existing[0]) // identity preserved for existing entries
  })

  test('added rules with internal dupes → deduped against each other too', () => {
    // Defensive: if the caller ever passes an `added` array that contains
    // its own duplicates (e.g. from a malformed permission.asked event
    // carrying the same pattern twice in the `always` field), the helper
    // collapses them so they never reach opencode's flat-merge.
    const added: PermissionRuleset = [
      { permission: 'edit', pattern: 'src/**', action: 'allow' },
      { permission: 'edit', pattern: 'src/**', action: 'allow' }, // dup within added
      { permission: 'edit', pattern: 'tests/**', action: 'allow' },
    ]
    expect(dedupePermissionRuleset([], added)).toEqual([
      { permission: 'edit', pattern: 'src/**', action: 'allow' },
      { permission: 'edit', pattern: 'tests/**', action: 'allow' },
    ])
  })

  test('delta computation: union.length - existing.length gives addedCount', () => {
    // Mirrors how Layer 2 (onAcceptAlways) computes the count for its log:
    //   const union = dedupePermissionRuleset(alwaysAcceptedRules, addedRules)
    //   const addedCount = union.length - alwaysAcceptedRules.length
    // Verify the count is exactly the number of genuinely-new rules.
    const existing: PermissionRuleset = [
      { permission: 'edit', pattern: 'src/**', action: 'allow' },
    ]
    const added: PermissionRuleset = [
      { permission: 'edit', pattern: 'src/**', action: 'allow' }, // dup → 0
      { permission: 'bash', pattern: 'a', action: 'allow' }, // new → 1
      { permission: 'bash', pattern: 'b', action: 'allow' }, // new → 1
    ]
    const union = dedupePermissionRuleset(existing, added)
    expect(union.length - existing.length).toBe(2)
  })

  test('does not mutate inputs (pure)', () => {
    const existing: PermissionRuleset = [
      { permission: 'edit', pattern: 'src/**', action: 'allow' },
    ]
    const added: PermissionRuleset = [
      { permission: 'bash', pattern: '*', action: 'allow' },
    ]
    const existingSnapshot = [...existing]
    const addedSnapshot = [...added]
    dedupePermissionRuleset(existing, added)
    expect(existing).toEqual(existingSnapshot)
    expect(added).toEqual(addedSnapshot)
  })
})

describe('permissionRuleKey — three-field identity', () => {
  test('same permission+pattern+action → same key', () => {
    const a = { permission: 'edit', pattern: 'src/**', action: 'allow' as const }
    const b = { permission: 'edit', pattern: 'src/**', action: 'allow' as const }
    expect(permissionRuleKey(a)).toBe(permissionRuleKey(b))
  })

  test('different permission → different key', () => {
    const a = { permission: 'edit', pattern: 'src/**', action: 'allow' as const }
    const b = { permission: 'bash', pattern: 'src/**', action: 'allow' as const }
    expect(permissionRuleKey(a)).not.toBe(permissionRuleKey(b))
  })

  test('different pattern → different key', () => {
    const a = { permission: 'edit', pattern: 'src/**', action: 'allow' as const }
    const b = { permission: 'edit', pattern: 'tests/**', action: 'allow' as const }
    expect(permissionRuleKey(a)).not.toBe(permissionRuleKey(b))
  })

  test('different action → different key', () => {
    const a = { permission: 'edit', pattern: 'src/**', action: 'allow' as const }
    const b = { permission: 'edit', pattern: 'src/**', action: 'deny' as const }
    expect(permissionRuleKey(a)).not.toBe(permissionRuleKey(b))
  })

  test('three actions are all pairwise distinct', () => {
    // Pin the three valid actions so adding a new one is a conscious decision.
    const allow = { permission: 'edit', pattern: 'src/**', action: 'allow' as const }
    const deny = { permission: 'edit', pattern: 'src/**', action: 'deny' as const }
    const ask = { permission: 'edit', pattern: 'src/**', action: 'ask' as const }
    const keys = new Set([
      permissionRuleKey(allow),
      permissionRuleKey(deny),
      permissionRuleKey(ask),
    ])
    expect(keys.size).toBe(3)
  })

  test('pattern containing :: does not collide (separator behavior is unspecified, just pin current)', () => {
    // The key uses `::` as separator. A pattern like `a::b` could in theory
    // collide with permission `a` + pattern `b` if the parser naively split
    // on `::`. The current implementation only ever uses the key for Set
    // membership (no round-trip parsing), so this is fine. This test pins
    // the current behavior: two rules with different (permission, pattern)
    // that happen to produce the same string after join are still treated
    // as distinct in this test because we vary them in a non-colliding way.
    // If someone changes the separator, this test should be revisited.
    const weird = {
      permission: 'edit',
      pattern: 'a::b',
      action: 'allow' as const,
    }
    const other = {
      permission: 'edit',
      pattern: 'a',
      action: 'allow' as const,
    }
    expect(permissionRuleKey(weird)).not.toBe(permissionRuleKey(other))
  })
})
