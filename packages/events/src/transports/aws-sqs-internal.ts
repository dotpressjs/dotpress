// Internals of the SQS transport, tested on their own.

/** URL of the queue of an ARN (`arn:aws:sqs:region:account:name`). */
export const queueUrlOf = (arn: string) => {
  const [, partition, , region, account, name] = arn.split(':')
  if (!partition || !region || !account || !name) return undefined
  const domain = partition === 'aws-cn' ? 'amazonaws.com.cn' : 'amazonaws.com'
  return `https://sqs.${region}.${domain}/${account}/${name}`
}
