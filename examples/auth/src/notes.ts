import { randomUUID } from 'node:crypto'

export interface Note {
  id: string
  ownerId: string
  text: string
  createdAt: string
}

/** In-memory notes, to replace with your database. */
export const createNoteStore = () => {
  const notes = new Map<string, Note>()

  return {
    listByOwner: async (ownerId: string) =>
      [...notes.values()].filter((note) => note.ownerId === ownerId),
    get: async (id: string) => notes.get(id),
    create: async (ownerId: string, text: string): Promise<Note> => {
      const note: Note = {
        id: randomUUID(),
        ownerId,
        text,
        createdAt: new Date().toISOString(),
      }
      notes.set(note.id, note)
      return note
    },
  }
}

export type NoteStore = ReturnType<typeof createNoteStore>
