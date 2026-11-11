import { createHash, randomUUID } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

interface StoredMessage {
  id: string
  body: string
  attributes: Record<string, { DataType: string; StringValue?: string }>
  receiveCount: number
  visibleAt: number
  receipt: string | undefined
}

interface Queue {
  messages: StoredMessage[]
  redrivePolicy: string | undefined
}

const md5 = (text: string) => createHash('md5').update(text).digest('hex')

/**
 * In-memory SQS server speaking the AWS JSON 1.0 protocol of the SDK:
 * SendMessage(Batch), ReceiveMessage (long polling), DeleteMessageBatch,
 * ChangeMessageVisibility, GetQueueAttributes.
 */
export const startSqsServer = async () => {
  const queues = new Map<string, Queue>()
  const calls: { action: string; input: Record<string, unknown> }[] = []
  const failures = new Map<
    string,
    { status: number; type: string; message: string; queueUrl?: string }
  >()

  const queueOf = (url: unknown) => {
    const key = new URL(String(url)).pathname
    let queue = queues.get(key)
    if (!queue) {
      queue = { messages: [], redrivePolicy: undefined }
      queues.set(key, queue)
    }
    return queue
  }

  const store = (
    queue: Queue,
    body: string,
    attributes: StoredMessage['attributes'] = {},
    delaySeconds = 0
  ) => {
    const message: StoredMessage = {
      id: randomUUID(),
      body,
      attributes,
      receiveCount: 0,
      visibleAt: Date.now() + delaySeconds * 1000,
      receipt: undefined,
    }
    queue.messages.push(message)
    return message
  }

  const findByReceipt = (queue: Queue, receipt: unknown) =>
    queue.messages.find((message) => message.receipt === receipt)

  const receive = (queue: Queue, max: number, visibility: number) => {
    const now = Date.now()
    return queue.messages
      .filter((message) => message.visibleAt <= now)
      .slice(0, max)
      .map((message) => {
        message.receiveCount += 1
        message.receipt = randomUUID()
        message.visibleAt = now + visibility * 1000
        return message
      })
  }

  const actions: Record<
    string,
    (input: Record<string, unknown>, closed: () => boolean) => Promise<unknown>
  > = {
    SendMessageBatch: async (input) => {
      const queue = queueOf(input.QueueUrl)
      const entries = input.Entries as {
        Id: string
        MessageBody: string
        DelaySeconds?: number
        MessageAttributes?: StoredMessage['attributes']
      }[]
      return {
        Successful: entries.map((entry) => {
          const message = store(
            queue,
            entry.MessageBody,
            entry.MessageAttributes,
            entry.DelaySeconds
          )
          return {
            Id: entry.Id,
            MessageId: message.id,
            MD5OfMessageBody: md5(entry.MessageBody),
          }
        }),
        Failed: [],
      }
    },
    SendMessage: async (input) => {
      const message = store(
        queueOf(input.QueueUrl),
        input.MessageBody as string,
        input.MessageAttributes as StoredMessage['attributes']
      )
      return { MessageId: message.id, MD5OfMessageBody: md5(message.body) }
    },
    ReceiveMessage: async (input, closed) => {
      const queue = queueOf(input.QueueUrl)
      const max = (input.MaxNumberOfMessages as number | undefined) ?? 1
      const visibility = (input.VisibilityTimeout as number | undefined) ?? 30
      const deadline =
        Date.now() + ((input.WaitTimeSeconds as number) ?? 0) * 1000
      let messages = receive(queue, max, visibility)
      while (messages.length === 0 && Date.now() < deadline && !closed()) {
        await new Promise((resolve) => setTimeout(resolve, 10))
        messages = receive(queue, max, visibility)
      }
      return {
        Messages: messages.map((message) => ({
          MessageId: message.id,
          ReceiptHandle: message.receipt,
          Body: message.body,
          MD5OfBody: md5(message.body),
          Attributes: { ApproximateReceiveCount: String(message.receiveCount) },
        })),
      }
    },
    DeleteMessageBatch: async (input) => {
      const queue = queueOf(input.QueueUrl)
      const entries = input.Entries as { Id: string; ReceiptHandle: string }[]
      for (const { ReceiptHandle } of entries) {
        queue.messages = queue.messages.filter(
          (message) => message.receipt !== ReceiptHandle
        )
      }
      return { Successful: entries.map(({ Id }) => ({ Id })), Failed: [] }
    },
    ChangeMessageVisibility: async (input) => {
      const message = findByReceipt(
        queueOf(input.QueueUrl),
        input.ReceiptHandle
      )
      if (message) {
        message.visibleAt =
          Date.now() + (input.VisibilityTimeout as number) * 1000
      }
      return {}
    },
    GetQueueAttributes: async (input) => {
      const { redrivePolicy } = queueOf(input.QueueUrl)
      return {
        Attributes: redrivePolicy ? { RedrivePolicy: redrivePolicy } : {},
      }
    },
  }

  const server: Server = createServer((req, res) => {
    let closed = false
    res.on('close', () => {
      closed = true
    })
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      void (async () => {
        const action = String(req.headers['x-amz-target']).replace(
          'AmazonSQS.',
          ''
        )
        const input = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
        calls.push({ action, input })
        const failure = failures.get(action)
        if (
          failure &&
          (failure.queueUrl === undefined ||
            failure.queueUrl === input.QueueUrl)
        ) {
          failures.delete(action)
          res.writeHead(failure.status, {
            'content-type': 'application/x-amz-json-1.0',
          })
          res.end(
            JSON.stringify({
              __type: `com.amazonaws.sqs#${failure.type}`,
              message: failure.message,
            })
          )
          return
        }
        const handler = actions[action]
        if (!handler) {
          res.writeHead(400)
          res.end()
          return
        }
        const output = await handler(input, () => closed)
        if (closed) return
        res.writeHead(200, { 'content-type': 'application/x-amz-json-1.0' })
        res.end(JSON.stringify(output))
      })()
    })
  })
  // Never closes idle connections itself: undici could reuse a connection
  // as the server closes it ("fetch failed", seen on Node.js 22 in CI).
  server.keepAliveTimeout = 0
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

  return {
    url,
    queueUrl: (name: string) => `${url}/123456789012/${name}`,
    queue: (name: string) => queueOf(`${url}/123456789012/${name}`),
    calls,
    /** The next call of this action (on this queue, if given) fails. */
    /** Forgets the failures that no request consumed. */
    reset: () => failures.clear(),
    failNext: (
      action: string,
      type: string,
      message: string,
      status = 400,
      queueUrl?: string
    ) => failures.set(action, { status, type, message, queueUrl }),
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}
