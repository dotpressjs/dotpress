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
  type EnvelopeLike,
  type ExpectEventOptions,
} from './events.js'

export {
  expectMailSent,
  expectNoMailSent,
  type ExpectedAddresses,
  type ExpectMailOptions,
  type MailCriteria,
  type MailOutbox,
  type SentMail,
  type SentMailAddress,
} from './mail.js'
