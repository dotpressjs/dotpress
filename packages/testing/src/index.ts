export { ExpectationError } from './assertions.js'

export type { TestTarget } from './target.js'

export {
  createLambdaTarget,
  fromLambdaResult,
  toLambdaEvent,
  type LambdaEventFormat,
  type LambdaTargetOptions,
  type LambdaTestHandler,
} from './lambda.js'

export {
  createMemoryLogger,
  type LogEntry,
  type MemoryLogger,
} from './logger.js'

export {
  createTestApp,
  memoryAdapter,
  type MemoryAdapter,
  type MemoryAdapterOptions,
  type TestApp,
  type TestAppOptions,
} from './memory.js'

export {
  expectEventEmitted,
  expectEventNotEmitted,
  type Emission,
  type EmissionSource,
  type ExpectEventOptions,
} from './events.js'

export {
  expectMailSent,
  expectNoMailSent,
  type ExpectMailOptions,
  type MailCriteria,
  type MailOutbox,
  type SentMail,
} from './mail.js'
