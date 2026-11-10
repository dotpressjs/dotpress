import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { main } from './cli.js'

const write = (stream: NodeJS.WriteStream) => (text: string) =>
  new Promise<void>((resolve) => {
    stream.write(text, () => resolve())
  })

// First SIGINT / SIGTERM: graceful stop. Second one: immediate exit.
const controller = new AbortController()
const onSignal = () => {
  if (controller.signal.aborted) process.exit(130)
  controller.abort()
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
      const child = spawn(
        process.execPath,
        ['--watch', fileURLToPath(import.meta.url), ...args],
        { stdio: 'inherit' }
      )
      child.on('exit', (exitCode) => resolve(exitCode ?? 0))
    }),
})

process.exit(code)
