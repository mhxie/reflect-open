import { describe, expect, it } from 'vitest'
import { parse as parseYaml } from 'yaml'
import { splitFrontmatter } from '../markdown/frontmatter.ts'
import {
  dropEchoRepeats,
  ECHO_MIN_WEIGHT,
  echoScore,
  formatClock,
  recordingIdentity,
  recordingTitle,
  mergeTurns,
  renderRecordingTranscript,
  textWeight,
  type RecordingSegment,
  type RecordingSpeaker,
  type RecordingNoteInput,
} from './transcript.ts'

function segment(
  speaker: RecordingSpeaker,
  startMs: number,
  endMs: number,
  text: string,
): RecordingSegment {
  return { startMs, endMs, speaker, text }
}

function frontmatterOf(source: string): Record<string, unknown> {
  const { raw } = splitFrontmatter(source)
  const parsed: unknown = parseYaml(raw ?? '')
  expect(parsed).toBeTypeOf('object')
  return Object.fromEntries(Object.entries(parsed ?? {}))
}

describe('echoScore', () => {
  it('measures how much of Me appears in order inside Them, Chinese included', () => {
    expect(echoScore('下周三之前', '我们下周三之前要交方案')).toBeGreaterThan(0.9)
    expect(echoScore('好的没问题', '我们下周三之前要交方案')).toBeLessThan(0.3)
  })

  it('ignores case, spacing, and punctuation', () => {
    expect(echoScore('Need the BUDGET, numbers!', 'we need the budget numbers by friday')).toBe(1)
  })

  it('is 0 when either side has no letters or digits', () => {
    expect(echoScore('...', 'anything')).toBe(0)
    expect(echoScore('hello', '')).toBe(0)
  })

  it('compares code points, not UTF-16 units', () => {
    // Both ideographs share a high surrogate; per unit they would half match.
    expect(echoScore('𠀁', '𠀀')).toBe(0)
  })
})

describe('textWeight', () => {
  it('counts letters and digits, ignoring spaces and punctuation', () => {
    expect(textWeight('Yes, 42!')).toBe(5)
  })

  it('weighs East Asian wide characters three times', () => {
    expect(textWeight('可以。')).toBe(6)
    expect(textWeight('下周三之前要交')).toBe(21)
    expect(textWeight('こんにちは')).toBe(15)
    expect(textWeight('안녕')).toBe(6)
    expect(textWeight('ＡＢ')).toBe(6)
  })

  it('puts the echo floor at about three words or four CJK characters', () => {
    expect(textWeight('the budget numbers')).toBeGreaterThanOrEqual(ECHO_MIN_WEIGHT)
    expect(textWeight('下周三之')).toBe(ECHO_MIN_WEIGHT)
    expect(textWeight('下周三')).toBeLessThan(ECHO_MIN_WEIGHT)
  })
})

describe('dropEchoRepeats', () => {
  const them = [
    segment('them', 10_000, 14_000, 'We need the budget numbers by Friday, can you send them?'),
  ]

  it('drops a restatement of nearby Them speech and keeps real replies', () => {
    const me = [
      segment('me', 10_300, 13_900, 'need the budget numbers by Friday'),
      segment('me', 15_000, 16_500, "Yes, I'll send them tonight."),
    ]
    expect(dropEchoRepeats(me, them).map((kept) => kept.startMs)).toEqual([15_000])
  })

  it('keeps unrelated Me speech that overlaps Them', () => {
    const me = [segment('me', 11_000, 13_000, 'Let me pull up the quarterly roadmap first.')]
    expect(dropEchoRepeats(me, them)).toEqual(me)
  })

  it('keeps a restatement outside the slack window', () => {
    const late = segment('me', 16_001, 18_000, 'need the budget numbers by Friday')
    const near = segment('me', 15_999, 18_000, 'need the budget numbers by Friday')
    expect(dropEchoRepeats([late, near], them)).toEqual([late])
    expect(dropEchoRepeats([near], them, { slackMs: 0 })).toEqual([near])
  })

  it('never drops short replies, even when Them says the same words', () => {
    const question = [
      segment('them', 10_000, 14_000, 'Can you send them now, or are you sure it can wait? 可以吗'),
    ]
    const replies = ['No.', 'Yes.', 'Sure.', 'Right.', '可以。'].map((reply) =>
      segment('me', 14_200, 14_800, reply),
    )
    expect(dropEchoRepeats(replies, question)).toEqual(replies)
  })

  it('drops a CJK restatement heavy enough to judge', () => {
    const echo = segment('me', 10_500, 13_500, '下周三之前要交')
    expect(
      dropEchoRepeats([echo], [segment('them', 10_000, 14_000, '我们下周三之前要交方案')]),
    ).toEqual([])
  })

  it('honors a custom threshold and keeps input order', () => {
    const me = [
      segment('me', 13_000, 14_000, 'need the budget numbers by Friday'),
      segment('me', 10_300, 13_000, 'the budget numbers by Friday'),
    ]
    expect(dropEchoRepeats(me, them, { threshold: 1.01 })).toEqual(me)
  })
})

describe('mergeTurns', () => {
  it('joins same-speaker segments into chronological turns', () => {
    const turns = mergeTurns([
      segment('them', 5_000, 6_000, 'Sounds good.'),
      segment('me', 0, 2_000, "Let's start"),
      segment('me', 2_500, 4_000, 'with the roadmap.'),
      segment('me', 9_000, 10_000, '我来跟进'),
      segment('me', 10_200, 11_000, '这个问题'),
    ])
    expect(turns).toEqual([
      segment('me', 0, 4_000, "Let's start with the roadmap."),
      segment('them', 5_000, 6_000, 'Sounds good.'),
      segment('me', 9_000, 11_000, '我来跟进这个问题'),
    ])
  })

  it('joins at exactly the gap and splits beyond it', () => {
    const atGap = mergeTurns([segment('me', 0, 1_000, 'One.'), segment('me', 2_500, 3_000, 'Two.')])
    expect(atGap.map((turn) => turn.text)).toEqual(['One. Two.'])
    const pastGap = mergeTurns([
      segment('me', 0, 1_000, 'One.'),
      segment('me', 2_501, 3_000, 'Two.'),
    ])
    expect(pastGap).toHaveLength(2)
    expect(
      mergeTurns([segment('me', 0, 1_000, 'One.'), segment('me', 4_000, 5_000, 'Two.')], 5_000),
    ).toHaveLength(1)
  })

  it('never joins across speakers', () => {
    const turns = mergeTurns([
      segment('me', 0, 1_000, 'Hi.'),
      segment('them', 1_100, 2_000, 'Hello.'),
      segment('me', 2_100, 3_000, 'Ready?'),
    ])
    expect(turns.map((turn) => turn.speaker)).toEqual(['me', 'them', 'me'])
  })

  it('puts Me first when both channels start together', () => {
    const turns = mergeTurns([segment('them', 0, 1_000, 'Hello.'), segment('me', 0, 1_000, 'Hi.')])
    expect(turns.map((turn) => turn.speaker)).toEqual(['me', 'them'])
  })

  it('adds a space only between ASCII edges', () => {
    const turns = mergeTurns([
      segment('me', 0, 1_000, 'OK'),
      segment('me', 1_100, 2_000, '好的'),
      segment('me', 2_100, 3_000, 'thanks'),
    ])
    expect(turns.map((turn) => turn.text)).toEqual(['OK好的thanks'])
  })

  it('keeps the later end and leaves the input untouched', () => {
    const outer = segment('me', 0, 5_000, 'Long one,')
    const inner = segment('me', 1_000, 2_000, 'short one.')
    expect(mergeTurns([outer, inner])).toEqual([segment('me', 0, 5_000, 'Long one, short one.')])
    expect(outer).toEqual(segment('me', 0, 5_000, 'Long one,'))
  })
})

describe('formatClock', () => {
  it('formats HH:MM:SS, flooring partial seconds', () => {
    expect(formatClock(0)).toBe('00:00:00')
    expect(formatClock(3_725_000)).toBe('01:02:05')
    expect(formatClock(3_726_999)).toBe('01:02:06')
    expect(formatClock(100 * 3_600_000)).toBe('100:00:00')
  })
})

describe('recordingIdentity', () => {
  it('derives names from local time', () => {
    expect(recordingIdentity(new Date(2026, 6, 1, 9, 5, 7))).toEqual({
      base: 'recording-2026-07-01-090507',
      date: '2026-07-01',
      time: '09:05',
      notePath: 'inbox/recordings/recording-2026-07-01-090507.md',
    })
  })

  it('keeps a late-night recording on its local day', () => {
    const identity = recordingIdentity(new Date(2026, 11, 31, 23, 59, 59))
    expect(identity.base).toBe('recording-2026-12-31-235959')
    expect(identity.time).toBe('23:59')
  })
})

describe('recordingTitle', () => {
  const identity = recordingIdentity(new Date(2026, 6, 1, 9, 5, 7))

  it('names the transcript after the matched event', () => {
    expect(recordingTitle(identity, ' Weekly sync ', 'Hello everyone.')).toBe(
      'Weekly sync transcript 2026-07-01',
    )
  })

  it('titles a memo from its first words, or its start time when silent', () => {
    expect(recordingTitle(identity, null, 'remember to call the bank. then lunch')).toBe(
      'Remember to call the bank',
    )
    expect(recordingTitle(identity, '   ', '')).toBe('Recording 2026-07-01 09:05')
  })
})

describe('renderRecordingTranscript', () => {
  const identity = recordingIdentity(new Date(2026, 6, 1, 9, 5, 7))

  function noteInput(overrides: Partial<RecordingNoteInput> = {}): RecordingNoteInput {
    return {
      identity,
      title: 'Meeting 2026-07-01 09:05',
      durationMs: 3_726_000,
      model: 'whisper-large-v3-turbo',
      audioPath: '/recordings/recording-2026-07-01-090507',
      eventTitle: null,
      attendees: [],
      warnings: [],
      turns: [],
      ...overrides,
    }
  }

  it('renders frontmatter, the title, and one paragraph per turn', () => {
    const source = renderRecordingTranscript(
      noteInput({
        title: 'Weekly sync transcript 2026-07-01',
        eventTitle: 'Weekly sync',
        attendees: ['Ada Lovelace', 'Grace Hopper'],
        warnings: ['system audio was silent'],
        turns: [
          segment('me', 3_725_000, 3_726_000, 'Hi.'),
          segment('them', 3_726_500, 3_727_000, '你好。'),
        ],
      }),
    )
    expect(source).toBe(
      [
        '---',
        'aliases:',
        '  - recording-2026-07-01-090507',
        'source: reflect-recording',
        'recorded: 2026-07-01 09:05',
        'duration: 01:02:06',
        'model: whisper-large-v3-turbo',
        'audio: /recordings/recording-2026-07-01-090507',
        'event: Weekly sync',
        'attendees:',
        '  - Ada Lovelace',
        '  - Grace Hopper',
        'speakers: Me = microphone, Them = system audio',
        'warnings:',
        '  - system audio was silent',
        '---',
        '',
        '# Weekly sync transcript 2026-07-01',
        '',
        '## Transcript',
        '',
        '**[01:02:05] Me:** Hi.',
        '',
        '**[01:02:06] Them:** 你好。',
        '',
      ].join('\n'),
    )
  })

  it('omits empty optional keys and marks an empty transcript', () => {
    const source = renderRecordingTranscript(noteInput())
    expect(Object.keys(frontmatterOf(source))).toEqual([
      'aliases',
      'source',
      'recorded',
      'duration',
      'model',
      'audio',
    ])
    expect(
      source.endsWith(
        '---\n\n# Meeting 2026-07-01 09:05\n\n## Transcript\n\n_No speech detected._\n',
      ),
    ).toBe(true)
  })

  it('renders a one-sided recording as plain paragraphs', () => {
    const source = renderRecordingTranscript(
      noteInput({
        title: 'Remember to call the bank',
        turns: [
          segment('me', 0, 2_000, 'Remember to call the bank.'),
          segment('me', 9_000, 11_000, 'Then lunch with Ada.'),
        ],
      }),
    )
    expect(source).toContain(
      '## Transcript\n\nRemember to call the bank.\n\nThen lunch with Ada.\n',
    )
    expect(frontmatterOf(source)).not.toHaveProperty('speakers')
  })

  it('round-trips YAML-special characters through the frontmatter', () => {
    const tricky = 'Q3 review: #budget "draft" [x]'
    const source = renderRecordingTranscript(
      noteInput({
        title: `${tricky} transcript 2026-07-01`,
        eventTitle: tricky,
        attendees: ['- Ada', "O'Brien: lead"],
        warnings: ['mic: {muted}'],
      }),
    )
    expect(source).toContain(`\n# ${tricky} transcript 2026-07-01\n`)
    expect(frontmatterOf(source)).toEqual({
      aliases: ['recording-2026-07-01-090507'],
      source: 'reflect-recording',
      recorded: '2026-07-01 09:05',
      duration: '01:02:06',
      model: 'whisper-large-v3-turbo',
      audio: '/recordings/recording-2026-07-01-090507',
      event: tricky,
      attendees: ['- Ada', "O'Brien: lead"],
      warnings: ['mic: {muted}'],
    })
  })

  it('ends with exactly one trailing newline', () => {
    const source = renderRecordingTranscript(noteInput({ turns: [segment('me', 0, 1_000, 'Hi.')] }))
    expect(source.endsWith('Hi.\n')).toBe(true)
    expect(source.endsWith('\n\n')).toBe(false)
  })
})
