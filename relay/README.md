# busto-relay — self-hosted Hyperswarm blind relay

A standalone Hyperswarm/hyperdht **blind relay** node. It bridges the QVAC
delegated-inference connection between the Orchestrator (M1 "Vault") and the
Edge ("AP Clerk") when **direct holepunch fails** — the case when both nodes sit
behind symmetric NAT (Starlink CGNAT), where hyperdht's UDP holepunch can't
traverse and the SDK reports `PEER_CONNECTION_FAILED`.

It is **blind**: it only forwards end-to-end-encrypted UDX stream messages
between two peers paired by a one-time token. It cannot read the invoice, the
inference, or anything else — it is transport, not an AI/data dependency. This
preserves Busto's "zero cloud AI, zero data leakage" thesis. Disclose it in
`evidence/remote_apis.json` as transport, alongside the Sepolia RPC.

## How it works

A connecting peer dials the relay by its public key (`dht.connect(relayKey)`),
opens a `blind-relay` client channel, and pairs with the other peer via a shared
token. The relay matches the two tokens and relays the encrypted stream between
them. Because the relay is on a **public IP** (FIREWALL.OPEN), both peers can
reach it directly even from behind CGNAT.

Wiring matches the canonical Holepunch reference (blind-relay `example.js`,
hyperdht `test/relaying.js`): `relay.accept(socket, { id: socket.remotePublicKey })`
and `createStream` over `dht.createRawStream({ ...opts, framed: true })`.

## Run locally

```sh
cp .env.example .env          # then paste your 64-hex RELAY_SEED
npm install
npm start
```

On startup it prints the relay **public key** (hex). That key is stable for a
given `RELAY_SEED`, so it survives redeploys. Put it in the repo-root
`qvac.config.json` under `swarmRelays` on **both** the provider and the consumer.

## Config

| Env | Default | Meaning |
|---|---|---|
| `RELAY_SEED` | *(required)* | 64-hex (32-byte) seed → deterministic relay public key. **Secret. Never commit.** |
| `RELAY_PORT` | `49737` | UDP port the relay binds and you expose publicly |
| `RELAY_HOST` | `0.0.0.0` | bind host |

## Deploy — needs a UDP-capable public host

The relay must be reachable on **inbound UDP** at `RELAY_PORT` from `0.0.0.0/0`.
HTTP-only platforms (Railway, classic PaaS) will **not** work.

### Option A — VPS (most reliable)

Any VPS with a public IPv4 (DigitalOcean, Hetzner, Vultr, EC2):

```sh
# open the UDP port in the cloud firewall / security group:  UDP 49737  from 0.0.0.0/0
git clone <repo> && cd busto/relay
npm install
RELAY_SEED=<your-64-hex-seed> RELAY_PORT=49737 node index.js
# keep it alive with systemd or pm2:
#   pm2 start index.js --name busto-relay
```

### Option B — Fly.io (UDP service)

UDP on Fly requires a **dedicated IPv4**:

```sh
cd relay
fly launch --no-deploy            # accept app name "busto-relay" (matches fly.toml)
fly ips allocate-v4               # dedicated IPv4 is REQUIRED for UDP
fly secrets set RELAY_SEED=<your-64-hex-seed>
fly deploy
fly logs                          # confirm "Busto blind relay — up" + the public key
```

The bundled `Dockerfile` + `fly.toml` expose UDP `49737`.

## Verify

On startup you must see the same public key that's in `qvac.config.json`:

```
🛰  Busto blind relay — up
    public key : <hex>
    udp bind   : 0.0.0.0:49737
```

`[stats]` lines report live sessions/pairings/streams once peers connect.
