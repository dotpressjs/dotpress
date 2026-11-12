export interface Note {
  id: string
  text: string
  createdAt: string
}

export type NoteStore = ReturnType<typeof createNoteStore>

/**
 * In-memory note store. Replace it with your database: on AWS Lambda, each
 * execution environment has its own memory.
 */
export const createNoteStore = () => {
  const notes = new Map<string, Note>()

  return {
    async list(): Promise<Note[]> {
      return [...notes.values()]
    },

    async get(id: string): Promise<Note | undefined> {
      return notes.get(id)
    },

    async create(text: string): Promise<Note> {
      const note: Note = {
        id: crypto.randomUUID(),
        text,
        createdAt: new Date().toISOString(),
      }
      notes.set(note.id, note)
      return note
    },
  }
}
