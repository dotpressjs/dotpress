import { main } from './cli.js'

const write = (stream: NodeJS.WriteStream) => (text: string) =>
  new Promise<void>((resolve) => {
    stream.write(text, () => resolve())
  })

const code = await main(process.argv.slice(2), {
  cwd: process.cwd(),
  stdout: write(process.stdout),
  stderr: write(process.stderr),
})

// Explicit exit: connections left open by the app must not keep the
// process alive. The output is flushed above.
process.exit(code)
