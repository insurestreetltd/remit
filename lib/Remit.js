const url = require('url')
const amqplib = require('amqplib')
const EventEmitter = require('eventemitter3')
const packageJson = require('../package.json')
const parseAmqpUrl = require('../utils/parseAmqpUrl')
const generateConnectionOptions = require('../utils/generateConnectionOptions')
const ChannelPool = require('../utils/ChannelPool')
const CallableWrapper = require('../utils/CallableWrapper')
const throwAsException = require('../utils/throwAsException')
const Endpoint = require('./Endpoint')
const Listener = require('./Listener')
const Request = require('./Request')
const Emitter = require('./Emitter')

class Remit {
  constructor (options = {}) {
    this.listen = new CallableWrapper(this, Listener)
    this.emit = new CallableWrapper(this, Emitter)
    this.endpoint = new CallableWrapper(this, Endpoint)
    this.request = new CallableWrapper(this, Request)

    this.version = packageJson.version

    this._options = {}

    this._options.exchange = options.exchange || 'remit'
    this._options.name = options.name || process.env.REMIT_NAME || ''
    this._options.priority = options.priority || process.env.REMIT_PRIORITY || '5'
    this._options.url = options.url || process.env.REMIT_URL || 'amqp://localhost'
    this._options.errorHandler = options.errorHandler || throwAsException

    this._emitter = new EventEmitter()
    this._connection = (options.connection
        ? this._ensureExchange(options.connection, this._options.exchange)
        : this._connect(this._options)
    ).catch(error => this.handleError(error))
    this._workers = ChannelPool(this._connection)
    this._publishChannels = {}

    // TODO make this better
    this._eventCounters = {}
  }

  on (...args) {
    this._emitter.on(...args)
  }

  handleError(error) {
    return this._options.errorHandler(error)
  }

  async _connect ({ url: unparsedUrl, name, exchange }) {
    const amqpUrl = parseAmqpUrl(unparsedUrl)
    const connectionOptions = generateConnectionOptions(name)
    const { hostname } = url.parse(amqpUrl)
    connectionOptions.servername = hostname
    const connection = await amqplib.connect(amqpUrl, connectionOptions)

    return await this._ensureExchange(connection, exchange)
  }

  async _ensureExchange(connection, exchange) {
    const tempChannel = await connection.createChannel()

    await tempChannel.assertExchange(exchange, 'topic', {
        durable: true,
        internal: false,
        autoDelete: true
    })

    tempChannel.close()

    return connection
  }

  async _incoming (message) {
    if (!message) {
      await this.handleError(new Error('Request reply consumer cancelled unexpectedly; this was most probably done via RabbitMQ\'s management panel'))
    }

    try {
      var content = JSON.parse(message.content.toString())
    } catch (e) {
      console.error(e)
    }

    this._emitter.emit(`data-${message.properties.correlationId}`, message, ...content)
  }

  // Should we expose `name`, `exchange` and `url` publically?
  // we can use getters so they're still actually saved within
  // _options, but exposing them might be cool.
  get _exchange () {
    return this._options.exchange
  }
}

module.exports = Remit
