import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import HyperDHT from 'hyperdht'
import { Server as BlindRelayServer } from 'blind-relay'

const envPath = fileURLToPath(new URL('./.env', import.meta.url))
if (typeof process.loadEnvFile === 'function' && existsSync(envPath)) {
  process.loadEnvFile(envPath)
}

const seedHex = process.env.RELAY_SEED
if (!seedHex || !/^[0-9a-fA-F]{64}$/.test(seedHex)) {
  console.error('FATAL: RELAY_SEED must be a 64-char hex string (32 bytes) — the relay identity must be stable so its public key survives redeploys.')
  console.error('Generate one: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"')
  process.exit(1)
}

const seed = Buffer.from(seedHex, 'hex')
const keyPair = HyperDHT.keyPair(seed)
const port = Number(process.env.RELAY_PORT) || 49737
const host = process.env.RELAY_HOST || '0.0.0.0'

const dht = new HyperDHT({ port, host })

const relay = new BlindRelayServer({
  createStream (opts) {
    // `opts` carries the firewall hook blind-relay uses to wire the relayed
    // UDX stream; `framed: true` matches hyperdht's own raw streams, without
    // which Noise frames would be corrupted in transit.
    return dht.createRawStream({ ...opts, framed: true })
  }
})

const server = dht.createServer((socket) => {
  // The Protomux channel id must be the *connecting peer's* key, mirroring the
  // client's `relay.Client.from(socket, { id: socket.publicKey })`.
  const who = socket.remotePublicKey.toString('hex').slice(0, 8)
  console.log(`+ session from ${who}`)
  const session = relay.accept(socket, { id: socket.remotePublicKey })
  session.on('pair', (isInitiator, token) => {
    console.log(`= paired ${who} isInitiator=${isInitiator} token=${token.toString('hex').slice(0, 8)}`)
  })
  session.on('error', (err) => console.log(`! session ${who} error: ${err.message}`))
  session.on('close', () => console.log(`- session ${who} closed`))
})

await server.listen(keyPair)

const publicKey = server.publicKey.toString('hex')
console.log('🛰  Custos blind relay — up')
console.log(`    public key : ${publicKey}`)
console.log(`    udp bind   : ${host}:${port}`)
console.log('    register this key in qvac.config.json -> swarmRelays on BOTH the provider (M1) and consumer (Edge)')

const statsTimer = setInterval(() => {
  const s = relay.stats
  console.log(
    `[stats] sessions=${s.sessions.active} pairings(active=${s.pairings.active} pending=${s.pairings.pending} matched=${s.pairings.matched}) streams=${s.streams.active}`
  )
}, 30000)
if (typeof statsTimer.unref === 'function') statsTimer.unref()

let closing = false
async function shutdown (signal) {
  if (closing) return
  closing = true
  console.log(`\n${signal} received — closing relay...`)
  clearInterval(statsTimer)
  try {
    await relay.close()
  } catch (err) {
    console.error('relay.close error:', err)
  }
  try {
    await server.close()
  } catch (err) {
    console.error('server.close error:', err)
  }
  try {
    await dht.destroy()
  } catch (err) {
    console.error('dht.destroy error:', err)
  }
  process.exit(0)
}

process.once('SIGINT', () => shutdown('SIGINT'))
process.once('SIGTERM', () => shutdown('SIGTERM'))
