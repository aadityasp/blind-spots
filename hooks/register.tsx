// Blind spots: a side pane that, after each of Claude's replies, lists the
// scenarios you might have missed and the assumptions Claude is making.
// One background fork of the conversation fills both lists. Pressing an item
// sends it as your next message.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Assumption, Spot, SpotKind, Status } from '../types'

const PANE = 'blind-spots'
const TITLE = 'Blind spots'
const MISSED_HEADING = 'Scenarios you might have missed'
const ASSUMED_HEADING = 'Assumptions Claude is making'
const MAX_SPOTS = 6
const MAX_ASSUMPTIONS = 12

const spots = atom({ plugin: 'blind-spots', key: 'spots' } as const, [])
const assumptions = atom({ plugin: 'blind-spots', key: 'assumptions' } as const, [])
const status = atom({ plugin: 'blind-spots', key: 'status' } as const, 'idle')
const isAuto = atom({ plugin: 'blind-spots', key: 'isAuto' } as const, true)
const picked = atom({ plugin: 'blind-spots', key: 'picked' } as const, [])

const KINDS: readonly SpotKind[] = ['question', 'feature', 'topic']
const TAG: Record<SpotKind, string> = { question: 'Q', feature: 'F', topic: 'T' }
const KIND_COLOR: Record<SpotKind, string> = { question: 'suggestion', feature: 'success', topic: 'merged' }

function promptFor(prior: readonly Spot[], priorAssumed: readonly Assumption[]): string {
  const shown =
    prior.length === 0
      ? ''
      : `\nAlready shown as missed (keep one only if it is still unaddressed and still among the most important): ${prior
          .map(spot => spot.title)
          .join('; ')}\n`
  const assumedBefore =
    priorAssumed.length === 0
      ? ''
      : `\nAlready listed as assumptions (keep each one still in force, drop any the user has since confirmed or corrected): ${priorAssumed
          .map(one => one.text)
          .join('; ')}\n`

  return `Step outside the conversation for a moment and answer two things.

1. "missed": what important things has the user probably NOT considered yet? Think of questions worth asking, features or options worth adding, and topics worth looking into. Prefer high-leverage, non-obvious items specific to this conversation over generic advice. Skip anything already discussed.
${shown}
2. "assumptions": every assumption the assistant has made so far while doing this work that the user never stated. Include inferred requirements, defaults it picked, guesses about the environment, tools, data or audience, and scope it decided to include or leave out. Write each as a plain statement of what was assumed, specific enough that the user can say yes or no to it. List all that are still in force, most consequential first, up to ${MAX_ASSUMPTIONS}. Use an empty list if there are none.
${assumedBefore}
Reply with ONLY one JSON object, nothing else:
{"missed":[{"kind":"question"|"feature"|"topic","title":"at most 6 words","ask":"one sentence the user could send to start discussing it"}],"assumptions":[{"text":"at most 14 words","ask":"one sentence the user could send to confirm or correct it"}]}
Give 3 to ${MAX_SPOTS} missed items, most important first. No em dashes.`
}

type Found = { spots: Spot[]; assumptions: Assumption[] }

function toSpots(raw: unknown): Spot[] {
  if (!Array.isArray(raw)) return []

  return raw
    .flatMap((item: unknown): Spot[] => {
      if (typeof item !== 'object' || item === null) return []
      const { kind, title, ask } = item as Record<string, unknown>
      if (typeof title !== 'string' || title.trim() === '') return []
      const spotKind = KINDS.find(one => one === kind) ?? 'topic'
      const spotAsk = typeof ask === 'string' && ask.trim() !== '' ? ask.trim() : `Let's discuss: ${title.trim()}`

      return [{ kind: spotKind, title: title.trim(), ask: spotAsk }]
    })
    .slice(0, MAX_SPOTS)
}

function toAssumptions(raw: unknown): Assumption[] {
  if (!Array.isArray(raw)) return []

  return raw
    .flatMap((item: unknown): Assumption[] => {
      const { text, ask } =
        typeof item === 'string' ? { text: item, ask: undefined } : ((item ?? {}) as Record<string, unknown>)
      if (typeof text !== 'string' || text.trim() === '') return []
      const oneAsk =
        typeof ask === 'string' && ask.trim() !== ''
          ? ask.trim()
          : `You assumed this, so let's check it. ${text.trim()}`

      return [{ text: text.trim(), ask: oneAsk }]
    })
    .slice(0, MAX_ASSUMPTIONS)
}

// The reply is one object with both lists. A bare array is the older shape
// and still reads as missed items only.
function parse(text: string): Found | undefined {
  const brace = text.indexOf('{')
  const bracket = text.indexOf('[')
  const isArray = bracket >= 0 && (brace < 0 || bracket < brace)
  const start = isArray ? bracket : brace
  const end = text.lastIndexOf(isArray ? ']' : '}')
  if (start < 0 || end <= start) return undefined

  let raw: unknown
  try {
    raw = JSON.parse(text.slice(start, end + 1))
  } catch {
    return undefined
  }

  const { missed, assumptions: assumed } = isArray ? { missed: raw, assumptions: [] } : ((raw ?? {}) as Record<string, unknown>)
  const found: Found = { spots: toSpots(missed), assumptions: toAssumptions(assumed) }

  return found.spots.length === 0 && found.assumptions.length === 0 ? undefined : found
}

// Only the newest refresh may write its answer.
let generation = 0

async function refresh($: EngineInterface): Promise<void> {
  const mine = ++generation
  await update($, status, (): Status => 'thinking')

  try {
    const prior = await read($, spots)
    const priorAssumed = await read($, assumptions)
    const reply = await $.model.fork({ prompt: promptFor(prior, priorAssumed) })
    if (mine !== generation) return

    if (!reply.isAnswered) {
      await update($, status, (): Status => (reply.reason === 'nothing-to-fork' ? 'idle' : 'failed'))
      return
    }
    const found = parse(reply.text)
    if (found === undefined) {
      await update($, status, (): Status => 'failed')
      return
    }
    const shownNow = [...found.spots.map(spot => spot.title), ...found.assumptions.map(one => one.text)]
    await update($, spots, () => found.spots)
    await update($, assumptions, () => found.assumptions)
    await update($, picked, list => list.filter(label => shownNow.includes(label)))
    await update($, status, (): Status => 'idle')
  } catch {
    if (mine === generation) await update($, status, (): Status => 'failed')
  }
}

// `label` is what the pane shows, so a pressed item can be dimmed.
async function ask($: EngineInterface, label: string, text: string): Promise<void> {
  await update($, picked, list => (list.includes(label) ? list : [...list, label]))
  await $.prompt.submit({ text, asUser: true })
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await update($, status, (): Status => 'idle')
    await $.command.register({
      name: 'blind-spots',
      description: 'Show scenarios you might have missed and the assumptions Claude is making',
    })
    void $.ui.open({ id: PANE, title: TITLE })

    return next(e)
  })

  on('command.run', { command: 'blind-spots' }, async $ => {
    await $.ui.open({ id: PANE, title: TITLE })
    $.clock.after(1, () => void refresh($))

    return { text: 'Blind spots pane opened. Refreshing now.' }
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    const isMainAnswer = e.agentId === undefined && e.reason === 'answer'

    if (isMainAnswer && (await read($, isAuto))) {
      $.clock.after(1, () => void refresh($))
    }

    return done
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const list = await read($, spots)
    const assumed = await read($, assumptions)
    const now = await read($, status)
    const auto = await read($, isAuto)
    const done = await read($, picked)

    const isTerminal = e.surface === 'terminal'
    const isEmpty = list.length === 0 && assumed.length === 0

    // A heading, then on the terminal a rule out to the pane's edge with the
    // item count at its end. A desktop draws a larger heading instead.
    const heading = (glyph: string, color: string, label: string, count: number) => {
      const tail = count > 0 ? ` ${count}` : ''
      const rule = '─'.repeat(Math.max(2, e.props.bodyColumns - label.length - tail.length - 4))

      return (
        <Box>
          <Text size="heading" weight="bold">
            <Text color={color}>{glyph}</Text> {label}
          </Text>
          {isTerminal && (
            <Text dimColor wrap="truncate-end">
              {' '}
              {rule}
              {tail}
            </Text>
          )}
        </Box>
      )
    }

    const hint = (text: string) => (
      <Text dimColor italic>
        {text}
      </Text>
    )

    const asked = (label: string) => done.includes(label) && <Text color="success"> ✓</Text>

    const state =
      now === 'thinking' ? (
        <Text color="claude">● thinking</Text>
      ) : now === 'failed' ? (
        <Text color="error">✕ refresh failed</Text>
      ) : (
        <Text> </Text>
      )

    return (
      <Box flexDirection="column">
        {heading('✦', 'claude', MISSED_HEADING, list.length)}
        <Box flexDirection="column" paddingLeft={2}>
          {isEmpty ? (
            hint("Appears after Claude's next reply.")
          ) : (
            <Text dimColor>
              <Text color={KIND_COLOR.question}>Q</Text> question · <Text color={KIND_COLOR.feature}>F</Text>{' '}
              feature · <Text color={KIND_COLOR.topic}>T</Text> topic
            </Text>
          )}
          {list.map((spot, index) => (
            <Button
              key={`spot:${index}`}
              plain
              hotkey={String(index + 1)}
              dimColor={done.includes(spot.title)}
              onPress={() => ask($, spot.title, spot.ask)}
            >
              <Text color={KIND_COLOR[spot.kind]} weight="bold">
                {TAG[spot.kind]}
              </Text>
              {'  '}
              {spot.title}
              {asked(spot.title)}
            </Button>
          ))}
        </Box>

        <Box marginTop={1} flexDirection="column">
          {heading('◇', 'warning', ASSUMED_HEADING, assumed.length)}
          <Box flexDirection="column" paddingLeft={2}>
            {isEmpty
              ? hint("Appears after Claude's next reply.")
              : assumed.length === 0
                ? hint('None so far.')
                : hint('Decided without asking. Press to check.')}
            {/* The bullet sits outside the Button so a long line wraps under its text. */}
            {assumed.map((one, index) => (
              <Box key={`row:${index}`}>
                <Text color="warning">{'› '}</Text>
                <Button
                  key={`assumed:${index}`}
                  plain
                  dimColor={done.includes(one.text)}
                  onPress={() => ask($, one.text, one.ask)}
                >
                  {one.text}
                  {asked(one.text)}
                </Button>
              </Box>
            ))}
          </Box>
        </Box>

        <Box marginTop={1} justifyContent="space-between">
          <Box columnGap={2}>
            <Button key="refresh" plain hotkey="r" dimColor onPress={() => refresh($)}>
              refresh
            </Button>
            <Button key="auto" plain hotkey="a" dimColor onPress={() => update($, isAuto, value => !value)}>
              {auto ? 'auto on' : 'auto off'}
            </Button>
          </Box>
          {state}
        </Box>
      </Box>
    )
  })
}
