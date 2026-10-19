import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const USAGE = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

const SPOTS = [
  { kind: 'question', title: 'Who pays for the forks', ask: 'How much will refreshing every turn cost me?' },
  { kind: 'feature', title: 'Dismiss a single item', ask: 'Should I be able to dismiss one item?' },
  { kind: 'risk', title: 'Unknown kinds become topics', ask: 'What happens to an unknown kind?' },
]

const ASSUMED = [
  { text: 'The pane should refresh after every reply', ask: 'Should the pane really refresh after every reply?' },
  'Plain strings count as assumptions too',
]

const REPLY = JSON.stringify({ missed: SPOTS, assumptions: ASSUMED })

const PANE = {
  plugin: 'blind-spots',
  component: 'Pane',
  requestId: 'blind-spots',
  props: {
    title: 'Blind spots',
    isFocused: false,
    bodyColumns: 40,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 20 },
    view: {},
  },
} as const

function engineBeneath(on: On, reply: string) {
  const forks: string[] = []
  const asked: string[] = []
  on('model.fork', ($, e) => {
    forks.push(e.prompt)
    return { value: { isAnswered: true, text: reply, usage: USAGE } }
  })
  on('prompt.submit', ($, e) => {
    asked.push(e.text)
    return { text: e.text }
  })
  on('turn.complete', ($, e) => ({ text: e.answer }))

  return { forks, asked }
}

function turn(agentId?: string) {
  return { answer: 'done', durationMs: 10, isAborted: false, turnId: 't1', reason: 'answer', agentId } as const
}

test('a finished main turn fills both sections and pressing an item asks it', async ($, on) => {
  const clock = mock.clock(on)
  const engine = engineBeneath(on, '```json\n' + REPLY + '\n```')

  const first = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await first.find({ text: /Scenarios you might have missed/ })).toBeDefined()
  expect(await first.find({ text: /Assumptions Claude is making/ })).toBeDefined()
  expect(await first.find({ text: /next reply/ })).toBeDefined()
  await $.turn.complete(turn())
  await clock.advance(5)
  await first.unmount()

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })

    expect(await ui.find({ key: 'spot:0', text: /Who pays for the forks/ })).toBeDefined()
    expect(await ui.find({ key: 'spot:2', text: /Unknown kinds become topics/ })).toBeDefined()
    expect(await ui.find({ key: 'assumed:0', text: /refresh after every reply/ })).toBeDefined()
    expect(await ui.find({ key: 'assumed:1', text: /Plain strings count/ })).toBeDefined()

    expect(await ui.find({ text: /Scenarios you might have missed/ })).toBeDefined()
    await ui.press({ key: 'spot:1' })
    expect(engine.asked.at(-1)).toBe('Should I be able to dismiss one item?')
    expect(await ui.find({ key: 'spot:1', text: /✓/ })).toBeDefined()
    await ui.press({ key: 'assumed:0' })
    expect(engine.asked.at(-1)).toBe('Should the pane really refresh after every reply?')
    await ui.press({ key: 'assumed:1' })
    expect(engine.asked.at(-1)).toMatch(/Plain strings count as assumptions too/)
    await ui.unmount()
  }
})

test('the older bare array reply still fills the missed section', async ($, on) => {
  const clock = mock.clock(on)
  engineBeneath(on, JSON.stringify(SPOTS))
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  await $.turn.complete(turn())
  await clock.advance(5)
  expect(await ui.find({ key: 'spot:0', text: /Who pays for the forks/ })).toBeDefined()
  expect(await ui.find({ text: /None so far/ })).toBeDefined()
})

test('the next refresh is told which assumptions are already listed', async ($, on) => {
  const clock = mock.clock(on)
  const engine = engineBeneath(on, REPLY)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  await $.turn.complete(turn())
  await clock.advance(5)
  await ui.press({ key: 'refresh' })
  expect(engine.forks.length).toBe(2)
  expect(engine.forks[1]).toMatch(/Already listed as assumptions.*The pane should refresh after every reply/)
})

test('subagent turns do not refresh, and auto off stops refreshing', async ($, on) => {
  const clock = mock.clock(on)
  const engine = engineBeneath(on, REPLY)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  await $.turn.complete(turn('agent-1'))
  await clock.advance(5)
  expect(engine.forks.length).toBe(0)

  await ui.press({ key: 'auto' })
  expect(await ui.find({ key: 'auto', text: /auto off/ })).toBeDefined()
  await $.turn.complete(turn())
  await clock.advance(5)
  expect(engine.forks.length).toBe(0)

  await ui.press({ key: 'refresh' })
  expect(engine.forks.length).toBe(1)
})

test('a reply that is not JSON marks the refresh failed', async ($, on) => {
  const clock = mock.clock(on)
  engineBeneath(on, 'Sorry, nothing comes to mind.')
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  await $.turn.complete(turn())
  await clock.advance(5)
  expect(await ui.find({ text: /refresh failed/ })).toBeDefined()
})
