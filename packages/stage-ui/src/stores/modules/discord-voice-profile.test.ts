import { describe, expect, it } from 'vitest'

import {
  applyVoiceProfileLearning,
  buildVoiceMemoryDirective,
  upsertVoiceProfileFromTranscript,
} from './discord-voice-profile'

describe('discord voice profile helpers', () => {
  it('touches a profile from a voice transcript without losing manual notes', () => {
    const profiles = {
      user_1: {
        userId: 'user_1',
        displayName: 'Old Name',
        addressAs: 'Khanh',
        notes: '- likes Vietnamese replies',
        lastSeen: 100,
      },
    }

    const next = upsertVoiceProfileFromTranscript(profiles, {
      userId: 'user_1',
      username: 'tieukhanhpro99',
      displayName: 'Khanh Pro',
      endedAt: 200,
    })

    expect(next.user_1).toEqual({
      userId: 'user_1',
      displayName: 'Khanh Pro',
      addressAs: 'Khanh',
      notes: '- likes Vietnamese replies',
      lastSeen: 200,
    })
  })

  it('appends learned notes while trimming bullets and removing duplicates', () => {
    const profile = {
      userId: 'user_1',
      displayName: 'Khanh',
      notes: '- prefers Vietnamese replies\n- uses Discord as the main surface',
      lastSeen: 100,
    }

    const next = applyVoiceProfileLearning(profile, {
      shouldUpdate: true,
      addressAs: 'anh Khanh',
      notes: '- uses Discord as the main surface\n- is working on an AIRI fork',
    })

    expect(next.addressAs).toBe('anh Khanh')
    expect(next.notes).toBe([
      '- prefers Vietnamese replies',
      '- uses Discord as the main surface',
      '- is working on an AIRI fork',
    ].join('\n'))
  })

  it('ignores empty or disabled learning results', () => {
    const profile = {
      userId: 'user_1',
      displayName: 'Khanh',
      addressAs: 'Khanh',
      notes: '- existing note',
      lastSeen: 100,
    }

    expect(applyVoiceProfileLearning(profile, {
      shouldUpdate: false,
      addressAs: 'ignored',
      notes: '- ignored note',
    })).toEqual(profile)

    expect(applyVoiceProfileLearning(profile, {
      shouldUpdate: true,
      addressAs: '   ',
      notes: '   ',
    })).toEqual(profile)
  })

  it('builds the voice memory directive only when enabled', () => {
    expect(buildVoiceMemoryDirective(false, 'custom')).toBe('')
    expect(buildVoiceMemoryDirective(true, '')).toContain('text_journal')
    expect(buildVoiceMemoryDirective(true, 'Use memory carefully.')).toContain('Use memory carefully.')
  })
})
