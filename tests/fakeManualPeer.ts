import * as engine from '../src/lib/p2p/manualPeer'

/**
 * Fake RTCPeerConnection pair for the manualPeer tests — the mirror of
 * fakeTrystero for the §12.2 engine (issue #97). Injected through the
 * engine's `setPeerConnectionFactory` seam, so the real WebRTC stack is
 * never contacted and the whole handshake is test-driven:
 *
 *  - `completeGathering()` fires `icegatheringstatechange === 'complete'`
 *    (non-trickle ICE, §12.2) after appending a candidate line to the SDP,
 *    so tests can tell the gathered description from the partial one the
 *    5 s guard would emit;
 *  - `connectPair()` walks both ends to `connected` and opens the data
 *    channels — exactly what a real DTLS handshake produces;
 *  - the paired channels deliver `send()` frames to the peer's `onmessage`,
 *    which is all the §12.2 JSON framing needs.
 *
 * The engine only ever sees DOM-typed objects: the instances are cast at
 * the factory boundary (`as unknown as RTCPeerConnection`), so handler
 * assignments land on the fake's plain properties at runtime.
 */

export class FakeDataChannel {
  readonly label: string
  readyState: 'connecting' | 'open' | 'closed' = 'connecting'
  onopen: (() => void) | null = null
  onclose: (() => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  readonly sent: string[] = []
  /** The paired channel on the other peer; wired by the pair factory. */
  peer: FakeDataChannel | null = null

  constructor(label: string) {
    this.label = label
  }

  /** Records the frame and delivers it to the peer engine's handler. */
  send(data: string): void {
    if (this.readyState !== 'open') throw new Error(`fake channel not open: ${this.label}`)
    this.sent.push(data)
    this.peer?.onmessage?.({ data })
  }

  /** Test-driven inbound delivery (e.g. hand-crafted frames, replays). */
  receive(data: string): void {
    this.onmessage?.({ data })
  }

  close(): void {
    if (this.readyState === 'closed') return
    this.readyState = 'closed'
    this.onclose?.()
  }

  open(): void {
    this.readyState = 'open'
    this.onopen?.()
  }

  lastFrame(): unknown {
    if (this.sent.length === 0) throw new Error(`no frames sent on ${this.label}`)
    return JSON.parse(this.sent[this.sent.length - 1] as string)
  }
}

export class FakeRTCPeerConnection {
  readonly rtcConfig: RTCConfiguration | undefined
  localDescription: RTCSessionDescriptionInit | null = null
  remoteDescription: RTCSessionDescriptionInit | null = null
  iceGatheringState: RTCIceGatheringState = 'new'
  iceConnectionState: RTCIceConnectionState = 'new'
  connectionState: RTCPeerConnectionState = 'new'
  onicegatheringstatechange: (() => void) | null = null
  oniceconnectionstatechange: (() => void) | null = null
  onconnectionstatechange: (() => void) | null = null
  ondatachannel: ((event: { channel: RTCDataChannel }) => void) | null = null

  /** The channel this side created (role A) or received (role B). */
  localChannel: FakeDataChannel | null = null
  remoteChannel: FakeDataChannel | null = null
  /** The other end of the pair, wired by `createFakePeerPair`. */
  peer: FakeRTCPeerConnection | null = null
  /** Set when `close()` ran — the dispose assertions watch this. */
  closed = false

  constructor(config?: RTCConfiguration) {
    this.rtcConfig = config
  }

  createDataChannel(label: string): FakeDataChannel {
    const channel = new FakeDataChannel(label)
    this.localChannel = channel
    return channel
  }

  async createOffer(): Promise<RTCSessionDescriptionInit> {
    return { type: 'offer', sdp: 'v=0\r\no=- 111 222 IN IP4 127.0.0.1\r\ns=-\r\n' }
  }

  async createAnswer(): Promise<RTCSessionDescriptionInit> {
    return { type: 'answer', sdp: 'v=0\r\no=- 333 444 IN IP4 127.0.0.1\r\ns=-\r\n' }
  }

  async setLocalDescription(description: RTCSessionDescriptionInit): Promise<void> {
    if (this.closed) throw new Error('fake pc is closed')
    this.localDescription = { ...description }
    this.iceGatheringState = 'gathering'
    // Non-trickle ICE is test-driven: `completeGathering()` below decides
    // when (and whether) the candidate harvest completes.
  }

  async setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void> {
    if (this.closed) throw new Error('fake pc is closed')
    this.remoteDescription = { ...description }
    if (description.type === 'offer') {
      // The remote side's createDataChannel materializes a paired channel
      // here, announced through ondatachannel like a real negotiation.
      const peerChannel = this.peer?.localChannel
      if (peerChannel !== undefined && peerChannel !== null && this.remoteChannel === null) {
        const channel = new FakeDataChannel(peerChannel.label)
        channel.peer = peerChannel
        peerChannel.peer = channel
        this.remoteChannel = channel
        queueMicrotask(() => {
          this.ondatachannel?.({ channel: channel as unknown as RTCDataChannel })
        })
      }
    }
  }

  /**
   * Completes the candidate harvest: appends a recognizable candidate line
   * (so the gathered SDP differs from the partial one the 5 s guard emits)
   * and fires the gathering-state event the engine waits on. Safe to call
   * before the engine registers its handler — the entry check in
   * `waitForLocalDescription` then resolves immediately.
   */
  completeGathering(): void {
    if (this.iceGatheringState === 'complete' || this.localDescription === null) return
    this.localDescription = {
      ...this.localDescription,
      sdp: this.localDescription.sdp + 'a=candidate:fake 1 udp 1 10.0.0.1 5000 typ host\r\n',
    }
    this.iceGatheringState = 'complete'
    this.onicegatheringstatechange?.()
  }

  close(): void {
    this.closed = true
    this.connectionState = 'closed'
    this.iceConnectionState = 'closed'
  }
}

export interface FakePeerPair {
  pcA: FakeRTCPeerConnection
  pcB: FakeRTCPeerConnection
}

/** Links two fake PCs into an A↔B pair (channels pair up on the offer). */
export function createFakePeerPair(): FakePeerPair {
  const pcA = new FakeRTCPeerConnection()
  const pcB = new FakeRTCPeerConnection()
  pcA.peer = pcB
  pcB.peer = pcA
  return { pcA, pcB }
}

/**
 * Drives both ends to `connected`: ICE/connection states flip first (role
 * B's establishment guard arms on the ice event and disarms on channel
 * open), then both data channels open.
 */
export function connectPair(pair: FakePeerPair): void {
  for (const pc of [pair.pcA, pair.pcB]) {
    pc.iceConnectionState = 'connected'
    pc.connectionState = 'connected'
    pc.oniceconnectionstatechange?.()
    pc.onconnectionstatechange?.()
  }
  pair.pcA.localChannel?.open()
  pair.pcB.remoteChannel?.open()
}

/** Simulates the link dying after connecting (§12.2 «The peer has disconnected»). */
export function dropPair(pair: FakePeerPair): void {
  pair.pcA.localChannel?.close()
  pair.pcB.remoteChannel?.close()
}

/**
 * Installs a factory that hands out the given PCs in creation order (the
 * engine created first receives the first PC of the list).
 */
export function installFakePeerConnectionFactory(pcs: FakeRTCPeerConnection[]): void {
  const queue = [...pcs]
  engine.setPeerConnectionFactory(() => {
    const pc = queue.shift()
    if (pc === undefined) throw new Error('no more fake PCs queued')
    return pc as unknown as RTCPeerConnection
  })
}

/**
 * Factory that RECORDS every created PC (state-machine tests inspect the
 * engine's transport without caring about a fixed pair).
 */
export function installRecordingFactory(): FakeRTCPeerConnection[] {
  const created: FakeRTCPeerConnection[] = []
  engine.setPeerConnectionFactory((config) => {
    const pc = new FakeRTCPeerConnection(config)
    created.push(pc)
    return pc as unknown as RTCPeerConnection
  })
  return created
}
