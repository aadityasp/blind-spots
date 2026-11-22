import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const USAGE = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

// Listed low stakes first on purpose: the pane must still lead with the risky one.
const ASSUMED = [
  { text: 'Amounts are stored in cents', risk: 2, ask: 'Should amounts really be stored in cents?' },
  {
    text: 'Old invoices are deleted, not archived',
    risk: 5,
    ifWrong: 'customer history is gone for good',
    ask: 'Should old invoices be archived instead of deleted?',
  },
  'Plain strings count as low stakes assumptions',
]

const MISSED = [
  { title: 'Who can see other users invoices?', ask: 'Who should be able to see other users invoices?' },
  { kind: 'risk', title: 'What if an upload fails halfway?', ask: 'What should happen when an upload fails halfway?' },
]

const REPLY = JSON.stringify({ assumptions: ASSUMED, missed: MISSED })

const PANE = {
  plugin: 'blind-spots',
  component: 'Pane',
  requestId: 'blind-spots',
  props: {
    title: 'Blind spots',
    isFocused: false,
    bodyColumns: 40,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

type Refusal = 'no_composer' | 'dialog' | 'unanswered'

function engineBeneath(on: On, first: string) {
  const forks: string[] = []
  const asked: string[] = []
  const state: { reply: string; box: string; refusal?: Refusal } = { reply: first, box: '' }
  on('model.fork', ($, e) => {
    forks.push(e.prompt)
    return { value: { isAnswered: true, text: state.reply, usage: USAGE } }
  })
  on('prompt.read', () => ({ value: { text: state.box, cursor: state.box.length } }))
  on('prompt.fill', ($, e) => {
    if (state.refusal !== undefined) return { isFilled: false, refusal: state.refusal }
    state.box = e.mode === 'append' ? state.box + e.text : e.text
    return { isFilled: true }
  })
  on('prompt.submit', ($, e) => {
    asked.push(e.text)
    return { text: e.text }
  })
  on('turn.complete', ($, e) => ({ text: e.answer }))

  return { forks, asked, state }
}

function turn(agentId?: string) {
  return { answer: 'done', durationMs: 10, isAborted: false, turnId: 't1', reason: 'answer', agentId } as const
}

test('before any reply the pane has a title and says what it will show', async ($, on) => {
  engineBeneath(on, REPLY)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  expect(await ui.find({ text: /BLIND SPOTS/ })).toBeDefined()
  expect(await ui.find({ text: /reads the chat/ })).toBeDefined()
})

test('the riskiest assumption leads, and Add puts each item in the prompt box without sending', async ($, on) => {
  const clock = mock.clock(on)
  const engine = engineBeneath(on, '```json\n' + REPLY + '\n```')
  await $.turn.complete(turn())
  await clock.advance(5)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })

    expect(await ui.find({ text: /Check this first/ })).toBeDefined()
    expect(await ui.find({ text: /Old invoices are deleted, not archived/ })).toBeDefined()
    expect(await ui.find({ text: /If this is wrong: customer history is gone for good/ })).toBeDefined()
    expect(await ui.find({ text: /Claude also decided for you/ })).toBeDefined()
    expect(await ui.find({ text: /Amounts are stored in cents/ })).toBeDefined()
    expect(await ui.find({ text: /Questions you haven't raised yet/ })).toBeDefined()
    expect(await ui.find({ text: /What if an upload fails halfway/ })).toBeDefined()

    engine.state.box = ''
    await ui.press({ key: 'assumed:0' })
    expect(engine.state.box).toBe('Should old invoices be archived instead of deleted?')
    expect(await ui.find({ text: /\(added\)/ })).toBeDefined()
    await ui.press({ key: 'assumed:2' })
    expect(engine.state.box).toMatch(/deleted\?\nYou assumed this, so let's check it: Plain strings/)
    await ui.press({ key: 'spot:1' })
    expect(engine.state.box.split('\n').at(-1)).toBe('What should happen when an upload fails halfway?')
    expect(engine.asked.length).toBe(0)
    await ui.unmount()
  }
})

test('rest are fine settles the others without a message, and restore brings them back', async ($, on) => {
  const clock = mock.clock(on)
  const engine = engineBeneath(on, REPLY)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await $.turn.complete(turn())
  await clock.advance(5)

  await ui.press({ key: 'clear' })
  expect(engine.asked.length).toBe(0)
  expect(await ui.find({ text: /Amounts are stored in cents/ })).toBeUndefined()
  expect(await ui.find({ text: /Old invoices are deleted/ })).toBeDefined()
  expect(await ui.find({ key: 'restore', text: /bring back 4 hidden/ })).toBeDefined()

  await ui.press({ key: 'refresh' })
  await clock.advance(5)
  expect(engine.forks.at(-1)).toMatch(/Settled by the user.*Amounts are stored in cents/)
  expect(await ui.find({ text: /Amounts are stored in cents/ })).toBeUndefined()

  await ui.press({ key: 'restore' })
  await clock.advance(5)
  expect(engine.forks.at(-1)).not.toMatch(/Settled by the user/)
  expect(await ui.find({ text: /Amounts are stored in cents/ })).toBeDefined()
})

test("It's right settles only the lead", async ($, on) => {
  const clock = mock.clock(on)
  const engine = engineBeneath(on, REPLY)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await $.turn.complete(turn())
  await clock.advance(5)

  await ui.press({ key: 'settle:assumed:0' })
  expect(engine.asked.length).toBe(0)
  expect(await ui.find({ text: /Check this first/ })).toBeUndefined()
  expect(await ui.find({ text: /Amounts are stored in cents/ })).toBeDefined()
})

test('depth switches between focused and thorough and scans again', async ($, on) => {
  const clock = mock.clock(on)
  const engine = engineBeneath(on, REPLY)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ key: 'depth', text: /show more/ })).toBeDefined()

  await ui.press({ key: 'depth' })
  await clock.advance(5)
  expect(await ui.find({ key: 'depth', text: /show fewer/ })).toBeDefined()
  expect(engine.forks.at(-1)).toMatch(/at most 6\./)
})

test('a legend at the top explains the dots', async ($, on) => {
  const clock = mock.clock(on)
  engineBeneath(on, REPLY)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await $.turn.complete(turn())
  await clock.advance(5)

  expect(await ui.find({ text: /Dots show what a wrong guess would cost/ })).toBeDefined()
  expect(await ui.find({ text: /●○○○○ small fix/ })).toBeDefined()
  expect(await ui.find({ text: /●●●●● serious harm/ })).toBeDefined()
  expect(await ui.find({ text: /[▲◆✦]/ })).toBeUndefined()
})

test('empty lists read as nothing to flag, not as a failure', async ($, on) => {
  const clock = mock.clock(on)
  engineBeneath(on, '{"assumptions":[],"missed":[]}')
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await $.turn.complete(turn())
  await clock.advance(5)

  expect(await ui.find({ text: /Nothing to check/ })).toBeDefined()
  expect(await ui.find({ text: /couldn't read the chat/ })).toBeUndefined()
})

test('the older bare array reply still fills the questions', async ($, on) => {
  const clock = mock.clock(on)
  engineBeneath(on, JSON.stringify(MISSED))
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await $.turn.complete(turn())
  await clock.advance(5)

  expect(await ui.find({ text: /Who can see other users invoices/ })).toBeDefined()
  expect(await ui.find({ text: /Check this first/ })).toBeUndefined()
})

test('each row reveals the exact sentence Add puts in the prompt on hover', async ($, on) => {
  const clock = mock.clock(on)
  engineBeneath(on, REPLY)
  on('session.version', () => ({ value: { version: '2.1.327', base: '2.1.327' } }))
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await $.turn.complete(turn())
  await clock.advance(5)

  expect(await ui.find({ text: /Adds to your prompt: “Should old invoices be archived instead of deleted\?”/ })).toBeDefined()
  expect(await ui.find({ text: /Adds to your prompt: “Who should be able to see other users invoices\?”/ })).toBeDefined()
})

test('an engine older than hover support draws no preview', async ($, on) => {
  const clock = mock.clock(on)
  engineBeneath(on, REPLY)
  on('session.version', () => ({ value: { version: '2.1.286', base: '2.1.286' } }))
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await $.turn.complete(turn())
  await clock.advance(5)

  expect(await ui.find({ text: /Old invoices are deleted/ })).toBeDefined()
  expect(await ui.find({ text: /Adds to your prompt: “/ })).toBeUndefined()
})

test('subagent turns do not refresh, and auto off stops refreshing', async ($, on) => {
  const clock = mock.clock(on)
  const engine = engineBeneath(on, REPLY)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  await $.turn.complete(turn('agent-1'))
  await clock.advance(5)
  expect(engine.forks.length).toBe(0)

  await ui.press({ key: 'auto' })
  expect(await ui.find({ key: 'auto', text: /auto-check off/ })).toBeDefined()
  await $.turn.complete(turn())
  await clock.advance(5)
  expect(engine.forks.length).toBe(0)

  await ui.press({ key: 'refresh' })
  expect(engine.forks.length).toBe(1)
})

test('a reply that is not JSON says the scan failed and how to retry', async ($, on) => {
  const clock = mock.clock(on)
  engineBeneath(on, 'Sorry, nothing comes to mind.')
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await $.turn.complete(turn())
  await clock.advance(5)

  expect(await ui.find({ text: /couldn't read the chat/ })).toBeDefined()
  expect(await ui.find({ text: /Press r to try again/ })).toBeDefined()
})

test('Add keeps the draft already typed, and never adds the same sentence twice', async ($, on) => {
  const clock = mock.clock(on)
  const engine = engineBeneath(on, REPLY)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await $.turn.complete(turn())
  await clock.advance(5)

  engine.state.box = 'Also rename the table'
  await ui.press({ key: 'spot:0' })
  await ui.press({ key: 'spot:0' })
  expect(engine.state.box).toBe('Also rename the table\nWho should be able to see other users invoices?')
})

// The harness strips a cause a hook writes itself, so only the engine's own
// "dialog" and "no_composer" carry one; a refusal without a cause is tested.
test('a refused fill sends nothing and says to press again', async ($, on) => {
  const clock = mock.clock(on)
  const engine = engineBeneath(on, REPLY)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await $.turn.complete(turn())
  await clock.advance(5)

  engine.state.refusal = 'unanswered'
  await ui.press({ key: 'spot:0' })
  expect(engine.asked.length).toBe(0)
  expect(await ui.find({ text: /press again/ })).toBeDefined()
  expect(await ui.find({ text: /\(added\)/ })).toBeUndefined()

  engine.state.refusal = undefined
  await ui.press({ key: 'spot:0' })
  expect(engine.state.box).toBe('Who should be able to see other users invoices?')
  expect(await ui.find({ text: /press again/ })).toBeUndefined()
})
