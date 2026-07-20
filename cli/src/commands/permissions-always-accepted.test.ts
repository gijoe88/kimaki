// Locks the §11 threat-model invariant for Layer 2 of the arbitrary-depth
// permissions design (docs/architecture/permission-system-arbitrary-depth.md).
//
// The invariant: the kimaki-side auto-accept check (Layer 2) must ONLY match
// prompts whose permission type AND patterns are genuinely covered by an
// accepted rule. It must NEVER:
//   - auto-accept a broader permission type than what was approved (e.g. an
//     `edit` rule auto-accepting a `bash` prompt even if patterns overlap);
//   - propagate a `deny` or `ask` rule (only `allow` propagates);
//   - auto-accept when the prompt's patterns are not fully covered.
//
// These tests call the REAL exported predicate used by both
// ThreadSessionRuntime.isPermissionCoveredByAlwaysAccepted (Layer 2) and the
// in-memory safety net for "Accept Always" rules, so any drift between the
// predicate and its expected threat-model behavior surfaces here directly.

import { describe, expect, test } from 'vitest'
import type { PermissionRequest, PermissionRuleset } from '@opencode-ai/sdk/v2'
import { isPermissionCoveredByRules } from './permissions.js'

describe('Layer 2 always-accepted coverage — §11 threat model invariant', () => {
  test('same permission + covered pattern → auto-accept', () => {
    const rules: PermissionRuleset = [
      { permission: 'edit', pattern: 'src/**', action: 'allow' },
    ]
    expect(
      isPermissionCoveredByRules({
        rules,
        permission: { permission: 'edit', patterns: ['src/foo.ts'] },
      }),
    ).toBe(true)
  })

  test('different permission + overlapping pattern → NO auto-accept (§11 threat)', () => {
    // An `edit` allow-rule with pattern `src/**` must NOT auto-accept a `bash`
    // prompt whose pattern happens to overlap. This is the headline invariant
    // from §11: "an `edit` rule must not auto-accept a `bash` prompt even if
    // patterns overlap."
    const rules: PermissionRuleset = [
      { permission: 'edit', pattern: 'src/**', action: 'allow' },
    ]
    expect(
      isPermissionCoveredByRules({
        rules,
        permission: { permission: 'bash', patterns: ['src/**'] },
      }),
    ).toBe(false)
  })

  test('action: deny rule + matching pattern → NO auto-accept (only allow propagates)', () => {
    const rules: PermissionRuleset = [
      { permission: 'edit', pattern: 'src/**', action: 'deny' },
    ]
    expect(
      isPermissionCoveredByRules({
        rules,
        permission: { permission: 'edit', patterns: ['src/foo.ts'] },
      }),
    ).toBe(false)
  })

  test('action: ask rule + matching pattern → NO auto-accept', () => {
    const rules: PermissionRuleset = [
      { permission: 'edit', pattern: 'src/**', action: 'ask' },
    ]
    expect(
      isPermissionCoveredByRules({
        rules,
        permission: { permission: 'edit', patterns: ['src/foo.ts'] },
      }),
    ).toBe(false)
  })

  test('pattern NOT covered (rule src/**, prompt tests/**) → NO auto-accept', () => {
    const rules: PermissionRuleset = [
      { permission: 'edit', pattern: 'src/**', action: 'allow' },
    ]
    expect(
      isPermissionCoveredByRules({
        rules,
        permission: { permission: 'edit', patterns: ['tests/foo.test.ts'] },
      }),
    ).toBe(false)
  })

  test('multiple rules, partial coverage of prompt patterns → NO auto-accept', () => {
    // Prompt has two patterns; only one is covered by an allow rule.
    // arePatternsCoveredBy uses .every(), so partial coverage must fail.
    const rules: PermissionRuleset = [
      { permission: 'edit', pattern: 'src/**', action: 'allow' },
    ]
    expect(
      isPermissionCoveredByRules({
        rules,
        permission: { permission: 'edit', patterns: ['src/foo.ts', 'tests/x.ts'] },
      }),
    ).toBe(false)
  })

  test('multiple rules, ALL prompt patterns covered (by different rules) → auto-accept', () => {
    // Two allow rules of the same permission type jointly cover both prompt
    // patterns. This MUST auto-accept (each prompt pattern is covered by at
    // least one matching allow rule).
    const rules: PermissionRuleset = [
      { permission: 'edit', pattern: 'src/**', action: 'allow' },
      { permission: 'edit', pattern: 'tests/**', action: 'allow' },
    ]
    expect(
      isPermissionCoveredByRules({
        rules,
        permission: { permission: 'edit', patterns: ['src/foo.ts', 'tests/x.ts'] },
      }),
    ).toBe(true)
  })

  test('empty ruleset → fast false (no iterate)', () => {
    expect(
      isPermissionCoveredByRules({
        rules: [],
        permission: { permission: 'edit', patterns: ['src/foo.ts'] },
      }),
    ).toBe(false)
  })

  test('rules of a different permission type do not slow-match into coverage', () => {
    // A bash allow-rule with a very broad pattern (`**`) must NOT cover an
    // edit prompt. Confirms the permission-type filter runs before the
    // pattern check (order matters for correctness, not just performance).
    const rules: PermissionRuleset = [
      { permission: 'bash', pattern: '**', action: 'allow' },
    ]
    expect(
      isPermissionCoveredByRules({
        rules,
        permission: { permission: 'edit', patterns: ['src/foo.ts'] },
      }),
    ).toBe(false)
  })

  test('mixed deny + allow rules of same type: deny does not poison allow', () => {
    // A deny rule for the same permission type must not block an otherwise
    // valid allow rule. (Layer 2 only auto-accepts; it never auto-rejects.
    // A deny rule is simply ignored by the allow-filter.)
    const rules: PermissionRuleset = [
      { permission: 'edit', pattern: 'secrets/**', action: 'deny' },
      { permission: 'edit', pattern: 'src/**', action: 'allow' },
    ]
    expect(
      isPermissionCoveredByRules({
        rules,
        permission: { permission: 'edit', patterns: ['src/foo.ts'] },
      }),
    ).toBe(true)
  })
})
