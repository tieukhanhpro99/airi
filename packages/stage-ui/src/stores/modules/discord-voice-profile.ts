export interface VoiceUserProfile {
  userId: string
  displayName: string
  addressAs?: string
  notes?: string
  lastSeen: number
}

export interface VoiceTranscriptProfileInput {
  userId: string
  username: string
  displayName?: string
  endedAt: number
}

export interface VoiceProfileLearningResult {
  shouldUpdate: boolean
  addressAs?: string | null
  notes?: string | null
}

const MAX_PROFILE_NOTE_LINES = 12
const MAX_PROFILE_NOTES_CHARS = 1400

function normalizeNoteLine(line: string) {
  return line
    .trim()
    .replace(/^[-*]\s*/, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function noteLinesFromText(text?: string | null) {
  if (!text?.trim())
    return []

  return text
    .split(/\r?\n/)
    .map(normalizeNoteLine)
    .filter(Boolean)
}

function formatNoteLines(lines: string[]) {
  return lines.map(line => `- ${line}`).join('\n')
}

function mergeProfileNotes(existing?: string, learned?: string | null) {
  const seen = new Set<string>()
  const merged: string[] = []

  for (const line of [...noteLinesFromText(existing), ...noteLinesFromText(learned)]) {
    const key = line.toLowerCase()
    if (seen.has(key))
      continue

    seen.add(key)
    merged.push(line)

    if (merged.length >= MAX_PROFILE_NOTE_LINES)
      break
  }

  const formatted = formatNoteLines(merged)
  if (formatted.length <= MAX_PROFILE_NOTES_CHARS)
    return formatted || undefined

  return `${formatted.slice(0, MAX_PROFILE_NOTES_CHARS - 3).trimEnd()}...`
}

export function upsertVoiceProfileFromTranscript(
  profiles: Record<string, VoiceUserProfile>,
  transcript: VoiceTranscriptProfileInput,
) {
  const existing = profiles[transcript.userId]

  return {
    ...profiles,
    [transcript.userId]: {
      userId: transcript.userId,
      displayName: transcript.displayName?.trim() || transcript.username || transcript.userId,
      addressAs: existing?.addressAs,
      notes: existing?.notes,
      lastSeen: transcript.endedAt,
    },
  }
}

export function applyVoiceProfileLearning(
  profile: VoiceUserProfile,
  result: VoiceProfileLearningResult,
): VoiceUserProfile {
  if (!result.shouldUpdate)
    return profile

  const addressAs = result.addressAs?.trim()
  const notes = mergeProfileNotes(profile.notes, result.notes)

  const next: VoiceUserProfile = {
    ...profile,
    addressAs: addressAs || profile.addressAs,
    notes: notes || profile.notes,
  }

  if (next.addressAs === profile.addressAs && next.notes === profile.notes)
    return profile

  return next
}

export function buildVoiceMemoryDirective(enabled: boolean, customPrompt?: string) {
  if (!enabled)
    return ''

  const trimmed = customPrompt?.trim()
  if (trimmed)
    return `[Long-term memory directive: ${trimmed}]`

  return [
    '[Long-term memory directive:',
    'You may use the text_journal tool during Discord voice conversations.',
    'Use text_journal.search when prior user context would help the reply.',
    'Use text_journal.create only for durable memories: stable user preferences, identity details, project context, relationship context, or recurring inside jokes.',
    'Do not store secrets, one-off commands, temporary requests, or sensitive credentials.]',
  ].join(' ')
}
