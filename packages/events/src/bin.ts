import { spawn, type ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createStopHandler, main } from './cli.js'

const write = (stream: NodeJS.WriteStream) => (text: string) =>
  new Promise<void>((resolve) => {
    stream.write(text, () => resolve())
  })

const controller = new AbortController()
const stopOnSignal = createStopHandler({
  stop: () => controller.abort(),
  exit: (code) => process.exit(code),
})

// With --watch, the worker runs under `node --watch`, which relays the
// signals it receives to the worker. The signals sent to this process only
// (kill, the stop button of an IDE) are forwarded to it: the worker ignores
// the repeats of a signal also sent by the terminal.
let watched: ChildProcess | undefined
const onSignal = (signal: NodeJS.Signals) => {
  if (watched) watched.kill(signal)
  else stopOnSignal()
}
process.on('SIGINT', onSignal)
process.on('SIGTERM', onSignal)

const code = await main(process.argv.slice(2), {
  cwd: process.cwd(),
  stdout: write(process.stdout),
  stderr: write(process.stderr),
  signal: controller.signal,
  watch: (args) =>
    new Promise((resolve) => {
      // node --watch restarts the command when a loaded file changes.
      watched = spawn(
        process.execPath,
        ['--watch', fileURLToPath(import.meta.url), ...args],
        { stdio: 'inherit' }
      )
      watched.on('exit', (exitCode) => resolve(exitCode ?? 0))
    }),
})

process.exit(code)
