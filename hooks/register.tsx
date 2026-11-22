// Blind spots: a side pane that, after each of Claude's replies, scans the
// conversation for the decisions Claude made without asking you, rates each
// one's risk, and leads with the one most worth checking. It also lists the
// few things you haven't raised that would change the work.
//
// One background fork of the conversation fills it. "Ask" sends an item to
// Claude as your next message. "It's right" and "rest are fine" stay local:
// no message, no tokens, and the item is never raised again this session.
//
// Dots rate each decision: what a wrong guess would cost, from ●○○○○ (a
// small fix) to ●●●●● (serious harm). A legend at the top says so.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Assumption, Depth, Risk, Spot, Status } from '../types'

const PANE = 'blind-spots'
const TITLE = 'Blind spots'
const LIMITS: Record<Depth, { assumptions: number; spots: number }> = {
  focused: { assumptions: 3, spots: 2 },
  thorough: { assumptions: 6, spots: 4 },
}
const LEAD_RISK = 4
const SCAN = ['◜', '◠', '◝', '◞', '◡', '◟'] as const
const SCAN_MS = 120

const spots = atom({ plugin: 'blind-spots', key: 'spots' } as const, [])
const assumptions = atom({ plugin: 'blind-spots', key: 'assumptions' } as const, [])
const status = atom({ plugin: 'blind-spots', key: 'status' } as const, 'idle')
const isAuto = atom({ plugin: 'blind-spots', key: 'isAuto' } as const, true)
const picked = atom({ plugin: 'blind-spots', key: 'picked' } as const, [])
const settled = atom({ plugin: 'blind-spots', key: 'settled' } as const, [])
const fresh = atom({ plugin: 'blind-spots', key: 'fresh' } as const, [])
const hasRun = atom({ plugin: 'blind-spots', key: 'hasRun' } as const, false)
const depth = atom({ plugin: 'blind-spots', key: 'depth' } as const, 'focused')
const frame = atom({ plugin: 'blind-spots', key: 'frame' } as const, 0)

function listed(label: string, items: readonly string[]): string {
  return items.length === 0 ? '' : `\n${label}: ${items.join('; ')}\n`
}

function promptFor(shown: readonly string[], done: readonly string[], level: Depth): string {
  const limit = LIMITS[level]

  return `You have no tools for this. Answer straight away, without deliberating.

Look back over this conversation as a sharp reviewer whose only job is to protect the user from surprises. Return two lists.

"assumptions": decisions the assistant made that the user never stated: inferred requirements, defaults it picked, guesses about the environment, data, audience or scope. For each:
- "text": a plain statement of what was assumed, at most 10 words, that the user can answer yes or no to.
- "risk": 1 to 5, how much it would hurt if the assumption is wrong. 5: lost data, money, security or user trust. 4: days of rework. 3: hours of rework. 2: a small fix. 1: cosmetic. Be strict: most assumptions are 1 to 3, and at most one should be 5.
- "ifWrong": for risk 4 or 5 only, at most 10 words on what breaks.
- "ask": one sentence the user could send to confirm or correct it.
Riskiest first, at most ${limit.assumptions}.

"missed": things the user has not raised that would change what gets built or shipped. Each has "title" (a question, at most 10 words) and "ask" (one sentence the user could send). At most ${limit.spots}. Only items specific to this work. Never generic advice such as tests, docs or accessibility unless this conversation makes it urgent.

Return empty lists rather than filler. If no real work has happened yet, return both lists empty.
${listed('Settled by the user. Never list these again, or anything equivalent', done)}${listed('On screen now. Keep any that still hold, in exactly the same words, and drop any the conversation has since resolved', shown)}
Reply with ONLY this JSON object:
{"assumptions":[{"text":"","risk":3,"ifWrong":"","ask":""}],"missed":[{"title":"","ask":""}]}
No em dashes.`
}

type Found = { spots: Spot[]; assumptions: Assumption[] }

const clean = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')

// A 1 to 5 risk from a number, or from the older "stakes" field.
function toRisk(fields: Record<string, unknown>): Risk {
  const value = fields.risk === undefined || fields.risk === null ? Number.NaN : Number(fields.risk)
  if (Number.isFinite(value)) return Math.min(5, Math.max(1, Math.round(value))) as Risk
  return fields.stakes === 'high' ? 5 : 2
}

function toSpots(raw: unknown): Spot[] {
  if (!Array.isArray(raw)) return []

  return raw.flatMap((item: unknown): Spot[] => {
    if (typeof item !== 'object' || item === null) return []
    const { title, ask } = item as Record<string, unknown>
    const spotTitle = clean(title)
    if (spotTitle === '') return []

    return [{ title: spotTitle, ask: clean(ask) || `Let's talk about this: ${spotTitle}` }]
  })
}

function toAssumptions(raw: unknown): Assumption[] {
  if (!Array.isArray(raw)) return []

  const all = raw.flatMap((item: unknown): Assumption[] => {
    const fields = typeof item === 'string' ? { text: item } : ((item ?? {}) as Record<string, unknown>)
    const text = clean(fields.text)
    if (text === '') return []
    const risk = toRisk(fields)
    const ifWrong = clean(fields.ifWrong)

    return [
      {
        text,
        risk,
        ...(ifWrong === '' ? {} : { ifWrong }),
        ask: clean(fields.ask) || `You assumed this, so let's check it: ${text}`,
      },
    ]
  })

  // Riskiest first; the sort is stable, so equal risks keep the model's order.
  return [...all].sort((one, two) => two.risk - one.risk)
}

// One object with both lists. A bare array is the oldest shape and reads as
// missed items only. An empty pair is a real answer: nothing worth flagging.
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
  if (typeof raw !== 'object' || raw === null) return undefined

  const { missed, assumptions: assumed } = isArray
    ? { missed: raw, assumptions: [] }
    : (raw as Record<string, unknown>)

  return { spots: toSpots(missed), assumptions: toAssumptions(assumed) }
}

// Borders, hover reveals and padding pairs need a newer engine. An older one
// refuses an unknown prop and drops the whole pane, so below this version the
// pane draws plainer, with the same content and controls.
const RICH_SINCE = [2, 1, 327] as const

function isAtLeast(version: string, floor: readonly number[]): boolean {
  const parts = version.split(/[.-]/).slice(0, floor.length).map(Number)
  for (let i = 0; i < floor.length; i++) {
    const part = parts[i] ?? 0
    if (Number.isNaN(part)) return false
    if (part !== floor[i]) return part > floor[i]
  }
  return true
}

async function isRich($: EngineInterface): Promise<boolean> {
  try {
    const found = await $.session.version()
    return isAtLeast(found.base ?? found.version, RICH_SINCE)
  } catch {
    return false
  }
}

// The scan glyph turns while a refresh runs, and stops when it ends.
function spin($: EngineInterface): void {
  $.clock.after(SCAN_MS, async () => {
    if ((await read($, status)) !== 'thinking') return
    await update($, frame, value => (value + 1) % SCAN.length)
    spin($)
  })
}

// Only the newest refresh may write its answer.
let generation = 0

async function refresh($: EngineInterface): Promise<void> {
  const mine = ++generation
  await update($, status, (): Status => 'thinking')
  spin($)

  try {
    const before = [...(await read($, assumptions)).map(one => one.text), ...(await read($, spots)).map(one => one.title)]
    const done = await read($, settled)
    const level = await read($, depth)
    const reply = await $.model.fork({ prompt: promptFor(before, done, level) })
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

    // The model may repeat something the user settled; drop it here too.
    const isOpen = (label: string) => !done.includes(label)
    const limit = LIMITS[level]
    const nextAssumed = found.assumptions.filter(one => isOpen(one.text)).slice(0, limit.assumptions)
    const nextSpots = found.spots.filter(one => isOpen(one.title)).slice(0, limit.spots)
    const now = [...nextAssumed.map(one => one.text), ...nextSpots.map(one => one.title)]
    const wasFilled = await read($, hasRun)

    await update($, assumptions, () => nextAssumed)
    await update($, spots, () => nextSpots)
    // "new" marks what changed since the last refresh, never the first fill.
    await update($, fresh, () => (wasFilled ? now.filter(label => !before.includes(label)) : []))
    await update($, picked, list => list.filter(label => now.includes(label)))
    await update($, hasRun, () => true)
    await update($, status, (): Status => 'idle')
  } catch {
    if (mine === generation) await update($, status, (): Status => 'failed')
  }
}

// "Ask": send the item's sentence as the user's next message and mark it.
function asker($: EngineInterface) {
  return async (label: string, text: string): Promise<void> => {
    await update($, picked, list => (list.includes(label) ? list : [...list, label]))
    await $.prompt.submit({ text, asUser: true })
  }
}

// "It's right" and "rest are fine": local only. The items leave the pane, and
// every later refresh is told never to raise them again.
function settler($: EngineInterface) {
  return async (labels: readonly string[]): Promise<void> => {
    await update($, settled, list => [...list, ...labels.filter(label => !list.includes(label))])
    await update($, assumptions, list => list.filter(one => !labels.includes(one.text)))
    await update($, spots, list => list.filter(one => !labels.includes(one.title)))
  }
}

const DOTS = 5
const meter = (risk: number, cells = DOTS) => '●'.repeat(risk) + '○'.repeat(Math.max(0, cells - risk))

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await update($, status, (): Status => 'idle')
    await $.command.register({
      name: 'blind-spots',
      description: 'Show the decisions Claude made without asking you, rated by risk',
    })
    void $.ui.open({ id: PANE, title: TITLE })

    return next(e)
  })

  on('command.run', { command: 'blind-spots' }, async $ => {
    await $.ui.open({ id: PANE, title: TITLE })
    $.clock.after(1, () => void refresh($))

    return { text: 'Blind spots pane opened. Scanning now.' }
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    const isMainAnswer = e.agentId === undefined && e.reason === 'answer'

    if (isMainAnswer && (await read($, isAuto))) {
      $.clock.after(1, () => void refresh($))
    }

    return done
  })

  // Every long line is wrapping Text or, on the terminal, a plain Button,
  // which wraps there. A desktop draws a Button as a native control on one
  // line and cuts a long label off, so on a desktop Buttons hold one word.
  // No Text `size` and no Text inside a Button: the Claude Code the desktop
  // app pins (2.1.286) refuses both and drops the whole pane.
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const ask = asker($)
    const settle = settler($)
    // Items kept from before risk scores existed read as low risk until the
    // next scan rates them.
    const assumed = (await read($, assumptions)).map(one => ({ ...one, risk: one.risk ?? 2 }))
    const list = await read($, spots)
    const now = await read($, status)
    const auto = await read($, isAuto)
    const done = await read($, picked)
    const newer = await read($, fresh)
    const ran = await read($, hasRun)
    const level = await read($, depth)
    const tick = await read($, frame)
    const settledList = await read($, settled)
    const rich = await isRich($)
    const isTerminal = e.surface === 'terminal'

    const lead = assumed[0] !== undefined && assumed[0].risk >= LEAD_RISK ? assumed[0] : undefined
    const rest = lead === undefined ? assumed : assumed.slice(1)
    const isEmpty = assumed.length === 0 && list.length === 0

    // Hotkeys run 1, 2, 3 down the pane, in reading order.
    let digit = 0
    const nextHotkey = () => {
      digit += 1
      return digit <= 9 ? { hotkey: String(digit) } : {}
    }

    // "new" and "asked" are words at the end of the item's own sentence, so
    // they wrap with it instead of forming a ragged column of their own.
    const tagOf = (label: string) =>
      done.includes(label) ? ' (asked)' : newer.includes(label) ? ' (new)' : ''

    const tag = (label: string) => {
      const text = tagOf(label)
      return (
        text !== '' && (
          <Text key="tag" color={done.includes(label) ? 'success' : 'suggestion'}>
            {text}
          </Text>
        )
      )
    }

    // The exact message "Ask" sends, revealed while the pointer is over its
    // row. It carries no key: the hover belongs to the row's keyed Box.
    const preview = (text: string, indent: number) =>
      rich && (
        <Box display="none" hover={{ display: 'flex' }} paddingLeft={indent}>
          <Text dimColor italic>
            {`Sends: “${text}”`}
          </Text>
        </Box>
      )

    // One item, drawn per surface:
    // - Terminal (a monospace grid): a fixed-width dots column, then the text
    //   as the control itself ("2: text"), wrapping under its own start.
    //   Questions leave the dots column blank so every row's text lines up.
    // - Desktop (a proportional font, where no column of glyphs lines up):
    //   one wrapping paragraph that opens with the dots, and a small Ask
    //   pinned to the row's right edge so every Ask sits in one column.
    const row = (opts: { rowKey: string; pressKey: string; risk?: number; text: string; sends: string }) => {
      const keyProps = nextHotkey()
      const isAsked = done.includes(opts.text)
      const press = () => ask(opts.text, opts.sends)
      const dots = opts.risk === undefined ? '' : meter(opts.risk)
      const dotsColor = opts.risk !== undefined && opts.risk >= LEAD_RISK ? 'warning' : undefined

      if (!isTerminal) {
        return (
          <Box key={opts.rowKey} flexDirection="column" marginTop={1}>
            <Box justifyContent="space-between" columnGap={2}>
              <Box flexShrink={1}>
                <Text dimColor={isAsked}>
                  {dots !== '' && (
                    <Text color={dotsColor} dimColor={dotsColor === undefined}>
                      {`${dots}  `}
                    </Text>
                  )}
                  {opts.text}
                  {tag(opts.text)}
                </Text>
              </Box>
              <Box flexShrink={0}>
                <Button key={opts.pressKey} plain {...keyProps} dimColor label="Ask" onPress={press} />
              </Box>
            </Box>
            {preview(opts.sends, 0)}
          </Box>
        )
      }

      return (
        <Box key={opts.rowKey} flexDirection="column">
          <Box>
            <Box flexShrink={0}>
              <Text color={dotsColor} dimColor={dotsColor === undefined}>
                {`${dots === '' ? ' '.repeat(DOTS) : dots} `}
              </Text>
            </Box>
            <Box flexShrink={1}>
              <Button
                key={opts.pressKey}
                plain
                {...keyProps}
                dimColor={isAsked}
                label={opts.text + tagOf(opts.text)}
                onPress={press}
              />
            </Box>
          </Box>
          {preview(opts.sends, DOTS + 1)}
        </Box>
      )
    }

    // Section headings have to stand out from the items under them: colour
    // and weight everywhere, a rule out to the pane's edge on the terminal,
    // and a larger size on a desktop engine that takes it.
    const headingSize = rich && !isTerminal ? ({ size: 'heading' } as const) : {}
    const section = (heading: string, count: number) => {
      const tail = `  ${count} `
      const rule = '─'.repeat(Math.max(2, e.props.bodyColumns - heading.length - tail.length - 1))

      return (
        <Box marginTop={1}>
          <Text bold color="suggestion" {...headingSize}>
            {heading}
          </Text>
          <Text dimColor>{tail}</Text>
          {isTerminal && (
            <Text dimColor wrap="truncate-end">
              {rule}
            </Text>
          )}
        </Box>
      )
    }

    const statusLine =
      now === 'thinking' ? (
        <Text color="claude">{`${SCAN[tick % SCAN.length]} reading the chat`}</Text>
      ) : now === 'failed' ? (
        <Text color="error">couldn't read the chat</Text>
      ) : auto ? (
        <Text>
          <Text color="success">●</Text>
          <Text dimColor> on</Text>
        </Text>
      ) : (
        <Text dimColor>○ paused</Text>
      )

    // What the dots mean, once, at the top, whenever any are on screen.
    const legend = assumed.length > 0 && (
      <Box flexDirection="column">
        <Text dimColor>Dots show what a wrong guess would cost:</Text>
        <Box columnGap={3}>
          <Text dimColor>{`${meter(1)} small fix`}</Text>
          <Text color="warning">{`${meter(5)} serious harm`}</Text>
        </Box>
      </Box>
    )

    // The one bold element: the riskiest decision, in a card where the engine
    // draws borders, with its dots, what breaks if it's wrong, and its actions.
    const leadInner = lead !== undefined && (
      <Box flexDirection="column">
        <Box justifyContent="space-between">
          <Text color="warning" bold {...headingSize}>
            Check this first
          </Text>
          <Text color="warning">{meter(lead.risk)}</Text>
        </Box>
        <Text bold dimColor={done.includes(lead.text)}>
          {lead.text}
          {tag(lead.text)}
        </Text>
        {lead.ifWrong !== undefined && <Text dimColor>{`If this is wrong: ${lead.ifWrong}`}</Text>}
        <Box columnGap={2}>
          <Button
            key="assumed:0"
            plain
            {...nextHotkey()}
            label="Ask Claude about it"
            onPress={() => ask(lead.text, lead.ask)}
          />
          <Button key="settle:assumed:0" plain dimColor label="It's right" onPress={() => settle([lead.text])} />
        </Box>
      </Box>
    )

    const leadBlock =
      lead !== undefined &&
      (rich ? (
        <Box key="lead" flexDirection="column" marginTop={1} borderStyle="round" borderColor="warning" paddingX={1}>
          {leadInner}
          {preview(lead.ask, 0)}
        </Box>
      ) : (
        <Box key="lead" flexDirection="column" marginTop={1}>
          {leadInner}
        </Box>
      ))

    const decidedBlock = rest.length > 0 && (
      <Box flexDirection="column">
        {section(lead === undefined ? 'Claude decided for you' : 'Claude also decided for you', rest.length)}
        {rest.map((one, index) => {
          const at = lead === undefined ? index : index + 1
          return row({ rowKey: `row:${at}`, pressKey: `assumed:${at}`, risk: one.risk, text: one.text, sends: one.ask })
        })}
      </Box>
    )

    const missedBlock = list.length > 0 && (
      <Box flexDirection="column">
        {section("Questions you haven't raised yet", list.length)}
        {list.map((spot, index) =>
          row({ rowKey: `spotrow:${index}`, pressKey: `spot:${index}`, text: spot.title, sends: spot.ask }),
        )}
      </Box>
    )

    const others = [...rest.map(one => one.text), ...list.map(spot => spot.title)]

    return (
      <Box flexDirection="column">
        <Box justifyContent="space-between">
          <Text bold color="claude" {...headingSize}>
            BLIND SPOTS
          </Text>
          {statusLine}
        </Box>
        {legend}

        {now === 'failed' && (
          <Box marginTop={1}>
            <Text color="error">The last read didn't come back readable. Press r to try again.</Text>
          </Box>
        )}

        {isEmpty && (
          <Box marginTop={1} flexDirection="column">
            {ran ? (
              <Box flexDirection="column">
                <Text>Nothing to check right now.</Text>
                <Text dimColor>Claude hasn't decided anything you didn't ask for.</Text>
              </Box>
            ) : (
              <Text dimColor>
                After each reply, this reads the chat and lists what Claude decided without asking you, and how much a
                wrong guess would cost.
              </Text>
            )}
          </Box>
        )}

        {leadBlock}
        {decidedBlock}
        {missedBlock}

        <Box marginTop={1} flexDirection="column">
          <Box columnGap={2}>
            <Button key="refresh" plain hotkey="r" dimColor label="check again" onPress={() => refresh($)} />
            <Button
              key="auto"
              plain
              hotkey="a"
              dimColor
              label={auto ? 'auto-check on' : 'auto-check off'}
              onPress={() => update($, isAuto, value => !value)}
            />
            <Button
              key="depth"
              plain
              hotkey="d"
              dimColor
              label={level === 'focused' ? 'show more' : 'show fewer'}
              onPress={async () => {
                await update($, depth, (value): Depth => (value === 'focused' ? 'thorough' : 'focused'))
                await refresh($)
              }}
            />
          </Box>
          {(others.length > 0 || settledList.length > 0) && (
            <Box columnGap={2}>
              {others.length > 0 && (
                <Button
                  key="clear"
                  plain
                  hotkey="f"
                  dimColor
                  label="mark the rest fine"
                  onPress={() => settle(others)}
                />
              )}
              {settledList.length > 0 && (
                <Button
                  key="restore"
                  plain
                  hotkey="u"
                  dimColor
                  label={`bring back ${settledList.length} hidden`}
                  onPress={async () => {
                    await update($, settled, () => [])
                    await refresh($)
                  }}
                />
              )}
            </Box>
          )}
        </Box>
      </Box>
    )
  })
}
