const CallableInstance = require('callable-instance')
const EventEmitter = require('eventemitter3')
const genUuid = require('../utils/genUuid')
const parseEvent = require('../utils/parseEvent')
const getStackLine = require('../utils/getStackLine')
const bubble = require('../utils/bubble')
const ms = require('ms')

class Request extends CallableInstance {
  constructor (remit, opts = {}) {
    super('send')

    this._remit = remit

    this._emitter = new EventEmitter()
    this._remit._emitter = this._remit._emitter || new EventEmitter()

    this._timers = {}

    let parsedOpts = {}

    if (typeof opts === 'string') {
      parsedOpts.event = opts
    } else {
      parsedOpts = opts
    }

    if (!parsedOpts.event) {
      throw new Error('No/invalid event specified when creating a request')
    }

    this.options(parsedOpts)

    this._ready = this._setup(this._options)
  }

  on (...args) {
    // should we warn/block users when they try
    // to listen to an event that doesn't exist?
    this._emitter.on(...args)

    return this
  }

  fallback (data) {
    if (arguments.length === 0) {
      delete this._fallback
    } else {
      this._fallback = data
    }

    return this
  }

  options (opts = {}) {
    this._options = this._generateOptions(opts)

    return this
  }

  ready () {
    return this._ready
  }

  send (...args) {
    while (args.length < this._send.length) {
      args.push(undefined)
    }

    if (!bubble.active) args[2] = true

    return bubble.active
      ? this._send(...args)
      : bubble.runAndReturn(this._send.bind(this, ...args))
  }

  async _send (data = null, opts = {}, extendedCapture = false) {
    // parse the callsites here, as after the `await`
    // we'll get a different stack
    const callsites = getStackLine.capture(extendedCapture)
    await this._ready
    const now = new Date().getTime()
    const parsedOptions = this._generateOptions(opts)
    parsedOptions.priority = this._remit?._x_priority || 0
    const trace = getStackLine.parse(callsites)
    const messageId = genUuid()

    const originId = bubble.get('originId') || messageId
    const bubbleId = bubble.get('bubbleId') || null

    const message = {
      mandatory: false,
      messageId: messageId,
      appId: this._remit._options.name,
      timestamp: now,
      headers: {
        trace: trace,
        originId: originId,
        bubbleId: bubbleId,
        fromBubbleId: bubbleId
      },
      correlationId: messageId,
      replyTo: 'amq.rabbitmq.reply-to'
    }

    if (parsedOptions.priority) {
      if (parsedOptions.priority > 10 || parsedOptions.priority < 0) {
        throw new Error(`Invalid priority "${parsedOptions.priority}" when making request`)
      }

      message.priority = parsedOptions.priority
    }

    let timeout = 30000
    let givenTimeout = Number(parsedOptions.timeout)
    if (!isNaN(givenTimeout)) timeout = givenTimeout

    if (timeout) message.expiration = timeout

    let parsedData
    let eventData = data

    // coerce data to `null` if undefined or an unparsable pure JS property.
    parsedData = JSON.stringify(data)

    if (typeof parsedData === 'undefined') {
      console.warn('[WARN] Remit request sent with unparsable JSON; this could be a function or an undefined variable. Data instead set to NULL.')

      // string here coerces to actual NULL once JSON.parse is performed
      parsedData = 'null'
      eventData = null
    }

    this._channel.publish(
      this._remit._exchange,
      parsedOptions.event,
      Buffer.from(parsedData),
      message
    )

    const event = parseEvent(message, {
      routingKey: parsedOptions.event
    }, eventData, {
      flowType: 'exit'
    })

    this._emitter.emit('sent', event)

    if (timeout) {
      this._setTimer(messageId, timeout, event)
    }

    return this._waitForResult(messageId)
  }

  _generateOptions (opts = {}) {
    const parsedOpts = {}

    if (opts.hasOwnProperty('timeout')) {
      parsedOpts.timeout = (typeof opts.timeout === 'string')
        ? ms(opts.timeout)
        : opts.timeout
    }

    return Object.assign({}, this._options || {}, opts, parsedOpts)
  }

  _setTimer (messageId, time, event) {
    this._timers[messageId] = setTimeout(() => {
      this._remit._emitter.emit(`timeout-${messageId}`, {}, {
        event: event,
        code: 'request_timedout',
        message: `Request timed out after no response for ${time}ms`
      })
    }, time)
  }

  async _setup (opts = {}) {
    try {
      if (!this._remit._publishChannels[opts.event]) {
        const publishChannelP = this._remit._publishChannels[opts.event] = (async () => {
          const connection = await this._remit._connection
          return connection.createChannel()
        })()

        const publishChannel = await publishChannelP
        publishChannel.on('error', error => this._remit.handleError(error))
        publishChannel.on('close', () => {
            this._remit.handleError(new Error('Reply consumer died - this is most likely due to the RabbitMQ connection dying'))
        })

        await publishChannel.consume(
          'amq.rabbitmq.reply-to',
          bubble.bind(this._remit._incoming.bind(this._remit)),
          {
            noAck: true,
            exclusive: true
          }
        )
      }

      this._channel = await this._remit._publishChannels[opts.event]

      return this
    } catch (e) {
      await this._remit.handleError(e)
    }
  }

  _waitForResult (messageId) {
    const types = ['data', 'timeout']

    return new Promise((resolve, reject) => {
      const cleanUp = (message, err, result) => {
        clearTimeout(this._timers[messageId])
        delete this._timers[messageId]

        types.forEach((type) => {
          this._remit._emitter.removeAllListeners(`${type}-${messageId}`)
        })

        if (err) {
          this._emitter.emit('error', err)

          if (this.hasOwnProperty('_fallback')) {
            resolve(this._fallback)
          } else {
            reject(err)
          }
        } else {
          resolve(result)
          this._emitter.emit('success', result, message)
        }

        this._emitter.emit(
          'data',
          parseEvent(message.properties, message.fields, err || result, {
            switchBubbles: true,
            isReceiver: true
          })
        )
      }

      types.forEach((type) => {
        this._remit._emitter.once(`${type}-${messageId}`, (message, ...args) => {
          cleanUp(message, ...args)
          if (type !== 'data') this._emitter.emit(type, ...args)
        })
      })
    })
  }
}

module.exports = Request
