/* global process, setInterval, clearInterval, setTimeout -- Node.js */
// A worker entry without dependencies: the command only checks its shape.
const globals = globalThis

const entry = {
  worker: {
    listeners: ['fixture'],
    handle: async () => ({ status: 'success' }),
  },
  source: {
    kind: 'fixture',
    consume: async (worker, { signal, logger }) => {
      globals.fixtureResult = await worker.handle('{}')
      logger.info({ step: 'consuming' }, 'Fixture source consuming')
      await new Promise((resolve) => {
        if (signal.aborted) resolve()
        signal.addEventListener('abort', resolve, { once: true })
      })
    },
  },
}

export default entry

export const factory = async () => entry

export const failing = {
  worker: entry.worker,
  source: {
    kind: 'failing',
    consume: async () => {
      throw new Error('connection refused')
    },
  },
}

export const failingWithText = {
  worker: entry.worker,
  source: {
    kind: 'failing',
    consume: async () => {
      throw 'connection refused'
    },
  },
}

export const withLogger = {
  ...entry,
  logger: {
    info: () => {
      globals.fixtureLogged = true
    },
    warn: () => {},
    error: () => {},
  },
}

export const invalid = { worker: entry.worker }

// Messages in progress when stopped: the source resolves
// FIXTURE_STOP_DELAY milliseconds after the stop request.
export const slowStop = {
  worker: entry.worker,
  source: {
    kind: 'slow-stop',
    consume: async (worker, { signal, logger }) => {
      logger.info({ pid: process.pid }, 'Fixture source consuming')
      // Keeps the process alive, like the connection of a real source.
      const alive = setInterval(() => {}, 60_000)
      await new Promise((resolve) => {
        signal.addEventListener('abort', resolve, { once: true })
      })
      clearInterval(alive)
      logger.info({}, 'Fixture source stopping')
      await new Promise((resolve) =>
        setTimeout(resolve, Number(process.env.FIXTURE_STOP_DELAY ?? 0))
      )
    },
  },
}
