import { EventEmitter } from 'node:events';

/**
 * Minimal zero-dependency WebSocket framing implementation over a net.Socket.
 * Implements RFC 6455 server-side framing (unmask incoming, send unmasked/masked outgoing).
 */
export class WebSocketStream extends EventEmitter {
  constructor(socket, { isServer = true, head = null } = {}) {
    super();
    this.socket = socket;
    this.isServer = isServer;
    this.buffer = head && head.length > 0 ? Buffer.from(head) : Buffer.alloc(0);
    this.closed = false;

    this.socket.on('data', (chunk) => this.#onData(chunk));
    this.socket.resume();
    if (this.buffer.length > 0) {
      queueMicrotask(() => this.#processBuffer());
    }
    this.socket.on('close', (hadError) => {
      if (!this.closed) {
        this.closed = true;
        this.emit('close', 1006, hadError ? 'abnormal closure' : '');
      }
    });
    this.socket.on('error', (err) => {
      this.emit('error', err);
    });
  }

  send(data) {
    if (this.closed || !this.socket.writable) return;
    const isBinary = Buffer.isBuffer(data);
    const payload = isBinary ? data : Buffer.from(String(data), 'utf8');
    const opcode = isBinary ? 0x02 : 0x01;
    this.#sendFrame(opcode, payload);
  }

  ping(data = Buffer.alloc(0)) {
    if (this.closed || !this.socket.writable) return;
    const payload = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
    this.#sendFrame(0x09, payload);
  }

  pong(data = Buffer.alloc(0)) {
    if (this.closed || !this.socket.writable) return;
    const payload = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
    this.#sendFrame(0x0a, payload);
  }

  close(code = 1000, reason = '') {
    if (this.closed) return;
    this.closed = true;
    try {
      const reasonBuf = Buffer.from(reason, 'utf8');
      const payload = Buffer.alloc(2 + reasonBuf.length);
      payload.writeUInt16BE(code, 0);
      reasonBuf.copy(payload, 2);
      this.#sendFrame(0x08, payload);
    } catch {
      // socket may already be destroyed
    }
    // Allow peer to receive close frame before ending
    setTimeout(() => {
      try {
        this.socket.end();
      } catch {}
    }, 10);
  }

  #sendFrame(opcode, payload) {
    const len = payload.length;
    let header;
    const maskBit = this.isServer ? 0x00 : 0x80;

    if (len < 126) {
      header = Buffer.alloc(2);
      header[0] = 0x80 | (opcode & 0x0f);
      header[1] = maskBit | len;
    } else if (len <= 0xffff) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | (opcode & 0x0f);
      header[1] = maskBit | 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | (opcode & 0x0f);
      header[1] = maskBit | 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }

    if (!this.isServer) {
      const maskKey = Buffer.alloc(4);
      for (let i = 0; i < 4; i += 1) {
        maskKey[i] = Math.floor(Math.random() * 256);
      }
      const maskedPayload = Buffer.alloc(len);
      for (let i = 0; i < len; i += 1) {
        maskedPayload[i] = payload[i] ^ maskKey[i % 4];
      }
      this.socket.write(Buffer.concat([header, maskKey, maskedPayload]));
    } else {
      this.socket.write(Buffer.concat([header, payload]));
    }
  }

  #onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    this.#processBuffer();
  }

  #processBuffer() {
    while (this.buffer.length >= 2) {
      const b0 = this.buffer[0];
      const b1 = this.buffer[1];
      const fin = (b0 & 0x80) === 0x80;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) === 0x80;
      let payloadLen = b1 & 0x7f;
      let offset = 2;

      if (payloadLen === 126) {
        if (this.buffer.length < 4) return;
        payloadLen = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (payloadLen === 127) {
        if (this.buffer.length < 10) return;
        payloadLen = Number(this.buffer.readBigUInt64BE(2));
        offset = 10;
      }

      let maskKey = null;
      if (masked) {
        if (this.buffer.length < offset + 4) return;
        maskKey = this.buffer.subarray(offset, offset + 4);
        offset += 4;
      }

      if (this.buffer.length < offset + payloadLen) return;

      const payload = Buffer.from(this.buffer.subarray(offset, offset + payloadLen));
      this.buffer = this.buffer.subarray(offset + payloadLen);

      if (masked && maskKey) {
        for (let i = 0; i < payload.length; i += 1) {
          payload[i] ^= maskKey[i % 4];
        }
      }

      this.#handleFrame(opcode, payload, fin);
    }
  }

  #handleFrame(opcode, payload, _fin) {
    if (opcode === 0x08) {
      // Close frame
      const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
      const reason = payload.length > 2 ? payload.subarray(2).toString('utf8') : '';
      this.close(code, reason);
      this.emit('close', code, reason);
    } else if (opcode === 0x09) {
      // Ping frame -> respond Pong
      this.pong(payload);
      this.emit('ping', payload);
    } else if (opcode === 0x0a) {
      // Pong frame
      this.emit('pong', payload);
    } else if (opcode === 0x01) {
      // Text frame
      this.emit('message', payload.toString('utf8'), false);
    } else if (opcode === 0x02) {
      // Binary frame
      this.emit('message', payload, true);
    }
  }
}
