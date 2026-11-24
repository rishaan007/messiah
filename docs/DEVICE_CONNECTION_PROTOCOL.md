# Messiah Device Connection & Real-Time Protocol Specification

**Status**: Phase 4A Implemented & Verified  
**Endpoint**: `GET /api/v1/devices/connect` (Upgrade to WebSocket)  
**Protocol Version**: `2026-08-01`  
**Max Frame Size**: 64 KB (65,536 bytes)

---

## 1. Connection Architecture

The Bridge daemon communicates with Messiah Cloud over an outbound-only secure WebSocket connection (`wss://`). The server does not trust the connection upon TCP handshake; instead, it enforces an immediate cryptographic challenge-response authentication protocol.

```
Bridge Daemon (Client)                           Messiah Server (Gateway)
      |                                                     |
      | -------- GET /api/v1/devices/connect (WSS) -------> |
      |                                                     |
      | <------- device.challenge (nonce, audience) ------- |
      |                                                     |
      | -------- device.auth.proof (Ed25519 signature) ---> |
      |                                                     |
      | [Server checks DB for status === ACTIVE             |
      |  Server verifies signature against SPKI public key  |
      |  Server records DeviceConnectionSession             |
      |  Server sets Redis ephemeral presence]              |
      |                                                     |
      | <------- device.auth.success ---------------------- |
      |                                                     |
      | <====== 15-second Bidirectional Heartbeat Loop ===> |
      | -------- device.heartbeat ------------------------> |
      | <------- device.heartbeat.ack (timestamp) --------- |
      |                                                     |
```

---

## 2. Frame Taxonomy & Schemas

All messages exchanged between the server and the bridge daemon are JSON frames strictly validated against the schemas in `@messiah/shared`.

### Server-to-Device Frames (`ServerToDeviceFrame`)

#### 1. `device.challenge`
Issued by the server immediately upon WebSocket upgrade:
```json
{
  "type": "device.challenge",
  "challengeId": "550e8400-e29b-41d4-a716-446655440000",
  "nonce": "a1f8c4e098... (256-bit hex)",
  "serverAudience": "messiah:cloud:device-gateway",
  "protocolVersion": "2026-08-01",
  "expiresAt": 1774438830000
}
```

#### 2. `device.auth.success`
Issued by the server once cryptographic proof is verified:
```json
{
  "type": "device.auth.success",
  "deviceId": "c20ad4ef-9b81-4258-a461-912f293a9fa1",
  "workspaceId": "ws-12345",
  "heartbeatIntervalMs": 15000,
  "heartbeatTimeoutMs": 45000,
  "serverTime": 1774438800100
}
```

#### 3. `device.auth.failed`
Issued if signature verification fails, device is revoked, paused, or unapproved:
```json
{
  "type": "device.auth.failed",
  "code": "INVALID_SIGNATURE | DEVICE_NOT_ACTIVE | DEVICE_REVOKED | CHALLENGE_EXPIRED",
  "message": "Human-readable failure reason"
}
```

#### 4. `device.heartbeat.ack`
Acknowledgement of device heartbeat:
```json
{
  "type": "device.heartbeat.ack",
  "timestamp": 1774438815100
}
```

#### 5. `device.revoked`
Sent when an administrator permanently revokes the device from the Messiah Web UI:
```json
{
  "type": "device.revoked",
  "deviceId": "c20ad4ef-9b81-4258-a461-912f293a9fa1",
  "reason": "Revoked by workspace administrator"
}
```

---

### Device-to-Server Frames (`DeviceToServerFrame`)

#### 1. `device.auth.proof`
Transmitted by the bridge daemon within 30 seconds of receiving `device.challenge`:
```json
{
  "type": "device.auth.proof",
  "deviceId": "c20ad4ef-9b81-4258-a461-912f293a9fa1",
  "challengeId": "550e8400-e29b-41d4-a716-446655440000",
  "signature": "<Base64 encoded 64-byte Ed25519 signature>",
  "timestamp": 1774438800050,
  "metadata": {
    "platform": "darwin",
    "architecture": "arm64",
    "bridgeVersion": "0.1.0"
  }
}
```

#### 2. `device.heartbeat`
Periodic keepalive frame sent every 15 seconds:
```json
{
  "type": "device.heartbeat",
  "deviceId": "c20ad4ef-9b81-4258-a461-912f293a9fa1",
  "timestamp": 1774438815050
}
```

#### 3. `device.disconnecting`
Sent before intentional daemon teardown:
```json
{
  "type": "device.disconnecting",
  "deviceId": "c20ad4ef-9b81-4258-a461-912f293a9fa1",
  "reason": "Daemon shutting down via messiah-bridge stop"
}
```

---

## 3. Heartbeat Watchdog & Ephemeral Presence

1. **Heartbeat Cadence**:
   - Client sends `device.heartbeat` every **15 seconds**.
   - Server validates receipt and extends Redis ephemeral key:
     - Redis Key: `messiah:device:presence:<deviceId>`
     - Redis TTL: **45 seconds** (allowing for up to 2 dropped pings before marking offline).
2. **Server-Side Watchdog**:
   - The server maintains a watchdog timer for each active socket.
   - If no heartbeat is received within 45 seconds, the server terminates the socket with close code `4408` (`HEARTBEAT_TIMEOUT`) and closes the database `DeviceConnectionSession`.
3. **Admin Actions & Instant Pub/Sub Disconnection**:
   - When an admin clicks **Pause** or **Revoke** on the web UI, the backend publishes an event to Redis pub/sub channel `messiah:device:control`.
   - All cluster instances subscribe to this channel; the gateway holding the active TCP/WSS socket immediately issues a close frame (`4403` or `4410`) and terminates the connection.

---

## 4. Error Codes & Reconnection Behavior

| WebSocket Close Code | Close Reason | Daemon Action |
| :--- | :--- | :--- |
| `1000` | Normal Closure | Clean shutdown; do not reconnect. |
| `1001` | Going Away / Server Restart | Reconnect with exponential backoff. |
| `4400` | Malformed Frame / Schema Error | Disconnect; inspect logs. |
| `4401` | Authentication Failed (Bad Signature) | Fatal; abort reconnect; alert user. |
| `4403` | Device Paused or Unapproved | Abort reconnect until unpaused/approved. |
| `4404` | Device Not Found | Fatal; clean up local config. |
| `4408` | Heartbeat Timeout | Reconnect with exponential backoff. |
| `4409` | Superceded by Newer Session | Newer session took over; do not reconnect. |
| `4410` | Device Permanently Revoked | Fatal; unpair and delete local credentials. |
