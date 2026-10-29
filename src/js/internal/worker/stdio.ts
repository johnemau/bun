// Port-backed stdio streams shared by both ends of a node:worker_threads Worker:
// worker.stdout/stderr/stdin on the parent, process.stdout/stderr/stdin in the
// worker (built lazily from BunProcess.cpp via ProcessObjectInternals).
//
// The three streams of a worker share one MessageChannel, as they share the one
// internal port of a node worker (lib/internal/worker/io.js): what a thread posts
// for any of them arrives in the order it was posted. Flow control is node's, and
// is per stream: the writer posts an array of chunks and withholds
// the writev callback until the reader acks from _read(). One batch is in
// flight at a time; further writes buffer in the Writable, so write() returns
// false and 'drain' fires only when the consumer catches up. On the port a batch
// is its chunks followed by the stream's fd, the ack is the bare fd, and EOF is
// -1 - fd.

const kFlushSync = Symbol("kFlushSync");

interface PortReadable extends $Node.Readable {
  endFromOwner?(): void;
}

interface PortWritable extends $Node.Writable {
  [kFlushSync]: () => void;
}

// What one stream posts and is given: a batch of chunks, EOF (null) or the ack (true).
type StreamMessage = Uint8Array[] | null | true;

// The share of the port that one stream has.
interface StreamPort {
  postMessage(message: StreamMessage): void;
  // Every stream gets what the peer posted for it. It is never given what it cannot take.
  listen(receiver: (message: any) => void): void;
  unlisten(): void;
  ref(): void;
  unref(): void;
}

// One end of a worker's stdio channel. The port starts to listen with its first stream.
function makeStreamPorts(port: MessagePort, receiveMessageOnPort?: (port: unknown) => unknown) {
  const receivers: (((message: StreamMessage) => void) | null)[] = [null, null, null];
  let listening = false;
  // The streams that keep the port ref'd (node's kWaitingStreams).
  let waiting = 0;
  function deliver(message: unknown[] | number) {
    if (typeof message === "number") {
      const receiver = receivers[message < 0 ? -1 - message : message];
      if (receiver !== null) receiver(message < 0 ? null : true);
      return;
    }
    const last = message.length - 1;
    const receiver = receivers[message[last] as number];
    message.length = last;
    if (receiver !== null) receiver(message as Uint8Array[]);
  }
  function onMessage(event: { data: unknown[] | number }) {
    deliver(event.data);
  }
  function streamPort(fd: number): StreamPort {
    let refd = false;
    return {
      postMessage(message) {
        if (message === true) port.postMessage(fd);
        else if (message === null) port.postMessage(-1 - fd);
        else {
          $arrayPush(message as unknown[], fd);
          port.postMessage(message);
        }
      },
      listen(receiver) {
        receivers[fd] = receiver;
        if (listening === false) {
          listening = true;
          // The listener refs the event loop. Only a stream that waits for the peer does.
          port.addEventListener("message", onMessage);
          port.unref();
        }
      },
      unlisten() {
        receivers[fd] = null;
      },
      ref() {
        if (refd === false) {
          refd = true;
          if (waiting++ === 0) port.ref();
        }
      },
      unref() {
        if (refd) {
          refd = false;
          if (--waiting === 0) port.unref();
        }
      },
    };
  }
  return {
    stdin: streamPort(0),
    stdout: streamPort(1),
    stderr: streamPort(2),
    // Delivers what the port holds now, ahead of its 'message' events.
    deliverQueued() {
      let entry: unknown;
      while ((entry = receiveMessageOnPort!(port)) !== undefined) {
        deliver((entry as { message: unknown[] | number }).message);
      }
    },
  };
}

// Readable fed by a stream port (worker.stdout/stderr on the parent, process.stdin
// in the worker). The peer posts arrays of Buffers; null signals EOF.
function makePortReadable(port: StreamPort, incrementsPortRef: boolean) {
  let ended = false;
  let startedReading = false;
  function onMessage(payload: Uint8Array[] | null) {
    if (payload === null) {
      if (ended === false) {
        ended = true;
        stream.push(null);
      }
      port.unlisten();
    } else if (ended === false) {
      for (let i = 0; i < payload.length; i++) {
        stream.push(Buffer.from(payload[i]));
      }
    }
  }
  const Readable = require("internal/streams/readable");
  const stream: PortReadable = new Readable({
    read() {
      if (startedReading === false && incrementsPortRef) {
        startedReading = true;
        port.ref();
      }
      // Tell the writer we want more data; it completes its in-flight writev
      // on receipt (node's STDIO_WANTS_MORE_DATA).
      if (ended === false) port.postMessage(true);
    },
  });
  // Listen eagerly so the peer's writev is ack'd (via push -> maybeReadMore ->
  // _read) even when no one consumes this stream. That takes no ref: an
  // unconsumed captured stream never pins the loop on its own (node's model).
  port.listen(onMessage);
  // 'close' covers natural EOF and destroy(); release the read-time ref and
  // stop listening so a destroyed captured stream can't pin an unref'd worker.
  stream.on("close", () => {
    ended = true;
    port.unlisten();
    if (startedReading && incrementsPortRef) {
      startedReading = false;
      port.unref();
    }
  });
  // Lets the parent end worker.stdout/stderr when the worker exits, after it
  // delivered what the port still held (deliverQueued).
  stream.endFromOwner = function () {
    if (ended === false) {
      ended = true;
      stream.push(null);
      port.unlisten();
    }
  };
  return stream;
}

// Writable that forwards chunks over a stream port (worker.stdin on the parent,
// process.stdout/stderr in the worker). final() posts null as EOF.
function makePortWritable(port: StreamPort) {
  const Writable = require("internal/streams/writable");
  // Reader-side acks complete the in-flight writev. The port is ref'd only
  // while a batch is awaiting its ack, so unflushed data keeps the writer alive
  // (node's kWaitingStreams) but an idle stream never pins the loop.
  let pendingWriteCallback: $Node.ErrorCallback | null = null;
  function onAck() {
    const cb = pendingWriteCallback;
    if (cb !== null) {
      pendingWriteCallback = null;
      port.unref();
      cb();
    }
  }
  port.listen(onAck);
  const stream = new Writable({
    decodeStrings: false,
    writev(chunks: $Node.ChunkToWrite[], cb: $Node.ErrorCallback) {
      const payload = new Array(chunks.length);
      for (let i = 0; i < chunks.length; i++) {
        const { chunk, encoding } = chunks[i];
        payload[i] = typeof chunk === "string" ? Buffer.from(chunk, encoding as BufferEncoding) : chunk;
      }
      port.postMessage(payload);
      if (process._exiting) {
        // No event loop turns remain to deliver an ack; complete synchronously
        // so exit-time writes are not lost (node does the same).
        cb();
      } else {
        // Only one writev is in flight at a time, so the slot can't be occupied.
        pendingWriteCallback = cb;
        port.ref();
      }
    },
    final(cb: $Node.ErrorCallback) {
      port.postMessage(null);
      cb();
    },
    destroy(err: Error | null, cb: $Node.ErrorCallback) {
      // Discharge an in-flight batch: the reader may never ack a destroyed
      // stream, so release the loop ref taken in writev and complete the
      // parked callback; stop listening so a late ack can't fire
      // into the destroyed stream.
      const pending = pendingWriteCallback;
      if (pending !== null) {
        pendingWriteCallback = null;
        port.unref();
        pending(err);
      }
      port.unlisten();
      cb(err);
    },
  }) as PortWritable;
  // On a synchronous exit no ack can arrive; completing the parked writev lets
  // the Writable clear its buffer through writev, which now completes
  // synchronously because process._exiting is set (node's flushSync).
  stream[kFlushSync] = onAck;
  return stream;
}

// A node worker's process.stdin without { stdin: true }.
function makeEndedReadable() {
  const Readable = require("internal/streams/readable");
  return new Readable({
    read(this: $Node.Readable) {
      this.push(null);
    },
  });
}

export default {
  kFlushSync,
  makeStreamPorts,
  makePortReadable,
  makePortWritable,
  makeEndedReadable,
} as const;
