const bubble = require('../utils/bubble')
const { ulid } = require('ulid')
const EventEmitter = require('eventemitter3')
const parseEvent = require('../utils/parseEvent')
const waterfall = require('../utils/asyncWaterfall')
const handlerWrapper = require('../utils/handlerWrapper')

class Listener {
  constructor (remit, opts, ...handlers) {
    this._remit = remit
    this._emitter = new EventEmitter()

    let parsedOpts = {}

    if (typeof opts === 'string') {
      parsedOpts.event = opts
    } else {
      parsedOpts = opts
    }

    if (!parsedOpts.event) {
      throw new Error('No/invalid event specified when creating an endpoint')
    }

    this.options(parsedOpts)

    if (handlers.length) {
      this.handler(...handlers)
    }
  }

  handler (...fns) {
    this._handler = waterfall(...fns.map(handlerWrapper))

    return this
  }

  on (...args) {
    // should we warn/block users when they try
    // to listen to an event that doesn't exist?
    this._emitter.on(...args)

    return this
  }

  options (opts = {}) {
    const event = opts.event || this._options.event
    this._remit._eventCounters[event] = this._remit._eventCounters[event] || 0

    opts.queue = opts.queue || `${opts.event || this._options.event}:l:${this._remit._options.name}:${++this._remit._eventCounters[event]}`
    opts.subscribe = Boolean(opts.subscribe)

    this._options = Object.assign({}, this._options || {}, opts)

    return this
  }

  start () {
    if (this._started) {
      return this._started
    }

    if (!this._handler) {
      throw new Error('Trying to boot listener with no handler')
    }

    this._started = this._setup(this._options)

    return this._started
  }

  pause (cold) {
    if (!this._started) {
      return Promise.resolve(this)
    }

    if (this._paused) {
      if (this._resuming) {
        console.warn('Tried to pause listener whilst busy resuming')
      }

      return this._paused
    }

    this._paused = new Promise((resolve, reject) => {
      const ops = [this._consumer.cancel(this._consumerTag)]

      if (cold) {
        // cold pause requested, so let's push all messages
        // back in to the queue rather than handling them
        this._cold = true
        ops.push(this._consumer.recover())
      }

      return Promise.all(ops)
        .then(() => resolve(this))
        .catch(reject)
    })

    return this._paused
  }

  resume () {
    if (this._resuming) return this._resuming
    if (!this._started) return this.start()
    if (!this._starting && !this._paused) return Promise.resolve(this)

    this._resuming = new Promise(async (resolve, reject) => {
      const shouldSubscribe = this._options.subscribe
      const noAck = this._options.noAck !== undefined ? this._options.noAck : shouldSubscribe
      let consumeResult

      try {
        consumeResult = await this._consumer.consume(
          this._consumerQueueName,
          bubble.bind(this._incoming.bind(this)),
          {
            noAck: noAck,
            exclusive: shouldSubscribe
          }
        )
      } catch (e) {
        delete this._resuming

        return reject(e)
      }

      this._consumerTag = consumeResult.consumerTag
      delete this._resuming
      delete this._paused
      delete this._cold

      return resolve(this)
    })

    return this._resuming
  }

  async _incoming (message) {
    if (!message) {
      await this._remit.handleError(new Error('Consumer cancelled unexpectedly; this was most probably done via RabbitMQ\'s management panel'))
    }

    try {
      var data = JSON.parse(message.content.toString())
    } catch (e) {
      // if this fails, let's just nack the message and leave
      if(!this._options.subscribe) {
        this._consumer.nack(message)
      }

      return
    }

    if (message.properties.headers) {
      bubble.set('originId', message.properties.headers.originId)
      if (!bubble.get('bubbleId')) bubble.set('bubbleId', ulid())
    }

    const event = parseEvent(message.properties, message.fields, data, {
      flowType: 'entry',
      isReceiver: true
    })

    const resultOp = this._handler(event)

    try {
      this._emitter.emit('data', event)
    } catch (e) {
      console.error(e)
    }

    await resultOp

    // if a cold pause has been requested, don't process this
    if (this._cold) return

    const noAck = this._options.noAck !== undefined ? this._options.noAck : this._options.subscribe
    if(!noAck) {
      this._consumer.ack(message)
    }
  }

  async _setup ({ queue, event, prefetch = 48, subscribe }) {
    this._starting = true

    try {
      const worker = await this._remit._workers.acquire()
      let ok

      try {
        ok = await worker.assertQueue(subscribe ? '' : queue, {
          exclusive: subscribe,
          durable: !subscribe,
          autoDelete: subscribe,
          maxPriority: this._remit?._x_priority || 5
        })

        this._remit._workers.release(worker)
      } catch (e) {
        delete this._starting
        this._remit._workers.destroy(worker)
        throw e
      }

      this._consumerQueueName = ok.queue
      const connection = await this._remit._connection
      this._consumer = await connection.createChannel()
      this._consumer.on('error', error => this._remit.handleError(error))
      this._consumer.on('close', () => {
          this._remit.handleError(new Error('Consumer died - this is most likely due to the RabbitMQ connection dying'))
      })

      if (prefetch > 0) {
        this._consumer.prefetch(prefetch, true)
      }

      await this._consumer.bindQueue(
        this._consumerQueueName,
        this._remit._exchange,
        event
      )

      await this.resume()
      delete this._starting

      return this
    } catch (e) {
      delete this._starting
      await this._remit.handleError(e)
    }
  }
}

module.exports = Listener
