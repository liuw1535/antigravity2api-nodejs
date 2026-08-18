import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import requesterModule from '../src/requester.js';

const { FingerprintRequester } = requesterModule;

class StalledChildProcess extends EventEmitter {
  constructor() {
    super();
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
    this.stdin = {
      write() {},
      end() {},
    };
    this.killed = false;
  }

  kill() {
    if (this.killed) return false;
    this.killed = true;
    setImmediate(() => this.emit('close', null));
    return true;
  }
}

const child = new StalledChildProcess();
const requester = new FingerprintRequester({
  binaryPath: '/unused/fingerprint',
  configPath: '/unused/config.json',
  timeout: 0.02,
  spawnProcess: () => child,
});

const pending = requester.get('https://example.test/non-stream');
queueMicrotask(() => {
  child.stdout.emit('data', Buffer.from(
    'HTTP/1.1 200 OK\r\nContent-Length: 4\r\n\r\n'
  ));
});

const outcome = await Promise.race([
  pending.then(
    () => ({ type: 'resolved' }),
    error => ({ type: 'rejected', error })
  ),
  new Promise(resolve => setTimeout(() => resolve({ type: 'hung' }), 150)),
]);

assert.notEqual(
  outcome.type,
  'hung',
  'non-stream request should retain its watchdog after response headers'
);
assert.equal(outcome.type, 'rejected');
assert.equal(outcome.error.code, 'ECONNABORTED');
assert.equal(child.killed, true);

await new Promise(resolve => setImmediate(resolve));
assert.equal(requester.activeProcesses.size, 0);

console.log('PASS requester non-stream timeout remains active after headers');
